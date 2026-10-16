/**
 * Durable media store — chat photos / voice notes / small videos kept as REAL
 * FILES in the app's private storage, like WhatsApp's media folder.
 *
 * DIFFERENCE FROM THE OLD CACHE (mediaCache.ts, IndexedDB + LRU): files here are
 * never auto-deleted. They stay until the chat is cleared, the pairing ends or
 * the person signs out (wipe). IndexedDB blobs, by contrast, are reclaimable by
 * the OS and were trimmed at a fixed cap.
 *
 * Layout: chat-media/<sha256(key)>.<ext> plus chat-media/index.json mapping the
 * hash to { file, type, size }. The index is rewritten debounced (1 s) and when
 * the app is hidden. If the index is lost the files are orphaned (wasted space
 * only; the next wipe removes the folder) and items simply re-download once.
 *
 * Privacy: stored unencrypted inside the app sandbox — the same protection as
 * the IndexedDB copy had and as WhatsApp's media (see mediaCache.ts header).
 * Web builds don't use this store (no app-private filesystem).
 */
import type { NativeFileApi } from "@/lib/nativeFiles";
import { capacitorFiles, nativeFilesAvailable } from "@/lib/nativeFiles";
import { logWarn } from "@/lib/telemetry";

const DIR = "chat-media";
const INDEX_PATH = `${DIR}/index.json`;
const SAVE_DELAY_MS = 1000;

interface Entry { f: string; type: string; size: number; ts: number }

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/heic": "heic", "image/heif": "heif", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/3gpp": "3gp",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/opus": "opus",
  "audio/webm": "weba", "audio/wav": "wav", "audio/x-wav": "wav", "audio/3gpp": "3gp",
};

/** File extension for a MIME type (lets the WebView serve the right Content-Type). */
export function extensionForType(type: string): string {
  const t = (type || "").split(";")[0].trim().toLowerCase();
  return EXT_BY_TYPE[t] ?? "bin";
}

/** sha-256 hex of a key (fixed length, filesystem-safe). Falls back to a 53-bit hash where subtle is missing. */
export async function hashKey(key: string): Promise<string> {
  try {
    if (globalThis.crypto?.subtle) {
      const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* fall through */ }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `f${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => {
      const s = String(r.result ?? "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type });
}

export interface NativeMediaStore {
  put(key: string, blob: Blob): Promise<boolean>;
  getBlob(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  wipe(): Promise<void>;
  size(): Promise<number>;
  /** Count and bytes by kind (from each file's recorded MIME type). */
  stats(): Promise<MediaStats>;
  flush(): Promise<void>;
}

export interface MediaStats {
  count: number;
  size: number;
  photos: { count: number; size: number };
  audio: { count: number; size: number };
  video: { count: number; size: number };
  other: { count: number; size: number };
}

export const emptyStats = (): MediaStats => ({
  count: 0, size: 0,
  photos: { count: 0, size: 0 }, audio: { count: 0, size: 0 }, video: { count: 0, size: 0 }, other: { count: 0, size: 0 },
});

export function createNativeMediaStore(
  files: NativeFileApi,
  hash: (key: string) => Promise<string> = hashKey,
  opts: { listenForHide?: boolean } = {},
): NativeMediaStore {
  let index: Map<string, Entry> | null = null;
  let loading: Promise<Map<string, Entry>> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  async function loadIndex(): Promise<Map<string, Entry>> {
    if (index) return index;
    if (!loading) {
      loading = (async () => {
        const m = new Map<string, Entry>();
        try {
          const text = await files.readText(INDEX_PATH);
          if (text) {
            const parsed = JSON.parse(text) as { entries?: Record<string, Entry> };
            for (const [h, e] of Object.entries(parsed.entries ?? {})) {
              if (e && typeof e.f === "string" && typeof e.size === "number") m.set(h, e);
            }
          }
        } catch { /* unreadable index → start empty */ }
        index = m;
        return m;
      })();
    }
    return loading;
  }

  async function save(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !index) return;
    dirty = false;
    try {
      await files.writeText(INDEX_PATH, JSON.stringify({ v: 1, entries: Object.fromEntries(index) }));
    } catch (err) {
      dirty = true;
      logWarn("nativeMediaStore", "could not save the media index", err);
    }
  }

  const scheduleSave = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; void save(); }, SAVE_DELAY_MS);
  };

  if (opts.listenForHide !== false && typeof document !== "undefined" && typeof window !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void save(); });
    window.addEventListener("pagehide", () => { void save(); });
  }

  return {
    async put(key, blob) {
      try {
        const idx = await loadIndex();
        const h = await hash(key);
        const name = `${h}.${extensionForType(blob.type)}`;
        await files.writeBase64(`${DIR}/${name}`, await blobToBase64(blob));
        const old = idx.get(h);
        if (old && old.f !== name) await files.remove(`${DIR}/${old.f}`);
        idx.set(h, { f: name, type: blob.type, size: blob.size, ts: Date.now() });
        scheduleSave();
        return true;
      } catch (err) {
        logWarn("nativeMediaStore", "could not write media file — falling back to the browser store", err);
        return false;
      }
    },

    async getBlob(key) {
      try {
        const idx = await loadIndex();
        const h = await hash(key);
        const e = idx.get(h);
        if (!e) return null;
        const path = `${DIR}/${e.f}`;
        // Fast path: let the WebView read the file itself (no base64 over the bridge).
        const web = await files.webUrl(path);
        if (web) {
          try {
            const res = await fetch(web);
            if (res.ok) {
              const b = await res.blob();
              if (b.size > 0) return b.type ? b : new Blob([b], { type: e.type });
            }
          } catch { /* fall through to the bridge read */ }
        }
        const b64 = await files.readBase64(path);
        if (!b64) {
          idx.delete(h); scheduleSave(); // file vanished → forget it so it re-downloads
          return null;
        }
        return base64ToBlob(b64, e.type);
      } catch {
        return null;
      }
    },

    async has(key) {
      try { return (await loadIndex()).has(await hash(key)); } catch { return false; }
    },

    async remove(key) {
      try {
        const idx = await loadIndex();
        const h = await hash(key);
        const e = idx.get(h);
        if (!e) return;
        idx.delete(h);
        scheduleSave();
        await files.remove(`${DIR}/${e.f}`);
      } catch { /* best effort */ }
    },

    async wipe() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
      index = new Map();
      loading = Promise.resolve(index);
      await files.removeDir(DIR);
    },

    async size() {
      try {
        let n = 0;
        for (const e of (await loadIndex()).values()) n += e.size;
        return n;
      } catch { return 0; }
    },

    async stats() {
      const out = emptyStats();
      try {
        for (const e of (await loadIndex()).values()) {
          const bucket = e.type.startsWith("image/") ? out.photos
            : e.type.startsWith("audio/") ? out.audio
            : e.type.startsWith("video/") ? out.video : out.other;
          bucket.count++; bucket.size += e.size;
          out.count++; out.size += e.size;
        }
      } catch { /* empty stats */ }
      return out;
    },

    flush: save,
  };
}

/** The app's instance — null on web, where there is no app-private filesystem. */
export const nativeMediaStore: NativeMediaStore | null = nativeFilesAvailable() ? createNativeMediaStore(capacitorFiles) : null;
