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

// --- Meeting-type-specific insight categories ---
const INSIGHT_CATEGORIES = {
    'Client - Initial assessment': [
        { name: 'User Needs', description: 'How would users use the product? What do they need it to do? What problems are they trying to solve?' },
        { name: 'Feature Requests', description: 'What are the key features discussed? What functionality is most important? What should the product include?' },
        { name: 'Competitor Analysis', description: 'What products are currently on the market? What alternatives exist? What do competitors offer?' },
        { name: 'Pros & Cons', description: 'What works well about existing solutions? What doesn\'t? Advantages and disadvantages discussed.' },
        { name: 'Pain Points', description: 'What frustrates users? What\'s missing? Where do current solutions fall short?' },
    ],
    'Client - Design stage kick off': [
        { name: 'Design Requirements', description: 'What are the core design requirements? What must the product look like, feel like, or do?' },
        { name: 'User Scenarios', description: 'What use cases or user scenarios were discussed? How will real users interact with the product?' },
        { name: 'Technical Constraints', description: 'What technical limitations, material constraints, or manufacturing considerations were raised?' },
        { name: 'Scope & Priorities', description: 'What\'s in scope vs. out of scope? What are the highest priorities for this design phase?' },
        { name: 'Open Questions', description: 'What questions remain unanswered? What needs further research or client input?' },
    ],
    'Client - Mid way meeting': [
        { name: 'Progress Updates', description: 'What progress has been made since the last meeting? What milestones have been reached?' },
        { name: 'Design Feedback', description: 'What feedback did the client give on current designs, prototypes, or concepts?' },
        { name: 'Issues & Blockers', description: 'What problems or blockers were identified? What\'s preventing progress?' },
        { name: 'Scope Changes', description: 'Were any changes to scope, direction, or requirements discussed?' },
        { name: 'Next Steps', description: 'What are the agreed next steps, deadlines, or deliverables before the next meeting?' },
    ],
    'Client - Handover meeting': [
        { name: 'Deliverables Reviewed', description: 'What deliverables were presented and reviewed? What was the client shown?' },
        { name: 'Client Feedback', description: 'What was the client\'s reaction? What feedback did they give on the final output?' },
        { name: 'Outstanding Items', description: 'What items are still outstanding or incomplete? What needs follow-up?' },
        { name: 'Training & Support Needs', description: 'What training, documentation, or ongoing support does the client need?' },
        { name: 'Sign-off & Acceptance', description: 'Was sign-off given? What acceptance criteria were discussed?' },
    ],
    'Internal - Team meeting': [
        { name: 'Updates & Progress', description: 'What updates did team members share? What progress was reported on current projects?' },
        { name: 'Decisions Made', description: 'What decisions were made during the meeting? What was agreed upon?' },
        { name: 'Action Items', description: 'What tasks were assigned? Who is responsible and by when?' },
        { name: 'Blockers & Risks', description: 'What blockers, risks, or concerns were raised by the team?' },
        { name: 'Team Feedback', description: 'What general feedback, ideas, or suggestions did team members share?' },
    ],
    'Internal - Project review': [
        { name: 'Project Status', description: 'What is the current status of the project? Is it on track, behind, or ahead?' },
        { name: 'What Went Well', description: 'What aspects of the project went well? What successes were highlighted?' },
        { name: 'What Could Improve', description: 'What could be improved? What lessons were learned?' },
        { name: 'Resource & Timeline', description: 'Were any resource, budget, or timeline issues discussed?' },
        { name: 'Recommendations', description: 'What recommendations or next steps were proposed for the project?' },
    ],
    'Internal - Other': [
        { name: 'Key Discussion Points', description: 'What were the main topics discussed in the meeting?' },
        { name: 'Decisions Made', description: 'What decisions were made during the meeting?' },
        { name: 'Action Items', description: 'What tasks or actions were assigned? Who is responsible?' },
        { name: 'Open Questions', description: 'What questions remain unanswered or need further discussion?' },
        { name: 'Follow-ups', description: 'What follow-up meetings, emails, or tasks were agreed?' },
    ],
};

// Default fallback categories (same as Initial assessment)
const DEFAULT_CATEGORIES = INSIGHT_CATEGORIES['Client - Initial assessment'];

// Build the categories section of the prompt from the meeting type
const getCategoriesForType = (meetingType) => {
    return INSIGHT_CATEGORIES[meetingType] || DEFAULT_CATEGORIES;
};

const formatCategoriesForPrompt = (categories) => {
    return categories.map((cat, i) => `${i + 1}. **${cat.name}** — ${cat.description}`).join('\n');
};

const getCategoryNames = (categories) => {
    return categories.map(cat => cat.name).join(', ');
};

// Extract key insights / trigger questions from the transcript
// For very long transcripts, extract insights from each chunk then merge
app.post('/api/insights', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { meetingTitle, meetingType, attendeeNames, transcriptionText } = req.body;

        if (!transcriptionText) return res.json({ insights: '' });

        const categories = getCategoriesForType(meetingType);
        const categoriesText = formatCategoriesForPrompt(categories);
        const categoryNames = getCategoryNames(categories);

        const insightsPrompt = (text, context = '') => `You are a meeting analyst specialising in product design and innovation. Analyse the following meeting transcript${context} and extract key insights, organised into the categories below.

For each category, identify the specific question or prompt that triggered the discussion, then summarise the key points made in response. Quote important phrases directly from the transcript where possible.

Categories:
${categoriesText}

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
            contents: `Below are key insights extracted from different sections of the same meeting. Merge them into one comprehensive set of insights, removing duplicates and combining related points. Keep the same categories (${categoryNames}). Only include categories with content. Write in UK English.\n\n${chunkInsights.join('\n\n---\n\n')}`
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
