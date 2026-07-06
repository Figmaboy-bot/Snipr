const admin = require("firebase-admin");

// Origins allowed to call this endpoint — the Snipr webapp, wherever it's
// hosted. Add your production URL once you deploy it.
const ALLOWED_ORIGINS = [
  "http://localhost:8123",
  "https://snipr-gamma.vercel.app",
];

if (!admin.apps.length) {
  admin.initializeApp({
    // FIREBASE_SERVICE_ACCOUNT is the full JSON key for a Firebase service
    // account (Firebase Console → Project Settings → Service accounts →
    // Generate new private key), set as a Vercel environment variable.
    // Never commit this key to the repo.
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

// Called by the webapp right after a user signs in/up there. Verifies the
// caller's own Firebase ID token and mints a custom token for the same uid,
// which the extension exchanges for its own signed-in session via
// signInWithCustomToken — the extension never sees a password, and this
// function never sees the extension's storage.
module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return res.status(401).json({ error: "Missing ID token" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const token = await admin.auth().createCustomToken(decoded.uid);
    return res.status(200).json({ token });
  } catch (err) {
    console.error("mint-extension-token failed", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
