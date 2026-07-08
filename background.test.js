// @vitest-environment node
//
// Loads the real background.js (the extension's service worker) with a
// mocked `chrome`/`importScripts`, so these tests exercise the actual
// shipped message-handling code rather than a reimplementation. Deliberately
// out of scope: CAPTURE_SCREENSHOT (needs OffscreenCanvas/createImageBitmap
// mocking for little marginal value) and the SNIPR_AUTH_TOKEN external
// handoff (needs a mocked Firebase Auth flow) — both are covered by manual
// QA against a real deployment instead.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeChromeMock() {
  const store = {};
  const mock = { store, listener: null, externalListener: null };

  mock.chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: fn => { mock.listener = fn; } },
      onMessageExternal: { addListener: fn => { mock.externalListener = fn; } },
    },
    storage: {
      local: {
        // Mirrors chrome.storage.local's real behavior: get() returns a
        // structured-clone copy, not a live reference — a handler that
        // mutates the result without calling set() shouldn't appear to work.
        get: keys => {
          const keyList = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          const result = {};
          keyList.forEach(k => { if (store[k] !== undefined) result[k] = JSON.parse(JSON.stringify(store[k])); });
          return Promise.resolve(result);
        },
        set: obj => {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          return Promise.resolve();
        },
      },
    },
  };

  return mock;
}

function dispatch(mock, type, extra = {}, sender = {}) {
  return new Promise(resolve => {
    mock.listener({ type, ...extra }, sender, resolve);
  });
}

async function loadBackgroundWith(mock) {
  globalThis.chrome = mock.chrome;
  globalThis.self = globalThis;
  globalThis.importScripts = path => {
    if (path.includes("merge.bundle")) {
      // Real bundle, not a stub — this is the same file the extension ships.
      const code = readFileSync(join(__dirname, path), "utf8");
      (0, eval)(code);
    }
    // auth/firebase-auth.bundle.js needs real browser/Firebase APIs and
    // isn't touched by any handler under test here, so it's a no-op.
  };
  // Bust Node's module cache so each test file gets a fresh top-level
  // execution of background.js against its own chrome mock.
  await import(`${join(__dirname, "background.js")}?t=${Date.now()}-${Math.random()}`);
}

describe("background.js message handlers", () => {
  let mock;

  beforeEach(async () => {
    mock = makeChromeMock();
    await loadBackgroundWith(mock);
  });

  it("SAVE_SECTIONS creates saves with generated ids and persists them", async () => {
    const res = await dispatch(mock, "SAVE_SECTIONS", {
      sections: [{ label: "Hero", html: "<div></div>", url: "https://x.com", title: "X", screenshot: null }],
      folderId: "f-hero",
      categories: ["SaaS"],
      note: "nice gradient",
    });
    expect(res.ok).toBe(true);
    expect(res.saved).toBe(1);
    expect(res.saves[0].id).toMatch(/^save-/);
    expect(res.saves[0].note).toBe("nice gradient");

    const stored = await mock.chrome.storage.local.get("saves");
    expect(stored.saves).toHaveLength(1);
  });

  it("GET_SAVES filters by folderId and category", async () => {
    await dispatch(mock, "SAVE_SECTIONS", {
      sections: [
        { label: "Hero", url: "https://a.com", title: "A" },
        { label: "Footer", url: "https://b.com", title: "B" },
      ],
      folderId: "f-hero",
      categories: ["SaaS"],
    });
    await dispatch(mock, "SAVE_SECTIONS", {
      sections: [{ label: "CTA", url: "https://c.com", title: "C" }],
      folderId: "f-cta",
      categories: ["Fintech"],
    });

    const byFolder = await dispatch(mock, "GET_SAVES", { folderId: "f-cta" });
    expect(byFolder.saves).toHaveLength(1);
    expect(byFolder.saves[0].label).toBe("CTA");

    const byCategory = await dispatch(mock, "GET_SAVES", { category: "SaaS" });
    expect(byCategory.saves).toHaveLength(2);
  });

  it("DELETE_SAVE removes only the matching save", async () => {
    const saved = await dispatch(mock, "SAVE_SECTIONS", {
      sections: [{ label: "Hero", url: "https://a.com" }, { label: "Footer", url: "https://b.com" }],
      folderId: "f-hero",
      categories: [],
    });
    const [keep, remove] = saved.saves;

    const res = await dispatch(mock, "DELETE_SAVE", { saveId: remove.id });
    expect(res.ok).toBe(true);

    const remaining = await dispatch(mock, "GET_SAVES", {});
    expect(remaining.saves.map(s => s.id)).toEqual([keep.id]);
  });

  it("UPDATE_SAVE patches an existing save and rejects missing/invalid input", async () => {
    const saved = await dispatch(mock, "SAVE_SECTIONS", {
      sections: [{ label: "Hero", url: "https://a.com" }],
      folderId: "f-hero",
      categories: [],
    });
    const saveId = saved.saves[0].id;

    const ok = await dispatch(mock, "UPDATE_SAVE", { saveId, patch: { note: "updated" } });
    expect(ok.ok).toBe(true);
    expect(ok.save.note).toBe("updated");

    const missingArgs = await dispatch(mock, "UPDATE_SAVE", { saveId });
    expect(missingArgs.ok).toBe(false);

    const notFound = await dispatch(mock, "UPDATE_SAVE", { saveId: "nope", patch: { note: "x" } });
    expect(notFound.ok).toBe(false);
  });

  it("folder CRUD: create, list, delete", async () => {
    const created = await dispatch(mock, "CREATE_FOLDER", { name: "Testimonials", icon: "💬" });
    expect(created.ok).toBe(true);
    expect(created.folder.id).toMatch(/^f-/);

    const listed = await dispatch(mock, "GET_FOLDERS");
    expect(listed.folders.map(f => f.name)).toContain("Testimonials");

    await dispatch(mock, "DELETE_FOLDER", { folderId: created.folder.id });
    const afterDelete = await dispatch(mock, "GET_FOLDERS");
    expect(afterDelete.folders.map(f => f.id)).not.toContain(created.folder.id);
  });

  it("ADD_CATEGORY is idempotent — adding the same category twice doesn't duplicate it", async () => {
    await dispatch(mock, "ADD_CATEGORY", { category: "Web3" });
    await dispatch(mock, "ADD_CATEGORY", { category: "Web3" });
    const res = await dispatch(mock, "GET_CATEGORIES");
    expect(res.categories.filter(c => c === "Web3")).toHaveLength(1);
  });

  it("EXPORT_ALL returns the full local vault", async () => {
    await dispatch(mock, "SAVE_SECTIONS", { sections: [{ label: "Hero", url: "https://a.com" }], folderId: "f-hero", categories: [] });
    await dispatch(mock, "ADD_CATEGORY", { category: "Web3" });

    const res = await dispatch(mock, "EXPORT_ALL");
    expect(res.data.saves).toHaveLength(1);
    expect(res.data.categories).toContain("Web3");
  });

  it("IMPORT_ALL merges via the real shared/merge.bundle.js and is idempotent", async () => {
    const first = await dispatch(mock, "IMPORT_ALL", {
      data: {
        saves: [{ id: "s1", label: "Hero" }, { id: "s2", label: "Footer" }],
        folders: [{ id: "f1", name: "Imported", icon: "📥" }],
        categories: ["Web3"],
      },
    });
    expect(first.importedSaves).toBe(2);
    expect(first.skippedSaves).toBe(0);

    // Re-importing the exact same payload should add nothing the second time.
    const second = await dispatch(mock, "IMPORT_ALL", {
      data: { saves: [{ id: "s1" }, { id: "s2" }], folders: [{ id: "f1" }], categories: ["Web3"] },
    });
    expect(second.importedSaves).toBe(0);
    expect(second.skippedSaves).toBe(2);

    const saves = await dispatch(mock, "GET_SAVES", {});
    expect(saves.saves).toHaveLength(2);
  });

  it("returns an error for an unknown message type instead of hanging", async () => {
    const res = await dispatch(mock, "NOT_A_REAL_TYPE");
    expect(res.error).toBeTruthy();
  });
});
