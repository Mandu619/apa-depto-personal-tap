import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBOOELFBd07Iy3vF3SUkgZQD6eG5Td5ZaU",
  authDomain: "apa-depto-personal-tap.firebaseapp.com",
  projectId: "apa-depto-personal-tap",
  storageBucket: "apa-depto-personal-tap.firebasestorage.app",
  messagingSenderId: "826908597018",
  appId: "1:826908597018:web:5ac643714839cfe06d6aa3"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
