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

// ── Message Handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {

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
