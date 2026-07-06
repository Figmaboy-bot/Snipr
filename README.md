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
   - For **Google sign-in from the extension**, create an **OAuth 2.0 Client ID** of type **Chrome extension** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), using your extension’s ID from `chrome://extensions` → Snpr → **Details**.  
   - Put that client ID in `manifest.json` under `oauth2.client_id` (replace `YOUR_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com`).

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
2. **Set security rules** — paste the contents of `firestore.rules` into **Firestore → Rules** and publish. Each user can only read/write their own vault (`users/{uid}/…`).
3. **Deploy the extension sign-in endpoint** (one-time; this is a small [Vercel](https://vercel.com) serverless function — no Firebase Blaze plan required):
   - Get a service account key: Firebase Console → Project Settings → **Service accounts** → **Generate new private key** (downloads a JSON file — keep it secret, never commit it).
   - Deploy this repo to Vercel (`npx vercel` from the repo root, or connect the repo in the Vercel dashboard). Vercel auto-detects `api/mint-extension-token.js` as a serverless function.
   - In the Vercel project's **Settings → Environment Variables**, add `FIREBASE_SERVICE_ACCOUNT` with the *entire contents* of that JSON key file as the value.
   - Note the deployed URL (e.g. `https://your-project.vercel.app`) — you'll need it below.
   - Add that origin to `ALLOWED_ORIGINS` in `api/mint-extension-token.js` if it differs from `localhost:8123`.
4. **Point the web app at your deployed endpoint** — update `MINT_TOKEN_URL` near the top of `webapp/src/app.js` to `https://your-project.vercel.app/api/mint-extension-token`.
5. **Build the web app and auth bundle**:
   ```bash
   npm run build   # builds both auth/firebase-auth.bundle.js and webapp/app.bundle.js
   ```
6. **Run the web app locally**:
   ```bash
   npx serve webapp -l 8123       # or: python3 -m http.server 8123 --directory webapp
   ```
   `localhost` is authorized for Firebase Auth by default. To deploy the webapp itself (Firebase Hosting, Vercel, Netlify…):
   - Serve the `webapp/` folder and add your domain in **Authentication → Settings → Authorized domains**.
   - Update `WEBAPP_URL` in `popup.js` to your production URL.
   - Add your production origin to `externally_connectable.matches` in `manifest.json` (replace `YOUR-WEBAPP-PROD-DOMAIN`) and to `ALLOWED_ORIGINS` in `api/mint-extension-token.js`.

### Sign-in flow

Clicking **Sign in** / **Sign up** in the extension popup opens the web app in a new tab — that's where you actually enter credentials (or use Google). Once you're signed in there, the web app hands a one-time token back to the extension (via `api/mint-extension-token.js` + `chrome.runtime.sendMessage`), so the extension signs itself in automatically — no need to re-enter anything. Just reopen the popup afterward and it'll show "Signed in as …". New snips then sync automatically; use **"Sync all local snips"** in the extension settings to upload everything saved before you signed in.

Notes:
- Screenshots are re-encoded as bounded JPEGs and very large HTML is truncated before upload (Firestore documents are capped at 1 MB). The full-quality copy always stays in the extension's local storage.
- Deleting a snip in either place removes it from the cloud; local copies in the extension are only removed when deleted from the extension.

## Usage

1. Open the popup and click **Sign in** / **Sign up** — this opens the web app to authenticate (or use **Continue with Google** directly in the popup). Session persists across popup opens.
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
│   ├── styles.css
│   ├── src/app.js       # Source (bundled by npm run build:webapp)
│   └── app.bundle.js    # Built bundle loaded by index.html
├── firestore.rules      # Firestore security rules (paste into console)
├── api/
│   └── mint-extension-token.js  # Vercel serverless function: webapp → extension sign-in handoff
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

- [ ] Screenshot capture of selected sections
- [ ] HTML preview in library cards
- [ ] Search across saved sections
- [ ] Import from JSON export
- [x] Sync to cloud (Firebase)
- [x] Web app to browse your library
- [ ] Share collections with a link
