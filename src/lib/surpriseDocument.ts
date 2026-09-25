/**
 * Surprise document builder.
 *
 * Turns a surprise's three stored strings (html / css / js) into the one
 * self-contained HTML document that CodeSurpriseFrame renders inside a
 * sandboxed <iframe srcDoc>. Used by BOTH the editor preview and the
 * recipient-side SurpriseReveal, so whatever the creator tests is exactly
 * what the partner sees.
 *
 * What this fixes compared to the original builder (items marked ✔ were
 * reproduced in headless Chromium against the old code and confirmed fixed
 * against this one; see src/test/surpriseDocument.test.ts for the pure-logic
 * parts):
 *
 *  1. ✔ JS was wrapped in `try { … }`, which made every top-level
 *     `const`/`let`/`class` block-scoped: `const go = () => …` plus
 *     `onclick="go()"` threw ReferenceError. The creator script is now a
 *     plain global classic <script>, exactly like a normal page. Errors are
 *     still reported to the parent through window.onerror.
 *  2. ✔ User CSS was emitted AFTER an app-owned rule block inside a single
 *     <style>, so a leading `@import` (Google Fonts, animate.css…) was
 *     silently ignored — @import must come first. User CSS now gets its own
 *     <style>.
 *  3. ✔ Audio: a surprise that calls `new Audio(src).play()` on load is
 *     refused by the browser's autoplay policy, and the old frame never
 *     recovered — not even after the person tapped. The runtime below
 *     remembers the refused element, shows a "Tap for sound" chip, and
 *     retries on the first tap (also resumes suspended AudioContexts).
 *     CodeSurpriseFrame additionally delegates `allow="autoplay"`.
 *  4. ✔ `localStorage`/`sessionStorage` throw SecurityError in a sandboxed
 *     opaque-origin frame — any library touching them crashed on load.
 *     In-memory shims are installed when the real ones are unavailable.
 *  5. ✔ Link taps inside the frame went nowhere (sandbox blocks popups and
 *     top navigation). http(s)/mailto/tel taps are now forwarded to the
 *     parent, which opens them in the system/in-app browser.
 *  6. Media URLs (NOT verifiable in a browser sandbox with no network —
 *     logic is unit-tested, WebView behaviour is not): `http://` is upgraded
 *     via a upgrade-insecure-requests meta CSP (mixed content is blocked in
 *     a Capacitor https://localhost origin); protocol-relative `//host/x`
 *     is forced to https (it would resolve to capacitor:// on iOS); Google
 *     Drive / Dropbox / GitHub "share" links (HTML pages, not files) are
 *     rewritten to their direct-file form in media contexts; the frame
 *     sends no Referer so hot-link-protected hosts don't refuse it.
 *  7. Imported pages (see surpriseImport.ts) keep their <html>/<body>
 *     attributes through a leading marker comment and render "as a page":
 *     no forced box-sizing reset, normal scrolling, and the white
 *     background a browser would have given a page that sets none.
 */

export type SurpriseDraft = {
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
};

/** Size budgets shared by the importer, editor and library. */
export const SURPRISE_LIMITS = {
  /** One inlined asset (decoded bytes). */
  maxAssetBytes: 1_500_000,
  /** All inlined assets in one surprise (decoded bytes). */
  maxTotalAssetBytes: 3_000_000,
  /** html + css + js characters allowed on a saved surprise / library item. */
  maxSurpriseChars: 4_500_000,
  /** Compressed zip upload size. */
  maxZipBytes: 25_000_000,
  /** Total uncompressed bytes we are willing to read out of one zip. */
  maxZipUncompressedBytes: 60_000_000,
  maxZipEntries: 600,
} as const;

// ─── Import marker ─────────────────────────────────────────────────────────
// The importer strips <html>/<body> shells so the three stored fields hold
// only content. Their attributes (class, style, onload, lang, data-theme…)
// still matter, and there are only three text columns, so they ride along
// in one leading HTML comment. It doubles as the "this is an imported page,
// render it faithfully" flag (no forced box-sizing reset, normal scrolling).

export interface ImportShell {
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}

const MARKER_RE = /^\s*<!--ds-import:([\s\S]*?)-->\s*/;

export const encodeImportMarker = (shell: ImportShell): string => {
  const json = JSON.stringify(shell).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!--ds-import:${json}-->\n`;
};

export const parseImportMarker = (html: string): { shell: ImportShell | null; rest: string } => {
  const m = MARKER_RE.exec(html);
  if (!m) return { shell: null, rest: html };
  try {
    const shell = JSON.parse(m[1]) as ImportShell;
    return { shell: shell && typeof shell === "object" ? shell : {}, rest: html.slice(m[0].length) };
  } catch {
    return { shell: null, rest: html.slice(m[0].length) };
  }
};

// ─── Small helpers ─────────────────────────────────────────────────────────

const ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

const escapeAttr = (v: string) =>
  String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const escapeText = (v: string) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const attrString = (attrs?: Record<string, string>) =>
  Object.entries(attrs ?? {})
    .filter(([k]) => ATTR_NAME_RE.test(k))
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");

/** Remove inline base64 payloads so text scanners never chew through MBs. */
export const stripInlineData = (s: string): string =>
  s.replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{64,}/gi, "data:");

const looksLikeDocument = (html: string) => /<\s*(?:!doctype\b|html\b|head\b|body\b)/i.test(html);

interface DocumentShell {
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  headHtml: string;
  bodyHtml: string;
}

/** Split a full HTML document into shell attributes + head/body content. */
const splitDocumentShell = (html: string): DocumentShell | null => {
  if (typeof DOMParser === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const attrsOf = (el: Element) => {
      const out: Record<string, string> = {};
      Array.from(el.attributes).forEach((a) => { out[a.name] = a.value; });
      return out;
    };
    const head = doc.head.cloneNode(true) as HTMLElement;
    head.querySelectorAll("title,meta,base").forEach((n) => n.remove());
    return {
      htmlAttrs: attrsOf(doc.documentElement),
      bodyAttrs: attrsOf(doc.body),
      headHtml: head.innerHTML,
      bodyHtml: doc.body.innerHTML,
    };
  } catch {
    return null;
  }
};

// ─── URL normalization (media contexts only) ───────────────────────────────

type UrlHint = "image" | "media" | "any";

const AUDIO_VIDEO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|mp4|webm|ogv|mov)(?:[?#]|$)/i;

/**
 * Best-effort rewrite of share links that are web pages into direct file
 * URLs, plus scheme fixes that a Capacitor WebView needs. Anything it does
 * not recognise is returned untouched. Pure — safe to unit test.
 */
export const normalizeMediaUrl = (raw: string, hint: UrlHint = "any"): string => {
  let url = raw.trim();
  if (!url) return raw;

  // Protocol-relative: resolves to capacitor:// on iOS → broken. Force https.
  if (url.startsWith("//")) url = `https:${url}`;

  // Google Drive share links → direct file endpoint.
  let m = /^https?:\/\/drive\.google\.com\/file\/d\/([\w-]+)/i.exec(url)
    ?? /^https?:\/\/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/i.exec(url);
  if (m) {
    const kind = hint === "media" || AUDIO_VIDEO_EXT.test(url) ? "download" : "view";
    return `https://drive.google.com/uc?export=${kind}&id=${m[1]}`;
  }

  // Dropbox share links → raw file.
  if (/^https?:\/\/(?:www\.)?dropbox\.com\/s(?:h)?\//i.test(url)) {
    const u = url.replace(/^http:/i, "https:");
    if (/[?&]dl=\d/.test(u)) return u.replace(/([?&])dl=\d/, "$1raw=1");
    return u + (u.includes("?") ? "&" : "?") + "raw=1";
  }

  // GitHub "blob" page → raw file.
  m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(url);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;

  return url;
};

const rewriteHtmlUrls = (html: string): string => {
  const hintForTag = (tag: string): UrlHint => {
    const t = tag.toLowerCase();
    if (t === "img" || t === "image") return "image";
    if (t === "audio" || t === "video" || t === "source" || t === "track") return "media";
    return "any";
  };

  // Per-tag pass so several URL attributes on one element (<video src poster>)
  // are all handled.
  return html.replace(/<([a-zA-Z][\w:-]*)\b[^>]*>/g, (tagText: string, tag: string) => {
    let out = tagText;

    // src / poster / data
    out = out.replace(
      /(\s)(src|poster|data)(\s*=\s*)("([^"]*)"|'([^']*)')/gi,
      (all, ws, attr, eq, _q, dq, sq) => {
        const val = dq ?? sq ?? "";
        if (/^(data:|blob:|#|javascript:)/i.test(val.trim())) return all;
        const next = normalizeMediaUrl(val, attr.toLowerCase() === "poster" ? "image" : hintForTag(tag));
        return next === val ? all : `${ws}${attr}${eq}"${escapeAttr(next)}"`;
      }
    );

    // srcset: rewrite each candidate URL.
    out = out.replace(/(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi, (all, pre, _q, dq, sq) => {
      const val = dq ?? sq ?? "";
      const next = val
        .split(",")
        .map((part: string) => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [normalizeMediaUrl(u, "image"), ...rest].join(" ");
        })
        .join(", ");
      return next === val ? all : `${pre}"${escapeAttr(next)}"`;
    });

    const t = tag.toLowerCase();
    // <link href> (stylesheets, fonts) — scheme fix only, never share-link rewrite.
    if (t === "link") {
      out = out.replace(/(\shref\s*=\s*)("([^"]*)"|'([^']*)')/i, (all, pre, _q, dq, sq) => {
        const val = (dq ?? sq ?? "").trim();
        return val.startsWith("//") ? `${pre}"https:${escapeAttr(val)}"` : all;
      });
    }
    // SVG <image href|xlink:href>
    if (t === "image") {
      out = out.replace(/(\s(?:xlink:)?href\s*=\s*)("([^"]*)"|'([^']*)')/i, (all, pre, _q, dq, sq) => {
        const val = dq ?? sq ?? "";
        if (/^(data:|#)/i.test(val)) return all;
        const next = normalizeMediaUrl(val, "image");
        return next === val ? all : `${pre}"${escapeAttr(next)}"`;
      });
    }
    return out;
  });
};

const rewriteCssUrls = (css: string): string =>
  css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, val) => {
      if (/^(data:|blob:|#)/i.test(val.trim())) return all;
      const next = normalizeMediaUrl(val, "image");
      return next === val ? all : `url(${q}${next}${q})`;
    })
    .replace(/@import\s+(["'])(\/\/[^"']+)\1/gi, (_a, q, val) => `@import ${q}https:${val}${q}`);

const rewriteJsUrls = (js: string): string =>
  js.replace(
    /(new\s+Audio\(\s*|new\s+Image\(\s*\)\s*\.src\s*=\s*|\.src\s*=\s*)(["'])((?:https?:)?\/\/[^"'\s]+)\2/g,
    (all, pre, q, val) => {
      const next = normalizeMediaUrl(val, "any");
      return next === val ? all : `${pre}${q}${next}${q}`;
    }
  );

/** Exposed for tests / the editor's "unresolved files" lint. */
export const normalizeSurpriseUrls = (parts: { html: string; css: string; js: string }) => ({
  html: rewriteHtmlUrls(parts.html),
  css: rewriteCssUrls(parts.css),
  js: rewriteJsUrls(parts.js),
});

// ─── Unresolved local reference lint ───────────────────────────────────────

const isRemoteOrInline = (v: string) =>
  /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v.trim()) || v.trim() === "";

/**
 * Local file references (`img/us.jpg`, `style.css`, `../song.mp3`) that can
 * never resolve inside a standalone srcDoc frame. The importer inlines them
 * from a zip; anything still here after import (or pasted by hand) is
 * broken, and the editor says so instead of silently showing a blank image.
 */
export const findUnresolvedLocalRefs = (parts: { html: string; css: string; js: string }): string[] => {
  const found = new Set<string>();
  const html = stripInlineData(parts.html);
  const css = stripInlineData(parts.css);
  const js = stripInlineData(parts.js);

  const attrRe = /\s(?:src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of html.matchAll(attrRe)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (!isRemoteOrInline(v)) found.add(v);
  }
  for (const m of html.matchAll(/<link\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (!isRemoteOrInline(v) && !/rel\s*=\s*["']?(?:icon|shortcut|apple-touch)/i.test(m[0])) found.add(v);
  }
  for (const m of html.matchAll(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    (m[1] ?? m[2] ?? "").split(",").forEach((p) => {
      const v = p.trim().split(/\s+/)[0];
      if (v && !isRemoteOrInline(v)) found.add(v);
    });
  }
  for (const m of `${css}\n${html}`.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const v = m[2].trim();
    if (!isRemoteOrInline(v)) found.add(v);
  }
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1/gi)) {
    if (!isRemoteOrInline(m[2])) found.add(m[2]);
  }
  for (const m of js.matchAll(/new\s+Audio\(\s*(["'])([^"']+)\1/g)) {
    if (!isRemoteOrInline(m[2])) found.add(m[2]);
  }
  return Array.from(found).slice(0, 30);
};

// ─── In-frame runtime ──────────────────────────────────────────────────────
// Runs first in <head>, before any creator code. Plain ES5-ish on purpose:
// it must never itself be the thing that fails on an old Android WebView.

const RUNTIME_JS = `
(function () {
  var P = window.parent;
  function post(m) { try { P.postMessage(m, "*"); } catch (e) {} }
  function report(msg) { post({ type: "code-surprise-error", message: String(msg) }); }

  window.addEventListener("error", function (e) {
    report(String(e.message || (e.error && e.error.message) || "Script error").replace(/^Uncaught\s+/, ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    if (r && r.name === "NotAllowedError") return; // autoplay refusal — handled below
    report((r && r.message) || r || "Unhandled promise rejection");
  });

  // Sandboxed opaque origin: touching localStorage/sessionStorage throws.
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var ok = false;
    try { ok = !!window[name]; } catch (e) {}
    if (ok) return;
    var mem = {};
    var shim = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; },
      clear: function () { mem = {}; },
      key: function (i) { return Object.keys(mem)[i] || null; },
      get length() { return Object.keys(mem).length; }
    };
    try { Object.defineProperty(window, name, { configurable: true, get: function () { return shim; } }); } catch (e) {}
  });

  // Autoplay: retry blocked media / suspended AudioContexts on the first tap,
  // and surface a small tap target so the person knows there is sound.
  var pending = [], ctxs = [], hint = null;
  function showHint() {
    if (hint || !document.body) return;
    hint = document.createElement("button");
    hint.type = "button";
    hint.textContent = "\\uD83D\\uDD0A Tap for sound";
    hint.setAttribute("style", "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border:0;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;font:600 14px system-ui,sans-serif;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)");
    document.body.appendChild(hint);
  }
  function unlock() {
    var list = pending.slice(); pending = [];
    list.forEach(function (m) { try { var p = m.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} });
    ctxs.forEach(function (c) { try { if (c.state === "suspended") c.resume(); } catch (e) {} });
    if (hint) { try { hint.remove(); } catch (e) {} hint = null; }
  }
  ["pointerdown", "touchend", "keydown", "click"].forEach(function (t) {
    window.addEventListener(t, unlock, true);
  });
  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var el = this, r = origPlay.apply(el, arguments);
    if (r && r.catch) {
      r.catch(function (err) {
        if (err && err.name === "NotAllowedError") {
          if (pending.indexOf(el) < 0) pending.push(el);
          if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showHint);
          else showHint();
        }
      });
    }
    return r;
  };
  ["AudioContext", "webkitAudioContext"].forEach(function (n) {
    var AC = window[n];
    if (!AC || typeof Reflect === "undefined") return;
    var W = function () {
      var c = Reflect.construct(AC, arguments);
      ctxs.push(c);
      setTimeout(function () { if (c.state === "suspended") showHint(); }, 400);
      return c;
    };
    W.prototype = AC.prototype;
    try { window[n] = W; } catch (e) {}
  });

  // Links: the sandbox blocks popups / top navigation, so hand them to the app.
  function openUrl(u) { post({ type: "ds-open-url", url: String(u) }); }
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:|tel:)/i.test(href)) { e.preventDefault(); openUrl(a.href); }
    else if (href.charAt(0) !== "#" && !/^javascript:/i.test(href)) { e.preventDefault(); }
  }, true);
  window.open = function (u) { if (u && /^https?:/i.test(String(u))) openUrl(u); return null; };

  window.addEventListener("load", function () {
    // Imported pages that never set a background: give them the white a
    // browser would have (transparent here would show the app's dark bg).
    if (document.documentElement.hasAttribute("data-ds-page")) {
      var h = getComputedStyle(document.documentElement), b = getComputedStyle(document.body);
      var clear = function (s) {
        return (s.backgroundColor === "rgba(0, 0, 0, 0)" || s.backgroundColor === "transparent") && s.backgroundImage === "none";
      };
      if (clear(h) && clear(b)) document.documentElement.style.backgroundColor = "#fff";
    }
    var autos = document.querySelectorAll("audio[autoplay],video[autoplay]");
    for (var i = 0; i < autos.length; i++) { if (autos[i].paused) { try { autos[i].play(); } catch (e) {} } }
    post({ type: "ds-ready" });
  });
})();
`;

// ─── Builder ───────────────────────────────────────────────────────────────

export const buildSurpriseDocument = ({ title, html_content, css_content, js_content }: SurpriseDraft): string => {
  const { shell: marker, rest } = parseImportMarker(html_content ?? "");

  let htmlAttrs: Record<string, string> = marker?.htmlAttrs ?? {};
  let bodyAttrs: Record<string, string> = marker?.bodyAttrs ?? {};
  let headHtml = "";
  let bodyHtml = rest;
  let pageMode = !!marker;

  // A whole document pasted / uploaded raw into the HTML tab.
  if (!marker && looksLikeDocument(rest)) {
    const shell = splitDocumentShell(rest);
    if (shell) {
      htmlAttrs = shell.htmlAttrs;
      bodyAttrs = shell.bodyAttrs;
      headHtml = shell.headHtml;
      bodyHtml = shell.bodyHtml;
      pageMode = true;
    }
  }

  const normalized = normalizeSurpriseUrls({
    html: `${headHtml}\u0000${bodyHtml}`,
    css: css_content ?? "",
    js: js_content ?? "",
  });
  const [headOut, bodyOut] = normalized.html.split("\u0000");

  const css = normalized.css.replace(/<\/style/gi, "<\\/style");
  const js = normalized.js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

  const baseCss = pageMode
    ? `html { -webkit-text-size-adjust: 100%; overflow-x: hidden; }`
    : `html, body { width: 100%; height: 100%; }
       body { margin: 0; overflow: hidden; background: transparent; }
       *, *::before, *::after { box-sizing: border-box; }`;

  const htmlTagAttrs = attrString({
    lang: "en",
    ...htmlAttrs,
    ...(pageMode ? { "data-ds-page": "" } : {}),
  });

  return `<!DOCTYPE html>
<html${htmlTagAttrs}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests" />
<title>${escapeText(title ?? "")}</title>
<style id="ds-base">${baseCss}</style>
<style id="ds-user">
${css}
</style>
<script id="ds-runtime">${RUNTIME_JS}</script>
${headOut}
</head>
<body${attrString(bodyAttrs)}>
${bodyOut}
${js.trim() ? `<script id="ds-user-js">\n${js}\n</script>` : ""}
</body>
</html>`;
};
