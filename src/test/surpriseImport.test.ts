/**
 * Tests for src/lib/surpriseImport.ts — zip / html / css / js import.
 *
 * Zips are built in-test with JSZip. Notes on what is and isn't covered:
 *  - Image re-encoding (canvas) needs a real browser; here createImageBitmap
 *    doesn't exist so optimizeImage() correctly returns null and the
 *    original bytes + size limits apply. The canvas path was exercised in
 *    headless Chromium separately (see .ai/CHANGELOG.md).
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { ImportError, importSurpriseFiles } from "@/lib/surpriseImport";
import { SURPRISE_LIMITS } from "@/lib/surpriseDocument";

const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);
// 1x1 PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const makeZip = async (files: Record<string, string | Uint8Array>, name = "site.zip") => {
  const z = new JSZip();
  for (const [p, c] of Object.entries(files)) z.file(p, c);
  const data = await z.generateAsync({ type: "uint8array" });
  return new File([data], name, { type: "application/zip" });
};

const file = (name: string, text: string) => new File([text], name);

describe("importSurpriseFiles — zip", () => {
  it("splits an entry page into HTML / CSS / JS, inlines local media, strips the top folder", async () => {
    const zip = await makeZip({
      "love/index.html": `<!doctype html><html lang="en" class="rose"><head><title>Our Love</title>
        <link rel="stylesheet" href="css/style.css"><style>.inline{color:#fff}</style></head>
        <body class="stage" onload="window.loaded=1"><h1 id="t" onclick="go()">Hi</h1>
        <img id="p" src="img/heart.png"><audio src="snd/pop.wav"></audio>
        <script>const message = "hello"; function go(){ window.m = message }</script>
        <script src="js/app.js"></script></body></html>`,
      "love/css/style.css": ".stage{color:red} #p{background:url(../img/heart.png)}",
      "love/js/app.js": "window.app = 1;",
      "love/img/heart.png": PNG,
      "love/snd/pop.wav": bytes(500),
      "__MACOSX/love/._index.html": "junk",
      "love/.DS_Store": "junk",
    });
    const r = await importSurpriseFiles([zip]);

    expect(r.report.source).toBe("zip");
    expect(r.report.entry).toBe("index.html");
    expect(r.title).toBe("Our Love");

    // HTML: markup only — no <style>/<script>/<link>, shell attrs in the marker
    expect(r.html).toContain("<!--ds-import:");
    expect(r.html).toContain('"class":"stage"');
    expect(r.html).toContain('onload');
    expect(r.html).toContain('<h1 id="t" onclick="go()">Hi</h1>');
    expect(r.html).not.toMatch(/<script|<style|<link/i);
    expect(r.html).toMatch(/<img id="p" src="data:image\/png;base64,/);
    expect(r.html).toMatch(/<audio src="data:audio\/wav;base64,/);

    // CSS: linked file first, then <style>, url() inlined
    expect(r.css).toContain(".stage{color:red}");
    expect(r.css).toContain(".inline{color:#fff}");
    expect(r.css.indexOf(".stage")).toBeLessThan(r.css.indexOf(".inline"));
    expect(r.css).toMatch(/url\("data:image\/png;base64,/);
    expect(r.css).not.toContain("../img/heart.png");

    // JS: inline script, then app.js, in document order
    expect(r.js).toContain('const message = "hello"');
    expect(r.js).toContain("window.app = 1;");
    expect(r.js.indexOf("message")).toBeLessThan(r.js.indexOf("window.app"));

    expect(r.report.cssFiles).toEqual(["css/style.css"]);
    expect(r.report.jsFiles).toEqual(["js/app.js"]);
    expect(r.report.inlined.map((i) => i.path).sort()).toEqual(["img/heart.png", "snd/pop.wav"]);
    expect(r.report.unresolved).toEqual([]);
  });

  it("leaves JS blank when the page has no script", async () => {
    const zip = await makeZip({ "index.html": "<html><head><style>h1{color:red}</style></head><body><h1>x</h1></body></html>" });
    const r = await importSurpriseFiles([zip]);
    expect(r.js).toBe("");
    expect(r.report.jsFiles).toEqual([]);
    expect(r.css).toBe("h1{color:red}");
  });

  it("keeps remote scripts/stylesheets as tags and inlines local assets referenced from JS strings", async () => {
    const zip = await makeZip({
      "index.html": `<html><head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
        <script src="https://cdn.example.com/confetti.js"></script></head>
        <body><script>const a = new Audio("sound/kiss.wav"); const other = "not-a-file.png";</script></body></html>`,
      "sound/kiss.wav": bytes(300),
    });
    const r = await importSurpriseFiles([zip]);
    expect(r.html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">');
    expect(r.html).toContain('<script src="https://cdn.example.com/confetti.js"></script>');
    expect(r.js).toMatch(/new Audio\("data:audio\/wav;base64,/);
    expect(r.js).toContain('"not-a-file.png"'); // strings that aren't real uploaded files are untouched
  });

  it("reports (never silently drops) missing, oversize and over-budget assets", async () => {
    const big = bytes(SURPRISE_LIMITS.maxAssetBytes + 10, 3);
    const zip = await makeZip({
      "index.html": '<img src="gone.png"><audio src="huge.mp3"></audio><img src="ok.png">',
      "huge.mp3": big,
      "ok.png": PNG,
    });
    const r = await importSurpriseFiles([zip]);
    const skipped = Object.fromEntries(r.report.skipped.map((s) => [s.path, s.reason]));
    expect(skipped["gone.png"]).toMatch(/not found/);
    expect(skipped["huge.mp3"]).toMatch(/limit/);
    expect(r.report.inlined.map((i) => i.path)).toEqual(["ok.png"]);
    expect(r.report.unresolved).toEqual(expect.arrayContaining(["gone.png", "huge.mp3"]));
  });

  it("prefers index.html and warns about other pages; ES-module scripts with imports are skipped, not mangled", async () => {
    const zip = await makeZip({
      "pages/other.html": "<p>other</p>",
      "index.html": '<body><p>main</p><script type="module" src="m.js"></script></body>',
      "m.js": 'import x from "./y.js"; console.log(x);',
    });
    const r = await importSurpriseFiles([zip]);
    expect(r.report.entry).toBe("index.html");
    expect(r.report.warnings.join(" ")).toMatch(/2 HTML pages/);
    expect(r.report.skipped.some((s) => s.path === "m.js" && /module/i.test(s.reason))).toBe(true);
    expect(r.html).not.toContain("import x");
  });

  it("carries body/html attributes and inlines url() in body style attributes", async () => {
    const zip = await makeZip({
      "index.html": '<html data-theme="dark"><body style="background:url(bg.png)" class="c"><p>x</p></body></html>',
      "bg.png": PNG,
    });
    const r = await importSurpriseFiles([zip]);
    expect(r.html).toContain('"data-theme":"dark"');
    expect(r.html).toMatch(/"style":"background:url\(\\?"?data:image\/png;base64,/);
  });

  it("rejects a corrupt zip, an empty zip, and a zip mixed with other files", async () => {
    await expect(importSurpriseFiles([new File(["not a zip"], "x.zip", { type: "application/zip" })]))
      .rejects.toMatchObject({ code: "corrupt" });
    await expect(importSurpriseFiles([await makeZip({ ".DS_Store": "x" })]))
      .rejects.toMatchObject({ code: "empty" });
    await expect(importSurpriseFiles([await makeZip({ "index.html": "x" }), file("a.css", "a{}")]))
      .rejects.toMatchObject({ code: "not_supported" });
  });

  it("ignores path-traversal entries", async () => {
    const zip = await makeZip({ "index.html": "<p>x</p>", "../evil.html": "<p>evil</p>" });
    const r = await importSurpriseFiles([zip]);
    expect(r.report.entry).toBe("index.html");
    expect(r.html).not.toContain("evil");
  });
});

describe("importSurpriseFiles — individual files", () => {
  it("wires separately picked html + css + js together by name", async () => {
    const r = await importSurpriseFiles([
      file("page.html", '<body class="k"><h1>flat</h1><link rel="stylesheet" href="flat.css"><script src="flat.js"></script></body>'),
      file("flat.css", ".k{background:#123}"),
      file("flat.js", "window.flat = 1;"),
    ]);
    expect(r.report.source).toBe("files");
    expect(r.html).toContain("<h1>flat</h1>");
    expect(r.html).not.toMatch(/<script|<link/i);
    expect(r.css).toContain(".k{background:#123}");
    expect(r.js).toBe("window.flat = 1;");
  });

  it("includes picked css/js even if the html doesn't reference them", async () => {
    const r = await importSurpriseFiles([file("a.html", "<p>x</p>"), file("b.css", "p{color:red}"), file("c.js", "1+1")]);
    expect(r.css).toContain("p{color:red}");
    expect(r.js).toBe("1+1");
  });

  it("css + js only → HTML stays empty", async () => {
    const r = await importSurpriseFiles([file("s.css", "a{}"), file("s.js", "x()")]);
    expect(r.html).toBe("");
    expect(r.css).toContain("a{}");
    expect(r.js).toBe("x()");
  });

  it("html only → CSS and JS stay empty", async () => {
    const r = await importSurpriseFiles([file("only.html", "<p>hello</p>")]);
    expect(r.css).toBe("");
    expect(r.js).toBe("");
    expect(r.title).toBe("only");
  });

  it("rejects files that aren't html/css/js", async () => {
    await expect(importSurpriseFiles([file("notes.txt", "hi")])).rejects.toBeInstanceOf(ImportError);
  });
});
