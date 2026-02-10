
import React, { useState, useEffect } from 'react';
import { AppStep, MeetingData, Attendee, MEETING_TYPES } from './types';
import { ALL_ATTENDEES, DEPARTMENTS } from './constants';
import { Mic, Pause, Play, Square, CheckCircle, ChevronRight, UserPlus, Clock, Calendar, MessageSquare, LogOut, User, Loader2 } from 'lucide-react';
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
  const [, setSessionPromise] = useState<any>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

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

  const handleReset = () => {
    setStep(AppStep.HOME);
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAudioStream(stream);

      const ai = new GoogleGenAI({ apiKey: "AIzaSyCKw3U6eyMY9-Weoi0wB3BiMb_pIkm8Owk" });
      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

      const promise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'You are a professional meeting transcriber. Transcribe the conversation accurately in UK English. Do not add summaries, only transcription.'
        },
        callbacks: {
          onopen: () => {
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
              if (isRecording && !isPaused) {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                promise.then((session) => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text.trim()) {
                setMeetingData(prev => ({
                  ...prev,
                  transcription: [...prev.transcription, text]
                }));
              }
            }
          },
          onerror: (e) => console.error("Gemini Error:", e),
          onclose: () => console.log("Gemini session closed")
        }
      });

      setSessionPromise(promise);
      setIsRecording(true);
      setStep(AppStep.RECORDING);
    } catch (err) {
      console.error("Failed to start recording:", err);
      alert("Microphone access is required to record meetings.");
    }
  };

  const finishRecording = async () => {
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
    }
    setIsRecording(false);
    setStep(AppStep.FINISHED);
    setSaveStatus('saving');

    const meetingTitle = meetingData.title || 'Untitled meeting';
    const meetingType = meetingData.type || 'Standard meeting';
    const transcriptionText = meetingData.transcription.length > 0
      ? meetingData.transcription.join('\n\n')
      : 'No transcription was captured during this session.';
    const durationMins = Math.floor(recordingTime / 60);
    const durationSecs = recordingTime % 60;
    const durationStr = `${durationMins}m ${durationSecs}s`;
    const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const attendeeNames = meetingData.attendees.map(a => a.name).join(', ');

    try {
      // Save transcription to Firestore
      await addDoc(collection(db, 'transcriptions'), {
        title: meetingTitle,
        type: meetingType,
        attendees: meetingData.attendees.map(a => ({ id: a.id, name: a.name, email: a.email })),
        transcription: meetingData.transcription,
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

                  <div style="background: #f8f8f8; border-radius: 12px; padding: 24px; margin: 24px 0; white-space: pre-wrap; font-size: 15px; line-height: 1.8; color: #333;">
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
          <div className="flex-1 flex flex-col items-center justify-center animate-in fade-in duration-1000">
            <button
              onClick={() => setStep(AppStep.DETAILS)}
              className="bg-brand hover:bg-brand-dark text-white px-12 py-7 rounded-2xl text-2xl font-medium transition-all transform hover:scale-[1.03] flex items-center gap-4 shadow-2xl shadow-brand/20 border-none"
            >
              <PlusIcon size={32} />
              Start new meeting
            </button>
          </div>
        )}

        {step === AppStep.DETAILS && (
          <div className="py-16 max-w-[1000px] w-full px-8 space-y-12 animate-in slide-in-from-bottom-4 duration-500">
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

            <div className="pt-10 flex items-center justify-between border-t border-gray-100">
              <button
                onClick={() => setStep(AppStep.HOME)}
                className="text-gray-400 hover:text-gray-600 font-medium px-4 py-2 transition-colors"
              >
                Back to start
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
        )}

        {step === AppStep.RECORDING && (
          <div className="py-16 max-w-[1000px] w-full px-8 space-y-8 animate-in zoom-in-95 duration-500">
            <div className="bg-white rounded-[2rem] border border-gray-100 p-12 shadow-sm space-y-12 relative overflow-hidden">
              <div className={`absolute top-0 left-0 w-full h-1.5 ${isPaused ? 'bg-amber-400' : 'bg-brand animate-pulse'}`}></div>

              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-brand font-medium mb-2 uppercase tracking-widest text-xs">
                    <span className={`w-2.5 h-2.5 rounded-full ${isPaused ? 'bg-amber-400' : 'bg-red-500 animate-pulse'}`}></span>
                    {isPaused ? 'Recording paused' : 'Live recording...'}
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

              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400">Live transcription</h3>
                <div className="bg-gray-50/50 rounded-3xl p-8 h-[350px] overflow-y-auto space-y-6 font-light text-xl leading-relaxed scroll-smooth border border-gray-100">
                  {meetingData.transcription.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-gray-300 italic">
                      Waiting for speech...
                    </div>
                  ) : (
                    meetingData.transcription.map((line, idx) => (
                      <p key={idx} className="animate-in fade-in slide-in-from-left-2 duration-300 text-primary/80">{line}</p>
                    ))
                  )}
                </div>
              </div>

              <div className="flex items-center justify-center gap-6 pt-4">
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
                  onClick={finishRecording}
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
        )}

        {step === AppStep.FINISHED && (
          <div className="flex-1 max-w-2xl mx-auto flex flex-col items-center justify-center text-center space-y-10 animate-in fade-in zoom-in-95 duration-700">
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
        )}
      </main>

      <style>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
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
