const admin = require("firebase-admin");
const crypto = require("crypto");

// Origins allowed to call this endpoint — the Snipr webapp, wherever it's
// hosted. Add your production URL once you deploy it.
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

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hashOtp(otp, email) {
  return crypto.createHash("sha256").update(`${otp}:${email}`).digest("hex");
}

async function sendOtpEmail(email, otp) {
  const from = process.env.EMAIL_FROM || "Snipr <onboarding@resend.dev>";
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: `${otp} is your Snipr password reset code`,
      html: `
        <p>Someone (hopefully you) requested a password reset for your Snipr account.</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;">${otp}</p>
        <p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Resend API responded ${resp.status}: ${await resp.text()}`);
  }
}

// Step 1 of the forgot-password flow: looks up the email via Admin SDK (which
// is the only way to check existence without exposing that to Firestore
// rules/clients), and — deliberately, per product decision — tells the caller
// whether an account exists, rather than the enumeration-safe generic message
// used elsewhere. Password-account emails get a one-time 6-digit code stored
// (hashed, short-lived) in a Firestore collection with no client-facing
// security rules — it's only ever read/written by this and verify-password-otp.js
// via the Admin SDK, which bypasses rules entirely.
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
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Enter a valid email" });

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return res.status(200).json({ exists: false });
    }
    console.error("request-password-otp lookup failed", err);
    return res.status(500).json({ error: "Something went wrong — try again" });
  }

  // Google-only accounts have no password yet — still let them through the
  // same OTP flow so they can set one (verify-password-otp.js's updateUser()
  // call adds a password credential regardless of what the account already
  // has). `googleOnly` just lets the frontend tweak the copy accordingly.
  const googleOnly = !userRecord.providerData.some(p => p.providerId === "password");

  const otpRef = db.collection("passwordResetOtps").doc(email);
  const existing = await otpRef.get();
  const now = Date.now();
  if (existing.exists && now - (existing.data().lastSentAt || 0) < RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: "Please wait a moment before requesting another code" });
  }

  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await otpRef.set({
    codeHash: hashOtp(otp, email),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  });

  try {
    await sendOtpEmail(email, otp);
  } catch (err) {
    console.error("sending OTP email failed", err);
    return res.status(500).json({ error: "Couldn't send the email — try again" });
  }

  return res.status(200).json({ exists: true, googleOnly });
};
