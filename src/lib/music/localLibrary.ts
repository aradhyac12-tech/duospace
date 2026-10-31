/**
 * "My Files" — songs the user imports from their own device.
 *
 * WHY: the most reliable background playback there is. The file lives in the
 * app's private storage and plays through the native engine via a file:// URI,
 * so it needs no network, no third-party API and no licence beyond the user's
 * own copy.
 *
 * ARTWORK: every track always has a cover. Embedded art (MP3 ID3, M4A, FLAC) is
 * centre-cropped to a 200px JPEG and saved as a FILE next to the song (no
 * localStorage quota involved); a track without embedded art gets a generated
 * cover (./fallbackArt.ts). Files imported before tags were read are re-tagged
 * once, in the background, the first time the library opens.
 *
 * LIMITS (honest):
 *  - Per account, per device. Not synced, and a partner cannot play it (their
 *    phone doesn't have the file) — GroicContext tells the guest instead of
 *    failing silently.
 *  - Native (Android/iOS): files are copied into Directory.Data/groic-local/.
 *    Web: no persistent file store here, so imports (and their covers) last for
 *    the session only.
 *  - OGG/Opus and other tag formats fall back to the "Artist - Title" file name.
 */
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { GroicTrack } from "@/lib/music/types";
import { makeTrackId } from "@/lib/music/types";
import { getMusicProfileScope } from "@/lib/music/playHistory";
import { readAudioTags } from "@/lib/music/audioTags";
import { fallbackArt } from "@/lib/music/fallbackArt";

const KEY = "groic-local-files";
const LEGACY_COVERS_KEY = "groic-local-covers"; // earlier build kept covers in localStorage
const EVENT = "groic-local-files-changed";
const DIR = "groic-local";
const CHUNK = 768 * 1024; // multiple of 3 so each chunk's base64 concatenates cleanly
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga|weba|mp4)$/i;

interface LocalRecord {
  id: string; title: string; artist: string; duration: number; path: string; addedAt: number;
  hasCover?: boolean;
  tagged?: boolean; // true once tags have been read (new imports, or after the one-time backfill)
  artTried?: boolean; // scanned tracks: album art lookup already attempted (found or not)
  uri?: string;     // set for tracks found by "Scan phone": content:// URI, file NOT copied into app storage
}

const scopedKey = () => `${KEY}:${getMusicProfileScope()}`;
const coverPath = (id: string) => `${DIR}/${id}.jpg`;

// id -> data URL, kept in memory (≈10 KB each). Persisted as files on native.
const coverMemo = new Map<string, string>();
// Web fallback only: id -> object URL for this session.
const sessionUrls = new Map<string, string>();

function readRecords(): LocalRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey()) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string" && typeof r.path === "string") : [];
  } catch { return []; }
}
function writeRecords(list: LocalRecord[]): void {
  try { localStorage.setItem(scopedKey(), JSON.stringify(list)); } catch { /* storage full/blocked: keep going */ }
  window.dispatchEvent(new Event(EVENT));
}

const toTrack = (r: LocalRecord): GroicTrack => {
  const art = coverMemo.get(r.id) ?? fallbackArt(r.title, r.artist); // never blank
  return {
    id: makeTrackId("local", r.id),
    provider: "local",
    providerTrackId: r.id,
    videoId: r.id,
    title: r.title,
    artist: r.artist,
    thumbnail: art,
    artwork: art,
    duration: r.duration,
    isStreamable: true,
    isDownloadable: false,
  };
};

export const listLocalTracks = (): GroicTrack[] => readRecords().sort((a, b) => b.addedAt - a.addedAt).map(toTrack);

export function useLocalTracks(): GroicTrack[] {
  const [tracks, setTracks] = useState<GroicTrack[]>(() => listLocalTracks());
  useEffect(() => {
    const sync = () => setTracks(listLocalTracks());
    window.addEventListener(EVENT, sync);
    void ensureLibraryReady();
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return tracks;
}

/** "Artist - Title.mp3" -> {artist, title}; anything else -> title only. */
export function parseFileName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "My Files", title: base || "Untitled" };
}

export const isAudioFile = (f: File): boolean => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);

function probeDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (d: number) => { URL.revokeObjectURL(url); a.removeAttribute("src"); resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : 0); };
    const timer = window.setTimeout(() => done(0), 4000);
    a.preload = "metadata";
    a.onloadedmetadata = () => { window.clearTimeout(timer); done(a.duration); };
    a.onerror = () => { window.clearTimeout(timer); done(0); };
    a.src = url;
  });
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });

async function writeNative(path: string, file: Blob): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  for (let off = 0; off < file.size || off === 0; off += CHUNK) {
    const data = await blobToBase64(file.slice(off, off + CHUNK));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Data });
    if (file.size === 0) break;
  }
}

/** Downscale embedded art to a 200px square JPEG data URL (≈10 KB). */
async function coverToDataUrl(cover: { mime: string; data: Uint8Array }): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(new Blob([cover.data], { type: cover.mime }));
    const size = 200;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const side = Math.min(bmp.width, bmp.height); // centre-crop to a square
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    bmp.close?.();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch { return null; }
}

/** Remember a cover in memory and (native) persist it as a file. Returns false if it could not be kept. */
async function saveCover(id: string, dataUrl: string): Promise<boolean> {
  coverMemo.set(id, dataUrl);
  if (!Capacitor.isNativePlatform()) return true;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    await Filesystem.writeFile({ path: coverPath(id), data: dataUrl.split(",")[1] ?? "", directory: Directory.Data, recursive: true });
    return true;
  } catch { return false; }
}

// ───────────── library warm-up: load covers, migrate, backfill tags ─────────────
let readyScope: string | null = null;
let readyPromise: Promise<void> | null = null;

function ensureLibraryReady(): Promise<void> {
  const scope = getMusicProfileScope();
  if (readyPromise && readyScope === scope) return readyPromise;
  readyScope = scope;
  readyPromise = (async () => {
    if (!Capacitor.isNativePlatform()) return; // web: nothing persisted
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    let records = readRecords();

    // 1. One-time migration of covers the earlier build kept in localStorage.
    try {
      const legacyKey = `${LEGACY_COVERS_KEY}:${scope}`;
      const legacy = JSON.parse(localStorage.getItem(legacyKey) || "null") as Record<string, string> | null;
      if (legacy && typeof legacy === "object") {
        for (const [id, url] of Object.entries(legacy)) {
          const rec = records.find((r) => r.id === id);
          if (rec && typeof url === "string" && url.startsWith("data:") && (await saveCover(id, url))) rec.hasCover = true;
        }
        localStorage.removeItem(legacyKey);
        writeRecords(records);
      }
    } catch { /* migration is best-effort */ }

    // 2. Load saved covers into memory.
    let loaded = false;
    for (const r of records) {
      if (!r.hasCover || coverMemo.has(r.id)) continue;
      try {
        const { data } = await Filesystem.readFile({ path: coverPath(r.id), directory: Directory.Data });
        coverMemo.set(r.id, `data:image/jpeg;base64,${typeof data === "string" ? data : ""}`);
        loaded = true;
      } catch { r.hasCover = false; }
    }
    if (loaded) window.dispatchEvent(new Event(EVENT));

    // 3. Re-tag files imported before tags were read (once per file, in the background).
    for (const r of records.filter((x) => !x.tagged)) {
      try {
        const { uri } = await Filesystem.getUri({ path: r.path, directory: Directory.Data });
        const blob = await (await fetch(Capacitor.convertFileSrc(uri))).blob();
        const tags = await readAudioTags(blob);
        const fresh = readRecords(); // re-read: the user may have imported/removed meanwhile
        const cur = fresh.find((x) => x.id === r.id);
        if (!cur) continue;
        if (tags.title) cur.title = tags.title;
        if (tags.artist) cur.artist = tags.artist;
        if (tags.cover && !coverMemo.has(r.id)) {
          const url = await coverToDataUrl(tags.cover);
          if (url && (await saveCover(r.id, url))) cur.hasCover = true;
        }
        cur.tagged = true;
        writeRecords(fresh);
      } catch { /* leave untagged; retried next launch */ }
    }
    records = readRecords();
  })().catch(() => { readyPromise = null; });
  return readyPromise;
}

export interface ImportResult { added: GroicTrack[]; skipped: string[] }

/** Imports the picked files. Never throws; unreadable/non-audio files land in `skipped`. */
export async function importLocalFiles(files: File[]): Promise<ImportResult> {
  const native = Capacitor.isNativePlatform();
  const records = readRecords();
  const added: GroicTrack[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!isAudioFile(file)) { skipped.push(file.name); continue; }
    const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "");
    const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "mp3").toLowerCase();
    const path = `${DIR}/${id}.${ext}`;
    try {
      const duration = await probeDuration(file);
      if (native) await writeNative(path, file);
      else sessionUrls.set(id, URL.createObjectURL(file));
      const fromName = parseFileName(file.name);
      const tags = await readAudioTags(file);
      const rec: LocalRecord = { id, title: tags.title || fromName.title, artist: tags.artist || fromName.artist, duration, path, addedAt: Date.now(), tagged: true };
      if (tags.cover) {
        const url = await coverToDataUrl(tags.cover);
        if (url && (await saveCover(id, url))) rec.hasCover = true;
      }
      records.push(rec);
      added.push(toTrack(rec));
    } catch {
      skipped.push(file.name);
      if (native) { try { const { Filesystem, Directory } = await import("@capacitor/filesystem"); await Filesystem.deleteFile({ path, directory: Directory.Data }); } catch { /* partial file may not exist */ } }
    }
  }
  if (added.length) writeRecords(records);
  return { added, skipped };
}

export interface DeviceScanItem { id: string; uri: string; title: string; artist: string; album?: string; duration: number }

/**
 * Merge a phone scan into the library: adds new songs, refreshes tags of known ones,
 * and drops scanned songs that no longer exist on the phone. Imported (copied) files
 * are never touched. Ids are stable (`ms<MediaStore id>`) so rescans don't duplicate.
 */
export function syncDeviceTracks(items: DeviceScanItem[]): { added: number; removed: number } {
  const records = readRecords();
  const seen = new Set<string>();
  let added = 0;
  const now = Date.now();
  items.forEach((it, i) => {
    if (!it || typeof it.id !== "string" || typeof it.uri !== "string") return;
    const id = `ms${it.id.replace(/[^a-zA-Z0-9-]/g, "")}`;
    seen.add(id);
    const cur = records.find((r) => r.id === id);
    if (cur) { cur.title = it.title || cur.title; cur.artist = it.artist || cur.artist; cur.duration = it.duration || cur.duration; cur.uri = it.uri; return; }
    // addedAt keeps phone order (newest first) below anything imported just now.
    records.push({ id, title: it.title || "Untitled", artist: it.artist || "This phone", duration: it.duration || 0, path: "", addedAt: now - i - 1, tagged: true, uri: it.uri });
    added++;
  });
  const kept = records.filter((r) => !r.uri || seen.has(r.id));
  const removed = records.length - kept.length;
  for (const r of records) if (r.uri && !seen.has(r.id) && r.hasCover) { coverMemo.delete(r.id); void deleteCoverFile(r.id); }
  if (added || removed || items.length) writeRecords(kept);
  return { added, removed };
}

async function deleteCoverFile(id: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { const { Filesystem, Directory } = await import("@capacitor/filesystem"); await Filesystem.deleteFile({ path: coverPath(id), directory: Directory.Data }); } catch { /* already gone */ }
}

let artRunning = false;
/**
 * Fetch real album art for phone-scanned songs, one at a time in the background (never blocks the UI).
 * `getArt(mediaStoreId)` returns a JPEG data URL or null. Each song is tried once (artTried), so songs
 * without art are not re-queried on every launch. Safe to call repeatedly; only one run at a time.
 */
export async function backfillDeviceArt(getArt: (mediaStoreId: string) => Promise<string | null>): Promise<number> {
  if (artRunning) return 0;
  artRunning = true;
  let found = 0;
  try {
    await ensureLibraryReady();
    const todo = readRecords().filter((r) => r.uri && !r.hasCover && !r.artTried).map((r) => r.id);
    const flush = (updates: Map<string, boolean>) => {
      if (updates.size === 0) return;
      const fresh = readRecords(); // re-read: the user may have scanned/removed meanwhile
      for (const [id, has] of updates) { const cur = fresh.find((x) => x.id === id); if (cur) { cur.artTried = true; if (has) cur.hasCover = true; } }
      writeRecords(fresh);
      updates.clear();
    };
    const pending = new Map<string, boolean>();
    for (const id of todo) {
      let has = false;
      try {
        const url = await getArt(id.replace(/^ms/, ""));
        if (url && url.startsWith("data:") && (await saveCover(id, url))) { has = true; found++; }
      } catch { /* leave artTried so a broken file isn't retried forever */ }
      pending.set(id, has);
      if (pending.size >= 20) { flush(pending); await new Promise((r) => setTimeout(r, 0)); }
    }
    flush(pending);
  } finally { artRunning = false; }
  return found;
}

export const isDeviceTrack = (providerTrackId: string): boolean => !!readRecords().find((r) => r.id === providerTrackId)?.uri;

export async function removeLocalTrack(providerTrackId: string): Promise<void> {
  const records = readRecords();
  const rec = records.find((r) => r.id === providerTrackId);
  if (!rec) return;
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    // Scanned tracks live on the phone's storage: only forget them, NEVER delete the audio file.
    if (!rec.uri) { try { await Filesystem.deleteFile({ path: rec.path, directory: Directory.Data }); } catch { /* already gone */ } }
    if (rec.hasCover) { try { await Filesystem.deleteFile({ path: coverPath(rec.id), directory: Directory.Data }); } catch { /* already gone */ } }
  }
  coverMemo.delete(providerTrackId);
  const url = sessionUrls.get(providerTrackId);
  if (url) { URL.revokeObjectURL(url); sessionUrls.delete(providerTrackId); }
  writeRecords(records.filter((r) => r.id !== providerTrackId));
}

/** Playable URL for the native engine (file://...). Never throws; null = file is gone. */
export async function resolveLocalStreamUrl(providerTrackId: string): Promise<string | null> {
  const rec = readRecords().find((r) => r.id === providerTrackId);
  if (!rec) return null;
  if (rec.uri) return rec.uri; // phone-scanned track
  if (!Capacitor.isNativePlatform()) return sessionUrls.get(providerTrackId) ?? null;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { uri } = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
    return uri || null;
  } catch { return null; }
}
