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

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `design-vault` folder

## Usage

1. Navigate to any website
2. Click the DesignVault icon in your toolbar
3. The extension auto-scans the page and highlights detected sections
4. Hover sections on the page to see their label — click to select
5. Or use the list in the popup to select sections
6. Pick a **folder**, add **categories**, optionally write a **note**
7. Hit **Save to Vault**

## Project Structure

```
design-vault/
├── manifest.json        # Extension config (MV3)
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
