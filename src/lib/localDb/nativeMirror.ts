/**
 * Native mirror — a write-through copy of the on-device message store and
 * screen snapshots in real files (app-private storage), so the offline data is
 * STORED, not merely cached.
 *
 * WHY: the primary stores live in IndexedDB, which the OS can reclaim under
 * storage pressure. WhatsApp keeps its history in a database inside the app's
 * own storage and never auto-deletes it; this gives DuoSpace the same
 * durability without a new native dependency:
 *   - writes go to IndexedDB first (unchanged, fast) and are then mirrored;
 *   - reads still come from IndexedDB; ONLY when it comes back empty for a
 *     conversation / snapshot while the mirror has data, the mirror is copied
 *     back (restore) and everything carries on as if nothing happened.
 *
 * The mirrored bytes are the SAME AES-256-GCM records the primary holds (plain
 * routing metadata + ciphertext), never plaintext. They are readable only with
 * the per-user master key, which privacy/masterKeyBackup.ts keeps in the OS
 * keystore for exactly this reason. Sign-out / unlink delete the files
 * (deleteConversation / deleteUser) and the key.
 *
 * MESSAGE LAYOUT: chat-store/<uid>/<partner>/<yyyy-mm>.json — one file per
 * month of a conversation, so an incoming message rewrites only the newest
 * month, debounced (default 2 s) and flushed when the app is hidden.
 * LIMITS: best effort. A write that never reached disk (process killed inside
 * the debounce) is simply absent from the mirror; a torn file is skipped on
 * read. The server remains the source of truth either way.
 */
import type { MessageStoreBackend, QueryOptions, StoredRecord } from "@/lib/localDb/messageStore";
import type { CollectionBackend, CollectionRecord } from "@/lib/localDb/collectionStore";
import type { NativeFileApi } from "@/lib/nativeFiles";
import { b64ToArrayBuffer, b64ToBytes, bytesToB64 } from "@/lib/localDb/bytes";
import { logWarn } from "@/lib/telemetry";

const enc = encodeURIComponent;
const MSG_ROOT = "chat-store";
const COL_ROOT = "collections";
const DEFAULT_FLUSH_MS = 2000;

// ─── Messages ────────────────────────────────────────────────────────────────

interface SerMsg {
  key: string; uid: string; partnerId: string; id: string;
  ts: number; createdAt: string; iv: string; ct: string;
}

const serMsg = (r: StoredRecord): SerMsg => ({
  key: r.key, uid: r.uid, partnerId: r.partnerId, id: r.id, ts: r.ts, createdAt: r.createdAt,
  iv: bytesToB64(r.iv), ct: bytesToB64(r.ct),
});

const deserMsg = (s: SerMsg): StoredRecord => ({
  key: s.key, uid: s.uid, partnerId: s.partnerId, id: s.id, ts: s.ts, createdAt: s.createdAt,
  iv: b64ToBytes(s.iv), ct: b64ToArrayBuffer(s.ct),
});

const isSerMsg = (x: unknown): x is SerMsg => {
  const s = x as Partial<SerMsg> | null;
  return !!s && typeof s.key === "string" && typeof s.uid === "string" && typeof s.partnerId === "string"
    && typeof s.id === "string" && typeof s.ts === "number" && typeof s.createdAt === "string"
    && typeof s.iv === "string" && typeof s.ct === "string";
};

const monthOf = (ts: number): string => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 7) : "unknown");
const userDir = (uid: string) => `${MSG_ROOT}/${enc(uid)}`;
const convDir = (uid: string, partnerId: string) => `${userDir(uid)}/${enc(partnerId)}`;
const segPath = (r: { uid: string; partnerId: string; ts: number }) => `${convDir(r.uid, r.partnerId)}/${monthOf(r.ts)}.json`;
const uidOfKey = (key: string) => key.slice(0, key.indexOf("|"));

export interface MirroredMessageBackend extends MessageStoreBackend {
  /** Write everything staged so far to files now. */
  flush(): Promise<void>;
}

export function createMirroredMessageBackend(
  primary: MessageStoreBackend,
  files: NativeFileApi,
  opts: { flushDelayMs?: number; listenForHide?: boolean } = {},
): MirroredMessageBackend {
  const delay = opts.flushDelayMs ?? DEFAULT_FLUSH_MS;
  const staged = new Map<string, Map<string, SerMsg>>();   // segment path -> key -> record
  const pendingDeletes = new Map<string, Set<string>>();   // uid -> keys
  const restoring = new Map<string, Promise<void>>();      // `${uid}|${partner}` -> done
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function readSeg(path: string): Promise<Map<string, SerMsg>> {
    const out = new Map<string, SerMsg>();
    const text = await files.readText(path);
    if (!text) return out;
    try {
      const parsed = JSON.parse(text) as { records?: unknown[] };
      for (const r of parsed.records ?? []) if (isSerMsg(r)) out.set(r.key, r);
    } catch { /* torn file → treat as empty; the primary / server are the truth */ }
    return out;
  }

  async function writeSeg(path: string, recs: Map<string, SerMsg>): Promise<void> {
    if (recs.size === 0) { await files.remove(path); return; }
    await files.writeText(path, JSON.stringify({ v: 1, records: [...recs.values()] }));
  }

  async function applyDeletes(uid: string, keys: Set<string>): Promise<void> {
    for (const partner of await files.list(userDir(uid))) {
      const dir = `${userDir(uid)}/${partner}`;
      for (const name of await files.list(dir)) {
        if (!name.endsWith(".json")) continue;
        const path = `${dir}/${name}`;
        const recs = await readSeg(path);
        let changed = false;
        for (const k of keys) if (recs.delete(k)) changed = true;
        if (changed) await writeSeg(path, recs);
      }
    }
  }

  async function doFlush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const segs = [...staged.entries()];
    const dels = [...pendingDeletes.entries()];
    staged.clear();
    pendingDeletes.clear();
    for (const [path, recs] of segs) {
      try {
        const cur = await readSeg(path);
        for (const [k, v] of recs) cur.set(k, v);
        await writeSeg(path, cur);
      } catch (err) {
        // Keep what we could not write for the next flush (without clobbering newer staged values).
        const again = staged.get(path) ?? new Map<string, SerMsg>();
        for (const [k, v] of recs) if (!again.has(k)) again.set(k, v);
        staged.set(path, again);
        logWarn("nativeMirror", "message mirror write failed — will retry", err);
      }
    }
    for (const [uid, keys] of dels) {
      try { await applyDeletes(uid, keys); } catch (err) { logWarn("nativeMirror", "message mirror delete failed", err); }
    }
  }

  const flush = (): Promise<void> => {
    chain = chain.then(doFlush, doFlush);
    return chain;
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, delay);
  };

  async function restoreIfEmpty(uid: string, partnerId: string): Promise<void> {
    try {
      if ((await primary.count(uid, partnerId)) > 0) return;
      const dir = convDir(uid, partnerId);
      const recs: StoredRecord[] = [];
      for (const name of await files.list(dir)) {
        if (!name.endsWith(".json")) continue;
        for (const s of (await readSeg(`${dir}/${name}`)).values()) recs.push(deserMsg(s));
      }
      if (recs.length === 0) return;
      await primary.putMany(recs);
      logWarn("nativeMirror", `restored ${recs.length} stored messages from the native mirror (the browser store was empty)`, { uid, partnerId });
    } catch (err) {
      logWarn("nativeMirror", "restore from native mirror failed", err);
    }
  }

  const ensureRestored = (uid: string, partnerId: string): Promise<void> => {
    const k = `${uid}|${partnerId}`;
    let p = restoring.get(k);
    if (!p) { p = restoreIfEmpty(uid, partnerId); restoring.set(k, p); }
    return p;
  };

  if (opts.listenForHide !== false && typeof document !== "undefined" && typeof window !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });
    window.addEventListener("pagehide", () => { void flush(); });
  }

  return {
    flush,

    async putMany(records) {
      await primary.putMany(records);
      for (const r of records) {
        const path = segPath(r);
        let m = staged.get(path);
        if (!m) { m = new Map(); staged.set(path, m); }
        m.set(r.key, serMsg(r));
        pendingDeletes.get(r.uid)?.delete(r.key);
      }
      if (records.length) schedule();
    },

    async deleteKeys(keys) {
      await primary.deleteKeys(keys);
      for (const k of keys) {
        for (const m of staged.values()) m.delete(k);
        const uid = uidOfKey(k);
        let s = pendingDeletes.get(uid);
        if (!s) { s = new Set(); pendingDeletes.set(uid, s); }
        s.add(k);
      }
      if (keys.length) schedule();
    },

    async query(uid: string, partnerId: string, o: QueryOptions) {
      await ensureRestored(uid, partnerId);
      return primary.query(uid, partnerId, o);
    },

    async listKeysFrom(uid, partnerId, fromTs) {
      await ensureRestored(uid, partnerId);
      return primary.listKeysFrom(uid, partnerId, fromTs);
    },

    async count(uid, partnerId) {
      await ensureRestored(uid, partnerId);
      return primary.count(uid, partnerId);
    },

    async deleteConversation(uid, partnerId) {
      await primary.deleteConversation(uid, partnerId);
      const dir = convDir(uid, partnerId);
      for (const p of [...staged.keys()]) if (p.startsWith(`${dir}/`)) staged.delete(p);
      restoring.delete(`${uid}|${partnerId}`);
      await files.removeDir(dir);
    },

    async deleteUser(uid) {
      await primary.deleteUser(uid);
      const dir = userDir(uid);
      for (const p of [...staged.keys()]) if (p.startsWith(`${dir}/`)) staged.delete(p);
      pendingDeletes.delete(uid);
      for (const k of [...restoring.keys()]) if (k.startsWith(`${uid}|`)) restoring.delete(k);
      await files.removeDir(dir);
    },
  };
}

// ─── Collections (screen snapshots) ──────────────────────────────────────────

interface SerCol { key: string; uid: string; iv: string; ct: string; updatedAt: number }

const nameOfKey = (key: string) => key.slice(key.indexOf("|") + 1);
const colPath = (uid: string, key: string) => `${COL_ROOT}/${enc(uid)}/${enc(nameOfKey(key))}.json`;

export function createMirroredCollectionBackend(primary: CollectionBackend, files: NativeFileApi): CollectionBackend {
  return {
    async get(key) {
      const hit = await primary.get(key);
      if (hit) return hit;
      // Browser store has nothing for it — look in the mirror and restore.
      try {
        const uid = uidOfKey(key);
        const text = await files.readText(colPath(uid, key));
        if (!text) return undefined;
        const s = JSON.parse(text) as Partial<SerCol>;
        if (s.key !== key || typeof s.iv !== "string" || typeof s.ct !== "string" || typeof s.uid !== "string") return undefined;
        const rec: CollectionRecord = { key, uid: s.uid, iv: b64ToBytes(s.iv), ct: b64ToArrayBuffer(s.ct), updatedAt: Number(s.updatedAt) || 0 };
        await primary.put(rec).catch(() => { /* restored for this read at least */ });
        return rec;
      } catch {
        return undefined;
      }
    },

    async put(rec) {
      await primary.put(rec);
      try {
        const body: SerCol = { key: rec.key, uid: rec.uid, iv: bytesToB64(rec.iv), ct: bytesToB64(rec.ct), updatedAt: rec.updatedAt };
        await files.writeText(colPath(rec.uid, rec.key), JSON.stringify(body));
      } catch (err) {
        logWarn("nativeMirror", "snapshot mirror write failed", err);
      }
    },

    async delete(key) {
      await primary.delete(key);
      await files.remove(colPath(uidOfKey(key), key));
    },

    async deleteUser(uid) {
      await primary.deleteUser(uid);
      await files.removeDir(`${COL_ROOT}/${enc(uid)}`);
    },
  };
}
