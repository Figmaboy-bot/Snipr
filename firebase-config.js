/**
 * Replace placeholders with your Firebase web app config.
 * See firebase-config.example.js for instructions.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBE49LnKgxNVYEq4HO2jRzZzhJSCmBjJus",
  authDomain: "snipr-cc2b5.firebaseapp.com",
  projectId: "snipr-cc2b5",
  storageBucket: "snipr-cc2b5.firebasestorage.app",
  messagingSenderId: "690249490200",
  appId: "1:690249490200:web:89d8e7dde2b0698157086d",
  measurementId: "G-LYH26C3TJP"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Sign in with Google
async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    const result = await auth.signInWithPopup(provider);
    console.log("User signed in:", result.user);
    showView("capture"); // Go to main app after login
  } catch (error) {
    console.error("Sign in error:", error);
    showToast(error.message, "error");
  }
}

// Create account with email/password
async function createAccount(email, password) {
  try {
    const result = await auth.createUserWithEmailAndPassword(email, password);
    console.log("Account created:", result.user);
    showView("capture");
  } catch (error) {
    console.error("Create account error:", error);
    showToast(error.message, "error");
  }
}

// Sign in with email/password
async function signIn(email, password) {
  try {
    const result = await auth.signInWithEmailAndPassword(email, password);
    console.log("User signed in:", result.user);
    showView("capture");
  } catch (error) {
    console.error("Sign in error:", error);
    showToast(error.message, "error");
  }
}

// Sign out
async function signOut() {
  try {
    await auth.signOut();
    showView("auth");
  } catch (error) {
    console.error("Sign out error:", error);
  }
}

// Check auth state
auth.onAuthStateChanged((user) => {
  if (user) {
    console.log("User is logged in:", user.email);
    showView("capture");
  } else {
    console.log("User is logged out");
    showView("auth");
  }
});