// Import/export formats for Shayari entries.
//
// Three concerns live here:
//  1. `.shayari` — DuoSpace's native full-fidelity format (JSON). Reserves
//     category/tags/language/style fields for forward compatibility even
//     though nothing in the app populates them yet (the `shayaris` table
//     only has content/title/is_favorite/created_at today) — so re-import
//     is lossless for what actually exists, and free once those fields
//     land.
//  2. Plain text (.txt) — human-readable, printable on its own, still
//     round-trips title + content losslessly for our own exports.
//  3. A unified import parser that sniffs .shayari / .json / .txt and, for
//     txt files that aren't one of our own exports, intelligently splits
//     pasted/mixed content into separate shayaris.

export const SHAYARI_FORMAT = "duospace-shayari";
export const SHAYARI_FORMAT_VERSION = 1;

/** A normalized entry as read FROM any export (full fidelity, native format). */
export interface ShayariCollectionEntry {
  title: string | null;
  content: string;
  author: string | null;
  isFavorite: boolean;
  createdAt: string | null;
  // Reserved for forward compatibility — always null/empty today.
  category: string | null;
  tags: string[];
  language: string | null;
  style: Record<string, unknown> | null;
}

/** What the page actually has on hand to build an export entry from. */
export interface ShayariExportSource {
  title: string | null;
  content: string;
  authorName?: string | null;
  isFavorite?: boolean;
  createdAt?: string;
}

/** What an import produces — only fields we can actually insert today. */
export interface ShayariImportEntry {
  title: string | null;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────
// .shayari (native JSON)
// ─────────────────────────────────────────────────────────────────────────

export function serializeShayariCollection(items: ShayariExportSource[]): string {
  const payload = {
    format: SHAYARI_FORMAT,
    version: SHAYARI_FORMAT_VERSION,
    app: "DuoSpace",
    exportedAt: new Date().toISOString(),
    count: items.length,
    items: items.map((s) => ({
      title: s.title?.trim() || null,
      content: s.content,
      author: s.authorName || null,
      isFavorite: !!s.isFavorite,
      createdAt: s.createdAt || null,
      category: null,
      tags: [],
      language: null,
      style: null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function normalizeCollectionItem(raw: any): ShayariCollectionEntry | null {
  if (!raw || typeof raw !== "object") return null;
  // Native fields, with a few generic-JSON fallbacks (text/body/name) so an
  // arbitrary .json someone hand-built still has a fighting chance.
  const content = raw.content ?? raw.text ?? raw.body ?? raw.shayari;
  if (typeof content !== "string" || !content.trim()) return null;
  const title = raw.title ?? raw.name ?? null;
  return {
    title: typeof title === "string" && title.trim() ? title.trim() : null,
    content: String(content),
    author: typeof raw.author === "string" ? raw.author : null,
    isFavorite: !!raw.isFavorite,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    category: typeof raw.category === "string" ? raw.category : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === "string") : [],
    language: typeof raw.language === "string" ? raw.language : null,
    style: raw.style && typeof raw.style === "object" ? raw.style : null,
  };
}

/** Parses `.shayari` / `.json`. Throws on unparseable JSON or no recognizable entries. */
export function parseShayariCollection(text: string): ShayariCollectionEntry[] {
  const data = JSON.parse(text);
  const rawItems: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const entries = rawItems.map(normalizeCollectionItem).filter((e): e is ShayariCollectionEntry => e !== null);
  if (!entries.length) throw new Error("No shayaris found in file");
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// Plain text (.txt)
// ─────────────────────────────────────────────────────────────────────────

const RULE = "═".repeat(40);
const RULE_RE = /^═{10,}\s*$/;
const TITLE_PREFIX = "❖ ";
const UNTITLED = "(untitled)";

function formatEntryDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

export function formatShayariExport(entries: ShayariExportSource[]): string {
  const header = [
    "DuoSpace · Shayari Export",
    `Exported ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })} · ${entries.length} shayari${entries.length === 1 ? "" : "s"}`,
  ].join("\n");

  const blocks = entries.map((e) => {
    const titleLine = `${TITLE_PREFIX}${e.title?.trim() || UNTITLED}`;
    const metaBits = [e.authorName, formatEntryDate(e.createdAt)].filter(Boolean);
    const metaLine = metaBits.length ? `   ${metaBits.join(" · ")}` : "";
    const body = e.content.replace(/\r\n/g, "\n").trim();
    return [titleLine, metaLine, "", body].filter((l) => l !== "" || l === body).join("\n");
  });

  return [header, RULE, "", blocks.join(`\n\n${RULE}\n\n`), "", RULE].join("\n\n").replace(/\n{3,}/g, "\n\n\n");
}

/** Parses our own rule-delimited export format. Returns [] if the markers aren't present. */
function parseOwnTxtFormat(text: string): ShayariImportEntry[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[][] = [[]];
  for (const line of lines) {
    if (RULE_RE.test(line)) chunks.push([]);
    else chunks[chunks.length - 1].push(line);
  }

  const entries: ShayariImportEntry[] = [];
  for (const chunk of chunks) {
    const startIdx = chunk.findIndex((l) => l.trim().startsWith(TITLE_PREFIX));
    if (startIdx === -1) continue;

    const titleRaw = chunk[startIdx].trim().slice(TITLE_PREFIX.length).trim();
    const title = titleRaw && titleRaw !== UNTITLED ? titleRaw : null;

    let i = startIdx + 1;
    if (i < chunk.length && chunk[i].trim() && !chunk[i].trim().startsWith(TITLE_PREFIX)) i += 1; // meta line
    while (i < chunk.length && chunk[i].trim() === "") i += 1;
    const contentLines = chunk.slice(i);
    while (contentLines.length && contentLines[contentLines.length - 1].trim() === "") contentLines.pop();

    const content = contentLines.join("\n").trim();
    if (content) entries.push({ title, content });
  }
  return entries;
}

/**
 * Fallback for any other .txt: split on blank-line gaps (2+ newlines), each
 * resulting stanza becomes one shayari. If a stanza's first line is short
 * (looks like a title, not a poem line) and the stanza has more lines after
 * it, treat that first line as the title.
 */
function parseGenericTxt(text: string): ShayariImportEntry[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const stanzas = normalized.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  return stanzas.map((stanza) => {
    const lines = stanza.split("\n");
    const firstLine = lines[0].trim();
    const looksLikeTitle = lines.length > 1 && firstLine.length <= 40 && !/[.,!?]$/.test(firstLine);
    if (looksLikeTitle) {
      return { title: firstLine, content: lines.slice(1).join("\n").trim() };
    }
    return { title: null, content: stanza };
  }).filter((e) => e.content);
}

export function parseShayariImport(text: string): ShayariImportEntry[] {
  const own = parseOwnTxtFormat(text);
  if (own.length) return own;
  return parseGenericTxt(text);
}

// ─────────────────────────────────────────────────────────────────────────
// Unified import dispatcher
// ─────────────────────────────────────────────────────────────────────────

export type ImportSourceFormat = "shayari" | "json" | "txt";

export interface ParsedImport {
  entries: ShayariImportEntry[];
  sourceFormat: ImportSourceFormat;
}

/** Detects file format from extension/content and parses accordingly. Throws with a friendly message on failure. */
export function parseImportFile(fileName: string, text: string): ParsedImport {
  const lower = fileName.toLowerCase();
  const trimmed = text.trim();
  const isShayariExt = lower.endsWith(".shayari");
  const isJsonExt = lower.endsWith(".json");
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");

  if (isShayariExt || isJsonExt || looksLikeJson) {
    try {
      const collection = parseShayariCollection(text);
      return {
        entries: collection.map((e) => ({ title: e.title, content: e.content })),
        sourceFormat: isShayariExt ? "shayari" : "json",
      };
    } catch (err) {
      if (isShayariExt || isJsonExt) {
        throw new Error("That .shayari/.json file couldn't be read — it may be corrupted or in an unrecognized format");
      }
      // Otherwise fall through and try it as text.
    }
  }

  const entries = parseShayariImport(text);
  if (!entries.length) throw new Error("No shayaris found in that file");
  return { entries, sourceFormat: "txt" };
}
