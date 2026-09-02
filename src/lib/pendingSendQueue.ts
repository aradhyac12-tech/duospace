/**
 * Persists an outgoing photo/file/voice message's raw bytes across a page
 * reload — not just its "failed" status.
 *
 * ROOT CAUSE this exists to fix: attemptSendMedia's retry state
 * (pendingSendPayloads in Chat.tsx) is a `useRef<Map>` — pure in-memory
 * JS state. The optimistic "sending"/"failed" bubble itself lives only in
 * `messages` React state, which is rebuilt from a DB query on every mount.
 * Since a media message is only ever inserted into the `messages` table
 * AFTER its upload finishes (see attemptSendMedia), a page reload while a
 * photo/file/voice note is uploading — or after it failed but before the
 * user tapped retry — makes the ENTIRE attempt disappear with no trace and
 * no way to retry: not "failed", just gone, as if it was never picked at
 * all. Meanwhile the chunks that DID make it up before the reload, plus
 * the `pending_uploads` tracking row, are still sitting server-side —
 * genuinely resumable — but nothing on the client remembers they exist.
 *
 * The fix has to be the raw file bytes, not just a flag: a `File`/`Blob`
 * object cannot survive a reload on its own (it only ever exists as an
 * in-memory JS reference), and there's no way to reconstruct it from
 * whatever chunks happen to have landed server-side if the reload
 * happened before upload finished. IndexedDB is the one browser storage
 * that can hold a Blob directly (structured-clone support, no need to
 * base64-encode into localStorage, which would also blow its ~5MB quota
 * on anything but a tiny photo).
 *
 * Every record is keyed by the SAME clientId the optimistic bubble and
 * resumableUpload's objectPath already use — Chat.tsx's own "retry
 * integrity" fix derives objectPath from clientId specifically so a retry
 * resumes rather than re-uploads from zero. Rehydrating with that same
 * clientId after a reload gets that exact same resume behavior for free:
 * any chunks already on the server before the reload are skipped, not
 * re-sent.
 */
import { logError, logWarn } from "@/lib/telemetry";

const DB_NAME = "duospace-pending-send";
const DB_VERSION = 1;
const STORE = "pendingMedia";
// Mirrors the server-side cleanup-orphan-uploads cron's own 24h window —
// past that point the tracking row/chunks are already gone server-side,
// so resuming isn't possible anyway and holding onto the blob is just
// wasted space.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PendingMediaEntry {
  clientId: string;
  partnerId: string;
  msgType: "image" | "file" | "voice";
  fileName: string;
  contentType: string;
  disappearAt: string | null;
  blob: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  // IndexedDB isn't available in every embedding context (e.g. some
  // WebViews with storage locked down, private-browsing edge cases) — this
  // whole module is a resilience LAYER on top of the send flow, not a
  // requirement for it, so every entry point below degrades to "just don't
  // persist" rather than breaking the send itself if IndexedDB is missing.
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  return dbPromise;
}

/** Called right as the optimistic bubble is created — before the network
 *  upload starts — so even a reload a moment later has the bytes saved. */
export async function savePendingMedia(entry: PendingMediaEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("put failed"));
    });
  } catch (err) {
    // Never throw into the send path over a persistence-layer failure —
    // the send itself (attemptSendMedia) still works normally this
    // session, it just won't survive a reload if this failed.
    logWarn("pendingSendQueue", "savePendingMedia failed — send will proceed without reload-resilience", { clientId: entry.clientId, error: String(err) });
  }
}

/** Called once the message row is actually inserted (send succeeded). */
export async function deletePendingMedia(clientId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("delete failed"));
    });
  } catch (err) {
    logWarn("pendingSendQueue", "deletePendingMedia failed — entry may be resent once more on next reload, harmless (idempotent)", { clientId, error: String(err) });
  }
}

/** Called once on Chat mount to rehydrate anything left over from before a
 *  reload, for the current conversation only (this app is 1:1, but scoped
 *  by partnerId defensively rather than returning everything in the store). */
export async function listPendingMedia(partnerId: string): Promise<PendingMediaEntry[]> {
  try {
    const db = await openDb();
    const all = await new Promise<PendingMediaEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as PendingMediaEntry[]);
      req.onerror = () => reject(req.error ?? new Error("getAll failed"));
    });
    return all.filter((e) => e.partnerId === partnerId).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    logError("pendingSendQueue", "listPendingMedia failed — any media stuck from before a reload won't be offered to resume this session", { error: String(err) });
    return [];
  }
}

/** Called once on Chat mount, alongside listPendingMedia — drops anything
 *  old enough that the server has already garbage-collected its chunks. */
export async function purgeStalePendingMedia(): Promise<void> {
  try {
    const db = await openDb();
    const cutoff = Date.now() - MAX_AGE_MS;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      for (const entry of (req.result ?? []) as PendingMediaEntry[]) {
        if (entry.createdAt < cutoff) store.delete(entry.clientId);
      }
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("purge failed"));
    });
  } catch {
    // Best-effort housekeeping — a failed purge just means stale entries
    // linger until the next successful pass, not a correctness issue.
  }
}
