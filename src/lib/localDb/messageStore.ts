/**
 * Local message store — the on-device copy of the conversation that makes the
 * chat behave like WhatsApp: open the app and the messages are ALREADY there,
 * with or without a network, and the network only ever tops it up.
 *
 * HISTORY / WHY THIS REPLACES THE OLD CACHE:
 *   `chatCache.ts` used to keep the latest 60 messages as ONE encrypted blob
 *   in @capacitor/preferences (SharedPreferences / UserDefaults). That is the
 *   wrong tool for message history: it is rewritten wholesale on every change,
 *   capped tiny, cannot page, and — combined with a launch path that waited on
 *   the network (auth refresh, E2E key fetch) before it could use the cache —
 *   it never actually delivered "no need to load again".
 *
 * DESIGN
 *   - One IndexedDB record PER MESSAGE (upsert by id), so an incoming message
 *     is one small write and history can grow without rewriting anything.
 *   - Only routing/ordering metadata is plaintext (user id, partner id, id,
 *     timestamps — the same things the server's own row has). The message
 *     itself (decrypted text, file names, reply ids …) is AES-256-GCM
 *     encrypted per record with the SAME per-user master key secureStorage
 *     already manages, so `secureWipeAll()` on sign-out makes every stored
 *     message permanently unreadable, exactly as before.
 *   - The storage backend is injected (IndexedDB in the app, an in-memory map
 *     in tests) because jsdom has no IndexedDB. The crypto, sanitising,
 *     ordering, paging and reconcile logic below is identical either way.
 *
 * WHAT IS NEVER STORED (unchanged privacy rules from the old cache):
 *   - anything with `disappear_at` (vanish / disappearing / pending messages)
 *   - optimistic / unsent / failed bubbles (`pending-*`, `_sendStatus`) — those
 *     live in pendingSendQueue.ts until they are really sent
 *   - blob: preview URLs
 *   - messages that are still showing a decrypt-failure placeholder — caching
 *     "[🔒 Encrypted]" would poison the store with something that can never
 *     be corrected without a network round trip
 *
 * TRADE-OFF TO KEEP IN VIEW: this is a bigger on-device footprint of decrypted
 * conversation text than before (whole history rather than the last 60).
 * `PERSIST_CHAT_CACHE` in chatCache.ts still turns the whole thing off, and
 * `.ai/DATA_CLASSIFICATION.md` records the change. The at-rest key is software
 * AES with the key in the app's own IndexedDB (see secureStorage.ts's honest
 * note) — not hardware-backed Keystore/Keychain.
 */
import type { DecryptedMessage } from "@/types/chat";
import { logWarn } from "@/lib/telemetry";

// Logged at most once per (uid, partnerId) per app session — a whole
// conversation can fail to decrypt in one go (stale master key), and
// warning once per ROW would just spam telemetry with the same root cause.
const warnedDecryptFailure = new Set<string>();
function warnDecryptFailureOnce(uid: string, partnerId: string): void {
  const k = `${uid}|${partnerId}`;
  if (warnedDecryptFailure.has(k)) return;
  warnedDecryptFailure.add(k);
  logWarn(
    "messageStore",
    "stored message(s) exist locally but failed to decrypt — master key mismatch or corruption. " +
    "Treating them as absent (server stays source of truth); the person should toggle " +
    "\"Keep chat history on this phone\" off then on to clear the orphaned rows and let them re-cache.",
    { uid, partnerId },
  );
}

/** Hard ceiling per conversation; oldest rows are trimmed past this. */
export const MAX_STORED_MESSAGES_PER_CONVERSATION = 20_000;

/** Shown by the decrypt path when a message could not be decrypted. */
const DECRYPT_PLACEHOLDER_PREFIX = "[🔒";
const E2E_PREFIX = "E2E::";

// ─── Backend contract ────────────────────────────────────────────────────────

export interface StoredRecord {
  /** `${uid}|${id}` — primary key. */
  key: string;
  uid: string;
  partnerId: string;
  id: string;
  /** created_at as epoch ms — the sortable index component. */
  ts: number;
  /** Original created_at string, so delta sync can query the server with it. */
  createdAt: string;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export interface QueryOptions {
  /** Exclusive upper bound on ts. */
  beforeTs?: number;
  /** Inclusive lower bound on ts. */
  fromTs?: number;
  limit: number;
  newestFirst: boolean;
}

export interface MessageStoreBackend {
  putMany(records: StoredRecord[]): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
  query(uid: string, partnerId: string, opts: QueryOptions): Promise<StoredRecord[]>;
  /** Light listing (no ciphertext needed) of every record with ts >= fromTs. */
  listKeysFrom(uid: string, partnerId: string, fromTs: number | null): Promise<Array<{ key: string; id: string; ts: number }>>;
  count(uid: string, partnerId: string): Promise<number>;
  deleteConversation(uid: string, partnerId: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface MessageStoreDeps {
  backend: MessageStoreBackend;
  /** The per-user AES-GCM key. In the app: secureStorage's master key. */
  getKey: (uid: string) => Promise<CryptoKey>;
  /** Media message → the storage path we can re-find it by (or null). */
  mediaPathFromUrl?: (url: string) => string | null;
  /** Storage path → a URL that already works offline (or null if not cached). */
  localMediaUrl?: (path: string) => Promise<string | null>;
}

// ─── Sanitising ──────────────────────────────────────────────────────────────

type StoredPayload = Omit<DecryptedMessage, "file_url" | "_sendStatus" | "_uploadProgress" | "_localPreviewUrl"> & {
  file_url: null;
  _mediaPath?: string | null;
};

const isTextual = (t: string) => t === "text" || t === "letter";

/**
 * Is this message safe and useful to keep on disk? Exported for tests and for
 * chatCache.ts's pre-filter.
 */
export function isStorable(m: DecryptedMessage): boolean {
  if (!m || typeof m.id !== "string" || typeof m.created_at !== "string") return false;
  if (!Number.isFinite(Date.parse(m.created_at))) return false;
  if (m.disappear_at) return false;              // vanish / disappearing / pending
  if (m.id.startsWith("pending-")) return false; // optimistic bubble
  if (m._sendStatus) return false;               // unsent or failed
  if (isTextual(m.message_type)) {
    const t = m.decryptedContent;
    if (typeof t === "string") {
      if (t.startsWith(DECRYPT_PLACEHOLDER_PREFIX)) return false; // "[🔒 Encrypted]" / "[🔒 Cannot decrypt]"
      if (t.startsWith(E2E_PREFIX)) return false;                 // raw ciphertext leaked into the text slot
    }
  }
  return true;
}

function toPayload(m: DecryptedMessage, mediaPathFromUrl?: (url: string) => string | null): StoredPayload {
  const {
    _sendStatus: _s, _uploadProgress: _u, _localPreviewUrl: _l, file_url, ...rest
  } = m as DecryptedMessage & { _sendStatus?: unknown; _uploadProgress?: unknown; _localPreviewUrl?: unknown };
  // Prefer the live URL; fall back to a path carried over from an earlier load
  // (media that wasn't resolvable offline) so re-saving the row never drops it.
  const carried = (m as DecryptedMessage)._mediaPath ?? null;
  let mediaPath: string | null = null;
  if (file_url && mediaPathFromUrl) mediaPath = mediaPathFromUrl(file_url);
  if (!mediaPath) mediaPath = carried;
  return { ...(rest as Omit<DecryptedMessage, "file_url">), file_url: null, _mediaPath: mediaPath } as StoredPayload;
}

// ─── base64-free byte helpers ────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── The store ───────────────────────────────────────────────────────────────

export interface MessageStore {
  /** Upsert every storable message. Returns how many were written. */
  putMessages(uid: string, partnerId: string, msgs: DecryptedMessage[]): Promise<number>;
  /** Newest `limit` messages, returned oldest → newest, plus whether older ones exist locally. */
  getRecent(uid: string, partnerId: string, limit: number): Promise<{ messages: DecryptedMessage[]; hasMore: boolean }>;
  /** `limit` messages strictly older than `beforeCreatedAt`, oldest → newest. */
  getBefore(uid: string, partnerId: string, beforeCreatedAt: string, limit: number): Promise<{ messages: DecryptedMessage[]; hasMore: boolean }>;
  /** created_at (server string) of the newest stored message, or null. */
  getNewestCreatedAt(uid: string, partnerId: string): Promise<string | null>;
  deleteMessages(uid: string, ids: string[]): Promise<void>;
  /** Number of stored messages in the conversation. */
  countMessages(uid: string, partnerId: string): Promise<number>;
  /**
   * Server-authoritative reconcile for the window the server just answered
   * for: every stored row at/after `windowStartCreatedAt` (or every row, when
   * null — meaning the server returned the WHOLE conversation) whose id is
   * not in `serverIds` no longer exists server-side (deleted / cleared) and is
   * removed. Returns the number removed.
   */
  reconcileWindow(uid: string, partnerId: string, serverIds: ReadonlySet<string>, windowStartCreatedAt: string | null): Promise<number>;
  clearConversation(uid: string, partnerId: string): Promise<void>;
  wipeUser(uid: string): Promise<void>;
}

export function createMessageStore(deps: MessageStoreDeps): MessageStore {
  const { backend, getKey, mediaPathFromUrl, localMediaUrl } = deps;

  async function seal(uid: string, partnerId: string, m: DecryptedMessage): Promise<StoredRecord> {
    const key = await getKey(uid);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = enc.encode(JSON.stringify(toPayload(m, mediaPathFromUrl)));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      key: `${uid}|${m.id}`, uid, partnerId, id: m.id,
      ts: Date.parse(m.created_at), createdAt: m.created_at, iv, ct,
    };
  }

  async function open(uid: string, rec: StoredRecord, cryptoKey: CryptoKey): Promise<DecryptedMessage | null> {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv as BufferSource }, cryptoKey, rec.ct);
      const p = JSON.parse(dec.decode(pt)) as StoredPayload;
      const { _mediaPath, ...rest } = p;
      let file_url: string | null = null;
      if (_mediaPath && localMediaUrl) file_url = await localMediaUrl(_mediaPath);
      // _mediaPath stays on the returned message (see DecryptedMessage._mediaPath).
      return { ...(rest as Omit<DecryptedMessage, "file_url">), file_url, _mediaPath: _mediaPath ?? null } as DecryptedMessage;
    } catch (err) {
      // Undecryptable row (key was rotated / wiped, or genuinely corrupt).
      // Treated as absent — it is only a cache, the server copy is the
      // source of truth — but logged distinctly (once per conversation per
      // session, not once per row) so "stored count > 0 but nothing shows
      // offline" is provable from logs instead of inferred from symptoms.
      warnDecryptFailureOnce(uid, rec.partnerId);
      return null;
    }
  }

  async function openMany(uid: string, recs: StoredRecord[]): Promise<DecryptedMessage[]> {
    if (recs.length === 0) return [];
    const key = await getKey(uid);
    const out = await Promise.all(recs.map((r) => open(uid, r, key)));
    return out.filter((m): m is DecryptedMessage => m !== null);
  }

  /** Read a page newest-first from the backend, hand it back oldest → newest. */
  async function page(uid: string, partnerId: string, limit: number, beforeTs?: number) {
    const recs = await backend.query(uid, partnerId, { limit: limit + 1, beforeTs, newestFirst: true });
    const hasMore = recs.length > limit;
    const slice = hasMore ? recs.slice(0, limit) : recs;
    const opened = await openMany(uid, slice);
    opened.sort(byTimeThenId);
    return { messages: opened, hasMore };
  }

  return {
    async putMessages(uid, partnerId, msgs) {
      const storable = msgs.filter(isStorable);
      if (storable.length === 0) return 0;
      const records = await Promise.all(storable.map((m) => seal(uid, partnerId, m)));
      await backend.putMany(records);

      // Keep each conversation bounded.
      const total = await backend.count(uid, partnerId);
      if (total > MAX_STORED_MESSAGES_PER_CONVERSATION) {
        const overflow = total - MAX_STORED_MESSAGES_PER_CONVERSATION;
        const oldest = await backend.query(uid, partnerId, { limit: overflow, newestFirst: false });
        await backend.deleteKeys(oldest.map((r) => r.key));
      }
      return records.length;
    },

    getRecent(uid, partnerId, limit) {
      return page(uid, partnerId, limit);
    },

    getBefore(uid, partnerId, beforeCreatedAt, limit) {
      const beforeTs = Date.parse(beforeCreatedAt);
      if (!Number.isFinite(beforeTs)) return Promise.resolve({ messages: [], hasMore: false });
      return page(uid, partnerId, limit, beforeTs);
    },

    async getNewestCreatedAt(uid, partnerId) {
      const [newest] = await backend.query(uid, partnerId, { limit: 1, newestFirst: true });
      return newest ? newest.createdAt : null;
    },

    countMessages(uid, partnerId) {
      return backend.count(uid, partnerId);
    },

    async deleteMessages(uid, ids) {
      if (ids.length === 0) return;
      await backend.deleteKeys(ids.map((id) => `${uid}|${id}`));
    },

    async reconcileWindow(uid, partnerId, serverIds, windowStartCreatedAt) {
      let fromTs: number | null = null;
      if (windowStartCreatedAt !== null) {
        const parsed = Date.parse(windowStartCreatedAt);
        // An unparseable boundary means we cannot say which rows are in the
        // window — deleting on a guess would destroy history. Do nothing.
        if (!Number.isFinite(parsed)) return 0;
        fromTs = parsed;
      }
      const inWindow = await backend.listKeysFrom(uid, partnerId, fromTs);
      const gone = inWindow.filter((r) => !serverIds.has(r.id));
      if (gone.length === 0) return 0;
      await backend.deleteKeys(gone.map((r) => r.key));
      return gone.length;
    },

    clearConversation(uid, partnerId) {
      return backend.deleteConversation(uid, partnerId);
    },

    wipeUser(uid) {
      return backend.deleteUser(uid);
    },
  };
}

function byTimeThenId(a: DecryptedMessage, b: DecryptedMessage): number {
  const d = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── In-memory backend (tests, and a safe fallback when IndexedDB is absent) ─

export function createMemoryBackend(): MessageStoreBackend {
  const rows = new Map<string, StoredRecord>();
  const conv = (uid: string, partnerId: string) =>
    [...rows.values()].filter((r) => r.uid === uid && r.partnerId === partnerId);
  const order = (a: StoredRecord, b: StoredRecord) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    async putMany(records) { for (const r of records) rows.set(r.key, r); },
    async deleteKeys(keys) { for (const k of keys) rows.delete(k); },
    async query(uid, partnerId, o) {
      let list = conv(uid, partnerId).sort(order);
      if (o.fromTs !== undefined) list = list.filter((r) => r.ts >= o.fromTs!);
      if (o.beforeTs !== undefined) list = list.filter((r) => r.ts < o.beforeTs!);
      if (o.newestFirst) list.reverse();
      return list.slice(0, o.limit);
    },
    async listKeysFrom(uid, partnerId, fromTs) {
      return conv(uid, partnerId)
        .filter((r) => fromTs === null || r.ts >= fromTs)
        .map((r) => ({ key: r.key, id: r.id, ts: r.ts }));
    },
    async count(uid, partnerId) { return conv(uid, partnerId).length; },
    async deleteConversation(uid, partnerId) {
      for (const r of conv(uid, partnerId)) rows.delete(r.key);
    },
    async deleteUser(uid) {
      for (const r of [...rows.values()]) if (r.uid === uid) rows.delete(r.key);
    },
  };
}
