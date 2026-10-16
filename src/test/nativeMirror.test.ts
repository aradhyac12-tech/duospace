import { describe, it, expect } from "vitest";
import { createMessageStore, createMemoryBackend } from "@/lib/localDb/messageStore";
import type { StoredRecord } from "@/lib/localDb/messageStore";
import { createCollectionStore, createMemoryCollectionBackend } from "@/lib/localDb/collectionStore";
import { createMirroredMessageBackend, createMirroredCollectionBackend } from "@/lib/localDb/nativeMirror";
import { createMemoryFiles } from "@/lib/nativeFiles";
import type { DecryptedMessage } from "@/types/chat";

const rec = (n: number, month = 8, uid = "u1", partner = "p1"): StoredRecord => {
  const ts = Date.UTC(2026, month, 1, 0, 0, n);
  return {
    key: `${uid}|m${n}`, uid, partnerId: partner, id: `m${n}`, ts, createdAt: new Date(ts).toISOString(),
    iv: new Uint8Array([1, 2, 3, n]), ct: new Uint8Array([9, 8, 7, n]).buffer,
  };
};

const mk = (files = createMemoryFiles(), primary = createMemoryBackend()) => ({
  files, primary,
  m: createMirroredMessageBackend(primary, files, { flushDelayMs: 10_000, listenForHide: false }),
});

describe("native message mirror", () => {
  it("writes nothing until flushed, then one file per month", async () => {
    const { m, files } = mk();
    await m.putMany([rec(1, 7), rec(2, 8), rec(3, 8)]);
    expect([...files.dump().keys()]).toEqual([]);
    await m.flush();
    const paths = [...files.dump().keys()].sort();
    expect(paths).toEqual(["chat-store/u1/p1/2026-08.json", "chat-store/u1/p1/2026-09.json"]);
  });

  it("restores into an EMPTY primary store from the mirror", async () => {
    const a = mk();
    await a.m.putMany([rec(1), rec(2), rec(3)]);
    await a.m.flush();
    // The browser store is reclaimed: a brand-new empty primary, same files.
    const b = mk(a.files, createMemoryBackend());
    expect(await b.m.count("u1", "p1")).toBe(3);
    const got = await b.m.query("u1", "p1", { limit: 10, newestFirst: false });
    expect(got.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect([...new Uint8Array(got[0].ct)]).toEqual([9, 8, 7, 1]);
    expect([...got[0].iv]).toEqual([1, 2, 3, 1]);
  });

  it("does not restore over a primary that has data", async () => {
    const a = mk();
    await a.m.putMany([rec(1), rec(2)]);
    await a.m.flush();
    const primary = createMemoryBackend();
    await primary.putMany([rec(9)]);
    const b = mk(a.files, primary);
    expect(await b.m.count("u1", "p1")).toBe(1);
  });

  it("deleteKeys removes records from the mirror, including ones not yet flushed", async () => {
    const { m, files, primary } = mk();
    await m.putMany([rec(1), rec(2), rec(3)]);
    await m.flush();
    await m.putMany([rec(4)]);
    await m.deleteKeys(["u1|m2", "u1|m4"]);
    await m.flush();
    const restored = mk(files, createMemoryBackend());
    expect((await restored.m.query("u1", "p1", { limit: 10, newestFirst: false })).map((r) => r.id)).toEqual(["m1", "m3"]);
    expect(await primary.count("u1", "p1")).toBe(2);
  });

  it("deleting the last record of a month removes its file", async () => {
    const { m, files } = mk();
    await m.putMany([rec(1, 7)]);
    await m.flush();
    await m.deleteKeys(["u1|m1"]);
    await m.flush();
    expect([...files.dump().keys()]).toEqual([]);
  });

  it("a record re-put after a delete is kept", async () => {
    const { m, files } = mk();
    await m.putMany([rec(1)]);
    await m.flush();
    await m.deleteKeys(["u1|m1"]);
    await m.putMany([rec(1)]);
    await m.flush();
    expect([...files.dump().keys()].length).toBe(1);
  });

  it("deleteConversation / deleteUser remove the files and do not resurrect on read", async () => {
    const { m, files, primary } = mk();
    await m.putMany([rec(1), rec(2, 8, "u1", "p2"), rec(3, 8, "u2", "p1")]);
    await m.flush();
    await m.deleteConversation("u1", "p1");
    expect([...files.dump().keys()].some((k) => k.startsWith("chat-store/u1/p1/"))).toBe(false);
    expect(await m.count("u1", "p1")).toBe(0);           // no resurrection
    await m.deleteUser("u1");
    expect([...files.dump().keys()].every((k) => k.startsWith("chat-store/u2/"))).toBe(true);
    expect(await primary.count("u2", "p1")).toBe(1);
  });

  it("a torn / corrupt file is skipped, not fatal", async () => {
    const { files } = mk();
    await files.writeText("chat-store/u1/p1/2026-09.json", "{ not json");
    const b = mk(files, createMemoryBackend());
    expect(await b.m.count("u1", "p1")).toBe(0);
  });

  it("mirrors only ciphertext (no plaintext in the files)", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const files = createMemoryFiles();
    const backend = createMirroredMessageBackend(createMemoryBackend(), files, { listenForHide: false });
    const store = createMessageStore({ backend, getKey: async () => key });
    const message: DecryptedMessage = {
      id: "m1", content: "E2E::iv:ct", decryptedContent: "my very private sentence",
      sender_id: "u1", receiver_id: "p1", message_type: "text", file_url: null, file_name: null,
      created_at: new Date(Date.UTC(2026, 8, 1)).toISOString(), is_read: false, reply_to_id: null, disappear_at: null,
    };
    await store.putMessages("u1", "p1", [message]);
    await backend.flush();
    const all = [...files.dump().values()].join("");
    expect(all).not.toContain("my very private sentence");
  });

  it("end to end: history survives the browser store being wiped", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const files = createMemoryFiles();
    const mkStore = () => createMessageStore({
      backend: createMirroredMessageBackend(createMemoryBackend(), files, { flushDelayMs: 5, listenForHide: false }),
      getKey: async () => key,
    });
    const mkMsg = (n: number): DecryptedMessage => ({
      id: `m${n}`, content: "E2E::iv:ct", decryptedContent: `hello ${n}`,
      sender_id: "u1", receiver_id: "p1", message_type: "text", file_url: null, file_name: null,
      created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(), is_read: false, reply_to_id: null, disappear_at: null,
    });
    const first = mkStore();
    await first.putMessages("u1", "p1", [mkMsg(1), mkMsg(2), mkMsg(3)]);
    await new Promise((r) => setTimeout(r, 60));            // let the debounced flush run
    const second = mkStore();                                // fresh (empty) primary = IndexedDB reclaimed
    const page = await second.getRecent("u1", "p1", 10);
    expect(page.messages.map((x) => x.decryptedContent)).toEqual(["hello 1", "hello 2", "hello 3"]);
  });
});

describe("native snapshot mirror", () => {
  const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

  it("restores a snapshot into an empty primary and decrypts it", async () => {
    const key = await newKey();
    const files = createMemoryFiles();
    const mk1 = () => createCollectionStore({ backend: createMirroredCollectionBackend(createMemoryCollectionBackend(), files), getKey: async () => key });
    await mk1().write("u1", "shayari", { list: [1, 2, 3] });
    const fresh = mk1();                                    // new empty primary
    expect((await fresh.read<{ list: number[] }>("u1", "shayari"))?.value.list).toEqual([1, 2, 3]);
  });

  it("remove and wipeUser also remove the mirror", async () => {
    const key = await newKey();
    const files = createMemoryFiles();
    const backend = createMirroredCollectionBackend(createMemoryCollectionBackend(), files);
    const store = createCollectionStore({ backend, getKey: async () => key });
    await store.write("u1", "a", { x: 1 });
    await store.write("u1", "b", { x: 2 });
    await store.remove("u1", "a");
    expect([...files.dump().keys()]).toEqual(["collections/u1/b.json"]);
    await store.wipeUser("u1");
    expect([...files.dump().keys()]).toEqual([]);
    expect(await store.read("u1", "b")).toBeNull();
  });

  it("names with odd characters round-trip", async () => {
    const key = await newKey();
    const files = createMemoryFiles();
    const mk1 = () => createCollectionStore({ backend: createMirroredCollectionBackend(createMemoryCollectionBackend(), files), getKey: async () => key });
    await mk1().write("u1", "chat-imported-a/b c|d", { ok: true });
    expect((await mk1().read<{ ok: boolean }>("u1", "chat-imported-a/b c|d"))?.value.ok).toBe(true);
  });
});
