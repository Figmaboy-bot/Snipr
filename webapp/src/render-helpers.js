// Pure rendering helpers shared between the authenticated library (app.js)
// and the public read-only share page (share.js).

export function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (_) { return url || ""; }
}

export function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(text || "").replace(/[&<>"']/g, m => map[m]);
}

export function htmlPreviewSnippet(html) {
  if (!html) return "";
  let formatted = html.replace(/></g, ">\n<").trim();
  if (formatted.length > 280) formatted = formatted.slice(0, 280) + "…";
  return formatted;
}

export function cardThumbHtml(save) {
  if (save.screenshot) {
    return `<div class="save-card-thumb"><img src="${save.screenshot}" alt="${escapeHtml(save.label)}" loading="lazy" /></div>`;
  }
  if (save.html) {
    return `<div class="save-card-thumb save-card-thumb--code">
      <span class="code-preview-badge">HTML</span>
      <pre class="save-card-code">${escapeHtml(htmlPreviewSnippet(save.html))}</pre>
    </div>`;
  }
  return `<div class="save-card-thumb save-card-thumb--empty"><span>📷</span></div>`;
}

export function extractCodeParts(sectionHtml) {
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

export function buildCodeOptions(sectionHtml) {
  const parts = extractCodeParts(sectionHtml);
  const options = [
    { key: "html", label: "HTML", value: parts.html || "/* (none found) */" },
    { key: "css", label: "CSS", value: parts.css || "/* (none found) */" },
    { key: "js", label: "JavaScript", value: parts.js || "/* (none found) */" },
  ];
  if (parts.externals.css.length) options.push({ key: "css-urls", label: "External CSS URLs", value: parts.externals.css.join("\n") });
  if (parts.externals.js.length) options.push({ key: "js-urls", label: "External JS URLs", value: parts.externals.js.join("\n") });
  return options;
}

export function sanitizeSvg(svgHtml) {
  try {
    const docp = new DOMParser().parseFromString(svgHtml, "image/svg+xml");
    // DOMParser never throws on malformed XML — it returns a document whose
    // root is a <parsererror> instead, which would otherwise get serialized
    // and rendered as literal error text in the SVG asset panel.
    if (docp.querySelector("parsererror")) return "";
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

export function safeImageUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") ? url : "";
  } catch (_) {
    return "";
  }
}

export function renderDetailAssets(assets) {
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

export function wireAssetClicks(container, onToast) {
  container.querySelectorAll(".asset-color-swatch[data-color]").forEach(swatch => {
    swatch.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(swatch.dataset.color);
        onToast(`Copied ${swatch.dataset.color}`);
      } catch (_) { onToast("Failed to copy color", "error"); }
    });
  });

  container.querySelectorAll(".asset-image-thumb[data-img-url]").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(thumb.dataset.imgUrl);
        onToast("Image URL copied");
      } catch (_) { onToast("Failed to copy", "error"); }
    });
  });

  container.querySelectorAll(".asset-svg-thumb").forEach(thumb => {
    thumb.addEventListener("click", async () => {
      const svgEl = thumb.querySelector("svg");
      if (!svgEl) return onToast("No SVG markup found", "error");
      try {
        await navigator.clipboard.writeText(svgEl.outerHTML);
        onToast("SVG copied");
      } catch (_) { onToast("Failed to copy SVG", "error"); }
    });
  });
}
