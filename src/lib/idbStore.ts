// Generic IndexedDB-backed key/value store for binary/large-string assets
// (app icons, per-app icon configs, etc). localStorage (src/lib/storage.ts)
// has a small quota and is fine for settings-sized values, but data-URL
// images and full icon configs can be multi-MB — IndexedDB has no
// practical size limit and is the correct store for that.
//
// This was originally a private copy inside ThemeContext.tsx (for the
// single global "duo-app-icon" key); it's now shared so other modules
// (per-app icon config) can use the same store without duplicating it.

const IDB_DB = "duo-assets";
const IDB_STORE = "blobs";

const idbOpen = (): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

export const idbGet = async (key: string): Promise<string | null> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readonly");
    return await new Promise((res) => {
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => res(null);
    });
  } catch { return null; }
};

export const idbSet = async (key: string, value: string): Promise<void> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
  } catch { /* noop — idb unavailable in some private modes */ }
};

export const idbDelete = async (key: string): Promise<void> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
  } catch { /* noop */ }
};

/** Lists every key currently stored (used to enumerate saved per-app icon configs). */
export const idbKeys = async (): Promise<string[]> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readonly");
    return await new Promise((res) => {
      const req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => res((req.result as string[]) ?? []);
      req.onerror = () => res([]);
    });
  } catch { return []; }
};
