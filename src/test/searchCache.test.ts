import { describe, it, expect, vi } from "vitest";
import { createSearchCache } from "@/lib/music/searchCache";

describe("searchCache", () => {
  it("serves a repeat (case/space-insensitive) query from memory", async () => {
    const c = createSearchCache<number>(); const fn = vi.fn(async () => [1, 2]);
    await c.run("sc", "Daft  Punk", fn); await c.run("sc", " daft punk", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("shares one in-flight request between concurrent identical searches", async () => {
    const c = createSearchCache<number>(); const fn = vi.fn(() => new Promise<number[]>((r) => setTimeout(() => r([1]), 10)));
    await Promise.all([c.run("sc", "x", fn), c.run("sc", "x", fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("never caches empty results or failures (retry must really re-request)", async () => {
    const c = createSearchCache<number>();
    const empty = vi.fn(async () => [] as number[]); await c.run("sc", "q", empty); await c.run("sc", "q", empty);
    expect(empty).toHaveBeenCalledTimes(2);
    const bad = vi.fn(async () => { throw new Error("429"); });
    await expect(c.run("sc", "z", bad)).rejects.toThrow(); await expect(c.run("sc", "z", bad)).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(2);
  });
  it("expires after the TTL and keeps providers separate", async () => {
    let t = 0; const c = createSearchCache<number>({ ttlMs: 1000, now: () => t }); const fn = vi.fn(async () => [1]);
    await c.run("sc", "q", fn); await c.run("audius", "q", fn); expect(fn).toHaveBeenCalledTimes(2);
    t = 1001; await c.run("sc", "q", fn); expect(fn).toHaveBeenCalledTimes(3);
  });
  it("evicts the oldest entry past max", async () => {
    const c = createSearchCache<number>({ max: 2 }); const fn = async () => [1];
    await c.run("p", "a", fn); await c.run("p", "b", fn); await c.run("p", "c", fn);
    expect(c.size()).toBe(2);
  });
});
