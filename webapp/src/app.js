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
} from "firebase/firestore";
import { firebaseConfig } from "../../firebase-config.js";

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

// ── Library grid ──────────────────────────────────────────────────────────────
function filteredSaves() {
  let saves = state.saves;
  if (state.folderFilter) saves = saves.filter(s => s.folderId === state.folderFilter);
  if (state.categoryFilter) saves = saves.filter(s => s.categories?.includes(state.categoryFilter));
  return saves;
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (_) { return url || ""; }
}

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(text || "").replace(/[&<>"']/g, m => map[m]);
}

function renderLibrary() {
  if (!state.loaded) return;
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.innerHTML = "";

  const saves = filteredSaves();
  empty.classList.toggle("hidden", saves.length > 0);

  saves.forEach(save => {
    const folder = state.folders.find(f => f.id === save.folderId);
    const card = document.createElement("div");
    card.className = "save-card";

    const thumbHtml = save.screenshot
      ? `<div class="save-card-thumb"><img src="${save.screenshot}" alt="${escapeHtml(save.label)}" loading="lazy" /></div>`
      : `<div class="save-card-thumb save-card-thumb--empty"><span>📷</span></div>`;

    card.innerHTML = `
      ${thumbHtml}
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
function extractCodeParts(sectionHtml) {
  const parts = { html: sectionHtml || "", css: "", js: "", externals: { css: [], js: [] } };
  if (!sectionHtml) return parts;
  try {
    const docp = new DOMParser().parseFromString(sectionHtml, "text/html");

    const cssStyles = Array.from(docp.querySelectorAll("style"));
    parts.css = cssStyles.map(s => (s.textContent || "").trim()).filter(Boolean).join("\n\n");

    const scriptEls = Array.from(docp.querySelectorAll("script"));
    const jsChunks = [];
    scriptEls.forEach(s => {
      const src = s.getAttribute("src");
      if (src) { parts.externals.js.push(src); jsChunks.push(`// Script src: ${src}`); }
      const inline = (s.textContent || "").trim();
      if (inline) jsChunks.push(inline);
    });
    parts.js = jsChunks.join("\n\n").trim();

    Array.from(docp.querySelectorAll('link[rel="stylesheet"]')).forEach(l => {
      const href = l.getAttribute("href");
      if (href) parts.externals.css.push(href);
    });

    cssStyles.forEach(s => s.remove());
    scriptEls.forEach(s => s.remove());
    const root = docp.body.firstElementChild;
    parts.html = (root ? root.outerHTML : docp.body.innerHTML).trim();
  } catch (_e) { /* best effort */ }
  return parts;
}

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
  const parts = extractCodeParts(save.html);
  currentCodeOptions = [
    { key: "html", label: "HTML", value: parts.html || "/* (none found) */" },
    { key: "css", label: "CSS", value: parts.css || "/* (none found) */" },
    { key: "js", label: "JavaScript", value: parts.js || "/* (none found) */" },
  ];
  if (parts.externals.css.length) currentCodeOptions.push({ key: "css-urls", label: "External CSS URLs", value: parts.externals.css.join("\n") });
  if (parts.externals.js.length) currentCodeOptions.push({ key: "js-urls", label: "External JS URLs", value: parts.externals.js.join("\n") });

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
  wireAssetClicks($("detail-assets"));

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

// ── Assets (colors / fonts / images / svgs) ───────────────────────────────────
function sanitizeSvg(svgHtml) {
  try {
    const docp = new DOMParser().parseFromString(svgHtml, "image/svg+xml");
    docp.querySelectorAll("script").forEach(s => s.remove());
    docp.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
      });
    });
    return new XMLSerializer().serializeToString(docp.documentElement);
  } catch (_) {
    return "";
  }
}

function safeImageUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") ? url : "";
  } catch (_) {
    return "";
  }
}

function renderDetailAssets(assets) {
  if (!assets) return "";
  const { fonts = [], colors = [], images = [], svgs = [] } = assets;
  if (!fonts.length && !colors.length && !images.length && !svgs.length) return "";

  let html = '<div class="detail-assets-divider"></div>';

  if (colors.length) {
    html += `
      <div class="asset-section">
        <div class="asset-section-title">Colors <span class="asset-hint">click to copy</span></div>
        <div class="asset-colors">
          ${colors.map(c => `
            <div class="asset-color-swatch" data-color="${escapeHtml(c)}" style="background:${escapeHtml(c)}">
              <span class="asset-color-label">${escapeHtml(c)}</span>
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  if (fonts.length) {
    html += `
      <div class="asset-section">
        <div class="asset-section-title">Fonts</div>
        <div class="asset-fonts">
          ${fonts.map(f => `<div class="asset-font-row"><span style="font-family:'${escapeHtml(f)}',sans-serif">${escapeHtml(f)}</span></div>`).join("")}
        </div>
      </div>`;
  }

  if (images.length) {
    const thumbs = images.map(safeImageUrl).filter(Boolean)
      .map(src => `<div class="asset-image-thumb" data-img-url="${escapeHtml(src)}" title="Click to copy URL"><img src="${escapeHtml(src)}" alt="" loading="lazy" /></div>`)
      .join("");
    if (thumbs) {
      html += `
        <div class="asset-section">
          <div class="asset-section-title">Images <span class="asset-hint">click to copy URL</span></div>
          <div class="asset-images">${thumbs}</div>
        </div>`;
    }
  }

  if (svgs.length) {
    const thumbs = svgs.map(sanitizeSvg).filter(Boolean)
      .map(s => `<div class="asset-svg-thumb" title="Click to copy SVG">${s}</div>`)
      .join("");
    if (thumbs) {
      html += `
        <div class="asset-section">
          <div class="asset-section-title">SVGs <span class="asset-hint">click to copy</span></div>
          <div class="asset-svgs">${thumbs}</div>
        </div>`;
    }
  }

  return html;
}

function wireAssetClicks(container) {
  container.querySelectorAll(".asset-color-swatch[data-color]").forEach(swatch => {
    swatch.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(swatch.dataset.color);
        showToast(`Copied ${swatch.dataset.color}`);
      } catch (_) { showToast("Failed to copy color", "error"); }
    });
  });

  container.querySelectorAll(".asset-image-thumb[data-img-url]").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(thumb.dataset.imgUrl);
        showToast("Image URL copied");
      } catch (_) { showToast("Failed to copy", "error"); }
    });
  });

  container.querySelectorAll(".asset-svg-thumb").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      const svgEl = thumb.querySelector("svg");
      if (!svgEl) return showToast("No SVG markup found", "error");
      try {
        await navigator.clipboard.writeText(svgEl.outerHTML);
        showToast("SVG copied");
      } catch (_) { showToast("Failed to copy SVG", "error"); }
    });
  });
}
