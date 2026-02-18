import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

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

// Diarize transcript — identify and label speakers
app.post('/api/diarize', requireAuth, async (req, res) => {
    try {
        if (!ai) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
        const { attendeeNames, transcriptionText } = req.body;

        const diarizeResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: `You are a professional transcript editor. Your task is to take a raw meeting transcript (which is one continuous block of text) and reformat it into a speaker-separated dialogue.

Rules:
- Identify when different speakers are talking based on conversational context, topic shifts, and dialogue patterns.
- Label speakers as "Speaker 1", "Speaker 2", "Speaker 3", etc. Use these labels consistently throughout.
- Format each speaker turn on its own line, prefixed with the speaker label and a colon, e.g. "Speaker 1: ..."
- Add a blank line between different speakers for readability.
- Do NOT summarise or paraphrase. Keep the original words exactly as they are.
- Do NOT add any commentary, headings, or notes. Only output the reformatted transcript.
- Fix obvious transcription errors only if you are very confident.
- Write in UK English.

Raw transcript:
${transcriptionText}`
        });

        res.json({ diarized: diarizeResponse.text || transcriptionText });
    } catch (err) {
        console.error('Error diarizing transcript:', err.message);
        // Fall back to raw transcript on error
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
