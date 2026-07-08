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
  orderBy,
  onSnapshot,
  deleteDoc,
  writeBatch,
  serverTimestamp,
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
const state = {
  user: null,
  saves: [],
  folders: [],
  categories: [],
  folderFilter: null,
  categoryFilter: "",
  searchQuery: "",
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
    renderFolderTabs();
    renderCategoryFilter();
    renderLibrary();
  });
}

function teardownLibrary() {
  if (unsubSaves) { unsubSaves(); unsubSaves = null; }
  if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  state.saves = [];
  state.folders = [];
  state.categories = [];
  state.folderFilter = null;
  state.categoryFilter = "";
  state.searchQuery = "";
  $("search-input").value = "";
  $("btn-clear-search").classList.add("hidden");
  $("btn-share-folder").classList.add("hidden");
  closeDetail();
}

// ── Filters ───────────────────────────────────────────────────────────────────
function renderFolderTabs() {
  const el = $("folder-tabs");
  el.innerHTML = "";

  const allTab = document.createElement("div");
  allTab.className = "tab" + (!state.folderFilter ? " active" : "");
  allTab.textContent = "All";
  allTab.addEventListener("click", () => { state.folderFilter = null; renderFolderTabs(); renderLibrary(); });
  el.appendChild(allTab);

  state.folders.forEach(f => {
    const tab = document.createElement("div");
    tab.className = "tab" + (state.folderFilter === f.id ? " active" : "");
    tab.textContent = `${f.icon} ${f.name}`;
    tab.addEventListener("click", () => { state.folderFilter = f.id; renderFolderTabs(); renderLibrary(); });
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

  const btn = $("btn-share-folder");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sharing…";

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
    await metaBatch.commit();

    // Chunk into batches of 400 to stay under Firestore's 500-write limit.
    for (let i = 0; i < saves.length; i += 400) {
      const batch = writeBatch(db);
      for (const save of saves.slice(i, i + 400)) {
        batch.set(doc(db, "shares", shareRef.id, "saves", save.id), { ...save, ownerUid });
      }
      await batch.commit();
    }

    const link = `${location.origin}/share.html?id=${shareRef.id}`;
    await navigator.clipboard.writeText(link);
    showToast(`🔗 Link copied — shares ${saves.length} snip${saves.length !== 1 ? "s" : ""} from ${folder?.name || "this folder"}`);
  } catch (err) {
    console.error("share failed", err);
    showToast("Couldn't create share link", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$("btn-share-folder").addEventListener("click", shareFolder);

let searchDebounce = null;
$("search-input").addEventListener("input", e => {
  const value = e.target.value;
  $("btn-clear-search").classList.toggle("hidden", !value);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = value.trim().toLowerCase();
    renderLibrary();
  }, 150);
});

$("btn-clear-search").addEventListener("click", () => {
  $("search-input").value = "";
  $("btn-clear-search").classList.add("hidden");
  state.searchQuery = "";
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

  saves.forEach(save => {
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
  if (e.key === "Escape") closeDetail();
});

$("btn-delete-detail").addEventListener("click", async () => {
  if (!state.detailSave) return;
  if (!confirm(`Delete "${state.detailSave.label}" from your cloud library?`)) return;
  await deleteSave(state.detailSave.id);
  closeDetail();
});

