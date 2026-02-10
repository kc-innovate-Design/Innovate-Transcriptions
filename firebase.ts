import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyCKw3U6eyMY9-Weoi0wB3BiMb_pIkm8Owk",
    authDomain: "innovate-transcriptions.firebaseapp.com",
    projectId: "innovate-transcriptions",
    storageBucket: "innovate-transcriptions.firebasestorage.app",
    messagingSenderId: "652260638468",
    appId: "1:652260638468:web:7f864af089693bc2f57569"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
