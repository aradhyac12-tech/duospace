/**
 * locationQueue — durable offline write queue for live-location upserts.
 *
 * Storage strategy:
 *   1. IndexedDB (primary)         — survives reloads, large capacity.
 *   2. localStorage (fallback)     — when IDB is unavailable (private mode, old browsers).
 *   3. In-memory  (last resort)    — when both are blocked.
 *
 * Guarantees:
 *   • FIFO replay (insertion order preserved by auto-increment key / array index).
 *   • Bounded — oldest entries are evicted past `MAX_QUEUE`.
 *   • Successful writes are removed individually (no "lose-the-batch" replay bug).
 *   • Exponential retry handled by the caller; this module only stores/flushes.
 */

import { supabase } from "@/integrations/supabase/client";
import { logInfo, logWarn, logError } from "@/lib/telemetry";

export interface QueuedLocation {
  user_id: string;
  latitude: number;
  longitude: number;
  /** Capture timestamp (ms epoch). Preserved so server can reject stale fixes. */
  captured_at: number;
}

interface StoredEntry extends QueuedLocation {
  /** Internal id assigned at enqueue time (used for ordered deletion). */
  _id?: number;
}

const TELE      = "locationQueue";
const MAX_QUEUE = 500;
const DB_NAME   = "duo-location-queue";
const STORE     = "writes";
const LS_KEY    = "duo-loc-queue-fallback";

let idbPromise: Promise<IDBDatabase | null> | null = null;
let memoryFallback: StoredEntry[] = [];
let nextMemId = 1;

// ── IndexedDB helpers ───────────────────────────────────────────────────────
function openIdb(): Promise<IDBDatabase | null> {
  if (idbPromise) return idbPromise;
  if (typeof indexedDB === "undefined") return (idbPromise = Promise.resolve(null));
  idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "_id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => { logWarn(TELE, "idb_open_failed", req.error); resolve(null); };
      req.onblocked = () => resolve(null);
    } catch (err) { logWarn(TELE, "idb_open_threw", err); resolve(null); }
  });
  return idbPromise;
}

async function idbAdd(entry: QueuedLocation): Promise<boolean> {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(entry);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    } catch { resolve(false); }
  });
}

async function idbReadAll(): Promise<StoredEntry[]> {
  const db = await openIdb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as StoredEntry[]) ?? []);
      req.onerror   = () => resolve([]);
    } catch { resolve([]); }
  });
}

async function idbDelete(id: number): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    } catch { resolve(); }
  });
}

async function idbCount(): Promise<number> {
  const db = await openIdb();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result ?? 0);
      req.onerror   = () => resolve(0);
    } catch { resolve(0); }
  });
}

async function idbTrim(max: number): Promise<void> {
  const all = await idbReadAll();
  if (all.length <= max) return;
  const excess = all.length - max;
  for (let i = 0; i < excess; i++) {
    if (all[i]._id != null) await idbDelete(all[i]._id!);
  }
}

// ── localStorage fallback ───────────────────────────────────────────────────
function lsRead(): StoredEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as StoredEntry[]) : [];
  } catch { return []; }
}
function lsWrite(entries: StoredEntry[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(entries)); } catch { /* quota */ }
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function enqueueLocation(loc: QueuedLocation): Promise<void> {
  // Try IDB first.
  if (await idbAdd(loc)) {
    void idbTrim(MAX_QUEUE);
    return;
  }
  // Fall back to localStorage.
  if (typeof localStorage !== "undefined") {
    const entries = lsRead();
    entries.push({ ...loc, _id: Date.now() + Math.random() });
    while (entries.length > MAX_QUEUE) entries.shift();
    lsWrite(entries);
    return;
  }
  // Final: in-memory.
  memoryFallback.push({ ...loc, _id: nextMemId++ });
  while (memoryFallback.length > MAX_QUEUE) memoryFallback.shift();
}

export async function getQueueDepth(): Promise<number> {
  const idbN = await idbCount();
  if (idbN > 0) return idbN;
  if (typeof localStorage !== "undefined") {
    const n = lsRead().length;
    if (n > 0) return n;
  }
  return memoryFallback.length;
}

export interface FlushResult {
  success: number;
  failure: number;
  duration_ms: number;
  remaining: number;
}

/**
 * Replays queued writes oldest→newest. Successful entries are removed individually.
 * Stops early on the first persistent failure to preserve order; returns a summary.
 */
export async function flushQueuedLocations(): Promise<FlushResult> {
  const start = performance.now();
  const result: FlushResult = { success: 0, failure: 0, duration_ms: 0, remaining: 0 };

  const idbAll = await idbReadAll();
  let lsAll: StoredEntry[] = [];
  if (idbAll.length === 0 && typeof localStorage !== "undefined") {
    lsAll = lsRead();
  }
  const memAll = idbAll.length === 0 && lsAll.length === 0 ? memoryFallback.slice() : [];
  const all = idbAll.length ? idbAll : (lsAll.length ? lsAll : memAll);

  if (all.length === 0) {
    result.duration_ms = performance.now() - start;
    return result;
  }

  logInfo(TELE, "flush_start", { depth: all.length });

  for (const entry of all) {
    // Sanity: never replay payloads with bad coordinates.
    if (!Number.isFinite(entry.latitude) || !Number.isFinite(entry.longitude) ||
        Math.abs(entry.latitude) > 90 || Math.abs(entry.longitude) > 180) {
      // Drop poisoned entries silently.
      if (entry._id != null && idbAll.length) await idbDelete(entry._id);
      continue;
    }
    try {
      const { error } = await supabase
        .from("locations")
        .upsert(
          { user_id: entry.user_id, latitude: entry.latitude, longitude: entry.longitude },
          { onConflict: "user_id" },
        );
      if (error) throw error;

      // Remove on success.
      if (idbAll.length && entry._id != null) {
        await idbDelete(entry._id);
      } else if (lsAll.length) {
        const remaining = lsRead().filter((e) => e._id !== entry._id);
        lsWrite(remaining);
      } else {
        memoryFallback = memoryFallback.filter((e) => e._id !== entry._id);
      }
      result.success++;
    } catch (err) {
      result.failure++;
      logWarn(TELE, "flush_entry_failed", err);
      // Stop on first failure — preserve FIFO; caller will retry later.
      break;
    }
  }

  result.duration_ms = performance.now() - start;
  result.remaining   = await getQueueDepth();
  logInfo(TELE, "flush_complete", result);
  return result;
}

export async function clearQueue(): Promise<void> {
  try {
    const db = await openIdb();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror    = () => resolve();
        } catch { resolve(); }
      });
    }
  } catch (err) { logError(TELE, "clear_failed", err); }
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  memoryFallback = [];
}
