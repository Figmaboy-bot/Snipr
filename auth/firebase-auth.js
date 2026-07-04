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
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { firebaseConfig } from "../firebase-config.js";

let app;
let auth;
let db;

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
    db = getFirestore(app);
    setPersistence(auth, browserLocalPersistence).catch(() => {});
  }
  return { ok: true, auth };
}

export function getCurrentUser() {
  return auth?.currentUser || null;
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

// ── Cloud sync (Firestore) ────────────────────────────────────────────────────
// Saves live at users/{uid}/saves/{saveId}; folders & categories are mirrored
// into users/{uid}/meta/config so the web app can render folder names/icons.

function requireUser() {
  const user = auth?.currentUser;
  if (!user) throw new Error("Not signed in");
  return user;
}

export async function cloudPushSaves(saves) {
  const user = requireUser();
  const batch = writeBatch(db);
  for (const save of saves) {
    const ref = doc(db, "users", user.uid, "saves", save.id);
    batch.set(ref, { ...save, syncedAt: serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  return saves.length;
}

export async function cloudDeleteSave(saveId) {
  const user = requireUser();
  await deleteDoc(doc(db, "users", user.uid, "saves", saveId));
}

export async function cloudSyncMeta(folders, categories) {
  const user = requireUser();
  await setDoc(
    doc(db, "users", user.uid, "meta", "config"),
    { folders, categories, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

const SnprFirebaseAuth = {
  initFirebase,
  getFirebaseAuth,
  getCurrentUser,
  signInEmailPassword,
  signUpEmailPassword,
  signInWithGoogleChrome,
  signOutUser,
  subscribeAuth,
  cloudPushSaves,
  cloudDeleteSave,
  cloudSyncMeta,
};

export default SnprFirebaseAuth;
