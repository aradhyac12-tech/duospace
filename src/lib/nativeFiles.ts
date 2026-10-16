/**
 * Thin facade over @capacitor/filesystem (Directory.Data = the app's private
 * storage) used by the durable on-device tier: the message/snapshot mirror
 * (localDb/nativeMirror.ts) and the media files (nativeMediaStore.ts).
 *
 * WHY THIS EXISTS: IndexedDB lives inside the WebView's browser storage, which
 * the OS may reclaim when the device is low on space (Capacitor's own storage
 * guide says so for iOS; on Android only `storage.persist()` mitigates it).
 * Real files in app-private storage are not subject to that — which is how
 * WhatsApp keeps messages and media (a database + media files in the app's own
 * folders, never auto-deleted).
 *
 * Every method is best-effort and never throws except the two writers (callers
 * catch). Paths are relative to Directory.Data. Web builds have no equivalent:
 * `nativeFilesAvailable()` is false there and callers skip this tier entirely.
 */
import { Capacitor } from "@capacitor/core";

export interface NativeFileApi {
  readText(path: string): Promise<string | null>;
  writeText(path: string, data: string): Promise<void>;
  readBase64(path: string): Promise<string | null>;
  writeBase64(path: string, b64: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  /** Entry names (files and folders) directly inside `dir`; [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  /** A URL the WebView can load the file from (fetch / <img>), or null. */
  webUrl(path: string): Promise<string | null>;
}

export const nativeFilesAvailable = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const fs = () => import("@capacitor/filesystem");

export const capacitorFiles: NativeFileApi = {
  async readText(path) {
    try {
      const { Filesystem, Directory, Encoding } = await fs();
      const r = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof r.data === "string" ? r.data : null;
    } catch { return null; }
  },
  async writeText(path, data) {
    const { Filesystem, Directory, Encoding } = await fs();
    await Filesystem.writeFile({ path, data, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
  },
  async readBase64(path) {
    try {
      const { Filesystem, Directory } = await fs();
      const r = await Filesystem.readFile({ path, directory: Directory.Data });
      return typeof r.data === "string" ? r.data : null;
    } catch { return null; }
  },
  async writeBase64(path, b64) {
    const { Filesystem, Directory } = await fs();
    await Filesystem.writeFile({ path, data: b64, directory: Directory.Data, recursive: true });
  },
  async remove(path) {
    try {
      const { Filesystem, Directory } = await fs();
      await Filesystem.deleteFile({ path, directory: Directory.Data });
    } catch { /* already gone */ }
  },
  async removeDir(path) {
    try {
      const { Filesystem, Directory } = await fs();
      await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true });
    } catch { /* already gone */ }
  },
  async list(dir) {
    try {
      const { Filesystem, Directory } = await fs();
      const r = await Filesystem.readdir({ path: dir, directory: Directory.Data });
      return (r.files as Array<string | { name: string }>).map((f) => (typeof f === "string" ? f : f.name));
    } catch { return []; }
  },
  async webUrl(path) {
    try {
      const { Filesystem, Directory } = await fs();
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
      return Capacitor.convertFileSrc(uri);
    } catch { return null; }
  },
};

/** In-memory implementation for tests (and nothing else). */
export function createMemoryFiles(): NativeFileApi & { dump(): Map<string, string> } {
  const store = new Map<string, string>(); // path -> data (text or base64)
  const norm = (p: string) => p.replace(/\/+$/, "");
  return {
    dump: () => store,
    async readText(p) { return store.get(norm(p)) ?? null; },
    async writeText(p, d) { store.set(norm(p), d); },
    async readBase64(p) { return store.get(norm(p)) ?? null; },
    async writeBase64(p, d) { store.set(norm(p), d); },
    async remove(p) { store.delete(norm(p)); },
    async removeDir(p) { const d = norm(p) + "/"; for (const k of [...store.keys()]) if (k.startsWith(d)) store.delete(k); },
    async list(dir) {
      const d = norm(dir) + "/";
      const names = new Set<string>();
      for (const k of store.keys()) if (k.startsWith(d)) names.add(k.slice(d.length).split("/")[0]);
      return [...names];
    },
    async webUrl(p) { return store.has(norm(p)) ? `memory://${norm(p)}` : null; },
  };
}
