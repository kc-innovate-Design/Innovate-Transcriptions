import React, { useState } from 'react';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    User,
    signOut
} from 'firebase/auth';
import { auth } from './firebase';
import { LogIn, UserPlus, KeyRound, Mail, AlertCircle, Loader2, ArrowRight, CheckCircle2 } from 'lucide-react';

interface AuthProps {
    onLogin: (user: User) => void;
}

const ALLOWED_DOMAINS = ['innovate-design.com', 'innovate-design.co.uk', 'logic-lab.ai'];

export function Auth({ onLogin }: AuthProps) {
    const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [verificationSent, setVerificationSent] = useState(false);

    const validateDomain = (email: string) => {
        const domain = email.split('@')[1]?.toLowerCase();
        return ALLOWED_DOMAINS.includes(domain);
    };

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        setLoading(true);

        try {
            if (mode === 'login') {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                if (!userCredential.user.emailVerified) {
                    setVerificationSent(true);
                    throw new Error('Please verify your email address before logging in.');
                }
                onLogin(userCredential.user);
            } else if (mode === 'register') {
                if (!validateDomain(email)) {
                    throw new Error('Please use an Innovate Design or Logic Lab email address (@innovate-design.com, @innovate-design.co.uk, or @logic-lab.ai).');
                }
                if (password !== confirmPassword) {
                    throw new Error('Passwords do not match.');
                }
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                await sendEmailVerification(userCredential.user);
                setVerificationSent(true);
                setMessage('Verification email sent! Please check your inbox.');
            } else if (mode === 'forgot') {
                await sendPasswordResetEmail(auth, email);
                setMessage('Password reset email sent! Please check your inbox.');
                setTimeout(() => setMode('login'), 3000);
            }
        } catch (err: any) {
            console.error('Auth error:', err);
            let msg = err.message;
            if (err.code === 'auth/user-not-found') msg = 'No account found with this email.';
            if (err.code === 'auth/wrong-password') msg = 'Incorrect password.';
            if (err.code === 'auth/email-already-in-use') msg = 'An account already exists with this email.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleResendVerification = async () => {
        if (auth.currentUser) {
            try {
                setLoading(true);
                await sendEmailVerification(auth.currentUser);
                setMessage('Verification email resent!');
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
    };

    if (verificationSent && !auth.currentUser?.emailVerified) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#fafafa] p-6 font-outfit">
                <div className="max-w-md w-full bg-white rounded-[2rem] shadow-xl p-10 space-y-8 text-center animate-in fade-in zoom-in-95 duration-500">
                    <div className="flex justify-center">
                        <div className="w-20 h-20 bg-brand-light/10 rounded-full flex items-center justify-center">
                            <Mail className="text-brand w-10 h-10 animate-bounce" />
                        </div>
                    </div>
                    <div className="space-y-4">
                        <h2 className="text-3xl font-bold text-primary">Verify your email</h2>
                        <p className="text-muted-foreground text-lg leading-relaxed">
                            We've sent a verification link to <span className="font-semibold text-primary">{email}</span>.
                            Please click the link in the email to activate your account.
                        </p>
                    </div>

                    <div className="space-y-4 pt-4">
                        <button
                            onClick={() => window.location.reload()}
                            className="w-full flex items-center justify-center gap-2 bg-brand text-white py-4 px-6 rounded-2xl font-semibold hover:bg-brand-dark transition-all duration-300 shadow-lg shadow-brand/20 active:scale-[0.98]"
                        >
                            <CheckCircle2 size={20} />
                            I've verified my email
                        </button>

                        <div className="flex flex-col gap-3">
                            <button
                                onClick={handleResendVerification}
                                disabled={loading}
                                className="text-brand font-semibold hover:opacity-80 transition-all disabled:opacity-50"
                            >
                                {loading ? 'Sending...' : "Didn't receive it? Resend"}
                            </button>
                            <button
                                onClick={async () => {
                                    await signOut(auth);
                                    setVerificationSent(false);
                                    setMode('login');
                                }}
                                className="text-muted-foreground hover:text-primary transition-all text-sm"
                            >
                                Back to login
                            </button>
                        </div>
                    </div>

                    {message && (
                        <div className="p-4 bg-green-50 border border-green-100 rounded-2xl flex items-center gap-3 text-green-700 animate-in slide-in-from-top-2">
                            <CheckCircle2 size={20} className="shrink-0" />
                            <p className="text-sm font-medium">{message}</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-[#fafafa] p-6 font-outfit">
            <div className="max-w-md w-full bg-white rounded-[2rem] shadow-2xl p-10 space-y-8 animate-in fade-in zoom-in-95 duration-500">
                <div className="text-center space-y-3">
                    <h2 className="text-4xl font-bold tracking-tight text-primary">
                        {mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create account' : 'Reset password'}
                    </h2>
                    <p className="text-muted-foreground text-lg">
                        {mode === 'login' ? 'Login to Innovate Transcriptions' :
                            mode === 'register' ? 'Sign up with your Innovate/Logic email' :
                                'Enter your email to reset your password'}
                    </p>
                </div>

                <form onSubmit={handleAuth} className="space-y-5">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-primary/80 ml-1">Email Address</label>
                        <div className="relative group">
                            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-brand transition-colors" size={20} />
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-[#f8f8f8] border-none rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-brand/20 transition-all text-primary font-medium placeholder:text-muted-foreground/50"
                                placeholder="name@innovate-design.com"
                            />
                        </div>
                    </div>

                    {mode !== 'forgot' && (
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-primary/80 ml-1">Password</label>
                            <div className="relative group">
                                <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-brand transition-colors" size={20} />
                                <input
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full bg-[#f8f8f8] border-none rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-brand/20 transition-all text-primary font-medium placeholder:text-muted-foreground/50"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>
                    )}

                    {mode === 'register' && (
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-primary/80 ml-1">Confirm Password</label>
                            <div className="relative group">
                                <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-brand transition-colors" size={20} />
                                <input
                                    type="password"
                                    required
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className="w-full bg-[#f8f8f8] border-none rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-brand/20 transition-all text-primary font-medium placeholder:text-muted-foreground/50"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 animate-in shake duration-300">
                            <AlertCircle size={20} className="shrink-0" />
                            <p className="text-sm font-medium">{error}</p>
                        </div>
                    )}

                    {message && (
                        <div className="p-4 bg-green-50 border border-green-100 rounded-2xl flex items-center gap-3 text-green-700">
                            <CheckCircle2 size={20} className="shrink-0" />
                            <p className="text-sm font-medium">{message}</p>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-brand text-white py-4 px-6 rounded-2xl font-bold text-lg hover:bg-brand-dark transition-all duration-300 shadow-xl shadow-brand/25 disabled:bg-brand/50 disabled:shadow-none flex items-center justify-center gap-2 mt-4 active:scale-[0.98]"
                    >
                        {loading ? <Loader2 className="animate-spin" size={24} /> : (
                            <>
                                {mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Send Reset Link'}
                                <ArrowRight size={20} />
                            </>
                        )}
                    </button>
                </form>

                <div className="flex flex-col gap-4 text-center pt-2">
                    {mode === 'login' && (
                        <button
                            onClick={() => setMode('forgot')}
                            className="text-muted-foreground hover:text-brand transition-colors text-sm font-medium"
                        >
                            Forgot your password?
                        </button>
                    )}

                    <button
                        onClick={() => {
                            setMode(mode === 'login' ? 'register' : 'login');
                            setError(null);
                            setMessage(null);
                        }}
                        className="text-primary font-semibold hover:opacity-75 transition-all text-sm uppercase tracking-wider"
                    >
                        {mode === 'login' ? "Don't have an account? Sign Up" : "Already have an account? Login"}
                    </button>
                </div>
            </div>
        </div>
    );
}
