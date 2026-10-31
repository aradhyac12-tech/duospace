/**
 * Tag + cover reader for imported files: MP3 (ID3v2, see ./id3.ts), M4A/MP4
 * (iTunes atoms) and FLAC (Vorbis comment + PICTURE). No dependencies. OGG/Opus
 * and tag-less files simply return {} and the caller falls back to the file
 * name. Never throws.
 */
import { parseId3, readId3, type Id3Tags } from "@/lib/music/id3";

export type AudioTags = Id3Tags;

const MAX_MP4_READ = 80 * 1024 * 1024; // moov can sit at the END of a non-faststart file
const MAX_FLAC_HEAD = 8 * 1024 * 1024;

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf8 = (b: Uint8Array) => { try { return new TextDecoder("utf-8").decode(b).trim(); } catch { return ""; } };
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

// ───────────────────────────── MP4 / M4A ─────────────────────────────
export function parseMp4(b: Uint8Array): AudioTags {
  const out: AudioTags = {};
  const walk = (start: number, end: number, inIlst: boolean, depth: number) => {
    if (depth > 8) return;
    let p = start;
    while (p + 8 <= end) {
      let size = be32(b, p);
      const type = latin1(b.subarray(p + 4, p + 8));
      let hdr = 8;
      if (size === 1) { size = be32(b, p + 8) * 4294967296 + be32(b, p + 12); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      const bs = p + hdr, be = p + size;
      if (type === "moov" || type === "udta" || type === "ilst") walk(bs, be, type === "ilst", depth + 1);
      else if (type === "meta") walk(bs + 4, be, false, depth + 1); // meta has 4 bytes of version/flags first
      else if (inIlst && (type === "\u00a9nam" || type === "\u00a9ART" || type === "aART" || type === "covr")) {
        // child "data" box: [size][type][version+flags(4)][locale(4)][payload]
        if (bs + 16 <= be && latin1(b.subarray(bs + 4, bs + 8)) === "data") {
          const flags = be32(b, bs + 8) & 0xffffff;
          const payload = b.subarray(bs + 16, Math.min(be, bs + be32(b, bs)));
          if (type === "covr") { if (!out.cover && payload.length) out.cover = { mime: flags === 14 ? "image/png" : "image/jpeg", data: payload.slice() }; }
          else {
            const text = utf8(payload);
            if (text) { if (type === "\u00a9nam") out.title ??= text; else if (type === "\u00a9ART") out.artist = text; else out.artist ??= text; }
          }
        }
      }
      p += size;
    }
  };
  try { walk(0, b.length, false, 0); } catch { /* partial is fine */ }
  return out;
}

// ─────────────────────────────── FLAC ────────────────────────────────
export function parseFlac(b: Uint8Array): AudioTags {
  const out: AudioTags = {};
  try {
    if (b.length < 8 || latin1(b.subarray(0, 4)) !== "fLaC") return out;
    let p = 4;
    while (p + 4 <= b.length) {
      const last = (b[p] & 0x80) !== 0;
      const type = b[p] & 0x7f;
      const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      const s = p + 4, e = s + len;
      if (e > b.length) break;
      if (type === 4) { // VORBIS_COMMENT (little-endian lengths)
        let o = s + 4 + le32(b, s);
        const count = le32(b, o); o += 4;
        for (let i = 0; i < count && o + 4 <= e; i++) {
          const l = le32(b, o); o += 4;
          const kv = utf8(b.subarray(o, o + l)); o += l;
          const eq = kv.indexOf("=");
          if (eq > 0) {
            const key = kv.slice(0, eq).toUpperCase(), val = kv.slice(eq + 1).trim();
            if (val) { if (key === "TITLE") out.title ??= val; else if (key === "ARTIST") out.artist = val; else if (key === "ALBUMARTIST") out.artist ??= val; }
          }
        }
      } else if (type === 6 && !out.cover) { // PICTURE (big-endian)
        let o = s + 4;
        const mimeLen = be32(b, o); o += 4;
        const mime = latin1(b.subarray(o, o + mimeLen)); o += mimeLen;
        const descLen = be32(b, o); o += 4 + descLen + 16; // desc + width/height/depth/colours
        const dataLen = be32(b, o); o += 4;
        if (dataLen > 0 && o + dataLen <= e) out.cover = { mime: mime.startsWith("image/") ? mime : "image/jpeg", data: b.slice(o, o + dataLen) };
      }
      if (last) break;
      p = e;
    }
  } catch { /* partial is fine */ }
  return out;
}

const readBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsArrayBuffer(blob);
  });

/** Sniffs the container and reads whatever tags it has. Never throws. */
export async function readAudioTags(file: Blob & { name?: string }): Promise<AudioTags> {
  try {
    const head = await readBytes(file.slice(0, 12));
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return await readId3(file as File);
    if (latin1(head.subarray(0, 4)) === "fLaC") return parseFlac(await readBytes(file.slice(0, MAX_FLAC_HEAD)));
    if (latin1(head.subarray(4, 8)) === "ftyp" && file.size <= MAX_MP4_READ) return parseMp4(await readBytes(file));
  } catch { /* fall through */ }
  return {};
}
export { parseId3 };
