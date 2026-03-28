// DesignVault — Popup Logic

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
  auth:     $("view-auth"),
  capture:  $("view-capture"),
  library:  $("view-library"),
  detail:   $("view-detail"),
  settings: $("view-settings"),
};

const appHeader = $("app-header");

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name) {
  if (appHeader) {
    appHeader.style.display = name === "auth" ? "none" : "flex";
  }
  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
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

    const bgResponse = await chrome.runtime.sendMessage({
      type: "CAPTURE_SCREENSHOT",
      tabId: tab.id,
      windowId: tab.windowId,
      rect,
      dpr,
      viewportWidth,
      viewportHeight,
    });

    console.log("Background screenshot response:", bgResponse);
    return bgResponse?.screenshot || null;
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

// ── Save (with screenshot capture) ───────────────────────────────────────────
async function saveSelectedSections() {
  if (!state.selectedSections.length) return showToast("Select at least one section", "error");
  if (!state.selectedFolderId) return showToast("Pick a folder first", "error");

  const saveBtn = $("btn-save");
  const originalText = saveBtn.textContent;
  saveBtn.textContent = "Capturing…";
  saveBtn.disabled = true;

  try {
    const sectionsWithScreenshots = await Promise.all(
      state.selectedSections.map(async (section) => {
        try {
          console.log("Processing section:", section.id, section.label);
          const screenshot = await captureSectionScreenshot(section.id);
          console.log("Screenshot result for", section.id, ":", screenshot ? "success" : "null");
          
          return {
            ...section,
            screenshot: screenshot,
          };
        } catch (err) {
          console.error(`Error capturing section ${section.id}:`, err);
          return { ...section, screenshot: null };
        }
      })
    );

    console.log("Sections with screenshots:", sectionsWithScreenshots);

    saveBtn.textContent = "Saving…";

    const res = await chrome.runtime.sendMessage({
      type: "SAVE_SECTIONS",
      sections: sectionsWithScreenshots,
      folderId: state.selectedFolderId,
      categories: [...state.selectedCategories],
      note: $("note-input").value.trim(),
    });

    console.log("Save response:", res);

    saveBtn.textContent = originalText;
    saveBtn.disabled = false;

    if (res.ok) {
      showToast(`✓ Saved ${res.saved} section${res.saved !== 1 ? "s" : ""}!`);
      state.selectedSections = [];
      state.selectedCategories.clear();
      $("note-input").value = "";
      syncListSelection();
      updateSavePanel();
      sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
      $("sections-list").classList.add("hidden");
      $("section-count").textContent = "0 sections found";
      $("empty-state").classList.remove("hidden");
    } else {
      showToast("Failed to save sections", "error");
    }
  } catch (err) {
    console.error("Save failed:", err);
    showToast("Error saving sections", "error");
    saveBtn.textContent = originalText;
    saveBtn.disabled = false;
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
  $("btn-scan").addEventListener("click", scanPage);

  $("btn-clear-selection").addEventListener("click", () => {
    state.selectedSections = [];
    state.selectedCategories.clear();
    syncListSelection();
    updateSavePanel();
    sendToContent({ type: "DEACTIVATE_OVERLAY" }).catch(() => {});
    scanPage();
  });

  $("btn-save").addEventListener("click", saveSelectedSections);

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

  $("btn-back-detail").addEventListener("click", async () => {
    await loadLibrary();
    showView("library");
  });

  $("btn-delete-detail").addEventListener("click", async () => {
    if (!state.detailSave) return;
    await chrome.runtime.sendMessage({ type: "DELETE_SAVE", saveId: state.detailSave.id });
    state.detailSave = null;
    await loadLibrary();
    showView("library");
    showToast("Section deleted");
  });

  $("btn-settings").addEventListener("click", async () => {
    await loadBootstrap();
    renderFolderManager();
    renderCategoryManager();
    showView("settings");
  });

  $("btn-back-settings").addEventListener("click", () => showView("capture"));

  $("btn-sign-out").addEventListener("click", async () => {
    const authApi = window.SnprFirebaseAuth;
    if (!authApi) return;
    try {
      await authApi.signOutUser();
      showView("auth");
      showToast("Signed out");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Sign out failed", "error");
    }
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
    }
  });
}

function wireAuthEvents(authApi) {
  const errEl = $("auth-error");
  const showErr = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  const hideErr = () => errEl?.classList.add("hidden");

  $("auth-show-signup")?.addEventListener("click", () => {
    $("auth-login-panel")?.classList.add("hidden");
    $("auth-signup-panel")?.classList.remove("hidden");
    hideErr();
  });
  $("auth-show-login")?.addEventListener("click", () => {
    $("auth-signup-panel")?.classList.add("hidden");
    $("auth-login-panel")?.classList.remove("hidden");
    hideErr();
  });

  $("auth-login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const email = $("auth-login-email")?.value.trim();
    const password = $("auth-login-password")?.value || "";
    try {
      await authApi.signInEmailPassword(email, password);
    } catch (err) {
      showErr(err.message || "Sign in failed");
    }
  });

  $("auth-signup-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const email = $("auth-signup-email")?.value.trim();
    const password = $("auth-signup-password")?.value || "";
    try {
      await authApi.signUpEmailPassword(email, password);
    } catch (err) {
      showErr(err.message || "Sign up failed");
    }
  });

  $("btn-auth-google")?.addEventListener("click", async () => {
    hideErr();
    try {
      await authApi.signInWithGoogleChrome();
    } catch (err) {
      showErr(err.message || "Google sign-in failed");
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  showView("auth");

  const authApi = window.SnprFirebaseAuth;
  if (!authApi) {
    showToast("Auth script missing. Run npm install && npm run build:auth", "error");
    return;
  }

  const init = authApi.initFirebase();
  if (!init.ok) {
    $("auth-error")?.classList.remove("hidden");
    if ($("auth-error")) $("auth-error").textContent = init.error || "Firebase not configured";
    wireEvents();
    wireAuthEvents(authApi);
    return;
  }

  wireEvents();
  wireAuthEvents(authApi);

  authApi.subscribeAuth(async (user) => {
    if (user) {
      await loadBootstrap();
      const emailEl = $("header-user-email");
      if (emailEl) {
        const label = user.email || user.displayName || "";
        emailEl.textContent = label;
        emailEl.style.display = label ? "inline" : "none";
      }
      showView("capture");
      const tab = await getActiveTab();
      if (tab?.url && !tab.url.startsWith("chrome://")) {
        $("page-title").textContent = tab.title || tab.url;
        await scanPage().catch(() => {});
      }
    } else {
      const emailEl = $("header-user-email");
      if (emailEl) {
        emailEl.textContent = "";
        emailEl.style.display = "none";
      }
      showView("auth");
    }
  });
})();