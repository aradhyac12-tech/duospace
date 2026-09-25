/**
 * Surprise importer — turns uploaded files into the three editor fields.
 *
 *   • one .zip  → find the entry HTML, pull its <style>/<link rel=stylesheet>
 *                 into CSS, its classic <script> tags into JS, leave the
 *                 markup in HTML, and inline every local image / audio /
 *                 video / font it references as a data: URI
 *   • .html / .css / .js (any mix, multi-select) → same pipeline over a
 *                 flat set of files
 *
 * If the page has no script, the JS field stays EMPTY ("") — never a
 * placeholder comment.
 *
 * Why data: URIs (and not Storage URLs): a surprise renders inside a
 * sandboxed srcDoc frame with an opaque origin, so relative paths can never
 * resolve, and private-bucket signed URLs would expire inside stored
 * markup. Inlining keeps a surprise fully self-contained in its DB row.
 * The cost is row size, so every asset is budgeted (SURPRISE_LIMITS),
 * big raster images are re-encoded when the browser can, and anything that
 * still doesn't fit is reported by name rather than silently dropped.
 *
 * Pure browser code (DOMParser, Blob, canvas) — no network, no eval.
 */
import {
  SURPRISE_LIMITS,
  encodeImportMarker,
  findUnresolvedLocalRefs,
  type ImportShell,
} from "@/lib/surpriseDocument";

// ─── Public types ──────────────────────────────────────────────────────────

export type ImportSourceKind = "zip" | "files";

export interface ImportReport {
  source: ImportSourceKind;
  sourceName: string;
  /** Entry HTML path inside the zip / provided file name. Null = none. */
  entry: string | null;
  cssFiles: string[];
  jsFiles: string[];
  inlined: { path: string; bytes: number; optimized?: boolean }[];
  skipped: { path: string; reason: string }[];
  /** Local references still present after import (would render broken). */
  unresolved: string[];
  warnings: string[];
  totalAssetBytes: number;
  totalChars: number;
}

export interface ImportResult {
  title: string | null;
  html: string;
  css: string;
  js: string;
  report: ImportReport;
}

export class ImportError extends Error {
  code: "not_supported" | "too_large" | "empty" | "corrupt";
  constructor(code: ImportError["code"], message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

// ─── Virtual file system ───────────────────────────────────────────────────

interface VFile {
  path: string;
  size: number; // declared/known size in bytes (may be 0 if unknown)
  read: () => Promise<Uint8Array>;
}

class Vfs {
  private byPath = new Map<string, VFile>();
  private byLower = new Map<string, VFile>();
  private byBase = new Map<string, VFile[]>();
  private readBudget: number;

  constructor(maxUncompressed: number) {
    this.readBudget = maxUncompressed;
  }

  add(f: VFile) {
    this.byPath.set(f.path, f);
    this.byLower.set(f.path.toLowerCase(), f);
    const base = f.path.split("/").pop()!.toLowerCase();
    this.byBase.set(base, [...(this.byBase.get(base) ?? []), f]);
  }

  all(): VFile[] {
    return Array.from(this.byPath.values());
  }

  find(path: string): VFile | null {
    return this.byPath.get(path) ?? this.byLower.get(path.toLowerCase()) ?? null;
  }

  /** Unique-basename fallback: `assets/x.png` referenced, `x.png` present elsewhere. */
  findByBasename(path: string): VFile | null {
    const base = path.split("/").pop()!.toLowerCase();
    const hits = this.byBase.get(base) ?? [];
    return hits.length === 1 ? hits[0] : null;
  }

  async read(f: VFile): Promise<Uint8Array> {
    const bytes = await f.read();
    this.readBudget -= bytes.byteLength;
    if (this.readBudget < 0) {
      throw new ImportError("too_large", "The zip expands to more data than a surprise can hold.");
    }
    return bytes;
  }

  async readText(f: VFile): Promise<string> {
    const bytes = await this.read(f);
    return decodeText(bytes);
  }
}

// ─── Small utilities ───────────────────────────────────────────────────────

const decodeText = (bytes: Uint8Array): string => {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const extOf = (p: string) => {
  const base = p.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
};

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  json: "application/json", vtt: "text/vtt",
};

const RASTER_OPTIMIZABLE = new Set(["image/png", "image/jpeg"]);

const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
};

const fmtBytes = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;

/** Normalize a path inside the archive. Null = unsafe or unusable. */
const normalizeEntryPath = (raw: string): string | null => {
  const parts = raw.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  return out.length ? out.join("/") : null;
};

/** Resolve a reference found inside `fromDir` to an archive path. */
const resolveRef = (fromDir: string, ref: string): string | null => {
  let r = ref.trim().split("#")[0].split("?")[0];
  if (!r) return null;
  try { r = decodeURIComponent(r); } catch { /* keep raw */ }
  const isRootRelative = r.startsWith("/");
  const parts = (isRootRelative ? r : `${fromDir ? fromDir + "/" : ""}${r}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.length ? out.join("/") : null;
};

const isExternalRef = (v: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v.trim()) || v.trim() === "";

const replaceAsync = async (
  input: string,
  re: RegExp,
  fn: (match: RegExpExecArray) => Promise<string>
): Promise<string> => {
  const matches: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(input))) {
    matches.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  if (!matches.length) return input;
  const replacements = await Promise.all(matches.map(fn));
  let out = "";
  let last = 0;
  matches.forEach((match, i) => {
    out += input.slice(last, match.index) + replacements[i];
    last = match.index + match[0].length;
  });
  return out + input.slice(last);
};

const readBlob = async (blob: Blob): Promise<Uint8Array> => {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
};

/**
 * Re-encode a large PNG/JPEG smaller (max 1600px, WebP else JPEG) when the
 * browser can. Returns null when it can't or when the result isn't smaller —
 * callers then fall back to the original bytes. Never throws.
 */
const optimizeImage = async (bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string } | null> => {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }));
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const toBlob = (type: string, q: number) =>
      new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), type, q));
    const webp = await toBlob("image/webp", 0.82);
    if (webp && webp.type === "image/webp" && webp.size < bytes.byteLength) {
      return { bytes: await readBlob(webp), mime: "image/webp" };
    }
    // JPEG can't hold alpha — only fall back to it for sources that had none.
    if (mime === "image/jpeg") {
      const jpg = await toBlob("image/jpeg", 0.82);
      if (jpg && jpg.size < bytes.byteLength) return { bytes: await readBlob(jpg), mime: "image/jpeg" };
    }
    return null;
  } catch {
    return null;
  }
};

// ─── Import context (per run) ──────────────────────────────────────────────

class ImportContext {
  vfs: Vfs;
  report: ImportReport;
  private assetCache = new Map<string, Promise<string | null>>();
  private cssSeen = new Set<string>();

  constructor(vfs: Vfs, report: ImportReport) {
    this.vfs = vfs;
    this.report = report;
  }

  private skip(path: string, reason: string) {
    if (!this.report.skipped.some((s) => s.path === path)) this.report.skipped.push({ path, reason });
  }

  lookup(fromDir: string, ref: string): VFile | null {
    const p = resolveRef(fromDir, ref);
    if (!p) return null;
    return this.vfs.find(p) ?? this.vfs.findByBasename(p);
  }

  /** Inline one referenced file as a data: URI, honouring the budgets. */
  async inlineAsset(fromDir: string, ref: string): Promise<string | null> {
    if (isExternalRef(ref)) return null;
    const file = this.lookup(fromDir, ref);
    if (!file) {
      this.skip(ref.split("?")[0].split("#")[0], "referenced but not found in the upload");
      return null;
    }
    // Cache the PROMISE so concurrent references to the same file are
    // embedded (and budgeted) exactly once.
    let pending = this.assetCache.get(file.path);
    if (!pending) {
      pending = this.embed(file);
      this.assetCache.set(file.path, pending);
    }
    return pending;
  }

  private async embed(file: VFile): Promise<string | null> {
    const ext = extOf(file.path);
    let mime = MIME[ext];
    if (!mime) {
      this.skip(file.path, `.${ext || "?"} files can't be embedded`);
      return null;
    }

    let bytes = await this.vfs.read(file);
    let optimized = false;

    // Big raster image → try to shrink before giving up on it.
    if (RASTER_OPTIMIZABLE.has(mime) && bytes.byteLength > 500_000) {
      const smaller = await optimizeImage(bytes, mime);
      if (smaller) { bytes = smaller.bytes; mime = smaller.mime; optimized = true; }
    }

    if (bytes.byteLength > SURPRISE_LIMITS.maxAssetBytes) {
      this.skip(file.path, `${fmtBytes(bytes.byteLength)} is over the ${fmtBytes(SURPRISE_LIMITS.maxAssetBytes)} per-file limit`);
      return null;
    }
    // Check-then-add with no await in between, so concurrent embeds can't
    // both slip under the budget.
    if (this.report.totalAssetBytes + bytes.byteLength > SURPRISE_LIMITS.maxTotalAssetBytes) {
      this.skip(file.path, `would push embedded media past ${fmtBytes(SURPRISE_LIMITS.maxTotalAssetBytes)} total`);
      return null;
    }
    this.report.totalAssetBytes += bytes.byteLength;
    this.report.inlined.push({ path: file.path, bytes: bytes.byteLength, ...(optimized ? { optimized: true } : {}) });
    return `data:${mime};base64,${toBase64(bytes)}`;
  }

  /** Inline url(...) refs and local @import rules inside a stylesheet. */
  async processCss(css: string, cssPath: string, depth = 0): Promise<string> {
    const dir = dirOf(cssPath);

    // @import "x.css" / @import url(x.css)  — inline local ones, recursively.
    let out = await replaceAsync(
      css,
      /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?[^;]*;/gi,
      async (m) => {
        const ref = m[2];
        if (isExternalRef(ref)) return m[0];
        if (depth >= 5) { this.report.warnings.push(`@import nesting too deep at ${ref}`); return ""; }
        const file = this.lookup(dir, ref);
        if (!file) { this.skip(ref, "@import target not found in the upload"); return ""; }
        if (this.cssSeen.has(file.path)) return "";
        this.cssSeen.add(file.path);
        this.report.cssFiles.push(file.path);
        const inner = await this.vfs.readText(file);
        return `/* --- ${file.path} --- */\n${await this.processCss(inner, file.path, depth + 1)}\n`;
      }
    );

    out = await replaceAsync(out, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (m) => {
      const ref = m[2].trim();
      if (isExternalRef(ref)) return m[0];
      const uri = await this.inlineAsset(dir, ref);
      return uri ? `url("${uri}")` : m[0];
    });
    return out;
  }

  /**
   * Replace string literals that are the exact path of an uploaded asset
   * (`new Audio("sounds/kiss.mp3")`, `img.src = 'img/us.jpg'`). Only literals
   * that resolve to a real file are touched, so ordinary strings are safe.
   */
  async processJsAssets(js: string, dirs: string[]): Promise<string> {
    return replaceAsync(
      js,
      /(["'`])((?:\.{0,2}\/)?[\w\-. ()/]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp|mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|webm|ogv|mov|woff2?|ttf|otf|json|vtt))\1/gi,
      async (m) => {
        const ref = m[2];
        for (const d of dirs) {
          const file = this.lookup(d, ref);
          if (file) {
            const uri = await this.inlineAsset(d, ref);
            return uri ? `${m[1]}${uri}${m[1]}` : m[0];
          }
        }
        return m[0];
      }
    );
  }
}

// ─── HTML entry processing ─────────────────────────────────────────────────

const CLASSIC_SCRIPT_TYPES = new Set([
  "", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "text/jscript",
]);

const wrapMedia = (css: string, media: string | null) =>
  media && media.trim() && media.trim().toLowerCase() !== "all" ? `@media ${media.trim()} {\n${css}\n}` : css;

const joinJs = (chunks: { label: string; text: string }[]) =>
  chunks
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n;\n");

interface HtmlProcessed {
  title: string | null;
  html: string;
  css: string;
  js: string;
}

const processHtmlEntry = async (
  ctx: ImportContext,
  entryPath: string,
  source: string
): Promise<HtmlProcessed> => {
  if (typeof DOMParser === "undefined") throw new ImportError("not_supported", "This browser can't parse HTML uploads.");
  const doc = new DOMParser().parseFromString(source, "text/html");
  const dir = dirOf(entryPath);
  const { report } = ctx;

  const cssChunks: string[] = [];
  const jsChunks: { label: string; text: string }[] = [];
  const headKeep: string[] = [];

  if (doc.querySelector("base[href]")) {
    report.warnings.push("<base href> was removed — paths are resolved relative to the page.");
  }

  // Everything that carries code/style, in real document order.
  const nodes = Array.from(doc.querySelectorAll("link, style, script"));
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    const inHead = !!el.closest("head");
    const keep = () => {
      if (inHead) { headKeep.push(el.outerHTML); el.remove(); }
    };

    if (tag === "style") {
      const css = await ctx.processCss(el.textContent ?? "", entryPath);
      cssChunks.push(wrapMedia(css, el.getAttribute("media")));
      el.remove();
      continue;
    }

    if (tag === "link") {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase();
      const href = el.getAttribute("href") ?? "";
      if (/\b(icon|manifest|apple-touch-icon|canonical|alternate|preload|prefetch|modulepreload|dns-prefetch)\b/.test(rel)
        && !/\bstylesheet\b/.test(rel)) {
        el.remove();
        continue;
      }
      if (/\bstylesheet\b/.test(rel)) {
        if (isExternalRef(href)) { keep(); continue; }
        const file = ctx.lookup(dir, href);
        if (!file) {
          ctx.report.skipped.push({ path: href, reason: "stylesheet not found in the upload" });
          el.remove();
          continue;
        }
        const raw = await ctx.vfs.readText(file);
        ctx.report.cssFiles.push(file.path);
        const css = await ctx.processCss(raw, file.path);
        cssChunks.push(`/* --- ${file.path} --- */\n${wrapMedia(css, el.getAttribute("media"))}`);
        el.remove();
        continue;
      }
      keep();
      continue;
    }

    // <script>
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    const src = el.getAttribute("src");
    if (el.hasAttribute("nomodule")) { el.remove(); continue; }

    if (CLASSIC_SCRIPT_TYPES.has(type)) {
      if (src && !isExternalRef(src)) {
        const file = ctx.lookup(dir, src);
        if (!file) {
          ctx.report.skipped.push({ path: src, reason: "script not found in the upload" });
        } else {
          ctx.report.jsFiles.push(file.path);
          jsChunks.push({ label: file.path, text: await ctx.vfs.readText(file) });
        }
        el.remove();
        continue;
      }
      if (src) { keep(); continue; } // remote classic script — stays a tag, runs before the JS field
      jsChunks.push({ label: "inline", text: el.textContent ?? "" });
      el.remove();
      continue;
    }

    if (type === "module" && src && !isExternalRef(src)) {
      const file = ctx.lookup(dir, src);
      if (!file) {
        ctx.report.skipped.push({ path: src, reason: "module script not found in the upload" });
        el.remove();
        continue;
      }
      const text = await ctx.vfs.readText(file);
      if (/^\s*(?:import|export)\b/m.test(text)) {
        ctx.report.skipped.push({ path: file.path, reason: "ES module with import/export — bundle it into one classic script" });
        el.remove();
        continue;
      }
      el.removeAttribute("src");
      el.textContent = text;
      ctx.report.jsFiles.push(file.path);
      keep();
      continue;
    }

    // Remote modules, importmaps, JSON-LD, templates: leave untouched.
    keep();
  }

  // Asset attributes still in the markup.
  const urlAttrs: [string, string][] = [
    ["[src]", "src"], ["[poster]", "poster"], ["object[data]", "data"],
    ["image[href]", "href"], ["image[*|href]", "xlink:href"],
  ];
  for (const [selector, attr] of urlAttrs) {
    let els: Element[] = [];
    try { els = Array.from(doc.querySelectorAll(selector)); } catch { /* namespaced selector unsupported */ }
    for (const el of els) {
      const v = el.getAttribute(attr);
      if (!v || isExternalRef(v)) continue;
      if (el.tagName.toLowerCase() === "iframe") continue; // nested local pages can't be embedded
      const uri = await ctx.inlineAsset(dir, v);
      if (uri) el.setAttribute(attr, uri);
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[srcset]"))) {
    const val = el.getAttribute("srcset") ?? "";
    const parts = await Promise.all(
      val.split(",").map(async (p) => {
        const [u, ...rest] = p.trim().split(/\s+/);
        if (!u || isExternalRef(u)) return p.trim();
        const uri = await ctx.inlineAsset(dir, u);
        return [uri ?? u, ...rest].join(" ");
      })
    );
    el.setAttribute("srcset", parts.join(", "));
  }
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const v = el.getAttribute("style") ?? "";
    if (/url\(/i.test(v)) el.setAttribute("style", await ctx.processCss(v, entryPath));
  }

  // JS-referenced assets.
  const processedJs: { label: string; text: string }[] = [];
  for (const c of jsChunks) {
    const jsDir = c.label === "inline" ? dir : dirOf(c.label);
    processedJs.push({ label: c.label, text: await ctx.processJsAssets(c.text, Array.from(new Set([dir, jsDir, ""]))) });
  }
  const js = joinJs(processedJs);

  // Shell attributes (class/style/onload/lang/…).
  const attrsOf = (el: Element) => {
    const out: Record<string, string> = {};
    Array.from(el.attributes).forEach((a) => { out[a.name] = a.value; });
    return out;
  };
  const shell: ImportShell = { htmlAttrs: attrsOf(doc.documentElement), bodyAttrs: attrsOf(doc.body) };
  for (const s of [shell.htmlAttrs!, shell.bodyAttrs!]) {
    if (s.style && /url\(/i.test(s.style)) s.style = await ctx.processCss(s.style, entryPath);
  }

  // The marker is always written for an imported page: besides carrying the
  // <html>/<body> attributes it tells the builder "render this like a page".
  const html =
    encodeImportMarker(shell) +
    (headKeep.length ? headKeep.join("\n") + "\n" : "") +
    doc.body.innerHTML.trim();

  return {
    title: doc.title.trim() || null,
    html,
    css: cssChunks.map((c) => c.trim()).filter(Boolean).join("\n\n"),
    js,
  };
};

// ─── Entry selection ───────────────────────────────────────────────────────

const pickEntry = (vfs: Vfs, warnings: string[]): VFile | null => {
  const htmls = vfs.all().filter((f) => ["html", "htm"].includes(extOf(f.path)));
  if (!htmls.length) return null;
  const rank = (f: VFile) => {
    const base = f.path.split("/").pop()!.toLowerCase();
    const depth = f.path.split("/").length;
    return [base === "index.html" ? 0 : base === "index.htm" ? 1 : 2, depth, f.path] as const;
  };
  const sorted = [...htmls].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });
  if (sorted.length > 1) {
    warnings.push(
      `${sorted.length} HTML pages found — using ${sorted[0].path}. Ignored: ${sorted.slice(1, 6).map((f) => f.path).join(", ")}${sorted.length > 6 ? "…" : ""}`
    );
  }
  return sorted[0];
};

// ─── Loading sources ───────────────────────────────────────────────────────

const isZip = async (file: File): Promise<boolean> => {
  if (/\.zip$/i.test(file.name) || /zip/i.test(file.type)) return true;
  try {
    const head = await readBlob(file.slice(0, 4));
    return head[0] === 0x50 && head[1] === 0x4b; // "PK"
  } catch {
    return false;
  }
};

const loadZip = async (file: File): Promise<Vfs> => {
  if (file.size > SURPRISE_LIMITS.maxZipBytes) {
    throw new ImportError("too_large", `That zip is ${fmtBytes(file.size)} — the limit is ${fmtBytes(SURPRISE_LIMITS.maxZipBytes)}.`);
  }
  const JSZip = (await import("jszip")).default;
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(await readBlob(file));
  } catch {
    throw new ImportError("corrupt", "Couldn't open that zip — is it damaged or password-protected?");
  }

  type Raw = { path: string; entry: any };
  const raws: Raw[] = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    const norm = normalizeEntryPath(relPath);
    if (!norm) return;
    const segs = norm.split("/");
    if (segs[0] === "__MACOSX" || segs.some((s) => s.startsWith("."))) return;
    if (segs[segs.length - 1].toLowerCase() === "thumbs.db") return;
    raws.push({ path: norm, entry });
  });

  if (raws.length > SURPRISE_LIMITS.maxZipEntries) {
    throw new ImportError("too_large", `That zip has ${raws.length} files — the limit is ${SURPRISE_LIMITS.maxZipEntries}.`);
  }
  if (!raws.length) throw new ImportError("empty", "That zip has no usable files in it.");

  // Strip a single shared top-level folder ("my-surprise/index.html").
  const firstSegs = new Set(raws.map((r) => r.path.split("/")[0]));
  const stripPrefix = firstSegs.size === 1 && raws.every((r) => r.path.includes("/")) ? `${[...firstSegs][0]}/` : "";

  const declaredTotal = raws.reduce((n, r) => n + (r.entry?._data?.uncompressedSize ?? 0), 0);
  if (declaredTotal > SURPRISE_LIMITS.maxZipUncompressedBytes) {
    throw new ImportError("too_large", "That zip expands to more data than a surprise can hold.");
  }

  const vfs = new Vfs(SURPRISE_LIMITS.maxZipUncompressedBytes);
  for (const r of raws) {
    vfs.add({
      path: stripPrefix ? r.path.slice(stripPrefix.length) : r.path,
      size: r.entry?._data?.uncompressedSize ?? 0,
      read: () => r.entry.async("uint8array") as Promise<Uint8Array>,
    });
  }
  return vfs;
};

const loadFlatFiles = (files: File[]): Vfs => {
  const vfs = new Vfs(SURPRISE_LIMITS.maxZipUncompressedBytes);
  for (const f of files) {
    vfs.add({ path: f.name, size: f.size, read: () => readBlob(f) });
  }
  return vfs;
};

// ─── Public entry point ────────────────────────────────────────────────────

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/**
 * @param files  one .zip, OR any mix of .html/.htm/.css/.js (plus optional
 *               images/audio the page refers to by file name)
 */
export const importSurpriseFiles = async (files: File[]): Promise<ImportResult> => {
  if (!files.length) throw new ImportError("empty", "No files selected.");

  const zipFlags = await Promise.all(files.map(isZip));
  const zipCount = zipFlags.filter(Boolean).length;
  if (zipCount > 1 || (zipCount === 1 && files.length > 1)) {
    throw new ImportError("not_supported", "Pick one .zip on its own, or individual HTML / CSS / JS files — not both.");
  }

  const isZipImport = zipCount === 1;
  const vfs = isZipImport ? await loadZip(files[0]) : loadFlatFiles(files);
  const report: ImportReport = {
    source: isZipImport ? "zip" : "files",
    sourceName: files.length === 1 ? files[0].name : `${files.length} files`,
    entry: null,
    cssFiles: [],
    jsFiles: [],
    inlined: [],
    skipped: [],
    unresolved: [],
    warnings: [],
    totalAssetBytes: 0,
    totalChars: 0,
  };
  const ctx = new ImportContext(vfs, report);

  const entry = pickEntry(vfs, report.warnings);
  let title: string | null = null;
  let html = "";
  let css = "";
  let js = "";

  if (entry) {
    report.entry = entry.path;
    const processed = await processHtmlEntry(ctx, entry.path, await vfs.readText(entry));
    title = processed.title;
    html = processed.html;
    css = processed.css;
    js = processed.js;
  }

  // Explicitly picked stand-alone .css/.js that the HTML didn't already pull
  // in. (For a zip, unreferenced files are left alone — they'd not have run
  // in a browser either — but are listed so nothing vanishes silently.)
  const used = new Set([...report.cssFiles, ...report.jsFiles, ...(report.entry ? [report.entry] : [])]);
  const leftovers = vfs.all().filter((f) => !used.has(f.path));
  if (!isZipImport) {
    for (const f of leftovers) {
      const ext = extOf(f.path);
      if (ext === "css") {
        report.cssFiles.push(f.path);
        css = [css, `/* --- ${f.path} --- */\n${await ctx.processCss(await vfs.readText(f), f.path)}`].filter(Boolean).join("\n\n");
      } else if (ext === "js") {
        report.jsFiles.push(f.path);
        const text = await ctx.processJsAssets(await vfs.readText(f), [""]);
        js = [js, text].filter((s) => s.trim()).join("\n;\n");
      }
      // images/audio picked alongside are resolved by name on demand
    }
    if (!report.entry && !css && !js) {
      throw new ImportError("empty", "None of those files were HTML, CSS or JS.");
    }
  } else {
    const ignored = leftovers.filter((f) => ["css", "js", "html", "htm"].includes(extOf(f.path)));
    if (ignored.length) {
      report.warnings.push(`Not referenced by the page, so ignored: ${ignored.slice(0, 6).map((f) => f.path).join(", ")}${ignored.length > 6 ? "…" : ""}`);
    }
    if (!report.entry) {
      report.warnings.push("No HTML file found in the zip — nothing to use as the page.");
    }
  }

  // Standalone HTML-less import: no marker/shell needed.
  if (!entry) html = "";

  report.unresolved = findUnresolvedLocalRefs({ html, css, js });
  report.totalChars = html.length + css.length + js.length;
  if (report.totalChars > SURPRISE_LIMITS.maxSurpriseChars) {
    report.warnings.push(
      `Result is ${fmtBytes(report.totalChars)} of text — over the ${fmtBytes(SURPRISE_LIMITS.maxSurpriseChars)} limit. Remove media or use smaller files.`
    );
  }

  return {
    title: title ?? (files.length === 1 ? stem(files[0].name) : null),
    html,
    css,
    js, // "" when the page had no script — intentionally blank
    report,
  };
};

/** One-line human summary for the toast / report header. */
export const summarizeImport = (r: ImportReport): string => {
  const bits: string[] = [];
  if (r.entry) bits.push(`HTML: ${r.entry}`);
  bits.push(r.cssFiles.length ? `${r.cssFiles.length} CSS file${r.cssFiles.length > 1 ? "s" : ""}` : "CSS from page styles");
  bits.push(r.jsFiles.length ? `${r.jsFiles.length} JS file${r.jsFiles.length > 1 ? "s" : ""}` : "no JS files");
  if (r.inlined.length) bits.push(`${r.inlined.length} media file${r.inlined.length > 1 ? "s" : ""} embedded (${fmtBytes(r.totalAssetBytes)})`);
  return bits.join(" · ");
};
