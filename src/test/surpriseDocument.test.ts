/**
 * Tests for src/lib/surpriseDocument.ts — the builder that turns a surprise's
 * html/css/js into the document rendered inside the sandboxed iframe, plus
 * its URL-normalization and lint helpers.
 *
 * Scope note: these are string-level tests. The behaviours that need a real
 * browser (const-scoped inline handlers, @import ordering, autoplay
 * recovery, localStorage shim, link forwarding) were verified separately in
 * headless Chromium against both the old and new builder — see
 * .ai/CHANGELOG.md. WebView-specific behaviour (mixed content, Drive/Dropbox
 * hot-link behaviour) is NOT covered anywhere and is not verifiable here.
 */
import { describe, it, expect } from "vitest";
import {
  buildSurpriseDocument,
  encodeImportMarker,
  findUnresolvedLocalRefs,
  normalizeMediaUrl,
  normalizeSurpriseUrls,
  parseImportMarker,
  stripInlineData,
  type SurpriseDraft,
} from "@/lib/surpriseDocument";

const draft = (o: Partial<SurpriseDraft> = {}): SurpriseDraft => ({
  title: "t", max_views: 1, html_content: "", css_content: "", js_content: "", ...o,
});

describe("buildSurpriseDocument", () => {
  it("runs creator JS as a plain global script — not wrapped in try{}", () => {
    const doc = buildSurpriseDocument(draft({ js_content: "const go = () => 1;" }));
    const script = doc.slice(doc.indexOf('id="ds-user-js"'));
    expect(script).toContain("const go = () => 1;");
    expect(script).not.toMatch(/try\s*\{/);
  });

  it("emits no user <script> at all when the JS is blank", () => {
    expect(buildSurpriseDocument(draft({ js_content: "" }))).not.toContain('id="ds-user-js"');
    expect(buildSurpriseDocument(draft({ js_content: "   \n " }))).not.toContain('id="ds-user-js"');
  });

  it("puts creator CSS in its own <style> AFTER the base rules so a leading @import stays valid", () => {
    const doc = buildSurpriseDocument(draft({ css_content: '@import url("x.css"); .a{color:red}' }));
    const base = doc.indexOf('id="ds-base"');
    const user = doc.indexOf('id="ds-user"');
    expect(base).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(base);
    const userBlock = doc.slice(user, doc.indexOf("</style>", user));
    expect(userBlock).toContain('@import url("x.css")');
    // nothing but the tag opener precedes the @import inside its own <style>
    expect(userBlock.replace(/^[^>]*>\s*/, "")).toMatch(/^@import/);
  });

  it("neutralizes </script and </style sequences inside creator code", () => {
    const doc = buildSurpriseDocument(draft({
      js_content: 'document.write("</script><b>x</b>")',
      css_content: "/* </style><script>alert(1)</script> */",
    }));
    expect(doc).not.toContain('"</script><b>');
    expect(doc).not.toContain("/* </style><script>alert(1)");
  });

  it("escapes the title", () => {
    const doc = buildSurpriseDocument(draft({ title: "</title><script>x</script>" }));
    expect(doc).toContain("<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>");
  });

  it("loads the runtime before creator code and sends no referrer", () => {
    const doc = buildSurpriseDocument(draft({ js_content: "x()" }));
    expect(doc.indexOf('id="ds-runtime"')).toBeLessThan(doc.indexOf('id="ds-user-js"'));
    expect(doc).toContain('name="referrer" content="no-referrer"');
    expect(doc).toContain("upgrade-insecure-requests");
  });

  it("legacy (non-imported) surprises keep the old layout rules", () => {
    const doc = buildSurpriseDocument(draft({ html_content: "<p>hi</p>" }));
    expect(doc).toContain("overflow: hidden");
    expect(doc).toContain("box-sizing: border-box");
    // (the runtime mentions the attribute name, so look for the attribute itself)
    expect(doc).not.toContain('data-ds-page=""');
  });

  it("imported surprises render as a page and carry <html>/<body> attributes", () => {
    const marker = encodeImportMarker({
      htmlAttrs: { lang: "fr", class: "theme-rose" },
      bodyAttrs: { class: "stage", onload: "window.x=1" },
    });
    const doc = buildSurpriseDocument(draft({ html_content: `${marker}<h1>hi</h1>` }));
    expect(doc).toContain('<html lang="fr" class="theme-rose" data-ds-page="">');
    expect(doc).toContain('<body class="stage" onload="window.x=1">');
    expect(doc).toContain("<h1>hi</h1>");
    expect(doc).not.toContain("ds-import:");
    expect(doc).not.toContain("box-sizing: border-box");
  });

  it("ignores attribute names that aren't valid (no attribute injection)", () => {
    const marker = encodeImportMarker({ bodyAttrs: { 'x" onload="evil()': "1", ok: "yes" } });
    const doc = buildSurpriseDocument(draft({ html_content: `${marker}<p/>` }));
    expect(doc).toContain('ok="yes"');
    expect(doc).not.toContain("evil()");
  });
});

describe("import marker", () => {
  it("round-trips, even when attribute values contain --> or quotes", () => {
    const shell = { htmlAttrs: { "data-x": 'a-->b "q" <c>' }, bodyAttrs: { class: "k" } };
    const encoded = encodeImportMarker(shell) + "<p>rest</p>";
    const { shell: parsed, rest } = parseImportMarker(encoded);
    expect(parsed).toEqual(shell);
    expect(rest).toBe("<p>rest</p>");
  });

  it("returns the input untouched when there is no marker", () => {
    expect(parseImportMarker("<p>x</p>")).toEqual({ shell: null, rest: "<p>x</p>" });
  });
});

describe("normalizeMediaUrl", () => {
  it("rewrites Google Drive share links to direct endpoints", () => {
    const u = "https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing";
    expect(normalizeMediaUrl(u, "image")).toBe("https://drive.google.com/uc?export=view&id=1AbC_dEf-123");
    expect(normalizeMediaUrl(u, "media")).toBe("https://drive.google.com/uc?export=download&id=1AbC_dEf-123");
    expect(normalizeMediaUrl("https://drive.google.com/open?id=1AbC_dEf-123")).toBe(
      "https://drive.google.com/uc?export=view&id=1AbC_dEf-123"
    );
  });

  it("rewrites Dropbox and GitHub blob links", () => {
    expect(normalizeMediaUrl("https://www.dropbox.com/s/abc/song.mp3?dl=0")).toBe("https://www.dropbox.com/s/abc/song.mp3?raw=1");
    expect(normalizeMediaUrl("https://www.dropbox.com/s/abc/song.mp3")).toBe("https://www.dropbox.com/s/abc/song.mp3?raw=1");
    expect(normalizeMediaUrl("https://github.com/u/r/blob/main/a/b.png")).toBe("https://raw.githubusercontent.com/u/r/main/a/b.png");
  });

  it("forces protocol-relative URLs to https and leaves normal URLs alone", () => {
    expect(normalizeMediaUrl("//cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
    expect(normalizeMediaUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(normalizeMediaUrl("http://example.com/a.png")).toBe("http://example.com/a.png"); // upgraded by the frame's CSP, not rewritten
  });
});

describe("normalizeSurpriseUrls", () => {
  it("rewrites every URL attribute on a tag, not just the first", () => {
    const { html } = normalizeSurpriseUrls({
      html: '<video src="https://drive.google.com/file/d/AAA/view" poster="//cdn.x.com/p.jpg"></video>',
      css: "", js: "",
    });
    expect(html).toContain("uc?export=download&amp;id=AAA");
    expect(html).toContain('poster="https://cdn.x.com/p.jpg"');
  });

  it("does NOT rewrite ordinary links, or share links outside media contexts", () => {
    const link = '<a href="https://drive.google.com/file/d/AAA/view">keep me</a>';
    const { html, js } = normalizeSurpriseUrls({
      html: link, css: "",
      js: 'var u = "https://drive.google.com/file/d/AAA/view";',
    });
    expect(html).toBe(link);
    expect(js).toContain("drive.google.com/file/d/AAA/view");
  });

  it("rewrites CSS url() and @import, and JS new Audio()/.src", () => {
    const out = normalizeSurpriseUrls({
      html: "",
      css: '.a{background:url(https://www.dropbox.com/s/q/i.png?dl=0)} @import "//fonts.googleapis.com/css?family=X";',
      js: 'new Audio("https://www.dropbox.com/s/q/s.mp3?dl=0"); img.src = "//cdn.x.com/a.png";',
    });
    expect(out.css).toContain("url(https://www.dropbox.com/s/q/i.png?raw=1)");
    expect(out.css).toContain('@import "https://fonts.googleapis.com/css?family=X"');
    expect(out.js).toContain('new Audio("https://www.dropbox.com/s/q/s.mp3?raw=1")');
    expect(out.js).toContain('img.src = "https://cdn.x.com/a.png"');
  });

  it("leaves data: URIs alone", () => {
    const html = '<img src="data:image/png;base64,AAAA">';
    expect(normalizeSurpriseUrls({ html, css: "", js: "" }).html).toBe(html);
  });
});

describe("findUnresolvedLocalRefs", () => {
  it("flags local files, skips remote/data/icon links", () => {
    const refs = findUnresolvedLocalRefs({
      html: '<img src="a/b.png"><img src="data:image/png;base64,AAAA"><img src="https://x/y.png"><link rel="stylesheet" href="s.css"><link rel="icon" href="f.ico"><video poster="p.jpg" src="//x/v.mp4">',
      css: '.a{background:url("../i.png")} .b{background:url(data:image/png;base64,AAAA)}',
      js: 'new Audio("sound.mp3"); new Audio("https://x/s.mp3")',
    });
    expect(refs).toEqual(expect.arrayContaining(["a/b.png", "s.css", "p.jpg", "../i.png", "sound.mp3"]));
    expect(refs).not.toContain("f.ico");
    expect(refs.some((r) => r.startsWith("data:") || r.startsWith("http") || r.startsWith("//"))).toBe(false);
  });

  it("treats ds-asset:// editor tokens as resolved", () => {
    expect(findUnresolvedLocalRefs({ html: '<img src="ds-asset://a1">', css: "", js: "" })).toEqual([]);
  });
});

describe("stripInlineData", () => {
  it("removes long base64 payloads only", () => {
    const big = "data:audio/mpeg;base64," + "A".repeat(200);
    expect(stripInlineData(`x ${big} y`)).toBe("x data: y");
    expect(stripInlineData("data:text/plain;base64,QQ==")).toBe("data:text/plain;base64,QQ==");
  });
});
