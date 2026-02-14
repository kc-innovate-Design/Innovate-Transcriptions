
import React, { useState, useEffect, useRef } from 'react';
import { AppStep, MeetingData, Attendee, MEETING_TYPES } from './types';
import { ALL_ATTENDEES, DEPARTMENTS } from './constants';
import { Mic, Pause, Play, Square, CheckCircle, ChevronRight, UserPlus, Clock, Calendar, MessageSquare, LogOut, User, Loader2, Copy, Check, X, AlertTriangle, XCircle, Zap, Plus, Trash2 } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { onAuthStateChanged, User as FirebaseUser, signOut } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Auth } from './Auth';

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
      const stored = localStorage.getItem('meetingTemplates');
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateForm, setTemplateForm] = useState({ name: '', title: '', type: '', attendeeIds: [] as string[] });

  const saveTemplates = (templates: MeetingTemplate[]) => {
    setCustomTemplates(templates);
    localStorage.setItem('meetingTemplates', JSON.stringify(templates));
  };

  const handleSaveTemplate = () => {
    if (!templateForm.name.trim()) return;
    const newTemplate: MeetingTemplate = {
      id: Date.now().toString(),
      name: templateForm.name.trim(),
      title: templateForm.title.trim(),
      type: templateForm.type,
      attendeeIds: templateForm.attendeeIds,
    };
    saveTemplates([...customTemplates, newTemplate]);
    setTemplateForm({ name: '', title: '', type: '', attendeeIds: [] });
    setShowTemplateModal(false);
  };

  const handleDeleteTemplate = (id: string) => {
    saveTemplates(customTemplates.filter(t => t.id !== id));
  };

  const applyTemplate = (template: MeetingTemplate) => {
    const templateAttendees = ALL_ATTENDEES.filter(a => template.attendeeIds.includes(a.id));
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

  const startRecordingSession = async () => {
    try {
      console.log("[Recording] Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Recording] Microphone access granted, tracks:", stream.getAudioTracks().length);
      setAudioStream(stream);

      // Fetch API key from secure backend
      const token = await user?.getIdToken();
      const keyRes = await fetch('/api/gemini-key', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!keyRes.ok) throw new Error('Failed to fetch API key');
      const { key } = await keyRes.json();

      const ai = new GoogleGenAI({ apiKey: key });
      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = inputAudioContext;
      console.log("[Recording] AudioContext created, sampleRate:", inputAudioContext.sampleRate);

      // Start audio visualiser
      startAudioVisualiser(inputAudioContext, stream);

      // Start a timer to flush buffered transcript chunks every 300ms
      flushTimerRef.current = setInterval(flushTranscriptBuffer, 300);

      console.log("[Recording] Connecting to Gemini Live API...");
      const session = await ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'You are a professional meeting transcriber. Transcribe the conversation accurately in UK English. Do not add summaries, only transcription.'
        },
        callbacks: {
          onopen: () => {
            console.log("[Recording] Gemini session OPEN — setting up audio pipeline");
            setConnectionStatus('connected');
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            let audioChunkCount = 0;

            scriptProcessor.onaudioprocess = (e) => {
              if (isRecordingRef.current && !isPausedRef.current) {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                audioChunkCount++;
                if (audioChunkCount % 50 === 1) {
                  console.log(`[Recording] Sending audio chunk #${audioChunkCount}`);
                }
                session.sendRealtimeInput({
                  audio: {
                    data: pcmBlob.data,
                    mimeType: pcmBlob.mimeType
                  }
                });
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
            console.log("[Recording] Audio pipeline connected");
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("[Recording] Gemini message received:", JSON.stringify(message).substring(0, 300));
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text.trim()) {
                console.log("[Recording] Transcription:", text.substring(0, 100));
                // Buffer chunks instead of updating state on every message
                transcriptBufferRef.current.push(text);
              }
            }
          },
          onerror: (e: any) => {
            console.error("[Recording] Gemini Error:", e?.message || e);
            setConnectionStatus('disconnected');
          },
          onclose: (e: any) => {
            console.log("[Recording] Gemini session closed — code:", e?.code, "reason:", e?.reason || "none");
            // Only show disconnected if we were still recording (unexpected close)
            if (isRecordingRef.current) {
              setConnectionStatus('disconnected');
            }
          }
        }
      });

      sessionRef.current = session;
      setIsRecording(true);
      setConnectionStatus('connected');
      setShowFinishConfirm(false);
      setStep(AppStep.RECORDING);
      console.log("[Recording] Recording started, session:", typeof session);
    } catch (err) {
      console.error("[Recording] Failed to start recording:", err);
      alert("Microphone access is required to record meetings.");
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

    // Generate AI summary via secure backend
    let summaryText = '';
    if (meetingData.transcription.length > 0) {
      try {
        const token = await user?.getIdToken();
        const summaryRes = await fetch('/api/summary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            meetingTitle,
            meetingType,
            attendeeNames,
            transcriptionText
          })
        });
        if (!summaryRes.ok) throw new Error('Summary request failed');
        const data = await summaryRes.json();
        summaryText = data.summary || '';
        summaryTextRef.current = summaryText;
      } catch (err) {
        console.error("Error generating summary:", err);
        summaryText = 'Summary could not be generated for this meeting.';
      }
    }

    // Convert markdown bullet points to HTML for the email
    const summaryHtml = summaryText
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return `<li style="margin-bottom: 6px;">${trimmed.substring(2)}</li>`;
        }
        if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
          const heading = trimmed.replace(/^#+\s/, '');
          return `<h4 style="margin: 16px 0 8px 0; color: #121622; font-size: 15px;">${heading}</h4>`;
        }
        if (trimmed === '') return '';
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
        summary: summaryText,
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

                  ${summaryText ? `
                  <div style="background: #FFF7ED; border-left: 4px solid #F36D5B; border-radius: 0 12px 12px 0; padding: 20px 24px; margin: 24px 0;">
                    <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #F36D5B;">✨ AI Summary</h3>
                    <div style="font-size: 14px; line-height: 1.7; color: #333;">
                      ${summaryHtml}
                    </div>
                  </div>
                  ` : ''}

                  <h3 style="margin: 24px 0 12px 0; font-size: 16px; color: #888;">Full Transcription</h3>
                  <div style="background: #f8f8f8; border-radius: 12px; padding: 24px; margin: 0 0 24px 0; white-space: pre-wrap; font-size: 15px; line-height: 1.8; color: #333;">
${transcriptionText}
                  </div>

                  <p style="font-size: 13px; color: #aaa; margin-bottom: 0;">This email was sent automatically by Innovate Transcriptions.</p>
                </div>
              </div>
            `
          }
        })
      );
      await Promise.all(emailPromises);

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
        {ALL_ATTENDEES.filter(a => a.department === dept).map(attendee => {
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
              Start new meeting
            </button>
          </div>
        )}

        {step === AppStep.DETAILS && (
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
              {(() => {
                const icMembers = ALL_ATTENDEES.filter(a => a.department === 'Innovation Coaches');
                const allIcSelected = icMembers.every(m => meetingData.attendees.some(a => a.id === m.id));
                return (
                  <button
                    onClick={() => {
                      if (allIcSelected) {
                        const icIds = new Set(icMembers.map(m => m.id));
                        setMeetingData(prev => ({ ...prev, title: prev.title === 'IC Team Meeting' ? '' : prev.title, attendees: prev.attendees.filter(a => !icIds.has(a.id)) }));
                      } else {
                        const currentIds = new Set(meetingData.attendees.map(a => a.id));
                        const merged = [...meetingData.attendees, ...icMembers.filter(m => !currentIds.has(m.id))];
                        setMeetingData(prev => ({ ...prev, title: prev.title || 'IC Team Meeting', attendees: merged }));
                      }
                    }}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl border text-sm font-medium transition-colors ${allIcSelected ? 'bg-brand border-brand text-white' : 'border-brand/20 bg-brand/5 text-brand hover:bg-brand/10'}`}
                  >
                    <Zap size={14} />
                    IC Team Meeting
                  </button>
                );
              })()}
              {(() => {
                const designMembers = ALL_ATTENDEES.filter(a => a.department === 'Designer');
                const allDesignSelected = designMembers.every(m => meetingData.attendees.some(a => a.id === m.id));
                return (
                  <button
                    onClick={() => {
                      if (allDesignSelected) {
                        const designIds = new Set(designMembers.map(m => m.id));
                        setMeetingData(prev => ({ ...prev, title: prev.title === 'Designer Team Meeting' ? '' : prev.title, attendees: prev.attendees.filter(a => !designIds.has(a.id)) }));
                      } else {
                        const currentIds = new Set(meetingData.attendees.map(a => a.id));
                        const merged = [...meetingData.attendees, ...designMembers.filter(m => !currentIds.has(m.id))];
                        setMeetingData(prev => ({ ...prev, title: prev.title || 'Designer Team Meeting', attendees: merged }));
                      }
                    }}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl border text-sm font-medium transition-colors ${allDesignSelected ? 'bg-brand border-brand text-white' : 'border-brand/20 bg-brand/5 text-brand hover:bg-brand/10'}`}
                  >
                    <Zap size={14} />
                    Designer Team Meeting
                  </button>
                );
              })()}

              {/* Custom templates */}
              {customTemplates.map(tmpl => {
                const tmplAttendees = ALL_ATTENDEES.filter(a => tmpl.attendeeIds.includes(a.id));
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
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tmpl.id); }}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                      title="Delete template"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}

              {/* Add template button */}
              <button
                onClick={() => { setTemplateForm({ name: '', title: '', type: '', attendeeIds: [] }); setShowTemplateModal(true); }}
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
                      <h3 className="text-2xl font-medium">Create template</h3>
                      <button onClick={() => setShowTemplateModal(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
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
                            const deptAttendees = ALL_ATTENDEES.filter(a => a.department === dept);
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

                    <div className="flex justify-end gap-3 pt-2">
                      <button
                        onClick={() => setShowTemplateModal(false)}
                        className="px-6 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveTemplate}
                        disabled={!templateForm.name.trim()}
                        className="px-6 py-3 rounded-xl bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save template
                      </button>
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                {renderAttendeeGroup("Administrators")}
                {renderAttendeeGroup("Business Support")}
              </div>

              {renderAttendeeGroup("Researchers and IP")}
            </div>

            <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/80 backdrop-blur-xl border-t border-gray-100 px-8 py-4">
              <div className="max-w-[1000px] mx-auto flex items-center justify-between">
                <button
                  onClick={() => setMeetingData({ title: '', type: '', attendees: [], transcription: [] })}
                  className="text-gray-400 hover:text-red-500 font-medium px-4 py-2 transition-colors"
                >
                  Clear selection
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
                        <span className={`w-2.5 h-2.5 rounded-full ${connectionStatus === 'disconnected' ? 'bg-red-700' : isPaused ? 'bg-amber-400' : 'bg-red-500 animate-pulse'}`}></span>
                        {connectionStatus === 'disconnected' ? 'Connection lost — transcription may have stopped' : isPaused ? 'Recording paused' : 'Live recording...'}
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
