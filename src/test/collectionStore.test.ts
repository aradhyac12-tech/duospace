import { describe, it, expect } from "vitest";
import { createCollectionStore, createMemoryCollectionBackend } from "@/lib/localDb/collectionStore";

const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

function make() {
  const backend = createMemoryCollectionBackend();
  const keys = new Map<string, Promise<CryptoKey>>();
  const getKey = (uid: string) => { if (!keys.has(uid)) keys.set(uid, newKey()); return keys.get(uid)!; };
  return { store: createCollectionStore({ backend, getKey }), backend, keys };
}

describe("collectionStore", () => {
  it("round-trips a snapshot", async () => {
    const { store } = make();
    await store.write("u", "shayari", { shayaris: [{ id: "1", content: "hello" }], partnerId: null });
    const r = await store.read<{ shayaris: Array<{ content: string }> }>("u", "shayari");
    expect(r?.value.shayaris[0].content).toBe("hello");
  });

  it("returns null when nothing is stored", async () => {
    const { store } = make();
    expect(await store.read("u", "nope")).toBeNull();
  });

  it("stores ciphertext only", async () => {
    const { store, backend } = make();
    await store.write("u", "us", { note: "very private sentence" });
    const rec = await backend.get("u|us");
    expect(new TextDecoder("latin1").decode(rec!.ct)).not.toContain("very private sentence");
  });

  it("a whole-value write replaces the previous snapshot", async () => {
    const { store } = make();
    await store.write("u", "gallery", { items: [1, 2, 3] });
    await store.write("u", "gallery", { items: [9] });
    expect((await store.read<{ items: number[] }>("u", "gallery"))?.value.items).toEqual([9]);
  });

  it("isolates users and names; wipeUser removes only that user", async () => {
    const { store } = make();
    await store.write("u1", "a", { v: 1 });
    await store.write("u1", "b", { v: 2 });
    await store.write("u2", "a", { v: 3 });
    expect(await store.read("u2", "b")).toBeNull();
    await store.wipeUser("u1");
    expect(await store.read("u1", "a")).toBeNull();
    expect(await store.read("u1", "b")).toBeNull();
    expect((await store.read<{ v: number }>("u2", "a"))?.value.v).toBe(3);
  });

  it("remove deletes one snapshot", async () => {
    const { store } = make();
    await store.write("u", "a", { v: 1 });
    await store.write("u", "b", { v: 2 });
    await store.remove("u", "a");
    expect(await store.read("u", "a")).toBeNull();
    expect((await store.read<{ v: number }>("u", "b"))?.value.v).toBe(2);
  });

  it("an unreadable snapshot (key rotated) is treated as absent, not an error", async () => {
    const { store, keys } = make();
    await store.write("u", "a", { v: 1 });
    keys.set("u", newKey());
    expect(await store.read("u", "a")).toBeNull();
  });
});
