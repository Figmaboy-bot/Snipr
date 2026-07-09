const admin = require("firebase-admin");
const crypto = require("crypto");

const ALLOWED_ORIGINS = [
  "http://localhost:8123",
  "https://snipr-gamma.vercel.app",
];

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = admin.firestore();
const MAX_ATTEMPTS = 5;

function hashOtp(otp, email) {
  return crypto.createHash("sha256").update(`${otp}:${email}`).digest("hex");
}

// Step 2: checks the code against the hash stored by request-password-otp.js
// and, if it matches and hasn't expired/been hammered past MAX_ATTEMPTS, sets
// the new password directly via the Admin SDK — no session/reauth needed
// since the OTP itself is the proof of email ownership.
module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const email = String(req.body?.email || "").trim().toLowerCase();
  const otp = String(req.body?.otp || "").trim();
  const newPassword = String(req.body?.newPassword || "");

  if (!email || !otp) return res.status(400).json({ error: "Missing email or code" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const otpRef = db.collection("passwordResetOtps").doc(email);
  const snap = await otpRef.get();
  if (!snap.exists) return res.status(400).json({ error: "Invalid or expired code — request a new one" });

  const data = snap.data();
  if (Date.now() > data.expiresAt) {
    await otpRef.delete();
    return res.status(400).json({ error: "That code expired — request a new one" });
  }
  if (data.attempts >= MAX_ATTEMPTS) {
    await otpRef.delete();
    return res.status(400).json({ error: "Too many incorrect attempts — request a new code" });
  }

  if (hashOtp(otp, email) !== data.codeHash) {
    await otpRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
    return res.status(400).json({ error: "Incorrect code" });
  }

  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });
    await otpRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("verify-password-otp update failed", err);
    return res.status(500).json({ error: "Couldn't reset your password — try again" });
  }
};
