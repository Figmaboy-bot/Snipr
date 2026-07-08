// Snipr Web App — browse the library synced from the Chrome extension.
import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  deleteDoc,
  setDoc,
  writeBatch,
  serverTimestamp,
  increment,
} from "firebase/firestore";
import { firebaseConfig } from "../../firebase-config.js";
import {
  hostnameOf,
  escapeHtml,
  cardThumbHtml,
  buildCodeOptions,
  renderDetailAssets,
  wireAssetClicks,
} from "./render-helpers.js";
import { computeImportDelta, chunk } from "../../shared/merge.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Vercel deployment of api/mint-extension-token.js.
const MINT_TOKEN_URL = "https://snipr-gamma.vercel.app/api/mint-extension-token";

// ── Extension sign-in handoff ─────────────────────────────────────────────────
// If this page was opened from the extension's Sign in / Sign up buttons, the
// URL carries the extension's own id. Once the user is authenticated here, we
// mint a custom token via the mint-extension-token endpoint and hand it to
// the extension so it can sign itself in — no password ever leaves this tab.
const extensionId = new URLSearchParams(location.search).get("extid");
let handoffDone = false;

async function handoffToExtension(user) {
  if (!extensionId || handoffDone || !chrome?.runtime?.sendMessage) return;
  handoffDone = true;
  try {
    const idToken = await user.getIdToken();
    const res = await fetch(MINT_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error(`mint-extension-token responded ${res.status}`);
    const { token } = await res.json();
    chrome.runtime.sendMessage(extensionId, { type: "SNIPR_AUTH_TOKEN", token }, () => {
      if (chrome.runtime.lastError) {
        console.error("Snipr: extension handoff failed", chrome.runtime.lastError.message);
        return;
      }
      showToast(`Signed in as ${user.email || user.displayName} — you can return to the Snipr extension now`);
    });
  } catch (err) {
    console.error("Snipr: mint-extension-token failed", err);
    handoffDone = false;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 24;
// Mirrors the cap enforced in firestore.rules — kept in sync there.
const MAX_ACTIVE_SHARES = 50;

const state = {
  user: null,
  saves: [],
  folders: [],
  categories: [],
  folderFilter: null,
  categoryFilter: "",
  searchQuery: "",
  visibleCount: PAGE_SIZE,
  shareCount: 0,
  detailSave: null,
  loaded: false,
};

let unsubSaves = null;
let unsubMeta = null;

const $ = id => document.getElementById(id);

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = "success") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

// ── Auth flow ─────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  state.user = user || null;
  if (user) {
    $("screen-auth").classList.add("hidden");
    $("screen-app").classList.remove("hidden");
    $("user-email").textContent = user.email || user.displayName || "";
    subscribeLibrary(user.uid);
    handoffToExtension(user);
  } else {
    $("screen-app").classList.add("hidden");
    $("screen-auth").classList.remove("hidden");
    teardownLibrary();
  }
});

function showAuthError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password")) return "Wrong email or password.";
  if (code.includes("user-not-found")) return "No account with that email — try Sign up.";
  if (code.includes("email-already-in-use")) return "That email already has an account — try Sign in.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("invalid-email")) return "That doesn't look like a valid email.";
  return err?.message || "Something went wrong.";
}

$("btn-sign-in").addEventListener("click", async () => {
  $("auth-error").classList.add("hidden");
  try {
    await signInWithEmailAndPassword(auth, $("auth-email").value.trim(), $("auth-password").value);
  } catch (err) {
    showAuthError(friendlyAuthError(err));
  }
});

$("btn-sign-up").addEventListener("click", async () => {
  $("auth-error").classList.add("hidden");
  try {
    await createUserWithEmailAndPassword(auth, $("auth-email").value.trim(), $("auth-password").value);
  } catch (err) {
    showAuthError(friendlyAuthError(err));
  }
});

$("auth-password").addEventListener("keydown", e => {
  if (e.key === "Enter") $("btn-sign-in").click();
});

$("btn-google").addEventListener("click", async () => {
  $("auth-error").classList.add("hidden");
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user") showAuthError(friendlyAuthError(err));
  }
});

$("btn-sign-out").addEventListener("click", () => signOut(auth));

// ── Library subscription ──────────────────────────────────────────────────────
function subscribeLibrary(uid) {
  teardownLibrary();
  state.loaded = false;
  $("library-loading").classList.remove("hidden");

  const savesQuery = query(collection(db, "users", uid, "saves"), orderBy("savedAt", "desc"));
  unsubSaves = onSnapshot(savesQuery, snap => {
    state.saves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.loaded = true;
    $("library-loading").classList.add("hidden");
    renderLibrary();
  }, err => {
    console.error("saves subscription failed", err);
    $("library-loading").classList.add("hidden");
    showToast("Couldn't load your library — check Firestore rules", "error");
  });

  unsubMeta = onSnapshot(doc(db, "users", uid, "meta", "config"), snap => {
    const data = snap.data() || {};
    state.folders = data.folders || [];
    state.categories = data.categories || [];
    state.shareCount = data.shareCount || 0;
    renderFolderTabs();
    renderCategoryFilter();
    renderLibrary();
  });
}

function teardownLibrary() {
  if (unsubSaves) { unsubSaves(); unsubSaves = null; }
  if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  closeSharesModal();
  state.saves = [];
  state.folders = [];
  state.categories = [];
  state.folderFilter = null;
  state.categoryFilter = "";
  state.searchQuery = "";
  state.visibleCount = PAGE_SIZE;
  $("search-input").value = "";
  $("btn-clear-search").classList.add("hidden");
  $("btn-share-folder").classList.add("hidden");
  $("library-load-more").classList.add("hidden");
  closeDetail();
}

// ── Filters ───────────────────────────────────────────────────────────────────
function renderFolderTabs() {
  const el = $("folder-tabs");
  el.innerHTML = "";

  const allTab = document.createElement("div");
  allTab.className = "tab" + (!state.folderFilter ? " active" : "");
  allTab.textContent = "All";
  allTab.addEventListener("click", () => { state.folderFilter = null; state.visibleCount = PAGE_SIZE; renderFolderTabs(); renderLibrary(); });
  el.appendChild(allTab);

  state.folders.forEach(f => {
    const tab = document.createElement("div");
    tab.className = "tab" + (state.folderFilter === f.id ? " active" : "");
    tab.textContent = `${f.icon} ${f.name}`;
    tab.addEventListener("click", () => { state.folderFilter = f.id; state.visibleCount = PAGE_SIZE; renderFolderTabs(); renderLibrary(); });
    el.appendChild(tab);
  });

  $("btn-share-folder").classList.toggle("hidden", !state.folderFilter);
}

function renderCategoryFilter() {
  const sel = $("category-filter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>';
  state.categories.forEach(cat => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    opt.selected = cat === current;
    sel.appendChild(opt);
  });
}

$("category-filter").addEventListener("change", e => {
  state.categoryFilter = e.target.value;
  state.visibleCount = PAGE_SIZE;
  renderLibrary();
});

// ── Sharing ───────────────────────────────────────────────────────────────────
// Copies the currently-selected folder into a public shares/{id} doc (+ a
// shares/{id}/saves subcollection) so anyone with the link can view a
// read-only snapshot without signing in. Re-sharing later creates a new,
// independent snapshot — it does not update a previous link.
async function shareFolder() {
  if (!state.folderFilter || !state.user) return;
  const folder = state.folders.find(f => f.id === state.folderFilter);
  const saves = state.saves.filter(s => s.folderId === state.folderFilter);
  if (!saves.length) return showToast("This folder is empty — nothing to share", "error");
  if (saves.length > 500) return showToast("This folder has more than 500 snips — too large to share in one link", "error");
  if (state.shareCount >= MAX_ACTIVE_SHARES) {
    return showToast(`You've reached the ${MAX_ACTIVE_SHARES} shared-link limit — revoke one from My Shares first`, "error");
  }

  const btn = $("btn-share-folder");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sharing…";

  let link;
  try {
    const ownerUid = state.user.uid;
    const shareRef = doc(collection(db, "shares"));

    const metaBatch = writeBatch(db);
    metaBatch.set(shareRef, {
      ownerUid,
      folderId: folder?.id || state.folderFilter,
      folderName: folder?.name || "Snips",
      folderIcon: folder?.icon || "📁",
      count: saves.length,
      createdAt: serverTimestamp(),
    });
    // Kept in the same batch as the share create — the rule reads this
    // doc's pre-batch value, so this only protects future creates, not
    // this one, but that's fine: it's what keeps the counter accurate.
    metaBatch.set(
      doc(db, "users", ownerUid, "meta", "config"),
      { shareCount: increment(1) },
      { merge: true }
    );
    await metaBatch.commit();

    // Chunk into batches of 400 to stay under Firestore's 500-write limit.
    for (const batchSaves of chunk(saves, 400)) {
      const batch = writeBatch(db);
      for (const save of batchSaves) {
        batch.set(doc(db, "shares", shareRef.id, "saves", save.id), { ...save, ownerUid });
      }
      await batch.commit();
    }

    link = `${location.origin}/share.html?id=${shareRef.id}`;
  } catch (err) {
    console.error("share failed", err);
    showToast("Couldn't create share link", "error");
    btn.disabled = false;
    btn.textContent = originalText;
    return;
  }
  btn.disabled = false;
  btn.textContent = originalText;

  // The share itself is already created at this point — clipboard access is
  // best-effort and shouldn't make a successful share look like it failed.
  // navigator.clipboard.writeText throws NotAllowedError if the document
  // loses focus while the Firestore writes above were in flight (e.g. devtools
  // or another tab had focus), which is common enough to need a fallback.
  try {
    await navigator.clipboard.writeText(link);
    showToast(`🔗 Link copied — shares ${saves.length} snip${saves.length !== 1 ? "s" : ""} from ${folder?.name || "this folder"}`);
  } catch (_) {
    window.prompt(`Share created — copy this link (${saves.length} snip${saves.length !== 1 ? "s" : ""}):`, link);
  }
}

$("btn-share-folder").addEventListener("click", shareFolder);

// ── Export / Import ──────────────────────────────────────────────────────────
// Operates on your whole cloud vault (every folder/category/save synced to
// Firestore) — distinct from the Chrome extension's own Export/Import, which
// only covers that one browser's local, possibly-unsynced storage. The two
// produce/accept the same JSON shape, so a file exported from either side can
// be imported into the other.
function exportVault() {
  const saves = state.saves.map(({ syncedAt, ...rest }) => rest);
  const data = { saves, folders: state.folders, categories: state.categories };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `snipr-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

$("btn-export").addEventListener("click", exportVault);

// Firestore documents are capped at 1MB. A file exported from the extension
// can carry full-resolution local screenshots, so re-compress before writing
// to the cloud — mirrors popup.js's compressScreenshotForCloud/prepareSaveForCloud.
async function compressScreenshotForCloud(dataUrl) {
  if (!dataUrl) return null;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
    const maxW = 1200;
    const scale = Math.min(1, maxW / img.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let out = canvas.toDataURL("image/jpeg", 0.8);
    if (out.length > 600_000) out = canvas.toDataURL("image/jpeg", 0.5);
    if (out.length > 600_000) return null;
    return out;
  } catch (_e) {
    return null;
  }
}

async function prepareSaveForImport(save) {
  const MAX_HTML = 250_000;
  const html = save.html && save.html.length > MAX_HTML
    ? save.html.slice(0, MAX_HTML) + "\n<!-- truncated for cloud sync -->"
    : (save.html || "");

  const assets = save.assets
    ? {
        fonts: (save.assets.fonts || []).slice(0, 20),
        colors: (save.assets.colors || []).slice(0, 30),
        images: (save.assets.images || []).slice(0, 24),
        svgs: (save.assets.svgs || []).filter(s => s.length < 20_000).slice(0, 12),
      }
    : null;

  const screenshot = await compressScreenshotForCloud(save.screenshot);
  const cloudSave = { ...save, html, assets, screenshot };
  if (JSON.stringify(cloudSave).length > 950_000) cloudSave.screenshot = null;
  return cloudSave;
}

async function importVaultFromFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_e) {
    return showToast("Not a valid JSON file", "error");
  }
  if (!parsed || !Array.isArray(parsed.saves)) {
    return showToast("Doesn't look like a Snipr export", "error");
  }

  const btn = $("btn-import");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Importing…";

  try {
    const { newSaves, skippedSaves, newFolders, newCategories } = computeImportDelta(state, parsed);

    if (newFolders.length || newCategories.length) {
      await setDoc(
        doc(db, "users", state.user.uid, "meta", "config"),
        { folders: [...state.folders, ...newFolders], categories: [...state.categories, ...newCategories] },
        { merge: true }
      );
    }

    const prepared = [];
    for (const save of newSaves) prepared.push(await prepareSaveForImport(save));

    // Chunk into batches of 400 to stay under Firestore's 500-write limit.
    for (const batchSaves of chunk(prepared, 400)) {
      const batch = writeBatch(db);
      batchSaves.forEach(save =>
        batch.set(doc(db, "users", state.user.uid, "saves", save.id), save, { merge: true })
      );
      await batch.commit();
    }

    const parts = [`Imported ${newSaves.length} snip${newSaves.length !== 1 ? "s" : ""}`];
    if (skippedSaves) parts.push(`${skippedSaves} already in your library`);
    showToast(`✂ ${parts.join(" — ")}`);
  } catch (err) {
    console.error("import failed", err);
    showToast("Import failed", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$("btn-import").addEventListener("click", () => $("import-file-input").click());
$("import-file-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await importVaultFromFile(file);
});

let searchDebounce = null;
$("search-input").addEventListener("input", e => {
  const value = e.target.value;
  $("btn-clear-search").classList.toggle("hidden", !value);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = value.trim().toLowerCase();
    state.visibleCount = PAGE_SIZE;
    renderLibrary();
  }, 150);
});

$("btn-clear-search").addEventListener("click", () => {
  $("search-input").value = "";
  $("btn-clear-search").classList.add("hidden");
  state.searchQuery = "";
  state.visibleCount = PAGE_SIZE;
  renderLibrary();
  $("search-input").focus();
});

// ── Library grid ──────────────────────────────────────────────────────────────
function matchesSearch(save, q) {
  if (!q) return true;
  const haystack = [
    save.label,
    save.pageTitle,
    save.url,
    save.note,
    ...(save.categories || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(q);
}

function filteredSaves() {
  let saves = state.saves;
  if (state.folderFilter) saves = saves.filter(s => s.folderId === state.folderFilter);
  if (state.categoryFilter) saves = saves.filter(s => s.categories?.includes(state.categoryFilter));
  if (state.searchQuery) saves = saves.filter(s => matchesSearch(s, state.searchQuery));
  return saves;
}

function renderLibrary() {
  if (!state.loaded) return;
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.innerHTML = "";

  const saves = filteredSaves();
  empty.classList.toggle("hidden", saves.length > 0);
  if (saves.length === 0) {
    const filtersActive = state.folderFilter || state.categoryFilter || state.searchQuery;
    $("library-empty-text").innerHTML = (filtersActive && state.saves.length > 0)
      ? "No snips match your search or filters."
      : "Nothing here yet.<br/>Save sections with the Snipr extension — signed in with the same account — and they'll appear here.";
  }

  const visible = saves.slice(0, state.visibleCount);
  const remaining = saves.length - visible.length;
  $("btn-load-more").textContent = `Load more (${visible.length} of ${saves.length})`;
  $("library-load-more").classList.toggle("hidden", remaining <= 0);

  visible.forEach(save => {
    const folder = state.folders.find(f => f.id === save.folderId);
    const card = document.createElement("div");
    card.className = "save-card";

    card.innerHTML = `
      ${cardThumbHtml(save)}
      <div class="save-card-body">
        <div class="save-card-header">
          <span class="save-card-title">${folder ? folder.icon + " " : ""}${escapeHtml(save.label)}</span>
          <button class="delete-btn" title="Delete">✕</button>
        </div>
        <div class="save-card-url">
          <a href="${escapeHtml(save.url)}" target="_blank" rel="noopener" title="${escapeHtml(save.pageTitle)}">${escapeHtml(hostnameOf(save.url))}</a>
        </div>
        ${save.categories?.length ? `
          <div class="save-card-chips">
            ${save.categories.map(c => `<span class="mini-chip">${escapeHtml(c)}</span>`).join("")}
          </div>` : ""}
        <div class="save-card-date">${save.savedAt ? new Date(save.savedAt).toLocaleDateString() : ""}</div>
      </div>
    `;

    card.addEventListener("click", e => {
      if (e.target.classList.contains("delete-btn")) return;
      if (e.target.closest("a")) return;
      openDetail(save);
    });

    card.querySelector(".delete-btn").addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${save.label}" from your cloud library?`)) return;
      await deleteSave(save.id);
    });

    grid.appendChild(card);
  });
}

$("btn-load-more").addEventListener("click", () => {
  state.visibleCount += PAGE_SIZE;
  renderLibrary();
});

async function deleteSave(saveId) {
  try {
    await deleteDoc(doc(db, "users", state.user.uid, "saves", saveId));
    showToast("Snip deleted");
  } catch (err) {
    console.error("delete failed", err);
    showToast("Failed to delete", "error");
  }
}

// ── Detail modal ──────────────────────────────────────────────────────────────
let currentCodeOptions = [];

function openDetail(save) {
  state.detailSave = save;
  $("detail-title").textContent = save.label || "Snip";

  // Image tab
  const img = $("detail-screenshot");
  const noShot = $("detail-no-screenshot");
  if (save.screenshot) {
    img.src = save.screenshot;
    img.classList.remove("hidden");
    noShot.classList.add("hidden");
  } else {
    img.src = "";
    img.classList.add("hidden");
    noShot.classList.remove("hidden");
  }

  // Code tab
  currentCodeOptions = buildCodeOptions(save.html);

  const sel = $("code-type-select");
  sel.innerHTML = currentCodeOptions.map((o, i) => `<option value="${o.key}" ${i === 0 ? "selected" : ""}>${o.label}</option>`).join("");
  renderSelectedCode();

  // Details tab
  const folder = state.folders.find(f => f.id === save.folderId);
  $("detail-folder").textContent = folder ? `${folder.icon} ${folder.name}` : "—";
  const urlEl = $("detail-url");
  urlEl.href = save.url || "#";
  urlEl.textContent = save.url || "";
  $("detail-date").textContent = save.savedAt ? new Date(save.savedAt).toLocaleString() : "—";

  const catsRow = $("detail-categories-row");
  if (save.categories?.length) {
    $("detail-categories").innerHTML = save.categories.map(c => `<span class="mini-chip">${escapeHtml(c)}</span>`).join("");
    catsRow.classList.remove("hidden");
  } else {
    catsRow.classList.add("hidden");
  }

  const noteRow = $("detail-note-row");
  if (save.note) {
    $("detail-note").textContent = save.note;
    noteRow.classList.remove("hidden");
  } else {
    noteRow.classList.add("hidden");
  }

  $("detail-assets").innerHTML = renderDetailAssets(save.assets);
  wireAssetClicks($("detail-assets"), showToast);

  switchDetailTab("image");
  $("detail-modal").classList.remove("hidden");
}

function closeDetail() {
  state.detailSave = null;
  $("detail-modal").classList.add("hidden");
}

function renderSelectedCode() {
  const key = $("code-type-select").value;
  const opt = currentCodeOptions.find(o => o.key === key) || currentCodeOptions[0];
  $("detail-current-code").textContent = opt?.value || "";
  $("detail-code-pre").scrollTop = 0;
}

function switchDetailTab(tabName) {
  document.querySelectorAll(".detail-tab").forEach(tab => {
    tab.classList.toggle("active", tab.getAttribute("data-tab") === tabName);
  });
  $("detail-image-tab").classList.toggle("hidden", tabName !== "image");
  $("detail-code-tab").classList.toggle("hidden", tabName !== "code");
  $("detail-info-tab").classList.toggle("hidden", tabName !== "details");
}

document.querySelectorAll(".detail-tab").forEach(tab => {
  tab.addEventListener("click", () => switchDetailTab(tab.getAttribute("data-tab")));
});

$("code-type-select").addEventListener("change", renderSelectedCode);

$("btn-copy-code").addEventListener("click", async () => {
  const key = $("code-type-select").value;
  const opt = currentCodeOptions.find(o => o.key === key);
  try {
    await navigator.clipboard.writeText(opt?.value || "");
    showToast("Code copied");
  } catch (_) {
    showToast("Failed to copy", "error");
  }
});

$("btn-close-detail").addEventListener("click", closeDetail);
$("detail-modal").addEventListener("click", e => {
  if (e.target === $("detail-modal")) closeDetail();
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  closeDetail();
  closeSharesModal();
});

$("btn-delete-detail").addEventListener("click", async () => {
  if (!state.detailSave) return;
  if (!confirm(`Delete "${state.detailSave.label}" from your cloud library?`)) return;
  await deleteSave(state.detailSave.id);
  closeDetail();
});

// ── My Shares modal ──────────────────────────────────────────────────────────
let unsubMyShares = null;

function openSharesModal() {
  if (!state.user) return;
  $("shares-modal").classList.remove("hidden");
  $("shares-list").innerHTML = "";
  $("shares-empty").classList.add("hidden");
  $("shares-loading").classList.remove("hidden");

  const sharesQuery = query(collection(db, "shares"), where("ownerUid", "==", state.user.uid));
  unsubMyShares = onSnapshot(sharesQuery, snap => {
    const shares = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("shares-loading").classList.add("hidden");
    renderShares(shares);

    // Self-heals shareCount drift (e.g. shares that predate this counter,
    // or a batch that partially failed) against the true live count —
    // cheap to check every time this modal opens, keeps the abuse-guard
    // cap accurate without a manual migration.
    if (shares.length !== state.shareCount) {
      setDoc(doc(db, "users", state.user.uid, "meta", "config"), { shareCount: shares.length }, { merge: true }).catch(() => {});
    }
  }, err => {
    console.error("shares subscription failed", err);
    $("shares-loading").classList.add("hidden");
    showToast("Couldn't load your shared links", "error");
  });
}

function closeSharesModal() {
  $("shares-modal").classList.add("hidden");
  if (unsubMyShares) { unsubMyShares(); unsubMyShares = null; }
}

function renderShares(shares) {
  const list = $("shares-list");
  list.innerHTML = "";
  $("shares-empty").classList.toggle("hidden", shares.length > 0);

  shares.forEach(share => {
    const link = `${location.origin}/share.html?id=${share.id}`;
    const row = document.createElement("div");
    row.className = "share-row";
    row.innerHTML = `
      <span class="share-row-icon">${escapeHtml(share.folderIcon || "📁")}</span>
      <div class="share-row-body">
        <div class="share-row-title">${escapeHtml(share.folderName || "Snips")}</div>
        <div class="share-row-meta">${share.count ?? 0} snip${share.count === 1 ? "" : "s"} · Shared ${share.createdAt?.toDate ? share.createdAt.toDate().toLocaleDateString() : "recently"}</div>
        <div class="share-row-link">${escapeHtml(link)}</div>
      </div>
      <div class="share-row-actions">
        <button class="btn-ghost-sm btn-copy-share" title="Copy link">Copy</button>
        <button class="btn-danger-sm btn-revoke-share" title="Revoke this link">Revoke</button>
      </div>
    `;

    row.querySelector(".btn-copy-share").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
        showToast("Link copied");
      } catch (_) {
        showToast("Failed to copy", "error");
      }
    });

    row.querySelector(".btn-revoke-share").addEventListener("click", async () => {
      if (!confirm(`Revoke the share link for "${share.folderName || "this folder"}"? Anyone with the link will lose access.`)) return;
      await revokeShare(share.id);
    });

    list.appendChild(row);
  });
}

async function revokeShare(shareId) {
  try {
    const savesSnap = await getDocs(collection(db, "shares", shareId, "saves"));
    const saveDocs = savesSnap.docs;
    const shareCountRef = doc(db, "users", state.user.uid, "meta", "config");

    // Chunk into batches of 400 to stay under Firestore's 500-write limit.
    const batches = chunk(saveDocs, 400);
    for (let i = 0; i < batches.length; i++) {
      const batch = writeBatch(db);
      batches[i].forEach(d => batch.delete(d.ref));
      if (i === 0) {
        batch.delete(doc(db, "shares", shareId));
        batch.set(shareCountRef, { shareCount: increment(-1) }, { merge: true });
      }
      await batch.commit();
    }
    if (!batches.length) {
      const soloBatch = writeBatch(db);
      soloBatch.delete(doc(db, "shares", shareId));
      soloBatch.set(shareCountRef, { shareCount: increment(-1) }, { merge: true });
      await soloBatch.commit();
    }

    showToast("Link revoked");
  } catch (err) {
    console.error("revoke share failed", err);
    showToast("Couldn't revoke link", "error");
  }
}

$("btn-my-shares").addEventListener("click", openSharesModal);
$("btn-close-shares").addEventListener("click", closeSharesModal);
$("shares-modal").addEventListener("click", e => {
  if (e.target === $("shares-modal")) closeSharesModal();
});

