import { IMAGE_MIMES, MEDIA_LIMITS, VIDEO_MIMES } from "./config";
import { MediaError, type MediaKind, type MediaScope } from "./types";

/** Detect the real type from magic bytes — file.type and extensions can be wrong or empty (Android). */
export function sniffMime(head: Uint8Array): string | null {
  const s = (o: number, n: number) => String.fromCharCode(...head.slice(o, o + n));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (s(0, 4) === "GIF8") return "image/gif";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (s(4, 4) === "ftyp") {
    const brand = s(8, 4);
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heif";
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("3gp")) return "video/3gpp";
    return "video/mp4"; // isom, mp41, mp42, M4V, ...
  }
  return null;
}

export interface ValidatedFile { mime: string; kind: MediaKind }

export async function validateMediaFile(file: Blob, scope: MediaScope): Promise<ValidatedFile> {
  if (!file || file.size <= 0) throw new MediaError("INVALID_FILE", "The file is empty");
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const sniffed = sniffMime(head);
  const declared = (file.type || "").toLowerCase();
  // The real bytes are the source of truth. A declared type is never trusted on
  // its own: arbitrary bytes labelled image/jpeg must not pass.
  if (!sniffed) throw new MediaError("INVALID_FILE", "This file type isn't supported");
  const mime = sniffed;
  const kind: MediaKind | null = (IMAGE_MIMES as readonly string[]).includes(mime) ? "image"
    : (VIDEO_MIMES as readonly string[]).includes(mime) ? "video" : null;
  if (!kind) throw new MediaError("INVALID_FILE", "This file type isn't supported");
  // A declared type that contradicts the real bytes (image/jpeg that is really a video) is rejected.
  if (declared && sniffed && (declared.startsWith("image/") !== sniffed.startsWith("image/")) && declared !== "application/octet-stream") {
    throw new MediaError("INVALID_FILE", "The file doesn't match its type");
  }
  if ((scope === "profile" || scope === "memories") && kind !== "image") throw new MediaError("INVALID_FILE", "Only photos are allowed here");
  const max = kind === "image" ? MEDIA_LIMITS.maxImageBytes : MEDIA_LIMITS.maxVideoBytes;
  if (file.size > max) throw new MediaError("INVALID_FILE", `File is too large (max ${Math.round(max / 1048576)} MB)`);
  if (kind === "video") {
    const seconds = await readVideoDuration(file);
    if (seconds !== null && seconds > MEDIA_LIMITS.maxVideoSeconds) throw new MediaError("INVALID_FILE", `Video is too long (max ${Math.round(MEDIA_LIMITS.maxVideoSeconds / 60)} min)`);
  }
  return { mime, kind };
}

/** Reads only container metadata (no full decode, no file bytes held in JS). null = unknown. */
export function readVideoDuration(file: Blob, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (n: number | null) => { clearTimeout(t); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); resolve(n); };
    const t = setTimeout(() => done(null), timeoutMs);
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
