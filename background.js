// DesignVault — Background Service Worker

// ── Default Data ──────────────────────────────────────────────────────────────

const DEFAULT_FOLDERS = [
  { id: "f-hero",         name: "Hero",         icon: "🦸" },
  { id: "f-navbar",       name: "Navbar",        icon: "🧭" },
  { id: "f-footer",       name: "Footer",        icon: "🏁" },
  { id: "f-features",     name: "Features",      icon: "✨" },
  { id: "f-pricing",      name: "Pricing",       icon: "💰" },
  { id: "f-testimonials", name: "Testimonials",  icon: "💬" },
  { id: "f-cta",          name: "CTA",           icon: "📣" },
  { id: "f-misc",         name: "Misc",          icon: "📦" },
];

const DEFAULT_CATEGORIES = [
  "Fintech", "Web3", "SaaS", "E-commerce", "Agency",
  "Portfolio", "Healthcare", "Education", "Gaming", "Startup",
];

// ── Init storage on install ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const { folders, categories } = await chrome.storage.local.get(["folders", "categories"]);
  if (!folders) {
    await chrome.storage.local.set({ folders: DEFAULT_FOLDERS });
  }
  if (!categories) {
    await chrome.storage.local.set({ categories: DEFAULT_CATEGORIES });
  }
  if (!(await chrome.storage.local.get("saves")).saves) {
    await chrome.storage.local.set({ saves: [] });
  }
});

// ── Screenshot helper ─────────────────────────────────────────────────────────
// Must run in the background service worker — captureVisibleTab called from the
// popup captures the popup itself, not the page. From the background it always
// captures the active tab's web content.

async function captureAndCrop(tabId, windowId, rect, dpr, viewportWidth, viewportHeight) {
  try {
    // Capture the visible tab — from the service worker this always captures
    // the web page, never the popup. Returns a base64 PNG data URL.
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });

    // Convert base64 data URL to a Blob without fetch() or FileReader
    // (both can be unreliable / unavailable in MV3 service workers)
    const base64 = dataUrl.split(",")[1];
    const binary  = atob(base64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const imgBlob = new Blob([bytes], { type: "image/png" });

    // createImageBitmap works fine in MV3 service workers
    const bitmap = await createImageBitmap(imgBlob);

    // Clamp CSS rect to viewport size
    const vpW  = viewportWidth  || bitmap.width  / dpr;
    const vpH  = viewportHeight || bitmap.height / dpr;
    const cssX = Math.max(0, rect.x);
    const cssY = Math.max(0, rect.y);
    const cssW = Math.min(rect.width,  vpW - cssX);
    const cssH = Math.min(rect.height, vpH - cssY);

    if (cssW <= 0 || cssH <= 0) { bitmap.close(); return null; }

    // Scale CSS coords to physical pixels
    const px = Math.round(cssX * dpr);
    const py = Math.round(cssY * dpr);
    const pw = Math.min(Math.round(cssW * dpr), bitmap.width  - px);
    const ph = Math.min(Math.round(cssH * dpr), bitmap.height - py);

    if (pw <= 0 || ph <= 0) { bitmap.close(); return null; }

    // Crop onto OffscreenCanvas at CSS display size
    const canvas = new OffscreenCanvas(Math.round(pw / dpr), Math.round(ph / dpr));
    const ctx    = canvas.getContext("2d");
    ctx.drawImage(bitmap, px, py, pw, ph, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    // convertToBlob works in service workers; FileReader does NOT
    const outBlob = await canvas.convertToBlob({ type: "image/png" });

    // Convert Blob to base64 data URL using arrayBuffer (works in service workers)
    const arrayBuf = await outBlob.arrayBuffer();
    const outBytes = new Uint8Array(arrayBuf);
    let outBinary  = "";
    for (let i = 0; i < outBytes.length; i++) outBinary += String.fromCharCode(outBytes[i]);
    return "data:image/png;base64," + btoa(outBinary);

  } catch (err) {
    console.warn("DesignVault: background screenshot failed", err);
    return null;
  }
}

// ── Message Handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {

      // ── Screenshot ─────────────────────────────────────────────────────────

      case "CAPTURE_SCREENSHOT": {
        const { tabId, windowId, rect, dpr, viewportWidth, viewportHeight } = message;
        const screenshot = await captureAndCrop(tabId, windowId, rect, dpr, viewportWidth, viewportHeight);
        sendResponse({ screenshot });
        break;
      }

      // ── Saves ──────────────────────────────────────────────────────────────

      case "SAVE_SECTIONS": {
        const { sections, folderId, categories, note } = message;
        const { saves = [] } = await chrome.storage.local.get("saves");

        const newSaves = sections.map(section => ({
          id: `save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          folderId,
          categories,
          note: note || "",
          label: section.label,
          html: section.html,
          url: section.url,
          pageTitle: section.title,
          savedAt: Date.now(),
          screenshot: section.screenshot || null,
        }));

        await chrome.storage.local.set({ saves: [...saves, ...newSaves] });
        sendResponse({ ok: true, saved: newSaves.length });
        break;
      }

      case "GET_SAVES": {
        const { saves = [] } = await chrome.storage.local.get("saves");
        const { folderId, category } = message;
        let filtered = saves;
        if (folderId) filtered = filtered.filter(s => s.folderId === folderId);
        if (category) filtered = filtered.filter(s => s.categories?.includes(category));
        sendResponse({ saves: filtered });
        break;
      }

      case "DELETE_SAVE": {
        const { saves = [] } = await chrome.storage.local.get("saves");
        const updated = saves.filter(s => s.id !== message.saveId);
        await chrome.storage.local.set({ saves: updated });
        sendResponse({ ok: true });
        break;
      }

      // ── Folders ────────────────────────────────────────────────────────────

      case "GET_FOLDERS": {
        const { folders = [] } = await chrome.storage.local.get("folders");
        sendResponse({ folders });
        break;
      }

      case "CREATE_FOLDER": {
        const { folders = [] } = await chrome.storage.local.get("folders");
        const newFolder = {
          id: `f-${Date.now()}`,
          name: message.name,
          icon: message.icon || "📁",
        };
        await chrome.storage.local.set({ folders: [...folders, newFolder] });
        sendResponse({ ok: true, folder: newFolder });
        break;
      }

      case "DELETE_FOLDER": {
        const { folders = [] } = await chrome.storage.local.get("folders");
        await chrome.storage.local.set({ folders: folders.filter(f => f.id !== message.folderId) });
        sendResponse({ ok: true });
        break;
      }

      // ── Categories ─────────────────────────────────────────────────────────

      case "GET_CATEGORIES": {
        const { categories = [] } = await chrome.storage.local.get("categories");
        sendResponse({ categories });
        break;
      }

      case "ADD_CATEGORY": {
        const { categories = [] } = await chrome.storage.local.get("categories");
        if (!categories.includes(message.category)) {
          await chrome.storage.local.set({ categories: [...categories, message.category] });
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Export ─────────────────────────────────────────────────────────────

      case "EXPORT_ALL": {
        const data = await chrome.storage.local.get(["saves", "folders", "categories"]);
        sendResponse({ data });
        break;
      }

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true;
});