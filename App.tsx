
import React, { useState, useEffect, useRef } from 'react';
import { AppStep, MeetingData, Attendee, MEETING_TYPES } from './types';
import { ALL_ATTENDEES, DEPARTMENTS } from './constants';
import { Mic, Pause, Play, Square, CheckCircle, ChevronRight, UserPlus, Clock, Calendar, MessageSquare, LogOut, User, Loader2, Copy, Check, X, AlertTriangle, XCircle, Zap, Plus, Trash2, Pencil, Settings, FileText } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { onAuthStateChanged, User as FirebaseUser, signOut } from 'firebase/auth';
import { collection, addDoc, serverTimestamp, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Auth } from './Auth';

const APP_VERSION = '1.0.53';

// --- Helper Functions for Audio ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// --- Components ---

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>(AppStep.HOME);
  const [meetingData, setMeetingData] = useState<MeetingData>({
    title: '',
    type: '',
    attendees: [],
    transcription: []
  });

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('connected');
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const [copiedField, setCopiedField] = useState<'transcript' | 'summary' | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>(new Array(32).fill(0));
  const [stepTransition, setStepTransition] = useState<'entering' | 'exiting' | 'idle'>('idle');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const summaryTextRef = useRef<string>('');

  // Custom meeting templates
  interface MeetingTemplate {
    id: string;
    name: string;
    title: string;
    type: string;
    attendeeIds: string[];
  }
  const [customTemplates, setCustomTemplates] = useState<MeetingTemplate[]>(() => {
    try {
      const icIds = ALL_ATTENDEES.filter(a => a.department === 'Innovation Coaches').map(a => a.id);
      const designerIds = ALL_ATTENDEES.filter(a => a.department === 'Designer').map(a => a.id);
      const defaultPresets: MeetingTemplate[] = [
        { id: 'preset-ic', name: 'IC Team Meeting', title: 'IC Team Meeting', type: 'Internal - Team meeting', attendeeIds: icIds },
        { id: 'preset-designer', name: 'Designer Team Meeting', title: 'Designer Team Meeting', type: 'Internal - Team meeting', attendeeIds: designerIds },
      ];
      const stored = localStorage.getItem('meetingTemplates');
      if (stored) {
        const existing: MeetingTemplate[] = JSON.parse(stored);
        // Migrate: ensure default presets exist
        const hasIc = existing.some(t => t.id === 'preset-ic');
        const hasDesigner = existing.some(t => t.id === 'preset-designer');
        if (!hasIc || !hasDesigner) {
          const toAdd = defaultPresets.filter(d => !existing.some(e => e.id === d.id));
          const merged = [...toAdd, ...existing];
          localStorage.setItem('meetingTemplates', JSON.stringify(merged));
          return merged;
        }
        return existing;
      }
      localStorage.setItem('meetingTemplates', JSON.stringify(defaultPresets));
      return defaultPresets;
    } catch { return []; }
  });
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateForm, setTemplateForm] = useState({ name: '', title: '', type: '', attendeeIds: [] as string[] });

  // Dynamic team member management
  const [teamMembers, setTeamMembers] = useState<Attendee[]>(() => {
    try {
      const stored = localStorage.getItem('teamMembers');
      return stored ? JSON.parse(stored) : ALL_ATTENDEES;
    } catch { return ALL_ATTENDEES; }
  });
  const [showManageTeam, setShowManageTeam] = useState(false);
  const [addMemberForm, setAddMemberForm] = useState({ name: '', email: '', department: DEPARTMENTS[0] });

  const saveTeamMembers = (members: Attendee[]) => {
    setTeamMembers(members);
    localStorage.setItem('teamMembers', JSON.stringify(members));
  };

  const handleAddMember = () => {
    if (!addMemberForm.name.trim() || !addMemberForm.email.trim()) return;
    const newMember: Attendee = {
      id: Date.now().toString(),
      name: addMemberForm.name.trim(),
      email: addMemberForm.email.trim(),
      department: addMemberForm.department,
    };
    saveTeamMembers([...teamMembers, newMember]);
    setAddMemberForm({ name: '', email: '', department: DEPARTMENTS[0] });
  };

  const handleRemoveMember = (id: string) => {
    saveTeamMembers(teamMembers.filter(m => m.id !== id));
    // Also remove from current meeting selection
    setMeetingData(prev => ({ ...prev, attendees: prev.attendees.filter(a => a.id !== id) }));
  };

  const saveTemplates = (templates: MeetingTemplate[]) => {
    setCustomTemplates(templates);
    localStorage.setItem('meetingTemplates', JSON.stringify(templates));
  };

  const handleSaveTemplate = () => {
    if (!templateForm.name.trim()) return;
    if (editingTemplateId) {
      // Update existing
      saveTemplates(customTemplates.map(t => t.id === editingTemplateId ? {
        ...t, name: templateForm.name.trim(), title: templateForm.title.trim(),
        type: templateForm.type, attendeeIds: templateForm.attendeeIds,
      } : t));
    } else {
      // Create new
      const newTemplate: MeetingTemplate = {
        id: Date.now().toString(), name: templateForm.name.trim(),
        title: templateForm.title.trim(), type: templateForm.type,
        attendeeIds: templateForm.attendeeIds,
      };
      saveTemplates([...customTemplates, newTemplate]);
    }
    setTemplateForm({ name: '', title: '', type: '', attendeeIds: [] });
    setEditingTemplateId(null);
    setShowTemplateModal(false);
  };

  const handleDeleteTemplate = (id: string) => {
    saveTemplates(customTemplates.filter(t => t.id !== id));
  };

  const applyTemplate = (template: MeetingTemplate) => {
    const templateAttendees = teamMembers.filter(a => template.attendeeIds.includes(a.id));
    const allSelected = templateAttendees.every(m => meetingData.attendees.some(a => a.id === m.id));
    if (allSelected && templateAttendees.length > 0) {
      const ids = new Set(template.attendeeIds);
      setMeetingData(prev => ({
        ...prev,
        title: prev.title === template.title ? '' : prev.title,
        type: prev.type === template.type ? '' : prev.type,
        attendees: prev.attendees.filter(a => !ids.has(a.id)),
      }));
    } else {
      const currentIds = new Set(meetingData.attendees.map(a => a.id));
      const merged = [...meetingData.attendees, ...templateAttendees.filter(m => !currentIds.has(m.id))];
      setMeetingData(prev => ({
        ...prev,
        title: prev.title || template.title,
        type: prev.type || template.type,
        attendees: merged,
      }));
    }
  };

  // Refs to avoid stale closures in audio callbacks
  const isRecordingRef = useRef(false);
  const isPausedRef = useRef(false);
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const transcriptionContainerRef = useRef<HTMLDivElement>(null);
  const transcriptBufferRef = useRef<string[]>([]);
  const flushTimerRef = useRef<any>(null);
  // Session resumption & reconnection refs
  const resumptionHandleRef = useRef<string | null>(null);
  const isReconnectingRef = useRef(false);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  // Audio pipeline node refs (to prevent duplicate pipelines on reconnect)
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const reconnectCountRef = useRef(0);
  const totalChunksSentRef = useRef(0);
  const lastSpeechTimeRef = useRef<number>(0);

  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);

  // Auth State
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser && currentUser.emailVerified ? currentUser : null);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Auto-redirect on finish
  useEffect(() => {
    if (step === AppStep.FINISHED) {
      const timer = setTimeout(() => {
        handleReset();
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [step]);

  // Recording Timer
  useEffect(() => {
    let interval: any;
    if (isRecording && !isPaused) {
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  // Flush any buffered transcript chunks into state
  const flushTranscriptBuffer = () => {
    if (transcriptBufferRef.current.length > 0) {
      const chunks = [...transcriptBufferRef.current];
      transcriptBufferRef.current = [];
      setMeetingData(prev => ({
        ...prev,
        transcription: [...prev.transcription, ...chunks]
      }));
    }
  };

  // Auto-scroll transcription to bottom when new text arrives
  useEffect(() => {
    if (transcriptionContainerRef.current) {
      transcriptionContainerRef.current.scrollTop = transcriptionContainerRef.current.scrollHeight;
    }
  }, [meetingData.transcription]);

  // Cleanup session and AudioContext
  const cleanupSession = () => {
    console.log(`[Recording][${new Date().toISOString()}] cleanupSession — total chunks sent: ${totalChunksSentRef.current}, reconnects: ${reconnectCountRef.current}`);
    isReconnectingRef.current = false;
    resumptionHandleRef.current = null;
    aiRef.current = null;
    audioStreamRef.current = null;
    // Disconnect audio pipeline nodes
    try {
      scriptProcessorRef.current?.disconnect();
      scriptProcessorRef.current = null;
    } catch (e) { /* ignore */ }
    try {
      audioSourceRef.current?.disconnect();
      audioSourceRef.current = null;
    } catch (e) { /* ignore */ }
    try {
      if (sessionRef.current) {
        sessionRef.current.close?.();
        sessionRef.current = null;
      }
    } catch (e) { console.warn('[Recording] Error closing session:', e); }
    try {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    } catch (e) { console.warn('[Recording] Error closing AudioContext:', e); }
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushTranscriptBuffer();
    // Stop audio visualiser
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevels(new Array(32).fill(0));
    reconnectCountRef.current = 0;
    totalChunksSentRef.current = 0;
  };

  // Animated step transition
  const transitionToStep = (newStep: AppStep) => {
    setStepTransition('exiting');
    setTimeout(() => {
      setStep(newStep);
      setStepTransition('entering');
      setTimeout(() => setStepTransition('idle'), 400);
    }, 250);
  };

  const handleReset = () => {
    cleanupSession();
    transitionToStep(AppStep.HOME);
    setMeetingData({
      title: '',
      type: '',
      attendees: [],
      transcription: []
    });
    setRecordingTime(0);
    setIsRecording(false);
    setIsPaused(false);
    setSaveStatus('idle');
    setConnectionStatus('connected');
    setCopiedField(null);
    summaryTextRef.current = '';
  };

  // Copy text to clipboard with feedback
  const handleCopy = async (text: string, field: 'transcript' | 'summary') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Start audio visualiser
  const startAudioVisualiser = (audioContext: AudioContext, stream: MediaStream) => {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const updateLevels = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      const levels = Array.from(dataArray).map(v => v / 255);
      setAudioLevels(levels);
      animationFrameRef.current = requestAnimationFrame(updateLevels);
    };
    updateLevels();
  };

  const handleToggleAttendee = (attendee: Attendee) => {
    setMeetingData(prev => {
      const exists = prev.attendees.find(a => a.id === attendee.id);
      if (exists) {
        return { ...prev, attendees: prev.attendees.filter(a => a.id !== attendee.id) };
      }
      return { ...prev, attendees: [...prev.attendees, attendee] };
    });
  };

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Connect to Gemini Live API (used by both start and reconnect)
  const connectToGemini = async (ai: GoogleGenAI, stream: MediaStream, inputAudioContext: AudioContext, resumeHandle?: string | null) => {
    const session = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: 'You are a professional meeting transcriber. Transcribe the conversation accurately in UK English. Do not add summaries, only transcription. If you hear silence, background noise, or non-speech sounds, do not output anything. If you are unsure, do not hallucinate.',
        contextWindowCompression: {
          triggerTokens: '100000',
          slidingWindow: { targetTokens: '50000' },
        },
        sessionResumption: {
          ...(resumeHandle ? { handle: resumeHandle } : {}),
        },
      },
      callbacks: {
        onopen: () => {
          console.log(`[Recording][${new Date().toISOString()}] Gemini session OPEN — isReconnect: ${!!resumeHandle}`);
          isReconnectingRef.current = false;
          setConnectionStatus('connected');

          // Only create audio pipeline once — reuse on reconnect
          if (!scriptProcessorRef.current) {
            console.log('[Recording] Creating new audio pipeline');
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
              if (isRecordingRef.current && !isPausedRef.current) {
                const inputData = e.inputBuffer.getChannelData(0);

                // --- VAD (Voice Activity Detection) Logic ---
                // Calculate RMS energy to detect speech vs silence
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                  sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);
                const VAD_THRESHOLD = 0.004;

                if (rms > VAD_THRESHOLD) {
                  lastSpeechTimeRef.current = Date.now();
                }

                // Keep stream active for 1s after speech ends to avoid clipping
                const now = Date.now();
                const isInHangover = (now - lastSpeechTimeRef.current) < 1000;

                if (rms > VAD_THRESHOLD || isInHangover) {
                  const pcmBlob = createBlob(inputData);
                  totalChunksSentRef.current++;
                  if (totalChunksSentRef.current % 100 === 1) {
                    console.log(`[Recording] Audio chunk #${totalChunksSentRef.current} (RMS: ${rms.toFixed(5)})`);
                  }
                  sessionRef.current?.sendRealtimeInput({
                    audio: {
                      data: pcmBlob.data,
                      mimeType: pcmBlob.mimeType
                    }
                  });
                }
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
            scriptProcessorRef.current = scriptProcessor;
            audioSourceRef.current = source;
            console.log('[Recording] Audio pipeline connected');
          } else {
            console.log('[Recording] Reusing existing audio pipeline after reconnect');
          }
        },
        onmessage: async (message: LiveServerMessage) => {
          console.log("[Recording] Gemini message received:", JSON.stringify(message).substring(0, 300));
          // Capture resumption tokens for transparent reconnection
          if ((message as any).sessionResumptionUpdate?.newHandle) {
            resumptionHandleRef.current = (message as any).sessionResumptionUpdate.newHandle;
            console.log("[Recording] Resumption handle updated");
          }
          // Proactive reconnect on GoAway (server warns ~60s before disconnect)
          if ((message as any).goAway) {
            console.log("[Recording] GoAway received — proactively reconnecting");
            reconnectSession();
            return;
          }
          if (message.serverContent?.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            if (text.trim()) {
              // --- Hallucination Filter ---
              // Discard repetitive gibberish patterns common in Gemini Live during silence:
              // 1. Repeating characters/sequences (e.g. "н-н-н-н", "нельнельнель")
              // 2. High density of Cyrillic or non-English characters
              // 3. Excessively long strings without spaces
              const isCyrillic = /[\u0400-\u04FF]/.test(text);
              const isRepetitive = /(.)\1{7,}/.test(text) || /(...)\1{3,}/.test(text);
              const isStrange = text.length > 5 && !text.includes(' ') && !/^[a-zA-Z0-9]+$/.test(text);

              if (isCyrillic || isRepetitive || isStrange) {
                console.warn("[Recording] Filtered hallucination:", text);
                return;
              }

              console.log("[Recording] Transcription:", text.substring(0, 100));
              // Buffer chunks instead of updating state on every message
              transcriptBufferRef.current.push(text);
            }
          }
        },
        onerror: (e: any) => {
          console.error(`[Recording][${new Date().toISOString()}] Gemini Error:`, e?.message || e);
          setConnectionStatus('disconnected');
        },
        onclose: (e: any) => {
          console.log(`[Recording][${new Date().toISOString()}] Gemini session closed — code: ${e?.code}, reason: ${e?.reason || 'none'}, hasHandle: ${!!resumptionHandleRef.current}, chunks: ${totalChunksSentRef.current}`);
          // Auto-reconnect if we were still recording and have a resumption handle
          if (isRecordingRef.current && !isReconnectingRef.current && resumptionHandleRef.current) {
            console.log("[Recording] Unexpected close during recording — auto-reconnecting");
            reconnectSession();
          } else if (isRecordingRef.current) {
            setConnectionStatus('disconnected');
          }
        }
      }
    });
    return session;
  };

  // Reconnect to Gemini Live API using stored resumption handle
  const reconnectSession = async () => {
    if (isReconnectingRef.current) return; // Prevent concurrent reconnect attempts
    isReconnectingRef.current = true;
    reconnectCountRef.current++;
    setConnectionStatus('reconnecting');
    console.log(`[Recording][${new Date().toISOString()}] Reconnecting (#${reconnectCountRef.current}) with handle: ${resumptionHandleRef.current?.substring(0, 20)}...`);

    // Insert a gap marker so users know audio may have been missed
    transcriptBufferRef.current.push(` [connection interrupted — some audio may have been missed] `);

    // Close old session without tearing down audio pipeline
    try { sessionRef.current?.close?.(); } catch (e) { /* ignore */ }
    sessionRef.current = null;

    try {
      const ai = aiRef.current;
      const stream = audioStreamRef.current;
      const ctx = audioContextRef.current;
      if (!ai || !stream || !ctx || ctx.state === 'closed') {
        throw new Error('Missing audio resources for reconnection');
      }
      const newSession = await connectToGemini(ai, stream, ctx, resumptionHandleRef.current);
      sessionRef.current = newSession;
      console.log(`[Recording][${new Date().toISOString()}] Reconnection #${reconnectCountRef.current} successful`);
    } catch (err) {
      console.error(`[Recording][${new Date().toISOString()}] Reconnection failed:`, err);
      isReconnectingRef.current = false;
      setConnectionStatus('disconnected');
    }
  };

  const startRecordingSession = async () => {
    try {
      console.log("[Recording] Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Recording] Microphone access granted, tracks:", stream.getAudioTracks().length);
      setAudioStream(stream);
      audioStreamRef.current = stream;

      // Fetch API key from secure backend
      const token = await user?.getIdToken();
      const keyRes = await fetch('/api/gemini-key', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!keyRes.ok) throw new Error('Failed to fetch API key');
      const { key } = await keyRes.json();

      const ai = new GoogleGenAI({ apiKey: key });
      aiRef.current = ai;
      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = inputAudioContext;
      console.log("[Recording] AudioContext created, sampleRate:", inputAudioContext.sampleRate);

      // Start audio visualiser
      startAudioVisualiser(inputAudioContext, stream);

      // Start a timer to flush buffered transcript chunks every 300ms
      flushTimerRef.current = setInterval(flushTranscriptBuffer, 300);

      console.log("[Recording] Connecting to Gemini Live API...");
      const session = await connectToGemini(ai, stream, inputAudioContext);

      sessionRef.current = session;
      setIsRecording(true);
      setConnectionStatus('connected');
      setShowFinishConfirm(false);
      setStep(AppStep.RECORDING);
      console.log("[Recording] Recording started, session:", typeof session);
    } catch (err: any) {
      console.error("[Recording] Failed to start recording:", err);
      const msg = err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
        ? 'Microphone access is required to record meetings.'
        : `Failed to start recording: ${err?.message || err}`;
      alert(msg);
    }
  };

  const cancelRecording = () => {
    cleanupSession();
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
    }
    setIsRecording(false);
    setAudioStream(null);
    transitionToStep(AppStep.DETAILS);
  };

  const handleFinishClick = () => {
    setShowFinishConfirm(true);
  };

  const finishRecording = async () => {
    setShowFinishConfirm(false);
    // Flush any remaining buffered transcript chunks
    flushTranscriptBuffer();
    cleanupSession();
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
    }
    setIsRecording(false);
    transitionToStep(AppStep.FINISHED);
    setSaveStatus('saving');

    const meetingTitle = meetingData.title || 'Untitled meeting';
    const meetingType = meetingData.type || 'Standard meeting';
    const transcriptionText = meetingData.transcription.length > 0
      ? meetingData.transcription.join('')
      : 'No transcription was captured during this session.';
    const durationMins = Math.floor(recordingTime / 60);
    const durationSecs = recordingTime % 60;
    const durationStr = `${durationMins}m ${durationSecs}s`;
    const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const attendeeNames = meetingData.attendees.map(a => a.name).join(', ');

    // Generate AI summary, insights, and speaker-separated transcript in parallel
    let summaryText = '';
    let insightsText = '';
    let diarizedText = transcriptionText;
    if (meetingData.transcription.length > 0) {
      try {
        const token = await user?.getIdToken();
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        };

        // Run summary, insights, and diarization in parallel
        const [summaryResult, insightsResult, diarizeResult] = await Promise.allSettled([
          fetch('/api/summary', {
            method: 'POST',
            headers,
            body: JSON.stringify({ meetingTitle, meetingType, attendeeNames, transcriptionText })
          }).then(r => r.ok ? r.json() : Promise.reject('Summary request failed')),
          fetch('/api/insights', {
            method: 'POST',
            headers,
            body: JSON.stringify({ meetingTitle, meetingType, attendeeNames, transcriptionText })
          }).then(r => r.ok ? r.json() : Promise.reject('Insights request failed')),
          fetch('/api/diarize', {
            method: 'POST',
            headers,
            body: JSON.stringify({ attendeeNames, transcriptionText })
          }).then(r => r.ok ? r.json() : Promise.reject('Diarize request failed'))
        ]);

        if (summaryResult.status === 'fulfilled') {
          summaryText = summaryResult.value.summary || '';
          summaryTextRef.current = summaryText;
        } else {
          console.error("Error generating summary:", summaryResult.reason);
          summaryText = 'Summary could not be generated for this meeting.';
        }

        if (insightsResult.status === 'fulfilled') {
          insightsText = insightsResult.value.insights || '';
        } else {
          console.error("Error extracting insights:", insightsResult.reason);
        }

        if (diarizeResult.status === 'fulfilled') {
          diarizedText = diarizeResult.value.diarized || transcriptionText;
        } else {
          console.error("Error diarizing transcript:", diarizeResult.reason);
        }
      } catch (err) {
        console.error("Error in post-processing:", err);
        summaryText = 'Summary could not be generated for this meeting.';
      }
    }

    // Helper to convert markdown text to HTML for email
    const markdownToHtml = (text: string) => text
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return `<li style="margin-bottom: 6px;">${trimmed.substring(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`;
        }
        if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
          const heading = trimmed.replace(/^#+\s/, '');
          return `<h4 style="margin: 16px 0 8px 0; color: #121622; font-size: 15px;">${heading}</h4>`;
        }
        if (trimmed === '') return '';
        return `<p style="margin: 4px 0;">${trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
      })
      .join('\n');

    const summaryHtml = markdownToHtml(summaryText);
    const insightsHtml = markdownToHtml(insightsText);

    // Format diarized transcript for email (convert line breaks to HTML)
    const diarizedHtml = diarizedText
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (trimmed === '') return '<br/>';
        // Bold speaker names (lines starting with "Name:")
        const speakerMatch = trimmed.match(/^([A-Za-z\s]+):\s/);
        if (speakerMatch) {
          return `<p style="margin: 4px 0;"><strong style="color: #F36D5B;">${speakerMatch[1]}:</strong> ${trimmed.substring(speakerMatch[0].length)}</p>`;
        }
        return `<p style="margin: 4px 0;">${trimmed}</p>`;
      })
      .join('\n');

    try {
      // Save transcription + summary to Firestore
      await addDoc(collection(db, 'transcriptions'), {
        title: meetingTitle,
        type: meetingType,
        attendees: meetingData.attendees.map(a => ({ id: a.id, name: a.name, email: a.email })),
        transcription: meetingData.transcription,
        diarizedTranscription: diarizedText,
        summary: summaryText,
        insights: insightsText,
        duration: recordingTime,
        createdAt: serverTimestamp(),
        createdBy: user?.uid,
        userEmail: user?.email
      });

      // Queue emails for each selected attendee
      const emailPromises = meetingData.attendees.map(attendee =>
        addDoc(collection(db, 'mail'), {
          to: attendee.email,
          message: {
            subject: `Meeting Transcription: ${meetingTitle} — ${dateStr}`,
            html: `
              <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #121622;">
                <div style="background: #F36D5B; padding: 24px 32px; border-radius: 16px 16px 0 0;">
                  <h1 style="color: white; margin: 0; font-size: 22px;">Innovate Transcriptions</h1>
                </div>
                <div style="background: #ffffff; padding: 32px; border: 1px solid #eee; border-top: none; border-radius: 0 0 16px 16px;">
                  <p style="font-size: 16px; margin-top: 0;">Hi ${attendee.name},</p>
                  <p style="font-size: 16px;">Here is the transcription from your recent meeting:</p>
                  
                  <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
                    <tr><td style="padding: 8px 0; color: #888; width: 120px;">Meeting</td><td style="padding: 8px 0; font-weight: 600;">${meetingTitle}</td></tr>
                    <tr><td style="padding: 8px 0; color: #888;">Type</td><td style="padding: 8px 0;">${meetingType}</td></tr>
                    <tr><td style="padding: 8px 0; color: #888;">Date</td><td style="padding: 8px 0;">${dateStr}</td></tr>
                    <tr><td style="padding: 8px 0; color: #888;">Duration</td><td style="padding: 8px 0;">${durationStr}</td></tr>
                    <tr><td style="padding: 8px 0; color: #888;">Attendees</td><td style="padding: 8px 0;">${attendeeNames}</td></tr>
                  </table>

                  ${insightsText ? `
                  <div style="background: #EEF2FF; border-left: 4px solid #6366F1; border-radius: 0 12px 12px 0; padding: 20px 24px; margin: 24px 0;">
                    <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #6366F1;">🔍 Key Insights</h3>
                    <div style="font-size: 14px; line-height: 1.7; color: #333;">
                      ${insightsHtml}
                    </div>
                  </div>
                  ` : ''}

                  ${summaryText ? `
                  <div style="background: #FFF7ED; border-left: 4px solid #F36D5B; border-radius: 0 12px 12px 0; padding: 20px 24px; margin: 24px 0;">
                    <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #F36D5B;">✨ AI Summary</h3>
                    <div style="font-size: 14px; line-height: 1.7; color: #333;">
                      ${summaryHtml}
                    </div>
                  </div>
                  ` : ''}

                  <h3 style="margin: 24px 0 12px 0; font-size: 16px; color: #888;">Full Transcription</h3>
                  <div style="background: #f8f8f8; border-radius: 12px; padding: 24px; margin: 0 0 24px 0; font-size: 15px; line-height: 1.8; color: #333;">
${diarizedHtml}
                  </div>

                  <p style="font-size: 13px; color: #aaa; margin-bottom: 0;">This email was sent automatically by Innovate Transcriptions v${APP_VERSION}.</p>
                </div>
              </div>
            `
          }
        })
      );
      await Promise.all(emailPromises);

      // --- Debug log email (sent silently to Kevin) ---
      try {
        const transcriptText = meetingData.transcription.join('');
        const gapMarkers = (transcriptText.match(/\[connection interrupted/g) || []).length;
        await addDoc(collection(db, 'mail'), {
          to: 'kevin.cope@innovate-design.co.uk',
          message: {
            subject: `[Debug] Session Log: ${meetingTitle} — ${dateStr}`,
            html: `
              <div style="font-family: monospace; font-size: 13px; color: #333; max-width: 600px; line-height: 1.6;">
                <h3 style="color: #6366F1; margin-bottom: 16px;">🔧 Debug Session Log</h3>
                <table style="border-collapse: collapse; width: 100%;">
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">App Version</td><td style="padding: 4px 0; font-weight: 600;">v${APP_VERSION}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">User</td><td style="padding: 4px 0;">${user?.email || 'unknown'}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Meeting</td><td style="padding: 4px 0;">${meetingTitle}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Type</td><td style="padding: 4px 0;">${meetingType}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Duration</td><td style="padding: 4px 0;">${durationStr}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Attendees</td><td style="padding: 4px 0;">${attendeeNames}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Transcript length</td><td style="padding: 4px 0;">${transcriptText.length.toLocaleString()} chars (${meetingData.transcription.length} chunks)</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Reconnections</td><td style="padding: 4px 0; ${reconnectCountRef.current > 0 ? 'color: #F59E0B; font-weight: 600;' : ''}">${reconnectCountRef.current}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Gap markers</td><td style="padding: 4px 0; ${gapMarkers > 0 ? 'color: #EF4444; font-weight: 600;' : ''}">${gapMarkers}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Connection at finish</td><td style="padding: 4px 0;">${connectionStatus}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Summary generated</td><td style="padding: 4px 0;">${summaryText ? '✅ Yes (' + summaryText.length + ' chars)' : '❌ No'}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Insights generated</td><td style="padding: 4px 0;">${insightsText ? '✅ Yes (' + insightsText.length + ' chars)' : '❌ No'}</td></tr>
                  <tr><td style="padding: 4px 12px 4px 0; color: #888;">Timestamp</td><td style="padding: 4px 0;">${new Date().toISOString()}</td></tr>
                </table>
              </div>
            `
          }
        });
      } catch (debugErr) {
        console.error('[Debug] Failed to send debug log email:', debugErr);
      }

      setSaveStatus('saved');
    } catch (err) {
      console.error("Error saving transcription:", err);
      setSaveStatus('error');
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setStep(AppStep.HOME);
  };

  const renderAttendeeGroup = (dept: string) => (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold uppercase tracking-widest text-gray-400">{dept}</h4>
      <div className="flex flex-wrap gap-2">
        {teamMembers.filter(a => a.department === dept).map(attendee => {
          const isSelected = meetingData.attendees.some(a => a.id === attendee.id);
          return (
            <button
              key={attendee.id}
              onClick={() => handleToggleAttendee(attendee)}
              className={`px-4 py-2 rounded-full border text-sm transition-all flex items-center gap-2 ${isSelected
                ? 'bg-brand border-brand text-white shadow-md shadow-brand/10'
                : 'bg-white border-gray-200 text-gray-600 hover:border-brand/40'
                }`}
            >
              {attendee.name}
              {isSelected && <Square size={12} fill="white" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Recover last session logic
  const [recoverLoading, setRecoverLoading] = useState(false);
  const [showManualRecover, setShowManualRecover] = useState(false);
  const [manualTranscriptText, setManualTranscriptText] = useState('');

  const handleManualRecoverSubmit = () => {
    let finalTranscript: string[] = [];
    try {
      // Try parsing as JSON first (if they pasted the array ["word", "word"])
      const parsed = JSON.parse(manualTranscriptText);
      if (Array.isArray(parsed)) {
        finalTranscript = parsed.map(String);
      } else {
        finalTranscript = [String(parsed)];
      }
    } catch (e) {
      // If not JSON, treat as raw text
      if (manualTranscriptText.trim()) {
        finalTranscript = [manualTranscriptText];
      }
    }

    if (finalTranscript.length === 0) {
      alert("Please paste some transcript text.");
      return;
    }

    // Load into state
    setMeetingData({
      title: 'Recovered Meeting',
      type: 'Standard meeting',
      attendees: [{ id: '1', name: 'Unknown', email: '', department: '' }],
      transcription: finalTranscript
    });
    setRecordingTime(3600); // Default to 1 hour placeholder
    setShowManualRecover(false);
    transitionToStep(AppStep.FINISHED);
  };

  const handleRecover = async () => {
    if (!user) return;
    setRecoverLoading(true);
    try {
      const q = query(
        collection(db, 'transcriptions'),
        orderBy('createdAt', 'desc'),
        limit(1)
      );
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        alert("No previous session found to recover.");
        setRecoverLoading(false);
        return;
      }

      const docSnap = querySnapshot.docs[0];
      const data = docSnap.data();

      // Restore meeting interface with previous data
      setMeetingData({
        title: data.title || '',
        type: data.type || '',
        attendees: data.attendees || [],
        transcription: data.transcription || []
      });

      // Approximate duration from stored seconds
      setRecordingTime(data.duration || 0);

      // Populate summary if it exists
      if (data.summary) {
        summaryTextRef.current = data.summary;
      }

      // Jump to finish screen to allow re-processing
      transitionToStep(AppStep.FINISHED);

    } catch (err: any) {
      console.error("Error recovering session:", err);
      alert("Failed to recover last session: " + err.message);
    } finally {
      setRecoverLoading(false);
    }
  };

  // Auth loading state
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fafafa]">
        <Loader2 className="text-brand animate-spin" size={48} />
      </div>
    );
  }

  // Not logged in
  if (!user) {
    return <Auth onLogin={(u) => setUser(u)} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#fafafa] text-primary">
      {/* Header with user info */}
      <header className="sticky top-0 z-50 bg-white/70 backdrop-blur-xl border-b border-black/5 px-8 h-16 flex items-center justify-end gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/5 rounded-full text-sm">
          <User size={14} className="text-brand" />
          <span className="font-medium">{user.email?.split('@')[0]}</span>
        </div>
        <button
          onClick={handleLogout}
          className="p-2 hover:bg-black/5 rounded-full transition-colors text-gray-400 hover:text-red-500"
          title="Logout"
        >
          <LogOut size={18} />
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center">
        {step === AppStep.HOME && (
          <div className={`flex-1 flex flex-col items-center justify-center transition-all duration-300 ${stepTransition === 'exiting' ? 'opacity-0 scale-95' : stepTransition === 'entering' ? 'opacity-0 scale-95 animate-[fadeScaleIn_0.4s_ease-out_forwards]' : 'opacity-100'}`}>
            <button
              onClick={() => transitionToStep(AppStep.DETAILS)}
              className="bg-brand hover:bg-brand-dark text-white px-12 py-7 rounded-2xl text-2xl font-medium transition-all transform hover:scale-[1.03] flex items-center gap-4 shadow-2xl shadow-brand/20 border-none"
            >
              <PlusIcon size={32} />
              Start New Meeting
            </button>
            <p className="mt-6 text-xs text-gray-400 select-none">v{APP_VERSION}</p>
          </div>
        )}

        {
          step === AppStep.DETAILS && (
            <div className={`pb-32 py-16 max-w-[1000px] w-full px-8 space-y-12 transition-all duration-300 ${stepTransition === 'exiting' ? 'opacity-0 translate-y-4' : stepTransition === 'entering' ? 'opacity-0 translate-y-4 animate-[slideUp_0.4s_ease-out_forwards]' : 'opacity-100'}`}>
              <div className="space-y-4">
                <h2 className="text-4xl font-medium tracking-tight">Meeting details</h2>
                <p className="text-gray-500 text-lg">Provide the context and select the attendees for this session.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-600">Meeting title (optional)</label>
                  <input
                    type="text"
                    value={meetingData.title}
                    onChange={(e) => setMeetingData({ ...meetingData, title: e.target.value })}
                    placeholder="e.g. Design Strategy Workshop"
                    className="w-full px-5 py-4 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all text-lg bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-600">Meeting type (optional)</label>
                  <select
                    value={meetingData.type}
                    onChange={(e) => setMeetingData({ ...meetingData, type: e.target.value })}
                    className="w-full px-5 py-4 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all text-lg appearance-none bg-white"
                  >
                    <option value="">Select type...</option>
                    {MEETING_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Meeting Presets */}
              <div className="flex flex-wrap gap-3">

                {/* Custom templates */}
                {customTemplates.map(tmpl => {
                  const tmplAttendees = teamMembers.filter(a => tmpl.attendeeIds.includes(a.id));
                  const allSelected = tmplAttendees.length > 0 && tmplAttendees.every(m => meetingData.attendees.some(a => a.id === m.id));
                  return (
                    <div key={tmpl.id} className="relative group">
                      <button
                        onClick={() => applyTemplate(tmpl)}
                        className={`flex items-center gap-2 px-5 py-2.5 rounded-xl border text-sm font-medium transition-colors ${allSelected ? 'bg-brand border-brand text-white' : 'border-brand/20 bg-brand/5 text-brand hover:bg-brand/10'}`}
                      >
                        <Zap size={14} />
                        {tmpl.name}
                      </button>
                      <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingTemplateId(tmpl.id); setTemplateForm({ name: tmpl.name, title: tmpl.title, type: tmpl.type, attendeeIds: tmpl.attendeeIds }); setShowTemplateModal(true); }}
                          className="w-5 h-5 bg-blue-500 text-white rounded-full flex items-center justify-center shadow-sm"
                          title="Edit template"
                        >
                          <Pencil size={9} />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Add template button */}
                <button
                  onClick={() => { setEditingTemplateId(null); setTemplateForm({ name: '', title: '', type: '', attendeeIds: [] }); setShowTemplateModal(true); }}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-300 text-sm font-medium text-gray-400 hover:border-brand/40 hover:text-brand transition-colors"
                >
                  <Plus size={14} />
                  Create template
                </button>
              </div>

              {/* Template Creation Modal */}
              {showTemplateModal && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowTemplateModal(false)}>
                  <div className="bg-white rounded-3xl shadow-2xl max-w-[600px] w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                    <div className="p-8 space-y-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-2xl font-medium">{editingTemplateId ? 'Edit template' : 'Create template'}</h3>
                        <button onClick={() => { setShowTemplateModal(false); setEditingTemplateId(null); }} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                          <X size={20} />
                        </button>
                      </div>

                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-sm font-medium text-gray-600">Template name *</label>
                          <input
                            type="text"
                            value={templateForm.name}
                            onChange={e => setTemplateForm(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="e.g. Weekly Standup"
                            className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all bg-white"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-gray-600">Meeting title</label>
                            <input
                              type="text"
                              value={templateForm.title}
                              onChange={e => setTemplateForm(prev => ({ ...prev, title: e.target.value }))}
                              placeholder="Auto-fill title"
                              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-gray-600">Meeting type</label>
                            <select
                              value={templateForm.type}
                              onChange={e => setTemplateForm(prev => ({ ...prev, type: e.target.value }))}
                              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all appearance-none bg-white"
                            >
                              <option value="">Select type...</option>
                              {MEETING_TYPES.map(type => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <label className="text-sm font-medium text-gray-600">Attendees</label>
                            <span className="text-xs text-gray-400">{templateForm.attendeeIds.length} selected</span>
                          </div>
                          <div className="max-h-[280px] overflow-y-auto space-y-4 border border-gray-100 rounded-xl p-4">
                            {DEPARTMENTS.map(dept => {
                              const deptAttendees = teamMembers.filter(a => a.department === dept);
                              return (
                                <div key={dept}>
                                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{dept}</p>
                                  <div className="flex flex-wrap gap-2">
                                    {deptAttendees.map(att => {
                                      const isSelected = templateForm.attendeeIds.includes(att.id);
                                      return (
                                        <button
                                          key={att.id}
                                          onClick={() => setTemplateForm(prev => ({
                                            ...prev,
                                            attendeeIds: isSelected
                                              ? prev.attendeeIds.filter(id => id !== att.id)
                                              : [...prev.attendeeIds, att.id]
                                          }))}
                                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isSelected ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                        >
                                          {att.name}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-between gap-3 pt-2">
                        {editingTemplateId && (
                          <button
                            onClick={() => { handleDeleteTemplate(editingTemplateId); setShowTemplateModal(false); setEditingTemplateId(null); }}
                            className="px-6 py-3 rounded-xl text-red-500 hover:bg-red-50 font-medium transition-colors flex items-center gap-2"
                          >
                            <Trash2 size={16} />
                            Delete
                          </button>
                        )}
                        <div className="flex gap-3 ml-auto">
                          <button
                            onClick={() => { setShowTemplateModal(false); setEditingTemplateId(null); }}
                            className="px-6 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveTemplate}
                            disabled={!templateForm.name.trim()}
                            className="px-6 py-3 rounded-xl bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {editingTemplateId ? 'Update template' : 'Save template'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-10">
                <div className="flex justify-between items-end border-b border-gray-100 pb-4">
                  <h3 className="text-2xl font-medium">Attendees</h3>
                  <span className="text-sm text-gray-400 font-medium">{meetingData.attendees.length} selected</span>
                </div>

                {renderAttendeeGroup("Innovation Coaches")}
                {renderAttendeeGroup("Designer")}
                {renderAttendeeGroup("Business Support")}
                {renderAttendeeGroup("Administrators")}
                {renderAttendeeGroup("Researchers and IP")}
              </div>

              {/* Manage Team Modal */}
              {showManageTeam && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowManageTeam(false)}>
                  <div className="bg-white rounded-3xl shadow-2xl max-w-[650px] w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                    <div className="p-8 space-y-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-2xl font-medium">Manage team</h3>
                        <button onClick={() => setShowManageTeam(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                          <X size={20} />
                        </button>
                      </div>

                      <div className="space-y-4 border-b border-gray-100 pb-6">
                        <h4 className="text-sm font-semibold text-gray-600">Add new member</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <input
                            type="text"
                            value={addMemberForm.name}
                            onChange={e => setAddMemberForm(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="Name"
                            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all"
                          />
                          <input
                            type="email"
                            value={addMemberForm.email}
                            onChange={e => setAddMemberForm(prev => ({ ...prev, email: e.target.value }))}
                            placeholder="Email"
                            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all"
                          />
                        </div>
                        <div className="flex gap-3">
                          <select
                            value={addMemberForm.department}
                            onChange={e => setAddMemberForm(prev => ({ ...prev, department: e.target.value }))}
                            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all appearance-none bg-white"
                          >
                            {DEPARTMENTS.map(dept => (
                              <option key={dept} value={dept}>{dept}</option>
                            ))}
                          </select>
                          <button
                            onClick={handleAddMember}
                            disabled={!addMemberForm.name.trim() || !addMemberForm.email.trim()}
                            className="px-6 py-2.5 rounded-xl bg-brand text-white text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <Plus size={14} />
                            Add
                          </button>
                        </div>
                      </div>

                      <div className="space-y-6">
                        {DEPARTMENTS.map(dept => {
                          const members = teamMembers.filter(m => m.department === dept);
                          return (
                            <div key={dept} className="space-y-2">
                              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{dept} ({members.length})</p>
                              <div className="space-y-1">
                                {members.map(member => (
                                  <div key={member.id} className="flex items-center justify-between group px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors">
                                    <div className="flex-1 min-w-0">
                                      <span className="text-sm font-medium text-gray-700">{member.name}</span>
                                      <span className="text-xs text-gray-400 ml-2 truncate">{member.email}</span>
                                    </div>
                                    <button
                                      onClick={() => handleRemoveMember(member.id)}
                                      className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                      title="Remove member"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                ))}
                                {members.length === 0 && <p className="text-xs text-gray-300 italic px-3 py-2">No members</p>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/80 backdrop-blur-xl border-t border-gray-100 px-8 py-4">
                <div className="max-w-[1000px] mx-auto flex items-center justify-between">
                  <button
                    onClick={() => setMeetingData({ title: '', type: '', attendees: [], transcription: [] })}
                    className="text-gray-400 hover:text-red-500 font-medium px-4 py-2 transition-colors"
                  >
                    Clear selection
                  </button>
                  <button
                    onClick={() => setShowManageTeam(true)}
                    className="text-gray-400 hover:text-brand font-medium px-4 py-2 transition-colors flex items-center gap-2"
                  >
                    <Settings size={16} />
                    Manage attendees
                  </button>
                  <button
                    onClick={startRecordingSession}
                    className="bg-brand hover:bg-brand-dark text-white px-10 py-5 rounded-2xl font-medium flex items-center gap-3 transition-all shadow-xl shadow-brand/10"
                  >
                    <Mic size={22} />
                    Start recording
                  </button>
                </div>
              </div>
            </div>
          )
        }

        {
          step === AppStep.RECORDING && (
            <>
              <div className={`py-16 max-w-[1000px] w-full px-8 space-y-8 transition-all duration-300 ${stepTransition === 'exiting' ? 'opacity-0 scale-95' : stepTransition === 'entering' ? 'opacity-0 scale-[0.95] animate-[fadeScaleIn_0.4s_ease-out_forwards]' : 'opacity-100'}`}>
                <div className="bg-white rounded-[2rem] border border-gray-100 p-12 shadow-sm space-y-12 relative overflow-hidden">
                  <div className={`absolute top-0 left-0 w-full h-1.5 ${isPaused ? 'bg-amber-400' : 'bg-brand animate-pulse'}`}></div>

                  <div className="flex justify-between items-start">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-brand font-medium mb-2 uppercase tracking-widest text-xs">
                        <span className={`w-2.5 h-2.5 rounded-full ${connectionStatus === 'disconnected' ? 'bg-red-700' : connectionStatus === 'reconnecting' ? 'bg-blue-500 animate-pulse' : isPaused ? 'bg-amber-400' : 'bg-red-500 animate-pulse'}`}></span>
                        {connectionStatus === 'reconnecting' ? 'Reconnecting...' : connectionStatus === 'disconnected' ? 'Connection lost' : isPaused ? 'Recording paused' : 'Live recording...'}
                      </div>
                      <h2 className="text-4xl font-medium tracking-tight text-primary">{meetingData.title || 'Untitled meeting'}</h2>
                      <p className="text-gray-400 text-lg">{meetingData.type || 'Standard meeting'}</p>
                    </div>
                    <div className="text-right space-y-2">
                      <div className="text-sm font-medium text-gray-400 flex items-center justify-end gap-2 uppercase tracking-widest">
                        <Calendar size={14} />
                        {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                      <div className="text-sm font-medium text-gray-400 flex items-center justify-end gap-2">
                        <Clock size={14} />
                        {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>

                  {/* Connection warning banner */}
                  {connectionStatus === 'disconnected' && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 animate-[fadeScaleIn_0.3s_ease-out_forwards]">
                      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-red-600 text-lg">⚠</span>
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-red-800">Transcription connection lost</p>
                        <p className="text-sm text-red-700">New speech is no longer being captured. Everything recorded so far has been saved.</p>
                        <p className="text-sm text-red-600 font-medium mt-2">You can click <strong>Finish recording</strong> to save what you have, or try stopping and starting a new recording.</p>
                      </div>
                    </div>
                  )}
                  {connectionStatus === 'reconnecting' && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 animate-[fadeScaleIn_0.3s_ease-out_forwards]">
                      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="animate-spin text-amber-600">⟳</span>
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-amber-800">Reconnecting to transcription service...</p>
                        <p className="text-sm text-amber-700">This usually takes a few seconds. Your existing transcript is safe.</p>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-center py-8">
                    <div className="text-8xl font-light tracking-tighter tabular-nums text-primary">
                      {formatTime(recordingTime)}
                    </div>
                  </div>

                  {/* Audio Visualiser */}
                  <div className="flex items-end justify-center gap-[3px] h-16 px-4">
                    {audioLevels.map((level, i) => (
                      <div
                        key={i}
                        className="rounded-full transition-all duration-75"
                        style={{
                          width: '6px',
                          height: `${Math.max(4, (isPaused ? 0.05 : level) * 64)}px`,
                          backgroundColor: isPaused ? '#d1d5db' : level > 0.6 ? '#F36D5B' : level > 0.3 ? '#fb923c' : '#e5e7eb',
                          opacity: isPaused ? 0.4 : 0.5 + level * 0.5,
                        }}
                      />
                    ))}
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400">Live transcription</h3>
                    <div ref={transcriptionContainerRef} className="bg-gray-50/50 rounded-3xl p-8 h-[350px] overflow-y-auto font-light text-xl leading-relaxed scroll-smooth border border-gray-100">
                      {meetingData.transcription.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-gray-300 italic">
                          Waiting for speech...
                        </div>
                      ) : (
                        <p className="text-primary/80 whitespace-pre-wrap">{meetingData.transcription.join('')}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-6 pt-4">
                    <button
                      onClick={cancelRecording}
                      className="flex items-center gap-2 px-6 py-5 rounded-2xl font-medium transition-all text-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
                    >
                      <XCircle size={22} />
                      Cancel
                    </button>
                    <button
                      onClick={() => setIsPaused(!isPaused)}
                      className={`flex items-center gap-2 px-10 py-5 rounded-2xl font-medium transition-all text-lg ${isPaused
                        ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                      {isPaused ? <Play size={22} /> : <Pause size={22} />}
                      {isPaused ? 'Continue recording' : 'Pause recording'}
                    </button>
                    <button
                      onClick={handleFinishClick}
                      className="bg-brand hover:bg-brand-dark text-white px-10 py-5 rounded-2xl font-medium flex items-center gap-2 shadow-xl shadow-brand/10 text-lg"
                    >
                      <Square size={22} />
                      Finish recording
                    </button>
                  </div>
                </div>

                <div className="bg-brand/5 rounded-3xl p-8 flex items-center gap-5 border border-brand/10">
                  <div className="w-12 h-12 bg-brand/10 rounded-2xl flex items-center justify-center text-brand shrink-0">
                    <UserPlus size={24} />
                  </div>
                  <div className="text-lg text-primary/80">
                    <span className="font-semibold">{meetingData.attendees.length} team members</span> will receive the transcription via email.
                  </div>
                </div>
              </div>

              {/* Finish Confirmation Modal */}
              {showFinishConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
                  <div className="bg-white rounded-3xl p-10 max-w-md w-full mx-4 shadow-2xl space-y-6 animate-[fadeScaleIn_0.3s_ease-out]">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-500 shrink-0">
                        <AlertTriangle size={28} />
                      </div>
                      <div>
                        <h3 className="text-xl font-semibold text-primary">Finish recording?</h3>
                        <p className="text-gray-500 mt-1">This will stop the transcription and send emails to all selected attendees.</p>
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => setShowFinishConfirm(false)}
                        className="flex-1 px-6 py-4 rounded-2xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
                      >
                        <X size={18} />
                        Keep recording
                      </button>
                      <button
                        onClick={finishRecording}
                        className="flex-1 px-6 py-4 rounded-2xl bg-brand text-white font-medium hover:bg-brand-dark transition-colors flex items-center justify-center gap-2 shadow-lg shadow-brand/20"
                      >
                        <Square size={18} />
                        Finish & send
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )
        }

        {
          step === AppStep.FINISHED && (
            <div className={`flex-1 max-w-2xl mx-auto flex flex-col items-center justify-center text-center space-y-10 transition-all duration-300 ${stepTransition === 'exiting' ? 'opacity-0 scale-95' : stepTransition === 'entering' ? 'opacity-0 scale-[0.95] animate-[fadeScaleIn_0.5s_ease-out_forwards]' : 'opacity-100'}`}>
              <div className="w-32 h-32 bg-green-50 text-green-500 rounded-full flex items-center justify-center mb-4">
                {saveStatus === 'saving' ? (
                  <Loader2 className="animate-spin" size={64} />
                ) : (
                  <CheckCircle size={64} />
                )}
              </div>
              <div className="space-y-4">
                <h2 className="text-5xl font-medium tracking-tight">Recording finished</h2>
                <p className="text-2xl text-gray-500 leading-relaxed max-w-lg font-light">
                  {saveStatus === 'saving'
                    ? 'Saving transcription...'
                    : saveStatus === 'error'
                      ? 'There was an error saving. The transcription may not have been stored.'
                      : 'Thank you for recording this meeting, the system will email selected attendees the transcription shortly.'}
                </p>
              </div>

              {/* Copy Buttons */}
              {saveStatus === 'saved' && (
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => handleCopy(meetingData.transcription.join(''), 'transcript')}
                    className={`flex items-center gap-2 px-6 py-3 rounded-xl border text-sm font-medium transition-all ${copiedField === 'transcript' ? 'bg-green-50 border-green-200 text-green-600' : 'bg-white border-gray-200 text-gray-600 hover:border-brand/40 hover:text-brand'}`}
                  >
                    {copiedField === 'transcript' ? <Check size={16} /> : <Copy size={16} />}
                    {copiedField === 'transcript' ? 'Copied!' : 'Copy transcript'}
                  </button>
                  {summaryTextRef.current && (
                    <button
                      onClick={() => handleCopy(summaryTextRef.current, 'summary')}
                      className={`flex items-center gap-2 px-6 py-3 rounded-xl border text-sm font-medium transition-all ${copiedField === 'summary' ? 'bg-green-50 border-green-200 text-green-600' : 'bg-white border-gray-200 text-gray-600 hover:border-brand/40 hover:text-brand'}`}
                    >
                      {copiedField === 'summary' ? <Check size={16} /> : <Copy size={16} />}
                      {copiedField === 'summary' ? 'Copied!' : 'Copy summary'}
                    </button>
                  )}
                </div>
              )}

              <div className="pt-8">
                <button
                  onClick={handleReset}
                  className="bg-brand hover:bg-brand-dark text-white px-12 py-6 rounded-2xl text-xl font-medium transition-all flex items-center gap-3 shadow-2xl shadow-brand/20"
                >
                  Start new meeting
                  <ChevronRight size={24} />
                </button>
              </div>

              <div className="pt-20">
                <p className="text-sm text-gray-300 font-medium">
                  Returning home in <span className="text-brand tabular-nums">10</span> seconds...
                </p>
                <div className="mt-4 w-64 h-1.5 bg-gray-100 rounded-full overflow-hidden mx-auto">
                  <div className="h-full bg-brand animate-[progress_10s_linear]"></div>
                </div>
              </div>
            </div>
          )
        }
      </main >

      <style>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }
        @keyframes fadeScaleIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div >
  );
};

// Simple Icon Components
const PlusIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

export default App;
