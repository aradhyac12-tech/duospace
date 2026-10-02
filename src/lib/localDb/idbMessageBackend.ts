/**
 * IndexedDB implementation of MessageStoreBackend (see messageStore.ts).
 *
 * Schema: database `duo-local-v1`, object store `messages` keyed by
 * `${uid}|${id}`, with a compound index `conv` on [uid, partnerId, ts, id] so
 * "newest N of this conversation" and "N older than X" are single index-cursor
 * range reads — no scanning, no sorting in JS.
 *
 * Every method rejects on a real IndexedDB failure; the message store's
 * callers (chatCache.ts) treat the whole local store as best-effort and never
 * let a storage error reach the chat UI.
 */
import type { MessageStoreBackend, QueryOptions, StoredRecord } from "@/lib/localDb/messageStore";

const DB_NAME = "duo-local-v1";
const STORE = "messages";
const INDEX = "conv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex(INDEX, ["uid", "partnerId", "ts", "id"]);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab/webview asked for an upgrade or the OS is reclaiming us:
      // drop the handle so the next call re-opens instead of failing forever.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** Key range covering one conversation between two ts bounds (see notes inline). */
function convRange(uid: string, partnerId: string, opts: { fromTs?: number; beforeTs?: number }): IDBKeyRange {
  // Array keys compare component by component; among the 4th component (a
  // string id) "" is the smallest string and "\uffff" is above any real id, and
  // a Number always sorts below a String — so these bounds bracket exactly the
  // rows we want.
  const lower: IDBValidKey = [uid, partnerId, opts.fromTs ?? -Infinity, ""];
  if (opts.beforeTs !== undefined) {
    // Exclusive upper bound: [.., beforeTs, ""] open excludes every row at ts >= beforeTs.
    return IDBKeyRange.bound(lower, [uid, partnerId, opts.beforeTs, ""], false, true);
  }
  return IDBKeyRange.bound(lower, [uid, partnerId, Infinity, "\uffff"], false, false);
}

export function createIdbBackend(): MessageStoreBackend {
  return {
    async putMany(records: StoredRecord[]) {
      if (records.length === 0) return;
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const r of records) store.put(r);
      await txDone(tx);
    },

    async deleteKeys(keys: string[]) {
      if (keys.length === 0) return;
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const k of keys) store.delete(k);
      await txDone(tx);
    },

    async query(uid: string, partnerId: string, o: QueryOptions) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index(INDEX);
      const range = convRange(uid, partnerId, { fromTs: o.fromTs, beforeTs: o.beforeTs });
      const out: StoredRecord[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = index.openCursor(range, o.newestFirst ? "prev" : "next");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || out.length >= o.limit) { resolve(); return; }
          out.push(cursor.value as StoredRecord);
          if (out.length >= o.limit) { resolve(); return; }
          cursor.continue();
        };
      });
      return out;
    },

    async listKeysFrom(uid: string, partnerId: string, fromTs: number | null) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index(INDEX);
      const range = convRange(uid, partnerId, { fromTs: fromTs ?? undefined });
      const out: Array<{ key: string; id: string; ts: number }> = [];
      await new Promise<void>((resolve, reject) => {
        // Key cursor: primary key + index key only — never reads the ciphertext.
        const req = index.openKeyCursor(range);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          const [, , ts, id] = cursor.key as [string, string, number, string];
          out.push({ key: cursor.primaryKey as string, id, ts });
          cursor.continue();
        };
      });
      return out;
    },

    async count(uid: string, partnerId: string) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index(INDEX);
      return new Promise<number>((resolve, reject) => {
        const req = index.count(convRange(uid, partnerId, {}));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async deleteConversation(uid: string, partnerId: string) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const index = store.index(INDEX);
      const req = index.openKeyCursor(convRange(uid, partnerId, {}));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      await txDone(tx);
    },

    async deleteUser(uid: string) {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      // Primary keys are `${uid}|${id}` — a plain string range covers the user.
      tx.objectStore(STORE).delete(IDBKeyRange.bound(`${uid}|`, `${uid}|\uffff`));
      await txDone(tx);
    },
  };
}
