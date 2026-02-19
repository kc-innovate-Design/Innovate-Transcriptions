import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY environment variable is not set. AI features will not work.');
}

// Reuse a single GenAI client instance across requests
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Middleware to verify Firebase Auth token (basic check)
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized — missing auth token' });
    }
    next();
};

// --- API Routes ---

// Return the Gemini API key to authenticated users (for Live WebSocket)
app.get('/api/gemini-key', requireAuth, (req, res) => {
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
    res.json({ key: GEMINI_API_KEY });
});

// Proxy for summary generation (key never reaches the browser)
// For very long transcripts, we chunk and summarise each chunk, then produce a final summary
app.post('/api/summary', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { meetingTitle, meetingType, attendeeNames, transcriptionText } = req.body;

        // If transcript is short enough, process in one go
        if (transcriptionText.length <= 30000) {
            const summaryResponse = await ai.models.generateContent({
                model: 'gemini-2.0-flash',
                contents: `You are a professional meeting assistant. Summarise the following meeting transcription into a clear, concise summary. Include:
- Key discussion points
- Decisions made
- Action items (if any)

Write in UK English. Use bullet points for clarity. Keep it concise but comprehensive.

Meeting: ${meetingTitle}
Type: ${meetingType}
Attendees: ${attendeeNames}

Transcription:
${transcriptionText}`
            });
            return res.json({ summary: summaryResponse.text || '' });
        }

        // For long transcripts: summarise each chunk, then merge summaries
        const chunks = chunkText(transcriptionText, 25000);
        console.log(`[Summary] Long transcript (${transcriptionText.length} chars) — processing ${chunks.length} chunks`);
        const chunkSummaries = [];

        for (let i = 0; i < chunks.length; i++) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.0-flash',
                    contents: `Summarise this section (part ${i + 1} of ${chunks.length}) of a meeting transcript. Include key points, decisions, and action items. Write in UK English. Be concise.\n\n${chunks[i]}`
                });
                chunkSummaries.push(response.text || '');
            } catch (e) {
                console.error(`[Summary] Chunk ${i + 1} failed:`, e.message);
            }
        }

        // Merge chunk summaries into one final summary
        const mergeResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: `You are a professional meeting assistant. Below are summaries from different sections of the same meeting. Merge them into one clear, concise overall summary. Remove duplicates. Include:
- Key discussion points
- Decisions made
- Action items (if any)

Write in UK English. Use bullet points for clarity.

Meeting: ${meetingTitle}
Type: ${meetingType}
Attendees: ${attendeeNames}

Section summaries:
${chunkSummaries.join('\n\n---\n\n')}`
        });

        res.json({ summary: mergeResponse.text || '' });
    } catch (err) {
        console.error('Error generating summary:', err.message);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

// Helper to chunk text while respecting sentence boundaries
const chunkText = (text, maxLength = 12000) => {
    const chunks = [];
    let currentChunk = '';

    const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)/g) || [text];

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
};

// Diarize transcript — identify and label speakers with chunking
app.post('/api/diarize', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { attendeeNames, transcriptionText } = req.body;

        if (!transcriptionText) return res.json({ diarized: '' });

        // Split long transcripts into chunks to avoid output token limits
        // 12000 chars is roughly 3000-4000 tokens, leaving ample room for the model's output
        const chunks = chunkText(transcriptionText);
        console.log(`[Diarization] Processing ${chunks.length} chunks for ${transcriptionText.length} chars`);

        const diarizedChunks = [];

        // Process chunks sequentially to maintain order and context
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`[Diarization] Processing chunk ${i + 1}/${chunks.length}...`);

            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.0-flash',
                    contents: `You are a professional transcript editor. Your task is to take a raw meeting transcript and reformat it into a speaker-separated dialogue.

Context:
- Attendees: ${attendeeNames || 'Unknown speakers'}
- This is part ${i + 1} of ${chunks.length} of the full transcript.

Rules:
- Identify speakers based on the provided attendee names where possible.
- If a speaker is clearly one of the attendees, use their name (e.g., "Tim:", "Sam:").
- If the speaker is unknown, use "Speaker 1", "Speaker 2", etc. ensuring consistency within this chunk.
- Format each speaker turn on its own line, prefixed with the name/label and a colon.
- Add a blank line between different speakers.
- Do NOT summarise or paraphrase. Keep the original words exactly as they are.
- Do NOT add any commentary. Only output the reformatted transcript.
- Write in UK English.

Raw transcript segment:
${chunk}`
                });

                const text = response.response.text();
                diarizedChunks.push(text);
            } catch (chunkError) {
                console.error(`[Diarization] Error in chunk ${i + 1}:`, chunkError.message);
                // Fallback: just append the raw chunk if AI fails
                diarizedChunks.push(chunk);
            }
        }

        const fullDiarized = diarizedChunks.join('\n\n');
        res.json({ diarized: fullDiarized });

    } catch (err) {
        console.error('Error diarizing transcript:', err.message);
        // Fall back to raw transcript on global error
        res.json({ diarized: req.body.transcriptionText || '' });
    }
});

// Extract key insights / trigger questions from the transcript
// For very long transcripts, extract insights from each chunk then merge
app.post('/api/insights', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { meetingTitle, meetingType, attendeeNames, transcriptionText } = req.body;

        if (!transcriptionText) return res.json({ insights: '' });

        const insightsPrompt = (text, context = '') => `You are a meeting analyst specialising in product design and innovation. Analyse the following meeting transcript${context} and extract key insights, organised into the categories below.

For each category, identify the specific question or prompt that triggered the discussion, then summarise the key points made in response. Quote important phrases directly from the transcript where possible.

Categories:
1. **User Needs** — How would users use the product? What do they need it to do? What problems are they trying to solve?
2. **Feature Requests** — What are the key features discussed? What functionality is most important? What should the product include?
3. **Competitor Analysis** — What products are currently on the market? What alternatives exist? What do competitors offer?
4. **Pros & Cons** — What works well about existing solutions? What doesn't? Advantages and disadvantages discussed.
5. **Pain Points** — What frustrates users? What's missing? Where do current solutions fall short?

Rules:
- Only include categories where relevant discussion was found. Skip empty categories entirely.
- For each insight, start with the trigger question/topic in bold, followed by the key points.
- Use bullet points for clarity.
- Write in UK English.
- Keep it concise but ensure no key insight is missed.
- If no meaningful insights are found for any category, respond with "No key insights identified in this meeting."

Meeting: ${meetingTitle}
Type: ${meetingType}
Attendees: ${attendeeNames}

Transcript:
${text}`;

        if (transcriptionText.length <= 30000) {
            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash',
                contents: insightsPrompt(transcriptionText)
            });
            return res.json({ insights: response.text || '' });
        }

        // For long transcripts: extract insights from each chunk, then merge
        const chunks = chunkText(transcriptionText, 25000);
        console.log(`[Insights] Long transcript (${transcriptionText.length} chars) — processing ${chunks.length} chunks`);
        const chunkInsights = [];

        for (let i = 0; i < chunks.length; i++) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.0-flash',
                    contents: insightsPrompt(chunks[i], ` (section ${i + 1} of ${chunks.length})`)
                });
                chunkInsights.push(response.text || '');
            } catch (e) {
                console.error(`[Insights] Chunk ${i + 1} failed:`, e.message);
            }
        }

        // Merge all chunk insights into a deduplicated final set
        const mergeResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: `Below are key insights extracted from different sections of the same meeting. Merge them into one comprehensive set of insights, removing duplicates and combining related points. Keep the same 5 categories (User Needs, Feature Requests, Competitor Analysis, Pros & Cons, Pain Points). Only include categories with content. Write in UK English.\n\n${chunkInsights.join('\n\n---\n\n')}`
        });

        res.json({ insights: mergeResponse.text || '' });
    } catch (err) {
        console.error('Error extracting insights:', err.message);
        res.status(500).json({ error: 'Failed to extract insights' });
    }
});

// --- Serve static frontend in production ---
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
