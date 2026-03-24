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
    { tag: "hero",    label: "Hero" },      // custom tag fallback
    { tag: "section", label: "Section" },
    { tag: "main",    label: "Main" },
    { tag: "aside",   label: "Sidebar" },
  ];

  // Class/id hints that help label a section
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

    // Also grab divs that have section-y class/id hints
    const divHints = Array.from(document.querySelectorAll("div[id], div[class]")).filter(el => {
      const combined = (el.id + " " + el.className);
      return HINT_MAP.some(({ pattern }) => pattern.test(combined));
    });

    const all = [...new Set([...rawEls, ...divHints])];

    // Filter: must be visible and reasonably sized
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

    // Notify popup of selection change
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

  // ── Screenshot capture via canvas ──────────────────────────────────────────

  function captureSection(sectionId) {
    const section = detectedSections.find(s => s.id === sectionId);
    if (!section) return null;

    const rect = section.el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  // ── Message Bridge ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {

      case "PING":
        sendResponse({ ready: true });
        break;

      case "GET_SECTIONS": {
        const sections = detectSections();
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

      case "GET_SELECTED_SECTIONS":
        sendResponse({ selected: getSelectedSections() });
        break;

      case "DEACTIVATE_OVERLAY":
        deactivateOverlay();
        sendResponse({ ok: true });
        break;

      case "GET_SECTION_RECT":
        sendResponse({ rect: captureSection(message.sectionId) });
        break;
    }
    return true; // keep channel open for async
  });

})();
