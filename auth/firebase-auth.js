import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithCredential,
} from "firebase/auth";
import { firebaseConfig } from "../firebase-config.js";

let app;
let auth;

function isConfigReady() {
  return (
    firebaseConfig &&
    typeof firebaseConfig.apiKey === "string" &&
    firebaseConfig.apiKey.length > 0 &&
    firebaseConfig.apiKey !== "YOUR_API_KEY"
  );
}

export function initFirebase() {
  if (!isConfigReady()) {
    return { ok: false, error: "Missing firebase-config.js (copy from firebase-config.example.js)" };
  }
  if (!app) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    setPersistence(auth, browserLocalPersistence).catch(() => {});
  }
  return { ok: true, auth };
}

export function getFirebaseAuth() {
  return auth;
}

export async function signInEmailPassword(email, password) {
  if (!auth) throw new Error("Auth not initialized");
  return signInWithEmailAndPassword(auth, email, password);
}

export async function signUpEmailPassword(email, password) {
  if (!auth) throw new Error("Auth not initialized");
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function signInWithGoogleChrome() {
  if (!auth) throw new Error("Auth not initialized");
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error("No Google token"));
        return;
      }
      try {
        const credential = GoogleAuthProvider.credential(null, token);
        const result = await signInWithCredential(auth, credential);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function signOutUser() {
  if (!auth) return;
  await signOut(auth);
  try {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token && chrome.identity.removeCachedAuthToken) {
        chrome.identity.removeCachedAuthToken({ token });
      }
    });
  } catch (_e) {
    /* optional */
  }
}

export function subscribeAuth(callback) {
  if (!auth) return () => {};
  return onAuthStateChanged(auth, callback);
}

const SnprFirebaseAuth = {
  initFirebase,
  getFirebaseAuth,
  signInEmailPassword,
  signUpEmailPassword,
  signInWithGoogleChrome,
  signOutUser,
  subscribeAuth,
};

export default SnprFirebaseAuth;
