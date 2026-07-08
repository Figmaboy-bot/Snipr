# ⬡ DesignVault

A Chrome extension to capture and organize website sections by design type and industry category.

## Features
- **Auto-detects sections** — header, footer, hero, navbar, features, pricing, CTA, testimonials, and more
- **Click to select** — hover sections on the page to see labels, click to select
- **Folders** — organize by section type (Hero, Footer, CTA, etc.)
- **Categories** — tag by industry (Fintech, Web3, SaaS, etc.)
- **Library** — browse, filter, and delete saved sections
- **Export** — download your full vault as JSON

## Installation

1. **Configure Firebase (required for sign-in)**  
   - Create a [Firebase](https://console.firebase.google.com/) project and add a **Web** app.  
   - In **Authentication → Sign-in method**, enable **Email/Password** and **Google**.  
   - Copy your web app config into `firebase-config.js` (see `firebase-config.example.js`).  
   - The extension itself only has **Sign in** / **Sign up** buttons, which open the web app to actually authenticate (email/password or Google) — see **Sign-in flow** below. There's no separate Google OAuth client to configure for the extension.

2. **Build the auth bundle** (after `npm install` or when you change `auth/firebase-auth.js` or `firebase-config.js`):  
   ```bash
   npm install
   npm run build:auth
   ```  
   This produces `auth/firebase-auth.bundle.js`, which the popup loads for Firebase Auth.

3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (toggle top-right)
5. Click **Load unpacked**
6. Select this project folder

## Cloud Sync & Web App

Snips saved from the extension sync to Firestore and show up in the **Snipr web app** (`webapp/`).

1. **Enable Firestore** — in the [Firebase console](https://console.firebase.google.com/) for your project, go to **Build → Firestore Database → Create database** (production mode is fine).
2. **Set security rules** — paste the contents of `firestore.rules` into **Firestore → Rules** and publish. Each user can only read/write their own vault (`users/{uid}/…`); a separate `shares/{id}` collection backs the "Share collection with a link" feature and is publicly readable by design (see below) — re-paste and republish `firestore.rules` whenever it changes, since the console doesn't track the file.
3. **Deploy to Vercel** (one-time; hosts both the web app and the extension sign-in endpoint — no Firebase Blaze plan required):
   - Get a service account key: Firebase Console → Project Settings → **Service accounts** → **Generate new private key** (downloads a JSON file — keep it secret, never commit it).
   - `vercel link` then `vercel deploy --prod` from the repo root (or connect the repo in the Vercel dashboard). `vercel.json` sets `outputDirectory: webapp`, so Vercel serves the web app as static output and auto-detects `api/mint-extension-token.js` as a serverless function — one deployment covers both.
   - In the Vercel project's **Settings → Environment Variables**, add `FIREBASE_SERVICE_ACCOUNT` with the *entire contents* of that JSON key file as the value, then redeploy so it takes effect.
   - In **Settings → Deployment Protection**, make sure "Vercel Authentication" is off — otherwise both the web app and the API are blocked behind a Vercel SSO wall.
   - This project is currently deployed at `https://snipr-gamma.vercel.app`. If you deploy your own copy, update the URL in three places: `MINT_TOKEN_URL` in `webapp/src/app.js`, `ALLOWED_ORIGINS` in `api/mint-extension-token.js`, and `WEBAPP_URL` in `popup.js` (also add it to `externally_connectable.matches` in `manifest.json`).
4. **Build the auth bundle after any `auth/firebase-auth.js` change, and rebuild+redeploy the web app after any `webapp/src/*.js` change**:
   ```bash
   npm run build          # builds auth/firebase-auth.bundle.js, webapp/app.bundle.js and webapp/share.bundle.js
   vercel deploy --prod   # ships the rebuilt bundles and api/
   ```
   For local iteration on the web app without redeploying every time:
   ```bash
   npx serve webapp -l 8123   # or: python3 -m http.server 8123 --directory webapp
   ```
   (`localhost` is authorized for Firebase Auth by default — just remember `MINT_TOKEN_URL`/`WEBAPP_URL` need to point at `localhost:8123` while doing this, and back at the deployed URL when you're done.)

### Sign-in flow

Clicking **Sign in** / **Sign up** in the extension popup opens the web app in a new tab — that's where you actually enter credentials (or use Google). Once you're signed in there, the web app hands a one-time token back to the extension (via `api/mint-extension-token.js` + `chrome.runtime.sendMessage`), so the extension signs itself in automatically — no need to re-enter anything. Just reopen the popup afterward and it'll show "Signed in as …". New snips then sync automatically; use **"Sync all local snips"** in the extension settings to upload everything saved before you signed in.

Notes:
- Screenshots are re-encoded as bounded JPEGs and very large HTML is truncated before upload (Firestore documents are capped at 1 MB). The full-quality copy always stays in the extension's local storage.
- Deleting a snip in either place removes it from the cloud; local copies in the extension are only removed when deleted from the extension.

### Sharing a folder

In the web app, select a folder tab (not "All") and click **🔗 Share** to publish a public, read-only snapshot of everything currently in that folder — the link (`/share.html?id=…`) works for anyone, no sign-in required. It's a snapshot: snips added to the folder afterward won't show up on that link unless you share again, which publishes a new, independent link.

Click **🔗 My Shares** in the header to see every link you've published and **Revoke** any of them — revoking deletes the shared snapshot entirely (not just the listing), so the link stops working immediately for anyone who has it.

## Usage

1. Open the popup and click **Sign in** / **Sign up** — this opens the web app to authenticate (email/password or Google). Session persists across popup opens.
2. Navigate to any website
3. Click the DesignVault icon in your toolbar
3. The extension auto-scans the page and highlights detected sections
4. Hover sections on the page to see their label — click to select
5. Or use the list in the popup to select sections
6. Pick a **folder**, add **categories**, optionally write a **note**
7. Hit **Save to Vault**

## Project Structure

```
design-vault/
├── manifest.json        # Extension config (MV3)
├── firebase-config.js   # Firebase web config (replace placeholders)
├── auth/
│   ├── firebase-auth.js # Auth source (Firebase SDK)
│   └── firebase-auth.bundle.js  # Built by npm run build:auth
├── content.js           # Injected into pages — detects & highlights sections
├── background.js        # Service worker — storage, messaging
├── popup.html           # Extension popup UI
├── popup.js             # Popup interaction logic
├── styles/
│   ├── content.css      # Page overlay styles
│   └── popup.css        # Popup UI styles
├── webapp/              # Snipr web app (browse your synced library)
│   ├── index.html
│   ├── share.html       # Public, read-only view of a shared folder
│   ├── styles.css
│   ├── src/
│   │   ├── app.js             # Library source (bundled by npm run build:webapp)
│   │   ├── share.js           # Share page source
│   │   └── render-helpers.js  # Card/detail rendering shared by app.js and share.js
│   ├── app.bundle.js    # Built bundle loaded by index.html
│   └── share.bundle.js  # Built bundle loaded by share.html
├── firestore.rules      # Firestore security rules (paste into console)
├── api/
│   └── mint-extension-token.js  # Vercel serverless function: webapp → extension sign-in handoff
├── vercel.json          # Vercel config (outputDirectory: webapp)
├── firebase.json        # Firebase CLI config (firestore rules only)
└── icons/               # Extension icons (add your own PNGs)
```

## Adding Icons

You need PNG icons at these sizes:
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

You can use any design tool or generate them online. A simple hexagon works great for the DesignVault brand.

## Next Steps / Roadmap

- [x] Screenshot capture of selected sections
- [x] HTML preview in library cards
- [x] Search across saved sections
- [x] Import from JSON export
- [x] Sync to cloud (Firebase)
- [x] Web app to browse your library
- [x] Share collections with a link
