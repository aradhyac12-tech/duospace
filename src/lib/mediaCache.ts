/**
 * On-device media cache — the part of "like WhatsApp" that is about photos,
 * voice notes and files rather than text.
 *
 * WHAT WAS WRONG: every private-bucket photo/voice note is shown through a
 * short-lived SIGNED URL that has to be minted over the network
 * (signedStorageUrl.ts). So even with the message list on screen, every image
 * was a network fetch on every launch, and offline every one of them was a
 * broken image.
 *
 * WHAT THIS DOES: the first time a media object is successfully signed (i.e.
 * the app is online and about to display it), the bytes are downloaded once in
 * the background and kept in IndexedDB. From then on `resolveSignedUrl()`
 * returns a local `blob:` URL for it — instantly, offline, and identical on
 * every render (so no flicker from a changing signed-URL token either).
 *
 * WHY IndexedDB (not the Cache API, not @capacitor/filesystem):
 *   - WKWebView (iOS) only exposes the Cache API for app-bound domains, so it
 *     is not a portable choice for the IPA.
 *   - IndexedDB stores Blobs natively on both WebViews; the app already relies
 *     on that for pendingSendQueue.ts (queued uploads), so it is a proven path
 *     in this codebase rather than a new dependency or native plugin.
 *
 * BOUNDS (so it can never eat the phone):
 *   - MAX_ITEM_BYTES per object (bigger files, e.g. long videos, are still
 *     streamed online as before — just not kept),
 *   - MAX_TOTAL_BYTES overall with least-recently-used eviction,
 *   - at most MAX_CONCURRENT_DOWNLOADS at a time, best-effort, never blocking
 *     display: the caller already has the signed URL and shows it as usual.
 *
 * PRIVACY NOTE (deliberately stated, not buried): chat media is uploaded to the
 * private bucket as-is (only message TEXT is end-to-end encrypted in this app),
 * so the server already holds the same bytes. The on-device copy is stored
 * unencrypted inside the app's own sandbox — the same protection WhatsApp's
 * media folder has — and is deleted on sign-out (`wipeMediaCache`). Flip
 * `MEDIA_CACHE_ENABLED` to false to turn the whole cache off. Encrypting the
 * blobs at rest is possible but costs a full decrypt-to-memory per view; it is
 * tracked as a follow-up in docs/OFFLINE_FIRST.md rather than half-done here.
 */
import { isOnlineNow } from "@/lib/connectivity";
import { logWarn } from "@/lib/telemetry";
import { getOfflinePref } from "@/lib/offlineSettings";

export const MEDIA_CACHE_ENABLED = true;

/** Build-time kill switch AND the person's own "Save photos & voice notes" choice. */
const enabled = () => MEDIA_CACHE_ENABLED && getOfflinePref("mediaCache");

/** True when we are on mobile data (so "Wi-Fi only" should hold downloads back). */
async function onCellular(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      const { Network } = await import("@capacitor/network");
      return (await Network.getStatus()).connectionType === "cellular";
    }
  } catch { /* fall through to the web signal */ }
  try {
    return (navigator as unknown as { connection?: { type?: string } }).connection?.type === "cellular";
  } catch {
    return false;
  }
}

const DB_NAME = "duo-media-v1";
const BLOBS = "blobs";
const META = "meta";

const MAX_ITEM_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
/** Don't hit the disk to bump "last used" more than this often per object. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed download, wait this long before trying the same object again. */
const RETRY_AFTER_FAIL_MS = 5 * 60 * 1000;
/** Negative-lookup memo so a burst of resolveSignedUrl() calls doesn't hammer IndexedDB. */
const MISS_MEMO_MS = 20_000;

interface MetaRow { key: string; size: number; lastAccess: number }
interface BlobRow { blob: Blob; size: number; type: string }

export const mediaKey = (bucket: string, path: string) => `${bucket}:${path}`;

// ─── Ephemeral (Vanish Mode) media ───────────────────────────────────────────
// Media that was shared while Vanish Mode was on must never be kept on the
// device: the whole point is that it is gone when the session ends. Anything
// registered here is neither served from nor written to the on-device cache.
// In-memory on purpose — Chat re-registers a message's media every time it
// loads the message, always BEFORE the URL is resolved (see vanishMedia.ts).
const ephemeralKeys = new Set<string>();

export function markMediaEphemeral(bucket: string, path: string): void {
  ephemeralKeys.add(mediaKey(bucket, path));
}

export function isMediaEphemeral(bucket: string, path: string): boolean {
  return ephemeralKeys.has(mediaKey(bucket, path));
}

// ─── IndexedDB plumbing ──────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

const objectUrls = new Map<string, string>();      // key -> blob: URL
const urlToKey = new Map<string, { bucket: string; path: string }>(); // blob: URL -> origin
const lastTouched = new Map<string, number>();
const recentMiss = new Map<string, number>();

/** If `url` is one of OUR local blob URLs, which stored object is it? */
export function pathFromLocalUrl(url: string): { bucket: string; path: string } | null {
  return urlToKey.get(url) ?? null;
}

/**
 * A URL that displays this object without the network, or null if we don't
 * have it. Same string every time for the same object (stable <img src>).
 */
export async function getLocalMediaUrl(bucket: string, path: string): Promise<string | null> {
  if (!enabled()) return null;
  const key = mediaKey(bucket, path);
  if (ephemeralKeys.has(key)) return null; // Vanish media is never served from disk
  const memo = objectUrls.get(key);
  if (memo) return memo;

  const missAt = recentMiss.get(key);
  if (missAt && Date.now() - missAt < MISS_MEMO_MS) return null;

  try {
    const db = await openDb();
    const tx = db.transaction(BLOBS, "readonly");
    const row = (await reqToPromise(tx.objectStore(BLOBS).get(key))) as BlobRow | undefined;
    if (!row?.blob) { recentMiss.set(key, Date.now()); return null; }

    const url = URL.createObjectURL(row.blob);
    objectUrls.set(key, url);
    urlToKey.set(url, { bucket, path });
    void touch(key, row.size);
    return url;
  } catch {
    return null; // cache is an optimisation; any failure just means "not cached"
  }
}

async function touch(key: string, size: number): Promise<void> {
  const now = Date.now();
  const last = lastTouched.get(key) ?? 0;
  if (now - last < TOUCH_INTERVAL_MS) return;
  lastTouched.set(key, now);
  try {
    const db = await openDb();
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put({ key, size, lastAccess: now } satisfies MetaRow);
    await txDone(tx);
  } catch { /* best effort */ }
}

// ─── Background download ─────────────────────────────────────────────────────

const inFlight = new Set<string>();
const failedAt = new Map<string, number>();
const waiting: Array<() => void> = [];
let active = 0;

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT_DOWNLOADS) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(() => { active++; resolve(); }));
}
function releaseSlot(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Fire-and-forget: keep a local copy of an object we just successfully signed.
 * Safe to call any number of times for the same object.
 */
export function cacheMediaInBackground(bucket: string, path: string, signedUrl: string): void {
  if (!enabled() || !signedUrl.startsWith("http")) return;
  const key = mediaKey(bucket, path);
  if (ephemeralKeys.has(key)) return; // Vanish media is never written to disk
  if (objectUrls.has(key) || inFlight.has(key)) return;
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_AFTER_FAIL_MS) return;
  inFlight.add(key);

  void (async () => {
    await acquireSlot();
    try {
      if (!isOnlineNow()) return;
      if (getOfflinePref("wifiOnlyMedia") && (await onCellular())) return; // held back, tried again next time it's shown
      // Already stored by an earlier session? Then there's nothing to download.
      if (await getLocalMediaUrl(bucket, path)) return;

      const res = await fetch(signedUrl);
      if (!res.ok) throw new Error(`download failed (${res.status})`);

      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_ITEM_BYTES) return; // too big to keep — still streams online

      const contentType = res.headers.get("content-type") ?? "";
      // Only things the UI shows INLINE (<img>/<audio>/<video>). Documents are
      // opened through their signed https URL in the system browser, where a
      // device-local blob: URL would not work — so they are never cached.
      if (!/^(image|audio|video)\//.test(contentType)) return;
      // Without a declared length we'd have to buffer the whole thing just to
      // find out it's huge. Only accept that risk for types that are small in practice.
      if (!Number.isFinite(declared) && contentType.startsWith("video/")) return;

      const blob = await res.blob();
      if (blob.size === 0 || blob.size > MAX_ITEM_BYTES) return;

      await store(key, blob);
      recentMiss.delete(key);
    } catch (err) {
      failedAt.set(key, Date.now());
      logWarn("mediaCache", "background media download failed", { key, err });
    } finally {
      inFlight.delete(key);
      releaseSlot();
    }
  })();
}

async function store(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const now = Date.now();
  const tx = db.transaction([BLOBS, META], "readwrite");
  tx.objectStore(BLOBS).put({ blob, size: blob.size, type: blob.type } satisfies BlobRow, key);
  tx.objectStore(META).put({ key, size: blob.size, lastAccess: now } satisfies MetaRow);
  await txDone(tx);
  lastTouched.set(key, now);
  await evictIfNeeded();
}

/** Least-recently-used eviction down to ~90% of the cap. */
async function evictIfNeeded(): Promise<void> {
  try {
    const db = await openDb();
    const rows = (await reqToPromise(db.transaction(META, "readonly").objectStore(META).getAll())) as MetaRow[];
    let total = rows.reduce((n, r) => n + r.size, 0);
    if (total <= MAX_TOTAL_BYTES) return;

    const target = MAX_TOTAL_BYTES * 0.9;
    const victims: string[] = [];
    for (const r of rows.sort((a, b) => a.lastAccess - b.lastAccess)) {
      if (total <= target) break;
      victims.push(r.key);
      total -= r.size;
    }
    if (victims.length === 0) return;
    const tx = db.transaction([BLOBS, META], "readwrite");
    for (const k of victims) {
      tx.objectStore(BLOBS).delete(k);
      tx.objectStore(META).delete(k);
      // The blob: URL for an evicted object may still be mounted in an <img>;
      // leave it registered (it stays valid for this session) but stop handing
      // it out for future lookups.
      objectUrls.delete(k);
      lastTouched.delete(k);
    }
    await txDone(tx);
  } catch { /* eviction is best effort */ }
}

// ─── Delete one object ───────────────────────────────────────────────────────

/**
 * Remove ONE object's on-device copy (Vanish Mode cleanup): the stored blob,
 * its metadata row, and the blob: URL handed out for it. Safe to call for an
 * object we never cached. Never throws.
 */
export async function deleteLocalMedia(bucket: string, path: string): Promise<void> {
  const key = mediaKey(bucket, path);
  const url = objectUrls.get(key);
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    urlToKey.delete(url);
  }
  objectUrls.delete(key);
  lastTouched.delete(key);
  recentMiss.delete(key);
  failedAt.delete(key);
  try {
    const db = await openDb();
    const tx = db.transaction([BLOBS, META], "readwrite");
    tx.objectStore(BLOBS).delete(key);
    tx.objectStore(META).delete(key);
    await txDone(tx);
  } catch { /* nothing stored / IndexedDB unavailable */ }
}

// ─── Wipe ────────────────────────────────────────────────────────────────────

/** Sign-out / account deletion: remove every cached object and forget all URLs. */
export async function wipeMediaCache(): Promise<void> {
  for (const url of urlToKey.keys()) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  objectUrls.clear();
  urlToKey.clear();
  lastTouched.clear();
  recentMiss.clear();
  failedAt.clear();
  try {
    const db = await openDb();
    const tx = db.transaction([BLOBS, META], "readwrite");
    tx.objectStore(BLOBS).clear();
    tx.objectStore(META).clear();
    await txDone(tx);
  } catch { /* nothing to wipe / IndexedDB unavailable */ }
}

/** Total bytes currently cached (for a future "Storage" settings row). */
export async function getMediaCacheSize(): Promise<number> {
  try {
    const db = await openDb();
    const rows = (await reqToPromise(db.transaction(META, "readonly").objectStore(META).getAll())) as MetaRow[];
    return rows.reduce((n, r) => n + r.size, 0);
  } catch {
    return 0;
  }
}
