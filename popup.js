// Snipr — Popup Logic

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
  detailSave: null,
  detailFromView: "library",
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const views = {
  capture:  $("view-capture"),
  library:  $("view-library"),
  detail:   $("view-detail"),
  settings: $("view-settings"),
};

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle("active", key === name);
    el.style.display = key === name ? "flex" : "none";
  });
  // Sync tab bar — detail keeps library tab highlighted
  const activeTab = name === "detail" ? "library" : name;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === activeTab);
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

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(url);
    // Ignore hash; it's often client-side routing noise.
    u.hash = "";
    return u.toString();
  } catch (_e) {
    return url || "";
  }
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

// ── Screenshot Capture ────────────────────────────────────────────────────────

// Sections taller than the viewport can't be captured in one shot — this caps
// how many extra viewport-height slices we'll scroll+capture+stitch before
// giving up, as a runaway-loop guard rather than a real UX target.
const MAX_CAPTURE_SLICES = 6;

async function captureVisibleSlice(tab, rect, dpr, viewportWidth, viewportHeight) {
  const bgResponse = await chrome.runtime.sendMessage({
    type: "CAPTURE_SCREENSHOT",
    tabId: tab.id,
    windowId: tab.windowId,
    rect,
    dpr,
    viewportWidth,
    viewportHeight,
  });
  return bgResponse?.screenshot || null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function stitchSlices(slices, width) {
  if (slices.length === 1) return slices[0].dataUrl;

  const totalHeight = slices.reduce((sum, s) => sum + s.height, 0);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(totalHeight));
  const ctx = canvas.getContext("2d");

  let y = 0;
  for (const slice of slices) {
    if (slice.dataUrl) {
      try {
        const img = await loadImage(slice.dataUrl);
        ctx.drawImage(img, 0, y);
      } catch (_e) { /* skip a failed slice, keep the rest */ }
    }
    y += slice.height;
  }
  return canvas.toDataURL("image/png");
}

async function captureSectionScreenshot(sectionId) {
  try {
    const tab = await getActiveTab();
    console.log("Capturing screenshot for tab:", tab.id, "section:", sectionId);

    // FIRST: Ensure content script is injected and ready
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      console.log("Content script is ready");
    } catch (e) {
      console.log("Content script not ready, injecting...");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["styles/content.css"],
      }).catch(() => {});

      // Re-scan to populate sections in content script
      console.log("Re-scanning page to populate sections");
      const scanRes = await chrome.tabs.sendMessage(tab.id, { type: "GET_SECTIONS" });
      console.log("Scan result:", scanRes);
    }

    // Now get the rect
    console.log("Requesting section rect...");
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SECTION_RECT",
      sectionId
    });
    console.log("GET_SECTION_RECT response:", response);

    if (!response?.rect) {
      console.error("No rect found in response");
      return null;
    }

    const { rect, dpr = 1, viewportWidth, viewportHeight } = response.rect;
    console.log("Rect data:", { rect, dpr, viewportWidth, viewportHeight });

    const firstY = Math.max(0, rect.y);
    const firstHeight = Math.min(rect.height, viewportHeight - firstY);
    const firstSlice = await captureVisibleSlice(
      tab, { x: rect.x, y: firstY, width: rect.width, height: firstHeight }, dpr, viewportWidth, viewportHeight
    );

    let remaining = rect.height - firstHeight;
    if (remaining <= 0) {
      // Fits in one shot — today's behavior, unchanged.
      return firstSlice;
    }

    // Tall section: scroll down exactly what's already been captured each
    // time, so slices are contiguous with no gap or overlap, then stitch.
    const slices = [{ dataUrl: firstSlice, height: firstHeight }];
    let scrolledBy = 0;

    while (remaining > 0 && slices.length < MAX_CAPTURE_SLICES) {
      const last = slices[slices.length - 1];
      await chrome.tabs.sendMessage(tab.id, { type: "SCROLL_BY", amount: last.height }).catch(() => {});
      scrolledBy += last.height;

      const sliceHeight = Math.min(remaining, viewportHeight);
      const dataUrl = await captureVisibleSlice(
        tab, { x: rect.x, y: 0, width: rect.width, height: sliceHeight }, dpr, viewportWidth, viewportHeight
      );
      if (!dataUrl) break;
      slices.push({ dataUrl, height: sliceHeight });
      remaining -= sliceHeight;
    }

    if (scrolledBy > 0) {
      await chrome.tabs.sendMessage(tab.id, { type: "SCROLL_BY", amount: -scrolledBy }).catch(() => {});
    }

    return await stitchSlices(slices, rect.width);
  } catch (err) {
    console.error("DesignVault: screenshot capture failed", err);
    return null;
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scanPage() {
  const tab = await getActiveTab();
  $("page-title").textContent = tab.title || tab.url;

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
  renderSectionGrid();

  if (state.sections.length === 0) {
    $("empty-state").classList.remove("hidden");
    $("sections-grid").classList.add("hidden");
  } else {
    $("sections-grid").classList.remove("hidden");
    loadSectionThumbnails().catch(() => {});
  }
}

// ── Section thumbnail loader ──────────────────────────────────────────────────
let _thumbnailScanId = 0;

async function loadSectionThumbnails() {
  const scanId = ++_thumbnailScanId;

  for (const section of state.sections) {
    // Abort if a new scan started
    if (scanId !== _thumbnailScanId) return;

    try {
      const screenshot = await captureSectionScreenshot(section.id);
      if (!screenshot) continue;
      if (scanId !== _thumbnailScanId) return;

      const card = document.querySelector(`.section-card[data-id="${section.id}"]`);
      if (!card || !card.isConnected) continue;

      const thumb = card.querySelector(".section-card-thumb");
      if (thumb) {
        thumb.innerHTML = `<img src="${screenshot}" alt="${section.label}" />`;
      }
    } catch (_e) {
      // Silently skip failed thumbnails
    }
  }
}

// ── Section grid ──────────────────────────────────────────────────────────────
function renderSectionGrid() {
  const container = $("sections-grid");
  container.innerHTML = "";
  state.sections.forEach(s => {
    const card = document.createElement("div");
    card.className = "section-card";
    card.setAttribute("data-id", s.id);
    card.innerHTML = `
      <div class="section-card-thumb">
        <div class="section-card-thumb-placeholder">
          <span class="ph-icon">${sectionIcon(s.label)}</span>
        </div>
      </div>
      <p class="section-card-label">${s.label}</p>
    `;
    card.addEventListener("click", () => toggleSectionCard(s.id, card));
    container.appendChild(card);
  });
}

function sectionIcon(label) {
  const map = {
    Navbar: "🧭", Header: "🏷️", Hero: "🦸", Features: "✨",
    Pricing: "💰", Testimonials: "💬", CTA: "📣", FAQ: "❓",
    Footer: "🏁", Blog: "📝", Contact: "📬", Gallery: "🖼️",
    Stats: "📊", Team: "👥", Sidebar: "📌", Main: "📄",
  };
  return map[label] || "📄";
}

function toggleSectionCard(id, card) {
  const idx = state.selectedSections.findIndex(s => s.id === id);
  if (idx > -1) {
    state.selectedSections.splice(idx, 1);
    card.classList.remove("selected");
  } else {
    const section = state.sections.find(s => s.id === id);
    if (section) {
      state.selectedSections.push(section);
      card.classList.add("selected");
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
  document.querySelectorAll(".section-card").forEach(card => {
    const id = card.getAttribute("data-id");
    card.classList.toggle("selected", state.selectedSections.some(s => s.id === id));
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

// ── Save (with screenshot capture) ───────────────────────────────────────────
function setSnipProgress(step, total, label) {
  const el = $("snip-progress");
  const fill = $("snip-progress-fill");
  const lbl = $("snip-progress-label");
  el.classList.remove("hidden");
  fill.style.width = `${Math.round((step / total) * 100)}%`;
  lbl.textContent = label;
}

function hideSnipProgress() {
  $("snip-progress").classList.add("hidden");
  $("snip-progress-fill").style.width = "0%";
}

async function saveSelectedSections() {
  if (!state.selectedSections.length) return showToast("Select at least one section", "error");
  if (!state.selectedFolderId) return showToast("Pick a folder first", "error");

  const saveBtn = $("btn-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Snipping…";

  const total = state.selectedSections.length;
  // Steps: N capture steps + 1 save step = total + 1
  const totalSteps = total + 1;

  try {
    const tab = await getActiveTab();
    const sectionsWithScreenshots = [];

    for (let i = 0; i < total; i++) {
      const section = state.selectedSections[i];
      setSnipProgress(i, totalSteps, `Step ${i + 1} of ${total}: capturing "${section.label}"…`);

      try {
        const screenshot = await captureSectionScreenshot(section.id);
        const assetsRes = await chrome.tabs.sendMessage(
          tab.id,
          { type: "GET_SECTION_ASSETS", sectionId: section.id }
        ).catch(() => null);
        sectionsWithScreenshots.push({
          ...section,
          screenshot: screenshot || null,
          assets: assetsRes?.assets || null,
        });
      } catch (err) {
        console.error(`Error capturing section ${section.id}:`, err);
        sectionsWithScreenshots.push({ ...section, screenshot: null, assets: null });
      }
    }

    setSnipProgress(total, totalSteps, "Saving…");
    saveBtn.textContent = "Saving…";

    const res = await chrome.runtime.sendMessage({
      type: "SAVE_SECTIONS",
      sections: sectionsWithScreenshots,
      folderId: state.selectedFolderId,
      categories: [...state.selectedCategories],
      note: $("note-input").value.trim(),
    });

    if (res.ok) {
      cloudPushSavesSafe(res.saves).catch(() => {});
      setSnipProgress(totalSteps, totalSteps, "Done!");
      setTimeout(() => {
        hideSnipProgress();
        saveBtn.textContent = "Save Snip ✂";
        saveBtn.disabled = false;
      }, 600);

      showToast(`✂ Snipped ${res.saved} section${res.saved !== 1 ? "s" : ""}!`);
      state.selectedSections = [];
      state.selectedCategories.clear();
      $("note-input").value = "";
      syncListSelection();
      updateSavePanel();
      sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
      $("sections-grid").classList.add("hidden");
      $("section-count").textContent = "0 sections found";
      $("empty-state").classList.remove("hidden");
    } else {
      hideSnipProgress();
      saveBtn.textContent = "Save Snip ✂";
      saveBtn.disabled = false;
      showToast("Failed to save sections", "error");
    }
  } catch (err) {
    console.error("Save failed:", err);
    hideSnipProgress();
    saveBtn.textContent = "Save Snip ✂";
    saveBtn.disabled = false;
    showToast("Error saving sections", "error");
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

    const thumbHtml = save.screenshot
      ? `<div class="save-card-thumb"><img src="${save.screenshot}" alt="${save.label}" /></div>`
      : `<div class="save-card-thumb save-card-thumb--empty"><span>📷</span></div>`;

    card.innerHTML = `
      ${thumbHtml}
      <div class="save-card-body">
        <div class="save-card-header">
          <span class="save-card-title">${folder ? folder.icon + " " : ""}${save.label}</span>
          <button class="delete-btn" data-id="${save.id}" title="Delete">✕</button>
        </div>
        <div class="save-card-url">
          <a href="${save.url}" target="_blank" title="${save.pageTitle}">${new URL(save.url).hostname}</a>
        </div>
        ${save.categories?.length ? `
          <div class="save-card-chips">
            ${save.categories.map(c => `<span class="mini-chip">${c}</span>`).join("")}
          </div>` : ""}
        <div class="save-card-date">${new Date(save.savedAt).toLocaleDateString()}</div>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      if (e.target.closest("a")) return;
      openDetailView(save);
    });

    card.querySelector(".delete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: "DELETE_SAVE", saveId: save.id });
      cloudDeleteSaveSafe(save.id);
      loadLibrary();
    });

    grid.appendChild(card);
  });
}

// ── Detail View ───────────────────────────────────────────────────────────────
function openDetailView(save) {
  state.detailSave = save;

  const folder = state.folders.find(f => f.id === save.folderId);

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const detailTabs = $("detail-tabs");
  detailTabs.innerHTML = `
    <div class="detail-tab" data-tab="image">📷 Image</div>
    <div class="detail-tab" data-tab="code">{'</>'} Code</div>
    <div class="detail-tab" data-tab="details">ℹ️ Details</div>
  `;

  // Wire tab switches
  document.querySelectorAll(".detail-tab").forEach(tab => {
    tab.addEventListener("click", () => switchDetailTab(tab.getAttribute("data-tab")));
  });

  // Set first tab active
  switchDetailTab("image");

  // ── Image Tab ────────────────────────────────────────────────────────────
  const img = $("detail-screenshot");
  const noShot = $("detail-no-screenshot");
  if (save.screenshot) {
    img.src = save.screenshot;
    img.style.display = "block";
    noShot.style.display = "none";
  } else {
    img.src = "";
    img.style.display = "none";
    noShot.style.display = "flex";
  }

  // ── Code Tab ─────────────────────────────────────────────────────────────
  const codeContainer = $("detail-code-container");

  if (save.html) {
    const parts = extractCodeParts(save.html);
    const codeOptions = [
      { key: "html", label: "HTML", value: parts.html || "/* (none found) */" },
      { key: "css", label: "CSS", value: parts.css || "/* (none found) */" },
      { key: "js", label: "JavaScript", value: parts.js || "/* (none found) */" },
    ];
    if (parts.externals?.css?.length) {
      codeOptions.push({
        key: "css-urls",
        label: "External CSS URLs",
        value: parts.externals.css.join("\n"),
      });
    }
    if (parts.externals?.js?.length) {
      codeOptions.push({
        key: "js-urls",
        label: "External JS URLs",
        value: parts.externals.js.join("\n"),
      });
    }
    const optionFileNames = {
      html: "section.html",
      css: "section.css",
      js: "section.js",
      "css-urls": "external-css.txt",
      "js-urls": "external-js.txt",
    };

    codeContainer.innerHTML = `
      <div class="snpr-code-toolbar">
        <div class="snpr-code-toolbar-left">
          <span class="snpr-code-toolbar-title">Code</span>
          <select id="code-type-select" class="snpr-code-type-select">
            ${codeOptions.map((o, idx) => `<option value="${o.key}" ${idx === 0 ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="snpr-code-editor">
        <div class="snpr-code-editor-header">
          <span id="detail-code-filename" class="snpr-code-editor-tab">section.html</span>
          <button id="btn-copy-code" class="snpr-copy-code-btn">Copy</button>
        </div>
        <div class="snpr-code-panel">
          <div id="detail-code-lines" class="snpr-code-lines"></div>
          <pre id="detail-code-pre" class="snpr-code-block"><code id="detail-current-code"></code></pre>
        </div>
      </div>
    `;

    const selectEl = $("code-type-select");
    const codeEl = $("detail-current-code");
    const linesEl = $("detail-code-lines");
    const preEl = $("detail-code-pre");
    const fileEl = $("detail-code-filename");
    const getSelectedOption = () => codeOptions.find(o => o.key === selectEl?.value) || codeOptions[0];
    const renderSelectedCode = () => {
      const selected = getSelectedOption();
      const value = selected?.value || "";
      if (codeEl) codeEl.textContent = value;
      if (fileEl) fileEl.textContent = optionFileNames[selected?.key] || "section.txt";
      if (linesEl) {
        const lineCount = Math.max(1, value.split("\n").length);
        linesEl.innerHTML = Array.from({ length: lineCount }, (_, i) => `<div>${i + 1}</div>`).join("");
      }
      if (preEl) {
        preEl.scrollTop = 0;
        preEl.scrollLeft = 0;
      }
      if (linesEl) linesEl.scrollTop = 0;
    };
    renderSelectedCode();
    if (selectEl) {
      selectEl.addEventListener("change", renderSelectedCode);
    }

    if (preEl && linesEl) {
      let syncing = false;
      const syncFromPre = () => {
        if (syncing) return;
        syncing = true;
        linesEl.scrollTop = preEl.scrollTop;
        syncing = false;
      };
      const syncFromLines = () => {
        if (syncing) return;
        syncing = true;
        preEl.scrollTop = linesEl.scrollTop;
        syncing = false;
      };
      preEl.addEventListener("scroll", syncFromPre);
      linesEl.addEventListener("scroll", syncFromLines);
    }

    const copyBtn = $("btn-copy-code");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          const selected = getSelectedOption();
          await navigator.clipboard.writeText(selected?.value || "");
          const originalText = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = originalText;
          }, 2000);
          showToast("Code copied");
        } catch (err) {
          console.error("Failed to copy:", err);
          showToast("Failed to copy code", "error");
        }
      });
    }
  } else {
    // If `html` is missing in older saves, offer a best-effort recovery from the current page.
    codeContainer.innerHTML = `
      <div class="snpr-code-empty">
        <div>No section code available for this save.</div>
        <button id="btn-fetch-code" class="snpr-fetch-code-btn">Fetch from current page</button>
        <div id="fetch-code-hint" class="snpr-fetch-code-hint">
          Open the original page, then click fetch.
        </div>
      </div>
    `;

    const fetchBtn = $("btn-fetch-code");
    const hintEl = $("fetch-code-hint");
    if (fetchBtn) {
      fetchBtn.addEventListener("click", async () => {
        try {
          fetchBtn.disabled = true;
          const originalText = fetchBtn.textContent;
          fetchBtn.textContent = "Fetching…";

          const tab = await getActiveTab();
          const activeUrl = normalizeUrlForCompare(tab?.url || "");
          const savedUrl = normalizeUrlForCompare(save.url || "");

          if (!activeUrl || !savedUrl || activeUrl !== savedUrl) {
            if (hintEl) hintEl.textContent = "The active tab URL doesn’t match this save. Open the original page and try again.";
            showToast("Open the original page first", "error");
            fetchBtn.textContent = originalText;
            fetchBtn.disabled = false;
            return;
          }

          // Ensure content script is injected; if not, inject it and continue.
          try {
            await chrome.tabs.sendMessage(tab.id, { type: "PING" });
          } catch (_e) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/content.css"] }).catch(() => {});
          }

          const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_SECTIONS" });
          const sections = res?.sections || [];
          const match = sections.find(s => s.label === save.label && s.html);

          if (!match?.html) {
            if (hintEl) hintEl.textContent = "Couldn’t find a matching section on the current page. Try re-scanning or choose a different section.";
            showToast("Could not find section code", "error");
            fetchBtn.textContent = originalText;
            fetchBtn.disabled = false;
            return;
          }

          const upd = await chrome.runtime.sendMessage({
            type: "UPDATE_SAVE",
            saveId: save.id,
            patch: { html: match.html },
          });

          if (!upd?.ok || !upd?.save?.html) {
            showToast("Failed to update saved code", "error");
            fetchBtn.textContent = originalText;
            fetchBtn.disabled = false;
            return;
          }

          // Re-render detail view with updated save object.
          openDetailView(upd.save);
          switchDetailTab("code");
          showToast("Section code recovered");
        } catch (err) {
          console.error("Fetch code failed:", err);
          showToast("Failed to fetch code", "error");
          try {
            const btn = $("btn-fetch-code");
            if (btn) {
              btn.disabled = false;
              btn.textContent = "Fetch from current page";
            }
          } catch (_e2) {}
        }
      });
    }
  }

  // ── Details Tab ──────────────────────────────────────────────────────────
  $("detail-title").textContent = save.label;
  $("detail-folder").textContent = folder ? `${folder.icon} ${folder.name}` : "—";
  
  const urlEl = $("detail-url");
  urlEl.href = save.url;
  urlEl.textContent = save.url;

  $("detail-date").textContent = new Date(save.savedAt).toLocaleString();

  const catsEl = $("detail-categories");
  const catsRow = $("detail-categories-row");
  if (save.categories?.length) {
    catsEl.innerHTML = save.categories.map(c => `<span class="mini-chip">${c}</span>`).join("");
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

  const assetsContainer = $("detail-assets");
  assetsContainer.innerHTML = renderDetailAssets(save.assets);
  wireAssetClicks(assetsContainer);

  showView("detail");
}

// ── Switch Detail Tabs ───────────────────────────────────────────────────────
function switchDetailTab(tabName) {
  // Update tab buttons
  document.querySelectorAll(".detail-tab").forEach(tab => {
    tab.classList.toggle("active", tab.getAttribute("data-tab") === tabName);
  });

  // Update tab content
  $("detail-image-tab").style.display = tabName === "image" ? "flex" : "none";
  $("detail-code-tab").style.display = tabName === "code" ? "flex" : "none";
  $("detail-info-tab").style.display = tabName === "details" ? "block" : "none";
}

// ── Helper: Escape HTML for display ───────────────────────────────────────────
function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ── Asset display helpers ─────────────────────────────────────────────────────

function sanitizeSvg(svgHtml) {
  try {
    const doc = new DOMParser().parseFromString(svgHtml, "image/svg+xml");
    doc.querySelectorAll("script").forEach(s => s.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
      });
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
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

async function copyImageToClipboard(url) {
  const resp = await fetch(url);
  const srcBlob = await resp.blob();

  let pngBlob;
  if (srcBlob.type === "image/png") {
    pngBlob = srcBlob;
  } else {
    const bmp = await createImageBitmap(srcBlob);
    const canvas = document.createElement("canvas");
    canvas.width  = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    pngBlob = await new Promise(res => canvas.toBlob(res, "image/png"));
  }

  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
}

function flashCopied(el) {
  el.classList.add("asset-copied");
  setTimeout(() => el.classList.remove("asset-copied"), 900);
}

function wireAssetClicks(container) {
  // ── Color swatches ────────────────────────────────────────────────────────
  container.querySelectorAll(".asset-color-swatch[data-color]").forEach(swatch => {
    swatch.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(swatch.dataset.color);
        flashCopied(swatch);
        showToast(`Copied ${swatch.dataset.color}`);
      } catch (_) {
        showToast("Failed to copy color", "error");
      }
    });
  });

  // ── Image thumbnails ──────────────────────────────────────────────────────
  container.querySelectorAll(".asset-image-thumb[data-img-url]").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      const url = thumb.dataset.imgUrl;
      try {
        await copyImageToClipboard(url);
        flashCopied(thumb);
        showToast("Image copied to clipboard");
      } catch (_) {
        // Fallback: copy the URL as text
        try {
          await navigator.clipboard.writeText(url);
          flashCopied(thumb);
          showToast("Image URL copied");
        } catch (_2) {
          showToast("Failed to copy image", "error");
        }
      }
    });
  });

  // ── SVG thumbnails ────────────────────────────────────────────────────────
  container.querySelectorAll(".asset-svg-thumb").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      try {
        const svgEl = thumb.querySelector("svg");
        const markup = svgEl ? svgEl.outerHTML : "";
        if (!markup) { showToast("No SVG markup found", "error"); return; }
        await navigator.clipboard.writeText(markup);
        flashCopied(thumb);
        showToast("SVG copied to clipboard");
      } catch (_) {
        showToast("Failed to copy SVG", "error");
      }
    });
  });
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
            <div class="asset-color-swatch" data-color="${c}" style="background:${c}">
              <span class="asset-color-label">${c}</span>
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
          ${fonts.map(f => `
            <div class="asset-font-row">
              <span class="asset-font-name" style="font-family:'${f}',sans-serif">${f}</span>
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  if (images.length) {
    const thumbs = images
      .map(safeImageUrl)
      .filter(Boolean)
      .map(src => `<div class="asset-image-thumb" data-img-url="${escapeHtml(src)}" title="Click to copy image"><img src="${src}" alt="" loading="lazy" /></div>`)
      .join("");
    if (thumbs) {
      html += `
        <div class="asset-section">
          <div class="asset-section-title">Images <span class="asset-hint">click to copy</span></div>
          <div class="asset-images">${thumbs}</div>
        </div>`;
    }
  }

  if (svgs.length) {
    const thumbs = svgs
      .map(sanitizeSvg)
      .filter(Boolean)
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

// Extract inline CSS/JS (and external asset URLs) from an element's saved HTML.
// Note: we can only extract code that exists in the DOM (inline <style>/<script> and their src/href URLs).
function extractCodeParts(sectionHtml) {
  const parts = {
    html: sectionHtml || "",
    css: "",
    js: "",
    externals: { css: [], js: [] },
  };

  if (!sectionHtml) return parts;

  try {
    const doc = new DOMParser().parseFromString(sectionHtml, "text/html");

    const cssStyles = Array.from(doc.querySelectorAll("style"));
    parts.css = cssStyles
      .map(s => (s.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");

    const scriptEls = Array.from(doc.querySelectorAll("script"));
    const jsChunks = [];
    scriptEls.forEach(s => {
      const src = s.getAttribute("src");
      if (src) {
        parts.externals.js.push(src);
        jsChunks.push(`// Script src: ${src}`);
      }

      const inline = (s.textContent || "").trim();
      if (inline) jsChunks.push(inline);
    });
    parts.js = jsChunks.join("\n\n").trim();

    const linkEls = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    linkEls.forEach(l => {
      const href = l.getAttribute("href");
      if (href) parts.externals.css.push(href);
    });

    // The HTML tab should show pure markup — strip the <style>/<script> tags
    // now that their contents live in the CSS/JS tabs, so each tab shows one
    // language instead of HTML duplicating what CSS/JS already show.
    cssStyles.forEach(s => s.remove());
    scriptEls.forEach(s => s.remove());
    const root = doc.body.firstElementChild;
    parts.html = (root ? root.outerHTML : doc.body.innerHTML).trim();
  } catch (_e) {
    // Best-effort extraction only.
  }

  return parts;
}

function buildCodeBundleText(parts) {
  const html = parts.html || "";
  const css = parts.css || "";
  const js = parts.js || "";
  const extCss = parts.externals?.css?.length ? parts.externals.css.join("\n") : "";
  const extJs = parts.externals?.js?.length ? parts.externals.js.join("\n") : "";

  const lines = [];
  lines.push("/* ================= HTML ================= */");
  lines.push(html);

  lines.push("\n/* ================= CSS (inline <style>) ================= */");
  lines.push(css || "/* (none found) */");

  if (extCss) {
    lines.push("\n/* ================= CSS (external <link rel=stylesheet>) ================= */");
    lines.push(extCss);
  }

  lines.push("\n/* ================= JS (inline <script>) ================= */");
  lines.push(js || "/* (none found) */");

  if (extJs) {
    lines.push("\n/* ================= JS (external <script src>) ================= */");
    lines.push(extJs);
  }

  return lines.join("\n");
}

// ── Cloud sync (Firebase / web app) ───────────────────────────────────────────
// When the user is signed in, every save is mirrored to Firestore under
// users/{uid}/saves so the Snipr web app can show the same library.

const cloud = {
  ready: false,
  user: null,
};

function cloudAvailable() {
  return cloud.ready && !!cloud.user;
}

function initCloud() {
  const api = window.SnprFirebaseAuth;
  if (!api) {
    console.error("Snipr: firebase-auth.bundle.js did not load — cloud sync disabled");
    showAuthError("Cloud sync unavailable: auth bundle failed to load. Run `npm run build:auth` and reload the extension.");
    return;
  }
  const res = api.initFirebase();
  if (!res.ok) {
    console.warn("Snipr: Firebase not configured —", res.error);
    showAuthError(res.error);
    return;
  }
  cloud.ready = true;
  api.subscribeAuth(user => {
    cloud.user = user || null;
    renderAuthUI();
  });
}

// Firestore documents are capped at 1MB, so screenshots are re-encoded as
// bounded JPEGs and giant HTML is truncated before upload.
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

async function prepareSaveForCloud(save) {
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
  // Rough total-size guard: drop the screenshot before failing the write.
  if (JSON.stringify(cloudSave).length > 950_000) cloudSave.screenshot = null;
  return cloudSave;
}

async function cloudPushSavesSafe(saves) {
  if (!cloudAvailable() || !saves?.length) return;
  try {
    const prepared = [];
    for (const save of saves) prepared.push(await prepareSaveForCloud(save));
    await window.SnprFirebaseAuth.cloudPushSaves(prepared);
    await cloudSyncMetaSafe();
    showToast(`☁ Synced ${prepared.length} snip${prepared.length !== 1 ? "s" : ""} to web app`);
  } catch (err) {
    console.error("Snipr: cloud sync failed", err);
    showToast("Cloud sync failed — saved locally", "error");
  }
}

async function cloudDeleteSaveSafe(saveId) {
  if (!cloudAvailable()) return;
  try {
    await window.SnprFirebaseAuth.cloudDeleteSave(saveId);
  } catch (err) {
    console.error("Snipr: cloud delete failed", err);
  }
}

async function cloudSyncMetaSafe() {
  if (!cloudAvailable()) return;
  try {
    await window.SnprFirebaseAuth.cloudSyncMeta(state.folders, state.categories);
  } catch (err) {
    console.error("Snipr: meta sync failed", err);
  }
}

async function cloudSyncAllSaves() {
  if (!cloudAvailable()) return showToast("Sign in first", "error");
  const statusEl = $("sync-status");
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Syncing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SAVES" });
    const saves = res.saves || [];
    if (!saves.length) {
      statusEl.textContent = "Nothing to sync.";
      return;
    }
    const prepared = [];
    for (let i = 0; i < saves.length; i++) {
      statusEl.textContent = `Preparing ${i + 1} of ${saves.length}…`;
      prepared.push(await prepareSaveForCloud(saves[i]));
    }
    statusEl.textContent = "Uploading…";
    // Push in chunks to stay well under Firestore batch limits.
    for (let i = 0; i < prepared.length; i += 100) {
      await window.SnprFirebaseAuth.cloudPushSaves(prepared.slice(i, i + 100));
    }
    await cloudSyncMetaSafe();
    statusEl.textContent = `Synced ${prepared.length} snips ✓`;
    showToast(`☁ Synced ${prepared.length} snips to web app`);
  } catch (err) {
    console.error("Snipr: full sync failed", err);
    statusEl.textContent = "Sync failed. Try again.";
    showToast("Sync failed", "error");
  }
}

// ── Auth UI (Settings view) ───────────────────────────────────────────────────
function renderAuthUI() {
  const signedOut = $("auth-signed-out");
  const signedIn = $("auth-signed-in");
  if (!signedOut || !signedIn) return;
  if (cloud.user) {
    signedOut.classList.add("hidden");
    signedIn.classList.remove("hidden");
    $("auth-user-email").textContent = cloud.user.email || cloud.user.displayName || "account";
  } else {
    signedIn.classList.add("hidden");
    signedOut.classList.remove("hidden");
  }
}

function showAuthError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// The Snipr web app. Use http://localhost:8123 for local dev (and add the
// matching origin to manifest.json's externally_connectable).
const WEBAPP_URL = "https://snipr-gamma.vercel.app";

function openWebappAuth(mode) {
  const url = `${WEBAPP_URL}/?extid=${encodeURIComponent(chrome.runtime.id)}&mode=${mode}`;
  chrome.tabs.create({ url });
}

function wireAuthEvents() {
  const api = () => window.SnprFirebaseAuth;

  $("btn-sign-in")?.addEventListener("click", () => openWebappAuth("signin"));
  $("btn-sign-up")?.addEventListener("click", () => openWebappAuth("signup"));

  // The background service worker signs the extension in as soon as the
  // webapp hands off a token; if the popup happens to already be open,
  // refresh its auth UI immediately instead of waiting for a reopen.
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "AUTH_UPDATED") renderAuthUI();
  });

  $("btn-sign-out")?.addEventListener("click", async () => {
    await api().signOutUser();
    showToast("Signed out");
  });

  $("btn-sync-all")?.addEventListener("click", cloudSyncAllSaves);
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
      cloudSyncMetaSafe();
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
  a.download = `snipr-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Import ────────────────────────────────────────────────────────────────────
async function importVaultFromFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_e) {
    showToast("Not a valid JSON file", "error");
    return;
  }

  if (!parsed || !Array.isArray(parsed.saves)) {
    showToast("Doesn't look like a Snipr export", "error");
    return;
  }

  const res = await chrome.runtime.sendMessage({ type: "IMPORT_ALL", data: parsed });
  if (!res?.ok) {
    showToast("Import failed", "error");
    return;
  }

  await loadBootstrap();
  await loadLibrary();

  if (res.addedSaves?.length) cloudPushSavesSafe(res.addedSaves).catch(() => {});

  const parts = [`Imported ${res.importedSaves} snip${res.importedSaves !== 1 ? "s" : ""}`];
  if (res.skippedSaves) parts.push(`${res.skippedSaves} already in your library`);
  showToast(`✂ ${parts.join(" — ")}`);
}

// ── Event Wiring ──────────────────────────────────────────────────────────────
function wireEvents() {
  $("btn-scan").addEventListener("click", scanPage);

  $("btn-manual-pick")?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    } catch (_e) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/content.css"] }).catch(() => {});
    }
    // The picker runs entirely on-page — clicking the underlying page would
    // close this popup anyway, so close it now and pick back up on reopen.
    await chrome.tabs.sendMessage(tab.id, { type: "START_MANUAL_PICKER" });
    window.close();
  });

  $("btn-clear-selection").addEventListener("click", () => {
    state.selectedSections = [];
    state.selectedCategories.clear();
    syncListSelection();
    updateSavePanel();
    sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
  });

  $("btn-save").addEventListener("click", saveSelectedSections);

  $("btn-add-category").addEventListener("click", async () => {
    const val = $("new-category-input").value.trim();
    if (!val) return;
    await chrome.runtime.sendMessage({ type: "ADD_CATEGORY", category: val });
    state.categories.push(val);
    $("new-category-input").value = "";
    renderCategoryChips();
    cloudSyncMetaSafe();
  });
  $("new-category-input").addEventListener("keydown", e => {
    if (e.key === "Enter") $("btn-add-category").click();
  });

  $("btn-export").addEventListener("click", exportVault);

  $("btn-import").addEventListener("click", () => $("import-file-input").click());
  $("import-file-input").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await importVaultFromFile(file);
  });

  $("category-filter").addEventListener("change", e => {
    state.libraryCategoryFilter = e.target.value;
    loadLibrary();
  });

  $("btn-back-detail").addEventListener("click", () => showView("library"));

  $("btn-delete-detail").addEventListener("click", async () => {
    if (!state.detailSave) return;
    await chrome.runtime.sendMessage({ type: "DELETE_SAVE", saveId: state.detailSave.id });
    cloudDeleteSaveSafe(state.detailSave.id);
    state.detailSave = null;
    await loadLibrary();
    showView("library");
    showToast("Section deleted");
  });

  // Tab bar navigation
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const view = btn.getAttribute("data-view");
      if (view === "library") {
        await loadBootstrap();
        await loadLibrary();
      } else if (view === "settings") {
        await loadBootstrap();
        renderFolderManager();
        renderCategoryManager();
      }
      showView(view);
    });
  });

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
      cloudSyncMetaSafe();
    }
  });

}

// If "Pick element manually" was used, the popup closed itself while the user
// picked an element on the page. Reopening the popup is the only way to
// continue that flow — pull the resulting selection back in here.
async function rehydratePendingManualPick(tab) {
  const { pendingManualPick } = await chrome.storage.local.get("pendingManualPick");
  if (!pendingManualPick) return;
  await chrome.storage.local.remove("pendingManualPick");
  if (pendingManualPick.tabId !== tab.id) return;

  const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTED_SECTIONS" });
  const selected = res?.selected || [];
  if (!selected.length) return;

  state.selectedSections = selected;
  syncListSelection();
  updateSavePanel();
  showToast("Custom element added — ready to snip!");
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  wireEvents();
  wireAuthEvents();
  initCloud();
  await loadBootstrap();
  showView("capture");
  const tab = await getActiveTab();
  if (tab?.url && !tab.url.startsWith("chrome://")) {
    $("page-title").textContent = tab.title || tab.url;
    await scanPage().catch(() => {});
    await rehydratePendingManualPick(tab).catch(() => {});
  }
})();