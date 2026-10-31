import { describe, it, expect } from "vitest";
import { createNativeMediaStore, extensionForType, hashKey } from "@/lib/nativeMediaStore";
import { createMemoryFiles } from "@/lib/nativeFiles";

const blobOf = (text: string, type: string) => new Blob([text], { type });
const mk = (files = createMemoryFiles()) => ({ files, s: createNativeMediaStore(files, hashKey, { listenForHide: false }) });
const textOf = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b); });

describe("extensionForType / hashKey", () => {
  it("maps common types, ignores parameters, falls back to bin", () => {
    expect(extensionForType("image/jpeg")).toBe("jpg");
    expect(extensionForType("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionForType("application/x-weird")).toBe("bin");
    expect(extensionForType("")).toBe("bin");
  });
  it("hash is stable, fixed length and key-sensitive", async () => {
    const a = await hashKey("chat-files:u/1.jpg");
    expect(a).toBe(await hashKey("chat-files:u/1.jpg"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await hashKey("chat-files:u/2.jpg"));
  });
});

describe("native media store", () => {
  it("stores a blob as a file and reads it back", async () => {
    const { s, files } = mk();
    expect(await s.put("k1", blobOf("pixels", "image/png"))).toBe(true);
    expect(await s.has("k1")).toBe(true);
    const names = [...files.dump().keys()];
    expect(names.some((n) => n.endsWith(".png"))).toBe(true);
    const b = await s.getBlob("k1");
    expect(b?.type).toBe("image/png");
    expect(await textOf(b!)).toBe("pixels");
  });

  it("returns null for unknown keys", async () => {
    const { s } = mk();
    expect(await s.getBlob("nope")).toBeNull();
    expect(await s.has("nope")).toBe(false);
  });

  it("the index survives a restart (new instance, same files)", async () => {
    const a = mk();
    await a.s.put("k1", blobOf("abc", "audio/mp4"));
    await a.s.flush();
    const b = mk(a.files);
    expect(await b.s.has("k1")).toBe(true);
    expect(await textOf((await b.s.getBlob("k1"))!)).toBe("abc");
    expect(await b.s.size()).toBe(3);
  });

  it("remove deletes the file and the entry", async () => {
    const { s, files } = mk();
    await s.put("k1", blobOf("abc", "image/jpeg"));
    await s.remove("k1");
    expect(await s.has("k1")).toBe(false);
    expect([...files.dump().keys()].filter((n) => !n.endsWith("index.json"))).toEqual([]);
  });

  it("a file that vanished is forgotten (so it re-downloads)", async () => {
    const { s, files } = mk();
    await s.put("k1", blobOf("abc", "image/jpeg"));
    for (const k of [...files.dump().keys()]) if (k.endsWith(".jpg")) files.dump().delete(k);
    expect(await s.getBlob("k1")).toBeNull();
    expect(await s.has("k1")).toBe(false);
  });

  it("wipe removes everything including the index", async () => {
    const { s, files } = mk();
    await s.put("k1", blobOf("abc", "image/jpeg"));
    await s.flush();
    await s.wipe();
    expect([...files.dump().keys()]).toEqual([]);
    expect(await s.has("k1")).toBe(false);
    expect(await s.size()).toBe(0);
  });

  it("a failing disk write reports false instead of throwing", async () => {
    const files = createMemoryFiles();
    files.writeBase64 = async () => { throw new Error("disk full"); };
    const s = createNativeMediaStore(files, hashKey, { listenForHide: false });
    expect(await s.put("k1", blobOf("abc", "image/jpeg"))).toBe(false);
    expect(await s.has("k1")).toBe(false);
  });

  it("stats break down count and bytes by kind", async () => {
    const { s } = mk();
    await s.put("a", blobOf("12345", "image/png"));
    await s.put("b", blobOf("123", "image/jpeg"));
    await s.put("c", blobOf("12", "audio/ogg"));
    await s.put("d", blobOf("1234567", "video/mp4"));
    await s.put("e", blobOf("1", "application/x-weird"));
    const st = await s.stats();
    expect(st.count).toBe(5);
    expect(st.size).toBe(5 + 3 + 2 + 7 + 1);
    expect(st.photos).toEqual({ count: 2, size: 8 });
    expect(st.audio).toEqual({ count: 1, size: 2 });
    expect(st.video).toEqual({ count: 1, size: 7 });
    expect(st.other).toEqual({ count: 1, size: 1 });
  });
});

