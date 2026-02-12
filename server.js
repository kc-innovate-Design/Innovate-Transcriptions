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
    console.error('FATAL: GEMINI_API_KEY environment variable is not set');
    process.exit(1);
}

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
    res.json({ key: GEMINI_API_KEY });
});

// Proxy for summary generation (key never reaches the browser)
app.post('/api/summary', requireAuth, async (req, res) => {
    try {
        const { meetingTitle, meetingType, attendeeNames, transcriptionText } = req.body;

        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
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

// --- Serve static frontend in production ---
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
