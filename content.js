// Snipr Content Script
// Detects semantic sections and manages highlight/selection overlay

(function () {
  if (window.__sniprLoaded) return;
  window.__sniprLoaded = true;

  // ── Section Detection ──────────────────────────────────────────────────────

  const SECTION_SELECTORS = [
    { tag: "header",  label: "Header" },
    { tag: "nav",     label: "Navbar" },
    { tag: "footer",  label: "Footer" },
    { tag: "hero",    label: "Hero" },
    { tag: "section", label: "Section" },
    { tag: "main",    label: "Main" },
    { tag: "aside",   label: "Sidebar" },
  ];

  const HINT_MAP = [
    { pattern: /hero/i,        label: "Hero" },
    { pattern: /banner/i,      label: "Banner" },
    { pattern: /nav|navbar|menu|topbar/i, label: "Navbar" },
    { pattern: /footer/i,      label: "Footer" },
    { pattern: /header/i,      label: "Header" },
    { pattern: /feature/i,     label: "Features" },
    { pattern: /pricing/i,     label: "Pricing" },
    { pattern: /testimonial|review/i, label: "Testimonials" },
    { pattern: /cta|call.to.action/i,  label: "CTA" },
    { pattern: /faq/i,         label: "FAQ" },
    { pattern: /team/i,        label: "Team" },
    { pattern: /blog|article|post/i,   label: "Blog" },
    { pattern: /contact/i,     label: "Contact" },
    { pattern: /gallery|portfolio/i,   label: "Gallery" },
    { pattern: /stat|metric|number/i,  label: "Stats" },
    { pattern: /logo/i,        label: "Logo" },
    { pattern: /sidebar|aside/i,       label: "Sidebar" },
  ];

  function labelFromElement(el) {
    const combined = [el.id, el.className, el.getAttribute("data-section") || ""].join(" ");
    for (const { pattern, label } of HINT_MAP) {
      if (pattern.test(combined)) return label;
    }
    const tag = el.tagName.toLowerCase();
    const match = SECTION_SELECTORS.find(s => s.tag === tag);
    return match ? match.label : "Section";
  }

  function detectSections() {
    const selectors = SECTION_SELECTORS.map(s => s.tag).join(", ");
    const rawEls = Array.from(document.querySelectorAll(selectors));

    const divHints = Array.from(document.querySelectorAll("div[id], div[class]")).filter(el => {
      const combined = (el.id + " " + el.className);
      return HINT_MAP.some(({ pattern }) => pattern.test(combined));
    });

    const all = [...new Set([...rawEls, ...divHints])].sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const labeled = all.map(el => ({ el, label: labelFromElement(el) }));

    // Drop elements whose ancestor is also a candidate with the same label —
    // e.g. <nav class="navbar"> wrapping <div class="navbar-menu"> wrapping
    // <div class="navbar-links"> would otherwise report "Navbar" 3x. Different
    // labels are still allowed to nest (e.g. Main containing a Hero).
    const deduped = labeled.filter(({ el, label }) =>
      !labeled.some(other =>
        other.el !== el && other.label === label && other.el.contains(el)
      )
    );

    return deduped
      .filter(({ el }) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 100 &&
          rect.height > 40
        );
      })
      .map(({ el, label }, idx) => ({
        id: `dv-section-${idx}`,
        label,
        el,
      }));
  }

  // ── Overlay / Highlight UI ─────────────────────────────────────────────────

  let detectedSections = [];
  let overlayActive = false;
  const highlightedEls = new Set();

  // Clean injected overlay artifacts from saved HTML.
  // Without this, the saved snippet would include the `dv-badge` overlay nodes.
  function getCleanOuterHTML(el) {
    try {
      const clone = el.cloneNode(true);
      const badges = clone.querySelectorAll(".dv-badge");
      badges.forEach(b => b.remove());
      return clone.outerHTML;
    } catch (_e) {
      // Fallback: best-effort; never block saving.
      return el.outerHTML;
    }
  }

  function createBadge(label) {
    const badge = document.createElement("div");
    badge.className = "dv-badge";
    badge.textContent = label;
    return badge;
  }

  function activateOverlay(sections) {
    detectedSections = sections;
    overlayActive = true;

    sections.forEach(({ id, label, el }) => {
      el.setAttribute("data-dv-id", id);
      el.classList.add("dv-highlightable");

      const badge = createBadge(label);
      badge.setAttribute("data-dv-badge", id);
      el.appendChild(badge);

      el.addEventListener("mouseenter", onHover);
      el.addEventListener("mouseleave", onUnhover);
      el.addEventListener("click", onSectionClick, true);
    });
  }

  function deactivateOverlay() {
    overlayActive = false;
    detectedSections.forEach(({ el }) => {
      el.classList.remove("dv-highlightable", "dv-hovered", "dv-selected");
      el.removeEventListener("mouseenter", onHover);
      el.removeEventListener("mouseleave", onUnhover);
      el.removeEventListener("click", onSectionClick, true);
      const badge = el.querySelector(".dv-badge");
      if (badge) badge.remove();
    });
    highlightedEls.clear();
  }

  function onHover(e) {
    e.currentTarget.classList.add("dv-hovered");
  }

  function onUnhover(e) {
    e.currentTarget.classList.remove("dv-hovered");
  }

  function onSectionClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget;
    const id = el.getAttribute("data-dv-id");
    const section = detectedSections.find(s => s.id === id);
    if (!section) return;

    if (highlightedEls.has(id)) {
      highlightedEls.delete(id);
      el.classList.remove("dv-selected");
    } else {
      highlightedEls.add(id);
      el.classList.add("dv-selected");
    }

    chrome.runtime.sendMessage({
      type: "SECTION_SELECTION_CHANGED",
      selected: getSelectedSections(),
    });
  }

  function getSelectedSections() {
    return detectedSections
      .filter(s => highlightedEls.has(s.id))
      .map(s => ({
        id: s.id,
        label: s.label,
        html: getCleanOuterHTML(s.el),
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
      }));
  }

  // ── Screenshot Capture ────────────────────────────────────────────────────────
  function captureSection(sectionId) {
    console.log("captureSection called with:", sectionId);
    const section = detectedSections.find(s => s.id === sectionId);
    if (!section) {
      console.error("Section not found:", sectionId, "Available:", detectedSections.map(s => s.id));
      return null;
    }

    const domRect = section.el.getBoundingClientRect();
    console.log("Got domRect:", domRect);

    const result = {
      rect: {
        x: Math.round(domRect.left),
        y: Math.round(domRect.top),
        width: Math.round(domRect.width),
        height: Math.round(domRect.height),
      },
      dpr: window.devicePixelRatio || 1,
      viewportWidth:  window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    };
    console.log("Returning rect:", result);
    return result;
  }

  // ── Asset Extraction ─────────────────────────────────────────────────────────

  function rgbToHex(rgb) {
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]]
      .map(v => parseInt(v, 10).toString(16).padStart(2, "0"))
      .join("").toUpperCase();
  }

  const SYSTEM_FONTS = new Set([
    "-apple-system", "blinkmacsystemfont", "segoe ui", "system-ui",
    "arial", "helvetica", "times new roman", "courier new", "georgia",
    "verdana", "tahoma", "trebuchet ms", "impact", "comic sans ms",
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
  ]);

  function extractAssets(sectionEl) {
    const fontsMap  = new Map(); // font → count
    const colorsMap = new Map(); // hex  → count
    const images    = [];
    const svgs      = [];

    const allEls = [sectionEl, ...sectionEl.querySelectorAll("*")];

    allEls.forEach(node => {
      if (node.classList?.contains("dv-badge")) return;

      // ── Computed styles ──────────────────────────────────────────────────
      let style;
      try { style = window.getComputedStyle(node); } catch (_) { return; }

      // Fonts
      const ff = style.fontFamily || "";
      ff.split(",").forEach(f => {
        const clean = f.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
        if (clean && !SYSTEM_FONTS.has(clean)) {
          // Restore original casing from the raw string
          const original = f.trim().replace(/^["']|["']$/g, "").trim();
          fontsMap.set(original, (fontsMap.get(original) || 0) + 1);
        }
      });

      // Colors (text + background)
      ["color", "backgroundColor"].forEach(prop => {
        const val = style[prop];
        if (!val || val === "rgba(0, 0, 0, 0)" || val === "transparent") return;
        const hex = rgbToHex(val);
        if (hex) colorsMap.set(hex, (colorsMap.get(hex) || 0) + 1);
      });

      // SVG fill/stroke
      if (node.namespaceURI === "http://www.w3.org/2000/svg") {
        ["fill", "stroke"].forEach(prop => {
          const val = style[prop];
          if (!val || val === "none" || val === "rgba(0, 0, 0, 0)") return;
          const hex = rgbToHex(val);
          if (hex) colorsMap.set(hex, (colorsMap.get(hex) || 0) + 1);
        });
      }

      // ── <img> elements ───────────────────────────────────────────────────
      if (node.tagName === "IMG") {
        const src = node.src || node.getAttribute("src") || "";
        if (src && !src.startsWith("data:") && !images.includes(src)) {
          images.push(src);
        }
      }

      // ── CSS background-image URLs ────────────────────────────────────────
      const bgImg = style.backgroundImage;
      if (bgImg && bgImg !== "none") {
        const urlRe = /url\(["']?([^"')]+)["']?\)/g;
        let match;
        while ((match = urlRe.exec(bgImg)) !== null) {
          const src = match[1];
          if (!src.startsWith("data:") && !images.includes(src)) {
            try {
              images.push(new URL(src, location.href).href);
            } catch (_) {}
          }
        }
      }

      // ── Root-level inline SVGs ───────────────────────────────────────────
      const tag = node.tagName && node.tagName.toLowerCase();
      if (tag === "svg" && !node.parentElement?.closest("svg")) {
        const str = node.outerHTML || "";
        if (str.length < 12000) svgs.push(str);
      }
    });

    // Sort by frequency, take top values
    const sortByCount = map =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);

    return {
      fonts:  sortByCount(fontsMap).slice(0, 12),
      colors: sortByCount(colorsMap).slice(0, 28),
      images: images.slice(0, 20),
      svgs:   svgs.slice(0, 12),
    };
  }

  // ── Message Bridge ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log("Content script received message:", message.type, "sectionId:", message.sectionId);
    
    try {
      switch (message.type) {

        case "PING":
          console.log("PING - responding ready");
          sendResponse({ ready: true });
          break;

        case "GET_SECTIONS": {
          console.log("GET_SECTIONS - detecting sections");
          const sections = detectSections();
          console.log("Detected", sections.length, "sections");

          // Build the payload before overlay injection so `html` doesn't include overlay UI.
          const payloadSections = sections.map(s => ({
            id: s.id,
            label: s.label,
            url: window.location.href,
            title: document.title,
            html: getCleanOuterHTML(s.el),
          }));

          activateOverlay(sections);
          sendResponse({ sections: payloadSections });
          break;
        }

        case "GET_SELECTED_SECTIONS": {
          console.log("GET_SELECTED_SECTIONS");
          const selected = getSelectedSections();
          sendResponse({ selected });
          break;
        }

        case "DEACTIVATE_OVERLAY": {
          console.log("DEACTIVATE_OVERLAY");
          deactivateOverlay();
          sendResponse({ ok: true });
          break;
        }

        case "GET_SECTION_RECT": {
          console.log("GET_SECTION_RECT - sectionId:", message.sectionId);
          const section = detectedSections.find(s => s.id === message.sectionId);
          if (!section) {
            sendResponse({ rect: null });
            break;
          }
          // Scroll section into view, then wait for layout to settle before returning rect
          section.el.scrollIntoView({ behavior: "instant", block: "start" });
          setTimeout(() => {
            const rect = captureSection(message.sectionId);
            console.log("Captured rect:", rect);
            sendResponse({ rect });
          }, 120);
          break;
        }

        case "GET_SECTION_ASSETS": {
          const section = detectedSections.find(s => s.id === message.sectionId);
          if (!section) {
            sendResponse({ assets: null });
            break;
          }
          const assets = extractAssets(section.el);
          sendResponse({ assets });
          break;
        }

        default:
          console.log("Unknown message type:", message.type);
          sendResponse({ error: "Unknown message type" });
      }
    } catch (err) {
      console.error("Error in message handler:", err);
      sendResponse({ error: err.message });
    }
    
    return true;
  });

})();