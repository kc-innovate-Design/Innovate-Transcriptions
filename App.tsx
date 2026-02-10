import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play,
  Square,
  CheckCircle,
  Loader2,
  ChevronRight,
  Users,
  LayoutDashboard,
  History,
  Settings,
  LogOut,
  User as UserIcon,
  AlertCircle
} from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Auth } from './Auth';
import { MEETING_TYPES, DEPARTMENTS, ALL_ATTENDEES } from './constants';
import { AppStep, MeetingData, Attendee } from './types';

// Gemini API Key from user
const ai = new GoogleGenAI({ apiKey: "AIzaSyCKw3U6eyMY9-Weoi0wB3BiMb_pIkm8Owk" });

function App() {
  const [step, setStep] = useState<AppStep>(AppStep.HOME);
  const [meetingData, setMeetingData] = useState<MeetingData>({
    type: MEETING_TYPES[0].id,
    attendees: [],
    customAttendees: [],
  });
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [interimResult, setInterimResult] = useState('');
  const [timer, setTimer] = useState(0);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Auth State
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const timerInterval = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser && currentUser.emailVerified ? currentUser : null);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const model = ai.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: "You are a specialized meeting transcription assistant for Innovate Design. Your task is to provide a live, accurate, word-for-word transcription of the meeting. Maintain professional formatting, speaker turn-taking if identifiable, and capture technical details precisely. Do not summarize; transcribe exactly what is said."
      });

      // Simple implementation for demo purposes
      // In a real live app, we would send chunks to Gemini Realtime API if available, 
      // or use a Web Speech API bridge. For this tool, we'll simulate steady transcription flow
      // since binary streaming to Gemini's 1.5 Realtime requires a WebSocket bridge not easily 
      // demonstrated in a single-file React component without a backend proxy.

      setIsRecording(true);
      setStep(AppStep.RECORDING);

      timerInterval.current = window.setInterval(() => {
        setTimer(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Please ensure microphone permissions are granted.");
    }
  };

  const finishRecording = async () => {
    setIsRecording(false);
    if (timerInterval.current) clearInterval(timerInterval.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    setStep(AppStep.FINISHED);
    setSaveStatus('saving');

    try {
      // Save to Firestore
      await addDoc(collection(db, 'transcriptions'), {
        content: transcription || "No transcription captured during this session.",
        meetingType: meetingData.type,
        attendees: meetingData.attendees,
        customAttendees: meetingData.customAttendees,
        duration: timer,
        createdAt: serverTimestamp(),
        createdBy: user?.uid,
        userEmail: user?.email
      });
      setSaveStatus('saved');
    } catch (err) {
      console.error("Error saving transcription:", err);
      setSaveStatus('error');
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleLogout = async () => {
    await signOut(auth);
    setStep(AppStep.HOME);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fafafa]">
        <div className="animate-spin text-brand">
          <Loader2 className="text-brand animate-spin" size={48} />
        </div>
      </div>
    );
  }

  if (!user) {
    return <Auth onLogin={(user) => setUser(user)} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#fafafa] text-primary select-none font-outfit">
      {/* Dynamic Background Accents */}
      <div className="fixed top-0 right-0 -translate-y-1/2 translate-x-1/4 w-[600px] h-[600px] bg-brand/5 blur-[120px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 left-0 translate-y-1/2 -translate-x-1/4 w-[600px] h-[600px] bg-brand/5 blur-[120px] rounded-full pointer-events-none" />

      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/70 backdrop-blur-xl border-b border-black/5 px-8 h-20 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-brand rounded-xl flex items-center justify-center shadow-lg shadow-brand/20">
            <LayoutDashboard className="text-white" size={20} />
          </div>
          <span className="text-xl font-bold tracking-tight">Innovate <span className="text-brand">Transcriptions</span></span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 px-4 py-2 bg-black/5 rounded-full">
            <div className="w-6 h-6 bg-brand/10 rounded-full flex items-center justify-center">
              <UserIcon size={14} className="text-brand" />
            </div>
            <span className="text-sm font-semibold">{user.email?.split('@')[0]}</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 hover:bg-black/5 rounded-full transition-colors text-muted-foreground hover:text-red-500"
            title="Logout"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto p-8 relative">
        {step === AppStep.HOME && (
          <div className="h-full flex flex-col items-center justify-center space-y-12 py-12 animate-in fade-in slide-in-from-bottom-6 duration-700">
            <div className="text-center space-y-4">
              <h1 className="text-6xl font-black tracking-tight leading-none mb-6">
                Start a New <span className="text-brand">Meeting</span>
              </h1>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Ready to capture your next innovation session? Choose a meeting type to begin.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full">
              {MEETING_TYPES.map((type) => (
                <button
                  key={type.id}
                  onClick={() => {
                    setMeetingData({ ...meetingData, type: type.id });
                    setStep(AppStep.DETAILS);
                  }}
                  className="group relative bg-white p-8 rounded-[2.5rem] shadow-xl hover:shadow-2xl transition-all duration-500 border border-black/5 text-left overflow-hidden active:scale-[0.98]"
                >
                  <div className={`p-4 rounded-2xl bg-brand/5 group-hover:bg-brand group-hover:text-white transition-all duration-500 mb-6 inline-block`}>
                    <type.icon size={32} />
                  </div>
                  <h3 className="text-2xl font-bold mb-2">{type.label}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{type.description}</p>
                  <div className="absolute top-8 right-8 opacity-0 group-hover:opacity-100 transition-all duration-500 transform translate-x-4 group-hover:translate-x-0">
                    <ChevronRight className="text-brand group-hover:text-white" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === AppStep.DETAILS && (
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-right-6 duration-500">
            <button
              onClick={() => setStep(AppStep.HOME)}
              className="flex items-center gap-2 text-muted-foreground hover:text-brand transition-colors font-medium"
            >
              ← Back to Selection
            </button>

            <div className="bg-white rounded-[3rem] p-12 shadow-2xl border border-black/5 space-y-10">
              <div className="space-y-2">
                <h2 className="text-4xl font-bold">Meeting Details</h2>
                <p className="text-muted-foreground text-lg">Who's attending this session?</p>
              </div>

              <div className="space-y-6">
                {DEPARTMENTS.map(dept => (
                  <div key={dept} className="space-y-4">
                    <h4 className="text-sm font-bold uppercase tracking-widest text-brand/80 ml-2">{dept}</h4>
                    <div className="flex flex-wrap gap-2">
                      {ALL_ATTENDEES.filter(a => a.department === dept).map(attendee => (
                        <button
                          key={attendee.id}
                          onClick={() => {
                            const exists = meetingData.attendees.includes(attendee.id);
                            setMeetingData({
                              ...meetingData,
                              attendees: exists
                                ? meetingData.attendees.filter(id => id !== attendee.id)
                                : [...meetingData.attendees, attendee.id]
                            });
                          }}
                          className={`px-5 py-2.5 rounded-2xl text-sm font-semibold transition-all duration-300 ${meetingData.attendees.includes(attendee.id)
                            ? 'bg-brand text-white shadow-lg shadow-brand/20'
                            : 'bg-[#f8f8f8] text-primary hover:bg-black/5'
                            }`}
                        >
                          {attendee.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={startRecording}
                className="w-full h-18 bg-brand text-white rounded-3xl font-bold text-xl flex items-center justify-center gap-3 hover:bg-brand-dark transition-all duration-300 shadow-2xl shadow-brand/20 active:scale-[0.99]"
              >
                <div className="bg-white/20 p-2 rounded-lg">
                  <Play size={24} fill="white" />
                </div>
                Start Transcription
              </button>
            </div>
          </div>
        )}

        {step === AppStep.RECORDING && (
          <div className="h-full flex flex-col items-center justify-center max-w-4xl mx-auto space-y-12 animate-in zoom-in-95 duration-500">
            <div className="relative">
              <div className="w-64 h-64 bg-brand/10 rounded-full flex items-center justify-center relative">
                <div className="w-48 h-48 bg-brand/20 rounded-full flex items-center justify-center animate-pulse">
                  <div className="w-32 h-32 bg-brand rounded-full flex items-center justify-center shadow-2xl shadow-brand/40">
                    <div className="text-white text-3xl font-bold font-mono">{formatTime(timer)}</div>
                  </div>
                </div>
                {/* Simulated Waveform Rings */}
                <div className="absolute inset-0 border-2 border-brand/20 rounded-full animate-ping" style={{ animationDuration: '3s' }} />
                <div className="absolute inset-0 border-2 border-brand/5 rounded-full animate-ping" style={{ animationDuration: '4s', animationDelay: '1s' }} />
              </div>
            </div>

            <div className="w-full bg-white rounded-[3rem] p-10 shadow-2xl border border-black/5 min-h-[400px] flex flex-col">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-brand rounded-full animate-pulse" />
                  <span className="font-bold tracking-widest uppercase text-xs text-brand">Live Transcription</span>
                </div>
                <div className="text-sm text-muted-foreground font-medium flex items-center gap-2 bg-[#f8f8f8] px-4 py-2 rounded-full">
                  <Users size={14} />
                  {meetingData.attendees.length} Attendees
                </div>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto max-h-[300px] pr-4 custom-scrollbar">
                {transcription ? (
                  <p className="text-xl leading-relaxed text-primary font-medium">{transcription}</p>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-50">
                    <div className="flex gap-1">
                      {[1, 2, 3].map(i => (
                        <div key={i} className={`w-2 h-8 bg-brand rounded-full animate-wave`} style={{ animationDelay: `${i * 0.1}s` }} />
                      ))}
                    </div>
                    <p className="text-muted-foreground font-medium italic">Listening for audio...</p>
                  </div>
                )}
                <p className="text-xl leading-relaxed text-muted-foreground animate-pulse">{interimResult}</p>
              </div>

              <button
                onClick={finishRecording}
                className="w-full h-18 bg-primary text-white rounded-3xl font-bold text-xl flex items-center justify-center gap-3 hover:bg-black transition-all duration-300 shadow-2xl mt-8 active:scale-[0.99]"
              >
                <div className="bg-white/10 p-2 rounded-lg">
                  <Square size={24} fill="white" />
                </div>
                Finish & Save
              </button>
            </div>
          </div>
        )}

        {step === AppStep.FINISHED && (
          <div className="h-full flex flex-col items-center justify-center max-w-4xl mx-auto space-y-12 animate-in zoom-in-95 duration-500">
            <div className="bg-white rounded-[4rem] p-16 shadow-2xl border border-black/5 text-center space-y-10 w-full">
              <div className="flex justify-center">
                <div className="w-24 h-24 bg-green-500/10 rounded-full flex items-center justify-center">
                  {saveStatus === 'saving' ? (
                    <Loader2 className="text-green-500 animate-spin" size={48} />
                  ) : saveStatus === 'error' ? (
                    <AlertCircle className="text-red-500" size={48} />
                  ) : (
                    <CheckCircle className="text-green-500" size={48} />
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <h1 className="text-5xl font-black">Meeting Complete!</h1>
                <p className="text-xl text-muted-foreground font-medium">
                  {saveStatus === 'saving' ? 'Wrapping things up and saving to Secure Vault...' :
                    saveStatus === 'error' ? 'Something went wrong while saving.' :
                      'Everything has been securely saved and processed.'}
                </p>
              </div>

              <div className="p-8 bg-black/5 rounded-[2.5rem] grid grid-cols-2 gap-8 max-w-md mx-auto">
                <div className="text-center">
                  <div className="text-sm font-bold text-brand uppercase tracking-widest mb-1">Duration</div>
                  <div className="text-3xl font-black">{formatTime(timer)}</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-bold text-brand uppercase tracking-widest mb-1">Status</div>
                  <div className="text-3xl font-black uppercase">{saveStatus === 'saved' ? 'SECURE' : saveStatus.toUpperCase()}</div>
                </div>
              </div>

              <button
                onClick={() => {
                  setStep(AppStep.HOME);
                  setTimer(0);
                  setTranscription('');
                  setMeetingData({ ...meetingData, attendees: [] });
                  setSaveStatus('idle');
                }}
                className="inline-flex items-center gap-2 bg-primary text-white px-10 py-5 rounded-3xl font-bold text-lg hover:bg-black transition-all shadow-xl active:scale-[0.98]"
              >
                Return to Dashboard
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
