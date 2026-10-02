/**
 * Editor-side asset folding.
 *
 * An imported surprise carries its images/audio/fonts as base64 data: URIs
 * inside the html/css/js strings — routinely hundreds of KB to MBs of
 * unreadable text. Dropped into a plain <textarea> that makes the editor
 * crawl (especially in a phone WebView) and buries the code. The editor
 * therefore shows a short token (`ds-asset://a1`) in place of each large
 * data URI and keeps the real bytes in a side table; everything that leaves
 * the editor (preview, Save, library) is expanded back first, so what is
 * stored and delivered is always the full self-contained code.
 *
 * Lossless by construction: collapse only touches COMPLETE base64 data URIs
 * above the size threshold; expand only replaces tokens it has bytes for.
 */

export type AssetTable = Record<string, string>;

export interface SurpriseParts {
  html: string;
  css: string;
  js: string;
}

/** Only fold URIs at least this long — small inline icons stay readable. */
export const COLLAPSE_MIN_CHARS = 1500;

const DATA_URI_RE = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi;
const TOKEN_RE = /ds-asset:\/\/(a\d+)/g;

export const collapseAssets = (parts: SurpriseParts): SurpriseParts & { table: AssetTable } => {
  const table: AssetTable = {};
  const byUri = new Map<string, string>();
  let n = 0;

  const fold = (text: string) =>
    text.replace(DATA_URI_RE, (uri) => {
      if (uri.length < COLLAPSE_MIN_CHARS) return uri;
      let token = byUri.get(uri);
      if (!token) {
        token = `a${++n}`;
        byUri.set(uri, token);
        table[token] = uri;
      }
      return `ds-asset://${token}`;
    });

  return { html: fold(parts.html), css: fold(parts.css), js: fold(parts.js), table };
};

export const expandAssets = (parts: SurpriseParts, table: AssetTable): SurpriseParts => {
  const unfold = (text: string) => text.replace(TOKEN_RE, (all, token) => table[token] ?? all);
  return { html: unfold(parts.html), css: unfold(parts.css), js: unfold(parts.js) };
};

/** Tokens present in the parts that the table has no bytes for (edited/pasted away). */
export const orphanedTokens = (parts: SurpriseParts, table: AssetTable): string[] => {
  const found = new Set<string>();
  for (const text of [parts.html, parts.css, parts.js]) {
    for (const m of text.matchAll(TOKEN_RE)) if (!(m[1] in table)) found.add(m[0]);
  }
  return Array.from(found);
};
