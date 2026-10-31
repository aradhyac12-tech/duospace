/**
 * Minimal ID3v2 (v2.3 / v2.4) reader for imported MP3s: title, artist and the
 * embedded cover picture. No dependency — only the frames the app shows.
 * Anything unexpected (v2.2, truncated tag, odd encoding) just yields fewer
 * fields; it never throws to the caller.
 */
export interface Id3Tags { title?: string; artist?: string; cover?: { mime: string; data: Uint8Array } }

const MAX_TAG_BYTES = 4 * 1024 * 1024; // cover art lives in the tag; cap what we read

const syncsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function decode(b: Uint8Array, enc: number): string {
  try {
    const label = enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : enc === 3 ? "utf-8" : "windows-1252";
    return new TextDecoder(label).decode(b).replace(/\u0000+/g, " ").replace(/^\uFEFF/, "").trim();
  } catch { return ""; }
}

/** Index just past the terminator of a string that starts at `from` (1 or 2 NUL bytes by encoding). */
function endOfString(b: Uint8Array, from: number, enc: number): number {
  const wide = enc === 1 || enc === 2;
  for (let i = from; i < b.length - (wide ? 1 : 0); i += wide ? 2 : 1) {
    if (b[i] === 0 && (!wide || b[i + 1] === 0)) return i + (wide ? 2 : 1);
  }
  return b.length;
}

export function parseId3(bytes: Uint8Array): Id3Tags {
  const out: Id3Tags = {};
  try {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return out; // "ID3"
    const major = bytes[3];
    if (major !== 3 && major !== 4) return out;
    const flags = bytes[5];
    const end = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
    let pos = 10;
    if (flags & 0x40) pos += major === 4 ? syncsafe(bytes, 10) : be32(bytes, 10) + 4; // extended header
    while (pos + 10 <= end) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding reached
      const size = major === 4 ? syncsafe(bytes, pos + 4) : be32(bytes, pos + 4);
      const start = pos + 10;
      const stop = start + size;
      if (size <= 0 || stop > bytes.length) break;
      const body = bytes.subarray(start, stop);
      if (id === "TIT2" || id === "TPE1" || id === "TPE2") {
        const text = decode(body.subarray(1), body[0]);
        if (text) {
          if (id === "TIT2") out.title ??= text;
          else if (id === "TPE1") out.artist = text; // TPE1 beats TPE2 (album artist)
          else out.artist ??= text;
        }
      } else if (id === "APIC" && !out.cover) {
        const enc = body[0];
        const mimeEnd = endOfString(body, 1, 0);
        const mime = decode(body.subarray(1, mimeEnd), 0) || "image/jpeg";
        const descStart = mimeEnd + 1; // skip picture-type byte
        const dataStart = endOfString(body, descStart, enc);
        if (dataStart < body.length) out.cover = { mime: mime.startsWith("image/") ? mime : "image/jpeg", data: body.slice(dataStart) };
      }
      pos = stop;
    }
  } catch { /* partial result is fine */ }
  return out;
}

const readBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsArrayBuffer(blob);
  });

/** Reads the tag from the start of a file. Never throws. */
export async function readId3(file: File): Promise<Id3Tags> {
  try {
    const head = await readBytes(file.slice(0, 10));
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const total = Math.min(10 + syncsafe(head, 6), MAX_TAG_BYTES);
    return parseId3(await readBytes(file.slice(0, total)));
  } catch { return {}; }
}
