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

## Usage

1. Open the popup and **sign in** with email/password or **Continue with Google** (session persists across popup opens).
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
- [ ] Sync to cloud (Firebase / Supabase)
- [ ] Share collections with a link
