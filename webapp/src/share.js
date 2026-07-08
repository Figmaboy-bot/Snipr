// Snipr Share Page — public, read-only view of a folder shared via a link.
// No authentication: Firestore rules allow anyone to read shares/{id} and
// its saves subcollection, since the owner explicitly published this link.
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, collection, getDocs } from "firebase/firestore";
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
const db = getFirestore(app);

const $ = id => document.getElementById(id);

let toastTimer = null;
function showToast(msg, type = "success") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

let saves = [];
let currentCodeOptions = [];

async function load() {
  const shareId = new URLSearchParams(location.search).get("id");
  if (!shareId) return showNotFound();

  try {
    const shareSnap = await getDoc(doc(db, "shares", shareId));
    if (!shareSnap.exists()) return showNotFound();
    const meta = shareSnap.data();

    const savesSnap = await getDocs(collection(db, "shares", shareId, "saves"));
    saves = savesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    $("library-loading").classList.add("hidden");
    $("share-header").classList.remove("hidden");
    $("share-folder-icon").textContent = meta.folderIcon || "📁";
    $("share-folder-name").textContent = meta.folderName || "Shared snips";
    $("share-folder-count").textContent = `${saves.length} snip${saves.length !== 1 ? "s" : ""}`;

    renderGrid();
  } catch (err) {
    console.error("Snipr: failed to load share", err);
    showNotFound();
  }
}

function showNotFound() {
  $("library-loading").classList.add("hidden");
  $("share-not-found").classList.remove("hidden");
}

function renderGrid() {
  const grid = $("library-grid");
  grid.innerHTML = "";

  saves.forEach(save => {
    const card = document.createElement("div");
    card.className = "save-card";
    card.innerHTML = `
      ${cardThumbHtml(save)}
      <div class="save-card-body">
        <div class="save-card-header">
          <span class="save-card-title">${escapeHtml(save.label)}</span>
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
      if (e.target.closest("a")) return;
      openDetail(save);
    });
    grid.appendChild(card);
  });
}

function openDetail(save) {
  $("detail-title").textContent = save.label || "Snip";

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

  currentCodeOptions = buildCodeOptions(save.html);
  const sel = $("code-type-select");
  sel.innerHTML = currentCodeOptions.map((o, i) => `<option value="${o.key}" ${i === 0 ? "selected" : ""}>${o.label}</option>`).join("");
  renderSelectedCode();

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

load();
