// DesignVault Content Script
// Detects semantic sections and manages highlight/selection overlay

(function () {
  if (window.__designVaultLoaded) return;
  window.__designVaultLoaded = true;

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

    const all = [...new Set([...rawEls, ...divHints])];

    return all
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 100 &&
          rect.height > 40
        );
      })
      .map((el, idx) => ({
        id: `dv-section-${idx}`,
        label: labelFromElement(el),
        el,
      }));
  }

  // ── Overlay / Highlight UI ─────────────────────────────────────────────────

  let detectedSections = [];
  let overlayActive = false;
  const highlightedEls = new Set();

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
        html: s.el.outerHTML,
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
          activateOverlay(sections);
          sendResponse({
            sections: sections.map(s => ({
              id: s.id,
              label: s.label,
              url: window.location.href,
              title: document.title,
            })),
          });
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
          const rect = captureSection(message.sectionId);
          console.log("Captured rect:", rect);
          sendResponse({ rect });
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