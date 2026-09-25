// Tiny IndexedDB wrapper for storing E2E private keys outside localStorage.
// Falls back to localStorage if IndexedDB is unavailable (private mode, etc.).
const DB_NAME = "duo-keystore";
const STORE = "keys";

// How long we'll wait for IndexedDB before giving up. A stale connection
// left open elsewhere (another tab, a suspended WebView instance, an app
// resume mid-transaction) can leave indexedDB.open() with neither
// onsuccess nor onerror ever firing — no onblocked handler, no timeout,
// means the returned promise just hangs forever. Every caller of this
// module (secureStorage.ts's getOrCreateMasterKey, used by every read/
// write the Reflection page does) awaits it directly and caches the
// pending promise, so one stuck open() used to silently freeze every tap
// on that page with no error and no recovery short of a full app restart.
const OPEN_TIMEOUT_MS = 4000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("IndexedDB open timed out"))),
      OPEN_TIMEOUT_MS,
    );
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => settle(() => resolve(req.result));
    req.onerror = () => settle(() => reject(req.error));
    // Fires instead of onsuccess/onerror when another open connection
    // blocks a version change — without this the promise never settles.
    req.onblocked = () => settle(() => reject(new Error("IndexedDB open blocked")));
  });
}

/** Races a transaction promise against a timeout so a stalled transaction
 * (rarer than a stalled open(), but the same hang shape) can't leave a
 * caller waiting forever either. */
function withTxTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("IndexedDB transaction timed out")), OPEN_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Throws on any real failure (timeout/blocked/IDB error) instead of
 * swallowing it into `null`. `null` from THIS function means "checked, and
 * the key genuinely isn't there" — the only case in which a caller like
 * secureStorage's master-key loader may safely generate a replacement.
 * Conflating "not found" with "couldn't check" here is what let a transient
 * IndexedDB hiccup at boot silently mint a new master key over an existing
 * one, permanently orphaning everything encrypted under the old key (see
 * idbGetOrNull for the old, unsafe behavior other callers still use).
 */
export async function idbGetStrict<T = unknown>(key: string): Promise<T | null> {
  const db = await open();
  return withTxTimeout(new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  }));
}

/** Best-effort read for callers that already treat "couldn't read" as
 * "absent" safely (nothing is generated/overwritten as a result). */
export async function idbGet<T = unknown>(key: string): Promise<T | null> {
  try {
    return await idbGetStrict<T>(key);
  } catch {
    return null;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await withTxTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  } catch {
    /* swallow — caller should treat as best-effort */
  }
}

export async function idbDelete(key: string): Promise<void> {
  try {
    const db = await open();
    await withTxTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  } catch { /* noop */ }
}
