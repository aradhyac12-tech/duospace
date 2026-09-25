/** IndexedDB backend for collectionStore.ts — database `duo-collections-v1`, store `docs`. */
import type { CollectionBackend, CollectionRecord } from "@/lib/localDb/collectionStore";

const DB_NAME = "duo-collections-v1";
const STORE = "docs";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "key" });
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

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
});

export function createIdbCollectionBackend(): CollectionBackend {
  return {
    async get(key) {
      const db = await openDb();
      return new Promise<CollectionRecord | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as CollectionRecord | undefined);
        req.onerror = () => reject(req.error);
      });
    },
    async put(rec) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      await done(tx);
    },
    async delete(key) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      await done(tx);
    },
    async deleteUser(uid) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(IDBKeyRange.bound(`${uid}|`, `${uid}|\uffff`));
      await done(tx);
    },
  };
}
