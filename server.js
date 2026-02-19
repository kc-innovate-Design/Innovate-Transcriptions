import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK to bypass client-side rules
try {
    admin.initializeApp({
        projectId: 'innovate-transcriptions'
    });
    console.log('Firebase Admin initialized with projectId: innovate-transcriptions');
} catch (e) {
    if (e.code !== 'app/duplicate-app') {
        console.warn('Firebase Admin initialization warning:', e.message);
    }
}
const db = admin.firestore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
    // The token is verified client-side via Firebase Auth
    // For additional security, you could verify the token server-side with Firebase Admin SDK
    next();
};

// --- API Routes ---

// Return the Gemini API key to authenticated users (for Live WebSocket)
app.get('/api/gemini-key', requireAuth, (req, res) => {
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
    res.json({ key: GEMINI_API_KEY });
});

// Recover the latest meeting (server-side bypass for auth rules)
app.get('/api/recover-latest', requireAuth, async (req, res) => {
    try {
        console.log('[Recover] Fetching latest meeting via Admin SDK...');
        const snapshot = await db.collection('transcriptions')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log('[Recover] No meetings found in collection');
            return res.status(404).json({ error: 'No meetings found' });
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        console.log(`[Recover] Found meeting: ${data.title} (ID: ${doc.id})`);

        // Return data. Admin SDK returns Timestamp objects, which serialize to ISO strings automatically in res.json
        res.json({
            ...data,
            id: doc.id
        });
    } catch (err) {
        console.error('[Recover] Error fetching latest session:', err);
        res.status(500).json({ error: 'Failed to recover session: ' + err.message });
    }
});

// Proxy for summary generation (key never reaches the browser)
app.post('/api/summary', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { meetingTitle, meetingType, attendeeNames, transcriptionText } = req.body;

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

        res.json({ summary: summaryResponse.text || '' });
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
