/**
 * Tests for the on-device message store (src/lib/localDb/messageStore.ts).
 *
 * SCOPE NOTE (same honesty as secureStorageCrypto.test.ts): jsdom has no
 * IndexedDB, so these run the real store logic — AES-GCM encryption, sanitising,
 * ordering, paging, server-window reconcile — against the in-memory backend.
 * The thin IndexedDB adapter (idbMessageBackend.ts) is NOT exercised here and
 * needs a real WebView/device run; see docs/OFFLINE_FIRST.md.
 */
import { describe, it, expect } from "vitest";
import {
  createMessageStore, createMemoryBackend, isStorable,
} from "@/lib/localDb/messageStore";
import type { DecryptedMessage } from "@/types/chat";

const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

async function makeStore(extra: Partial<Parameters<typeof createMessageStore>[0]> = {}) {
  const backend = createMemoryBackend();
  // Memoise the in-flight promise: putMessages() seals rows concurrently, and
  // (like secureStorage's getOrCreateMasterKey) the key must be created once.
  const keys = new Map<string, Promise<CryptoKey>>();
  const getKey = (uid: string) => {
    if (!keys.has(uid)) keys.set(uid, newKey());
    return keys.get(uid)!;
  };
  const store = createMessageStore({ backend, getKey, ...extra });
  return { store, backend, keys };
}

const msg = (n: number, over: Partial<DecryptedMessage> = {}): DecryptedMessage => ({
  id: `m${String(n).padStart(4, "0")}`,
  content: "E2E::iv:ct",
  decryptedContent: `hello ${n}`,
  sender_id: "me", receiver_id: "her", message_type: "text",
  file_url: null, file_name: null,
  created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(),
  is_read: false, reply_to_id: null, disappear_at: null,
  ...over,
});

describe("isStorable", () => {
  it("accepts an ordinary delivered message", () => expect(isStorable(msg(1))).toBe(true));
  it("rejects disappearing / vanish / pending", () => {
    expect(isStorable(msg(1, { disappear_at: "vanish" }))).toBe(false);
    expect(isStorable(msg(1, { disappear_at: "pending" }))).toBe(false);
    expect(isStorable(msg(1, { disappear_at: "2026-09-22T00:00:00Z" }))).toBe(false);
  });
  it("rejects optimistic / unsent bubbles", () => {
    expect(isStorable(msg(1, { id: "pending-abc" }))).toBe(false);
    expect(isStorable(msg(1, { _sendStatus: "failed" }))).toBe(false);
    expect(isStorable(msg(1, { _sendStatus: "sending" }))).toBe(false);
  });
  it("rejects decrypt-failure placeholders and leaked ciphertext (would poison the cache)", () => {
    expect(isStorable(msg(1, { decryptedContent: "[🔒 Encrypted]" }))).toBe(false);
    expect(isStorable(msg(1, { decryptedContent: "[🔒 Cannot decrypt]" }))).toBe(false);
    expect(isStorable(msg(1, { decryptedContent: "E2E::abc:def" }))).toBe(false);
  });
  it("does not apply the text checks to media messages", () => {
    expect(isStorable(msg(1, { message_type: "image", decryptedContent: null }))).toBe(true);
  });
  it("rejects malformed rows", () => {
    expect(isStorable(msg(1, { created_at: "not a date" }))).toBe(false);
  });
});

describe("messageStore", () => {
  it("round-trips and returns oldest → newest", async () => {
    const { store } = await makeStore();
    await store.putMessages("u", "p", [msg(3), msg(1), msg(2)]);
    const { messages, hasMore } = await store.getRecent("u", "p", 10);
    expect(messages.map((m) => m.id)).toEqual(["m0001", "m0002", "m0003"]);
    expect(messages[0].decryptedContent).toBe("hello 1");
    expect(hasMore).toBe(false);
  });

  it("stores ciphertext only — plaintext is not in the persisted record", async () => {
    const { store, backend } = await makeStore();
    await store.putMessages("u", "p", [msg(1, { decryptedContent: "super secret sentence" })]);
    const [raw] = await backend.query("u", "p", { limit: 1, newestFirst: true });
    const asText = new TextDecoder("latin1").decode(raw.ct);
    expect(asText).not.toContain("super secret sentence");
    expect(JSON.stringify({ id: raw.id, createdAt: raw.createdAt })).not.toContain("secret");
  });

  it("upserts by id (edit / read receipt updates the same row)", async () => {
    const { store } = await makeStore();
    await store.putMessages("u", "p", [msg(1)]);
    await store.putMessages("u", "p", [msg(1, { decryptedContent: "edited", is_read: true })]);
    const { messages } = await store.getRecent("u", "p", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].decryptedContent).toBe("edited");
    expect(messages[0].is_read).toBe(true);
  });

  it("skips non-storable messages instead of throwing", async () => {
    const { store } = await makeStore();
    const n = await store.putMessages("u", "p", [msg(1), msg(2, { disappear_at: "vanish" }), msg(3, { id: "pending-x" })]);
    expect(n).toBe(1);
  });

  it("pages: recent page + older page, hasMore reflects reality", async () => {
    const { store } = await makeStore();
    await store.putMessages("u", "p", Array.from({ length: 25 }, (_, i) => msg(i + 1)));
    const first = await store.getRecent("u", "p", 10);
    expect(first.messages.map((m) => m.id)[0]).toBe("m0016");
    expect(first.messages).toHaveLength(10);
    expect(first.hasMore).toBe(true);

    const second = await store.getBefore("u", "p", first.messages[0].created_at, 10);
    expect(second.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${String(i + 6).padStart(4, "0")}`),
    );
    expect(second.hasMore).toBe(true);

    const third = await store.getBefore("u", "p", second.messages[0].created_at, 10);
    expect(third.messages).toHaveLength(5);
    expect(third.hasMore).toBe(false);
  });

  it("getNewestCreatedAt is the delta-sync cursor", async () => {
    const { store } = await makeStore();
    expect(await store.getNewestCreatedAt("u", "p")).toBeNull();
    await store.putMessages("u", "p", [msg(1), msg(7), msg(3)]);
    expect(await store.getNewestCreatedAt("u", "p")).toBe(msg(7).created_at);
  });

  it("deleteMessages removes just those rows", async () => {
    const { store } = await makeStore();
    await store.putMessages("u", "p", [msg(1), msg(2), msg(3)]);
    await store.deleteMessages("u", ["m0002"]);
    const { messages } = await store.getRecent("u", "p", 10);
    expect(messages.map((m) => m.id)).toEqual(["m0001", "m0003"]);
  });

  describe("reconcileWindow (server-authoritative for the window it answered for)", () => {
    it("removes rows inside the window the server no longer has, keeps older history", async () => {
      const { store } = await makeStore();
      await store.putMessages("u", "p", Array.from({ length: 10 }, (_, i) => msg(i + 1)));
      // Server window = newest 5 (m6..m10) but m8 was deleted elsewhere.
      const removed = await store.reconcileWindow("u", "p", new Set(["m0006", "m0007", "m0009", "m0010"]), msg(6).created_at);
      expect(removed).toBe(1);
      const { messages } = await store.getRecent("u", "p", 20);
      expect(messages.map((m) => m.id)).toEqual(["m0001", "m0002", "m0003", "m0004", "m0005", "m0006", "m0007", "m0009", "m0010"]);
    });

    it("null window = server returned the whole conversation → anything missing is gone", async () => {
      const { store } = await makeStore();
      await store.putMessages("u", "p", [msg(1), msg(2), msg(3)]);
      const removed = await store.reconcileWindow("u", "p", new Set(["m0002"]), null);
      expect(removed).toBe(2);
      expect((await store.getRecent("u", "p", 10)).messages.map((m) => m.id)).toEqual(["m0002"]);
    });

    it("an unparseable window boundary deletes nothing (never guess on history)", async () => {
      const { store } = await makeStore();
      await store.putMessages("u", "p", [msg(1), msg(2)]);
      expect(await store.reconcileWindow("u", "p", new Set(), "garbage")).toBe(0);
      expect((await store.getRecent("u", "p", 10)).messages).toHaveLength(2);
    });
  });

  it("isolates users and partners; clearConversation / wipeUser only touch their own", async () => {
    const { store } = await makeStore();
    await store.putMessages("u1", "p1", [msg(1)]);
    await store.putMessages("u1", "p2", [msg(2)]);
    await store.putMessages("u2", "p1", [msg(3)]);

    await store.clearConversation("u1", "p1");
    expect((await store.getRecent("u1", "p1", 10)).messages).toHaveLength(0);
    expect((await store.getRecent("u1", "p2", 10)).messages).toHaveLength(1);
    expect((await store.getRecent("u2", "p1", 10)).messages).toHaveLength(1);

    await store.wipeUser("u1");
    expect((await store.getRecent("u1", "p2", 10)).messages).toHaveLength(0);
    expect((await store.getRecent("u2", "p1", 10)).messages).toHaveLength(1);
  });

  it("rows that can't be decrypted (key rotated / wiped) are treated as absent, not as errors", async () => {
    const { store, keys } = await makeStore();
    await store.putMessages("u", "p", [msg(1), msg(2)]);
    keys.set("u", newKey()); // simulate a different master key
    const { messages } = await store.getRecent("u", "p", 10);
    expect(messages).toEqual([]);
  });

  it("media: stores the storage PATH not the URL, and restores a local URL when cached", async () => {
    const cachedPaths = new Map([["uid/pic.jpg", "blob:local-1"]]);
    const { store } = await makeStore({
      mediaPathFromUrl: (url) => (url.includes("/object/sign/chat-files/") ? url.split("/chat-files/")[1].split("?")[0] : null),
      localMediaUrl: async (path) => cachedPaths.get(path) ?? null,
    });
    const signed = "https://x.supabase.co/storage/v1/object/sign/chat-files/uid/pic.jpg?token=abc";
    await store.putMessages("u", "p", [
      msg(1, { message_type: "image", decryptedContent: null, file_url: signed }),
      msg(2, { message_type: "image", decryptedContent: null, file_url: "https://x.supabase.co/storage/v1/object/sign/chat-files/uid/other.jpg?token=z" }),
    ]);
    const { messages } = await store.getRecent("u", "p", 10);
    expect(messages[0].file_url).toBe("blob:local-1");            // cached → works offline
    expect(messages[1].file_url).toBeNull();                       // not cached → null, not a dead signed URL
    expect(messages[1]._mediaPath).toBe("uid/other.jpg");          // …but the path is kept
    // Re-saving the uncached row (e.g. read receipt while offline) must not lose the path.
    await store.putMessages("u", "p", [{ ...messages[1], is_read: true }]);
    const again = (await store.getRecent("u", "p", 10)).messages[1];
    expect(again._mediaPath).toBe("uid/other.jpg");
  });

  it("never persists the signed URL token itself", async () => {
    const { store, backend } = await makeStore({ mediaPathFromUrl: () => "uid/pic.jpg" });
    await store.putMessages("u", "p", [msg(1, { message_type: "image", decryptedContent: null, file_url: "https://x/sign?token=SECRETTOKEN" })]);
    const [raw] = await backend.query("u", "p", { limit: 1, newestFirst: true });
    expect(new TextDecoder("latin1").decode(raw.ct)).not.toContain("SECRETTOKEN");
  });

  it("countMessages counts one conversation only", async () => {
    const { store } = await makeStore();
    await store.putMessages("u", "p1", [msg(1), msg(2), msg(3)]);
    await store.putMessages("u", "p2", [msg(4)]);
    expect(await store.countMessages("u", "p1")).toBe(3);
    expect(await store.countMessages("u", "p2")).toBe(1);
    expect(await store.countMessages("u", "nobody")).toBe(0);
  });
});
