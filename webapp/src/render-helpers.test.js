import { describe, it, expect, vi } from "vitest";
import {
  hostnameOf,
  escapeHtml,
  htmlPreviewSnippet,
  cardThumbHtml,
  extractCodeParts,
  buildCodeOptions,
  sanitizeSvg,
  safeImageUrl,
  renderDetailAssets,
  wireAssetClicks,
} from "./render-helpers.js";

describe("hostnameOf", () => {
  it("extracts the hostname from a URL", () => {
    expect(hostnameOf("https://www.example.com/path?q=1")).toBe("www.example.com");
  });

  it("falls back to the raw input for an invalid URL instead of throwing", () => {
    expect(hostnameOf("not a url")).toBe("not a url");
  });

  it("returns an empty string for undefined", () => {
    expect(hostnameOf(undefined)).toBe("");
  });
});

describe("escapeHtml", () => {
  it("escapes all five reserved HTML characters", () => {
    expect(escapeHtml(`<div class="x" data-y='z'>&`)).toBe(
      "&lt;div class=&quot;x&quot; data-y=&#039;z&#039;&gt;&amp;"
    );
  });

  it("neutralizes a script tag so it renders as inert text, not markup", () => {
    const escaped = escapeHtml("<script>alert(1)</script>");
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("returns an empty string for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("htmlPreviewSnippet", () => {
  it("truncates long HTML and appends an ellipsis", () => {
    const long = "<div>" + "x".repeat(400) + "</div>";
    const snippet = htmlPreviewSnippet(long);
    expect(snippet.length).toBeLessThanOrEqual(281);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("leaves short HTML untouched aside from line breaks between tags", () => {
    expect(htmlPreviewSnippet("<div><span>hi</span></div>")).toBe("<div>\n<span>hi</span>\n</div>");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlPreviewSnippet("")).toBe("");
  });
});

describe("cardThumbHtml", () => {
  it("prefers the screenshot when one is present", () => {
    const html = cardThumbHtml({ screenshot: "data:image/jpeg;base64,abc", label: "Hero", html: "<div></div>" });
    expect(html).toContain("<img");
    expect(html).not.toContain("save-card-thumb--code");
  });

  it("falls back to a code preview when there's HTML but no screenshot", () => {
    const html = cardThumbHtml({ html: "<div>hello</div>", label: "Hero" });
    expect(html).toContain("save-card-thumb--code");
    expect(html).toContain("hello");
  });

  it("falls back to the empty placeholder when there's neither", () => {
    const html = cardThumbHtml({ label: "Hero" });
    expect(html).toContain("save-card-thumb--empty");
  });

  it("escapes the label even in the code-preview branch", () => {
    const html = cardThumbHtml({ html: "<div></div>", label: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
});

describe("extractCodeParts", () => {
  it("splits inline <style> and <script> out of the markup", () => {
    const parts = extractCodeParts(`
      <div class="hero">
        <style>.hero { color: red; }</style>
        <script>console.log("hi")</script>
        <h1>Title</h1>
      </div>
    `);
    expect(parts.css).toContain("color: red");
    expect(parts.js).toContain('console.log("hi")');
    expect(parts.html).not.toContain("<style>");
    expect(parts.html).not.toContain("<script>");
    expect(parts.html).toContain("<h1>Title</h1>");
  });

  it("collects external stylesheet and script src URLs separately", () => {
    const parts = extractCodeParts(`
      <div>
        <link rel="stylesheet" href="https://example.com/style.css">
        <script src="https://example.com/app.js"></script>
      </div>
    `);
    expect(parts.externals.css).toEqual(["https://example.com/style.css"]);
    expect(parts.externals.js).toEqual(["https://example.com/app.js"]);
  });

  it("returns empty parts for empty input without throwing", () => {
    const parts = extractCodeParts("");
    expect(parts.html).toBe("");
    expect(parts.css).toBe("");
    expect(parts.js).toBe("");
  });
});

describe("buildCodeOptions", () => {
  it("always includes HTML/CSS/JS options, with placeholders when empty", () => {
    const options = buildCodeOptions("<div>plain</div>");
    const keys = options.map(o => o.key);
    expect(keys).toEqual(["html", "css", "js"]);
    expect(options.find(o => o.key === "js").value).toContain("none found");
  });

  it("adds external URL options only when they exist", () => {
    const options = buildCodeOptions('<link rel="stylesheet" href="https://x.com/a.css">');
    expect(options.map(o => o.key)).toContain("css-urls");
    expect(options.map(o => o.key)).not.toContain("js-urls");
  });
});

describe("sanitizeSvg", () => {
  it("strips <script> tags and on* attributes from SVG markup", () => {
    const dirty = `<svg onload="alert(1)"><script>alert(2)</script><rect onclick="alert(3)" /></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("<script>");
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
  });

  it("returns an empty string for unparseable input rather than throwing", () => {
    expect(sanitizeSvg("not svg at all <<<")).toBe("");
  });
});

describe("safeImageUrl", () => {
  it("allows http/https URLs", () => {
    expect(safeImageUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  it("blocks javascript: and other unsafe schemes", () => {
    expect(safeImageUrl("javascript:alert(1)")).toBe("");
  });

  it("returns an empty string for invalid input", () => {
    expect(safeImageUrl("not a url")).toBe("");
  });
});

describe("renderDetailAssets", () => {
  it("returns an empty string when there are no assets", () => {
    expect(renderDetailAssets(null)).toBe("");
    expect(renderDetailAssets({ fonts: [], colors: [], images: [], svgs: [] })).toBe("");
  });

  it("renders a section per non-empty asset type", () => {
    const html = renderDetailAssets({ colors: ["#fff"], fonts: ["Inter"], images: [], svgs: [] });
    expect(html).toContain("Colors");
    expect(html).toContain("Fonts");
    expect(html).not.toContain("Images");
  });

  it("escapes color values so a malicious value can't break out of the style attribute", () => {
    const html = renderDetailAssets({ colors: ['red;"><script>alert(1)</script>'], fonts: [], images: [], svgs: [] });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("wireAssetClicks", () => {
  it("copies a color swatch's value to the clipboard on click", async () => {
    document.body.innerHTML = `<div id="c"><div class="asset-color-swatch" data-color="#ff0000"></div></div>`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const onToast = vi.fn();
    wireAssetClicks(document.getElementById("c"), onToast);
    document.querySelector(".asset-color-swatch").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("#ff0000"));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("#ff0000"));
  });

  it("reports a copy failure via the toast callback instead of throwing", async () => {
    document.body.innerHTML = `<div id="c"><div class="asset-color-swatch" data-color="#ff0000"></div></div>`;
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.assign(navigator, { clipboard: { writeText } });

    const onToast = vi.fn();
    wireAssetClicks(document.getElementById("c"), onToast);
    document.querySelector(".asset-color-swatch").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("Failed"), "error"));
  });
});
