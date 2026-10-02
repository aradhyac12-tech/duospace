/**
 * Collection store — encrypted on-device snapshots of a screen's data
 * (Shayari list, Us page data, Gallery item lists, …), so those screens open
 * instantly and offline instead of fetching on every visit.
 *
 * Same security model as messageStore.ts (read its header): one AES-256-GCM
 * record per snapshot under the per-user secureStorage master key, deleted on
 * sign-out (`wipeUser`) and unreadable once that key is destroyed. The storage
 * backend is injected so the logic is testable without IndexedDB.
 *
 * SEMANTICS: a snapshot is a whole-value replacement of what the screen last
 * knew to be true. It is a *read cache only* — the server stays the source of
 * truth and screens re-fetch on open / reconnect / resume and replace it.
 */

export interface CollectionRecord {
  key: string;          // `${uid}|${name}`
  uid: string;
  iv: Uint8Array;
  ct: ArrayBuffer;
  updatedAt: number;
}

export interface CollectionBackend {
  get(key: string): Promise<CollectionRecord | undefined>;
  put(rec: CollectionRecord): Promise<void>;
  delete(key: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface CollectionStoreDeps {
  backend: CollectionBackend;
  getKey: (uid: string) => Promise<CryptoKey>;
}

export interface CollectionStore {
  read<T>(uid: string, name: string): Promise<{ value: T; updatedAt: number } | null>;
  write(uid: string, name: string, value: unknown): Promise<void>;
  remove(uid: string, name: string): Promise<void>;
  wipeUser(uid: string): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function createCollectionStore({ backend, getKey }: CollectionStoreDeps): CollectionStore {
  return {
    async read<T>(uid: string, name: string) {
      const rec = await backend.get(`${uid}|${name}`);
      if (!rec) return null;
      try {
        const key = await getKey(uid);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv as BufferSource }, key, rec.ct);
        return { value: JSON.parse(dec.decode(pt)) as T, updatedAt: rec.updatedAt };
      } catch {
        return null; // wrong/rotated key or corrupt row — it's only a cache
      }
    },

    async write(uid, name, value) {
      const key = await getKey(uid);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
      await backend.put({ key: `${uid}|${name}`, uid, iv, ct, updatedAt: Date.now() });
    },

    remove(uid, name) {
      return backend.delete(`${uid}|${name}`);
    },

    wipeUser(uid) {
      return backend.deleteUser(uid);
    },
  };
}

export function createMemoryCollectionBackend(): CollectionBackend {
  const rows = new Map<string, CollectionRecord>();
  return {
    async get(key) { return rows.get(key); },
    async put(rec) { rows.set(rec.key, rec); },
    async delete(key) { rows.delete(key); },
    async deleteUser(uid) { for (const [k, r] of [...rows]) if (r.uid === uid) rows.delete(k); },
  };
}
