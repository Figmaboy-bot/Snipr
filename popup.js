async function captureSectionScreenshot(sectionId) {
  const tab = await getActiveTab();
  const {rect} = await sendToContent({type: "GET_SECTION_RECT", sectionId});
  if (!rect) return null;

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: "png"});
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  const sx = rect.x - window.scrollX;
  const sy = rect.y - window.scrollY;
  // with captureVisibleTab, image uses viewport coords and includes scroll; maybe same as rect
  ctx.drawImage(img, sx, sy, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return canvas.toDataURL("image/png");
}// DesignVault — Popup Logic

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  sections: [],
  selectedSections: [],
  selectedFolderId: null,
  selectedCategories: new Set(),
  folders: [],
  categories: [],
  libraryFolderFilter: null,
  libraryCategoryFilter: "",
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const views = {
  capture:  $("view-capture"),
  library:  $("view-library"),
  settings: $("view-settings"),
};

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
    el.style.display = key === name ? "flex" : "none";
  });
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(msg) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, msg);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = "success") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  setTimeout(() => t.classList.add("hidden"), 2200);
}

// ── Load bootstrap data ───────────────────────────────────────────────────────
async function loadBootstrap() {
  const [fRes, cRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_FOLDERS" }),
    chrome.runtime.sendMessage({ type: "GET_CATEGORIES" }),
  ]);
  state.folders = fRes.folders || [];
  state.categories = cRes.categories || [];
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scanPage() {
  const tab = await getActiveTab();
  $("page-title").textContent = tab.title || tab.url;

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (_) { /* already injected */ }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["styles/content.css"],
  }).catch(() => {});

  const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_SECTIONS" });
  state.sections = res?.sections || [];

  $("section-count").textContent = `${state.sections.length} sections found`;
  $("empty-state").classList.add("hidden");
  renderSectionList();

  if (state.sections.length === 0) {
    $("empty-state").classList.remove("hidden");
    $("sections-list").classList.add("hidden");
  } else {
    $("sections-list").classList.remove("hidden");
  }
}

// ── Section list ──────────────────────────────────────────────────────────────
function renderSectionList() {
  const container = $("sections-items");
  container.innerHTML = "";
  state.sections.forEach(s => {
    const el = document.createElement("div");
    el.className = "section-item";
    el.setAttribute("data-id", s.id);
    el.innerHTML = `
      <div class="section-check">✓</div>
      <span class="section-label">${s.label}</span>
    `;
    el.addEventListener("click", () => toggleSectionFromList(s.id, el));
    container.appendChild(el);
  });
}

function toggleSectionFromList(id, el) {
  const idx = state.selectedSections.findIndex(s => s.id === id);
  if (idx > -1) {
    state.selectedSections.splice(idx, 1);
    el.classList.remove("selected");
  } else {
    const section = state.sections.find(s => s.id === id);
    if (section) {
      state.selectedSections.push(section);
      el.classList.add("selected");
    }
  }
  updateSavePanel();
}

// ── Selection sync from page ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SECTION_SELECTION_CHANGED") {
    state.selectedSections = msg.selected;
    syncListSelection();
    updateSavePanel();
  }
});

function syncListSelection() {
  document.querySelectorAll(".section-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.classList.toggle("selected", state.selectedSections.some(s => s.id === id));
  });
}

// ── Save panel ────────────────────────────────────────────────────────────────
function updateSavePanel() {
  const panel = $("save-panel");
  const count = state.selectedSections.length;
  $("selected-count").textContent = `${count} section${count !== 1 ? "s" : ""} selected`;

  if (count > 0) {
    panel.classList.remove("hidden");
    renderFolderGrid();
    renderCategoryChips();
  } else {
    panel.classList.add("hidden");
  }
}

function renderFolderGrid() {
  const el = $("folder-select");
  el.innerHTML = "";
  state.folders.forEach(f => {
    const chip = document.createElement("div");
    chip.className = "folder-chip" + (state.selectedFolderId === f.id ? " selected" : "");
    chip.innerHTML = `<span>${f.icon}</span><span>${f.name}</span>`;
    chip.addEventListener("click", () => {
      state.selectedFolderId = f.id;
      renderFolderGrid();
    });
    el.appendChild(chip);
  });
}

function renderCategoryChips() {
  const el = $("category-chips");
  el.innerHTML = "";
  state.categories.forEach(cat => {
    const chip = document.createElement("div");
    chip.className = "chip" + (state.selectedCategories.has(cat) ? " selected" : "");
    chip.textContent = cat;
    chip.addEventListener("click", () => {
      if (state.selectedCategories.has(cat)) state.selectedCategories.delete(cat);
      else state.selectedCategories.add(cat);
      renderCategoryChips();
    });
    el.appendChild(chip);
  });
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveSelectedSections() {
  if (!state.selectedSections.length) return showToast("Select at least one section", "error");
  if (!state.selectedFolderId) return showToast("Pick a folder first", "error");

  const res = await chrome.runtime.sendMessage({
    type: "SAVE_SECTIONS",
    sections: state.selectedSections,
    folderId: state.selectedFolderId,
    categories: [...state.selectedCategories],
    note: $("note-input").value.trim(),
  });

  if (res.ok) {
    showToast(`✓ Saved ${res.saved} section${res.saved !== 1 ? "s" : ""}!`);
    state.selectedSections = [];
    state.selectedCategories.clear();
    $("note-input").value = "";
    syncListSelection();
    updateSavePanel();
    // Deactivate overlay
    sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
    $("sections-list").classList.add("hidden");
    $("section-count").textContent = "0 sections found";
    $("empty-state").classList.remove("hidden");
  }
}

// ── Library ───────────────────────────────────────────────────────────────────
async function loadLibrary() {
  const params = { type: "GET_SAVES" };
  if (state.libraryFolderFilter) params.folderId = state.libraryFolderFilter;
  if (state.libraryCategoryFilter) params.category = state.libraryCategoryFilter;

  const res = await chrome.runtime.sendMessage(params);
  renderLibrary(res.saves || []);
  renderFolderTabs();
  renderCategoryFilter();
}

function renderFolderTabs() {
  const el = $("folder-tabs");
  el.innerHTML = "";

  const allTab = document.createElement("div");
  allTab.className = "tab" + (!state.libraryFolderFilter ? " active" : "");
  allTab.textContent = "All";
  allTab.addEventListener("click", () => { state.libraryFolderFilter = null; loadLibrary(); });
  el.appendChild(allTab);

  state.folders.forEach(f => {
    const tab = document.createElement("div");
    tab.className = "tab" + (state.libraryFolderFilter === f.id ? " active" : "");
    tab.textContent = `${f.icon} ${f.name}`;
    tab.addEventListener("click", () => { state.libraryFolderFilter = f.id; loadLibrary(); });
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

function renderLibrary(saves) {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.innerHTML = "";

  if (!saves.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  saves.slice().reverse().forEach(save => {
    const folder = state.folders.find(f => f.id === save.folderId);
    const card = document.createElement("div");
    card.className = "save-card";
    card.innerHTML = `
      <div class="save-card-header">
        <span class="save-card-title">${folder ? folder.icon + " " : ""}${save.label}</span>
        <button class="delete-btn" data-id="${save.id}" title="Delete">✕</button>
      </div>
      <div class="save-card-url">
        <a href="${save.url}" target="_blank" title="${save.pageTitle}">${save.url}</a>
      </div>
      ${save.categories?.length ? `
        <div class="save-card-chips">
          ${save.categories.map(c => `<span class="mini-chip">${c}</span>`).join("")}
        </div>` : ""}
      ${save.note ? `<div style="font-size:11px;color:var(--muted)">${save.note}</div>` : ""}
      <div class="save-card-date">${new Date(save.savedAt).toLocaleDateString()}</div>
    `;
    card.querySelector(".delete-btn").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "DELETE_SAVE", saveId: save.id });
      loadLibrary();
    });
    grid.appendChild(card);
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderFolderManager() {
  const el = $("folder-manager");
  el.innerHTML = "";
  state.folders.forEach(f => {
    const row = document.createElement("div");
    row.className = "manager-row";
    row.innerHTML = `
      <span>${f.icon}</span>
      <span class="manager-row-name">${f.name}</span>
      <button class="delete-btn" data-id="${f.id}">✕</button>
    `;
    row.querySelector(".delete-btn").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "DELETE_FOLDER", folderId: f.id });
      state.folders = state.folders.filter(x => x.id !== f.id);
      renderFolderManager();
    });
    el.appendChild(row);
  });
}

function renderCategoryManager() {
  const el = $("category-manager");
  el.innerHTML = "";
  state.categories.forEach(cat => {
    const row = document.createElement("div");
    row.className = "manager-row";
    row.innerHTML = `
      <span class="manager-row-name">${cat}</span>
    `;
    el.appendChild(row);
  });
}

// ── Export ────────────────────────────────────────────────────────────────────
async function exportVault() {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_ALL" });
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `design-vault-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Event Wiring ──────────────────────────────────────────────────────────────
function wireEvents() {
  // Scan
  $("btn-scan").addEventListener("click", scanPage);

  // Clear selection
  $("btn-clear-selection").addEventListener("click", () => {
    state.selectedSections = [];
    state.selectedCategories.clear();
    syncListSelection();
    updateSavePanel();
    sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
    scanPage();
  });

  // Save
  $("btn-save").addEventListener("click", saveSelectedSections);

  // Add category inline
  $("btn-add-category").addEventListener("click", async () => {
    const val = $("new-category-input").value.trim();
    if (!val) return;
    await chrome.runtime.sendMessage({ type: "ADD_CATEGORY", category: val });
    state.categories.push(val);
    $("new-category-input").value = "";
    renderCategoryChips();
  });
  $("new-category-input").addEventListener("keydown", e => {
    if (e.key === "Enter") $("btn-add-category").click();
  });

  // Library
  $("btn-library").addEventListener("click", async () => {
    await loadBootstrap();
    await loadLibrary();
    showView("library");
  });

  $("btn-back").addEventListener("click", () => showView("capture"));

  $("btn-export").addEventListener("click", exportVault);

  $("category-filter").addEventListener("change", e => {
    state.libraryCategoryFilter = e.target.value;
    loadLibrary();
  });

  // Settings
  $("btn-settings").addEventListener("click", async () => {
    await loadBootstrap();
    renderFolderManager();
    renderCategoryManager();
    showView("settings");
  });

  $("btn-back-settings").addEventListener("click", () => showView("capture"));

  $("btn-create-folder").addEventListener("click", async () => {
    const name = $("new-folder-name").value.trim();
    const icon = $("new-folder-icon").value.trim() || "📁";
    if (!name) return;
    const res = await chrome.runtime.sendMessage({ type: "CREATE_FOLDER", name, icon });
    if (res.ok) {
      state.folders.push(res.folder);
      $("new-folder-name").value = "";
      $("new-folder-icon").value = "";
      renderFolderManager();
      showToast(`Folder "${name}" created`);
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Init all views as hidden except capture
  Object.entries(views).forEach(([key, el]) => {
    el.style.display = key === "capture" ? "flex" : "none";
  });

  await loadBootstrap();
  wireEvents();

  // Auto-scan on open
  const tab = await getActiveTab();
  if (tab?.url && !tab.url.startsWith("chrome://")) {
    $("page-title").textContent = tab.title || tab.url;
    await scanPage().catch(() => {});
  }
})();
