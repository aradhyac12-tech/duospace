import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createStreamResolver, isGenuinePause } from "../lib/music/streamResolver";

type P = "soundcloud" | "audius";
function make(opts: { batch?: boolean; ttlMs?: number; failBatch?: boolean; max?: number } = {}) {
  let t = 1_000;
  const calls = { one: [] as string[], batch: [] as string[][] };
  const r = createStreamResolver<P>({
    now: () => t, ttlMs: opts.ttlMs ?? 1000, maxEntries: opts.max,
    resolveOne: async (p, id, o) => { calls.one.push(`${p}:${id}${o?.fresh ? ":fresh" : ""}`); return id === "dead" ? null : `url-${id}${o?.fresh ? "-fresh" : ""}`; },
    resolveBatch: opts.batch === false ? undefined : (p, ids) => {
      if (p !== "soundcloud") return null;
      calls.batch.push(ids);
      if (opts.failBatch) return Promise.reject(new Error("boom"));
      return Promise.resolve(Object.fromEntries(ids.map((i) => [i, i === "dead" ? null : `url-${i}`])));
    },
  });
  return { r, calls, advance: (ms: number) => { t += ms; } };
}

describe("streamResolver — cache & de-duplication", () => {
  it("second resolve of the same track is served from cache (no extra request)", async () => {
    const { r, calls } = make();
    expect(await r.resolve("soundcloud", "a")).toBe("url-a");
    expect(await r.resolve("soundcloud", "a")).toBe("url-a");
    expect(calls.one).toEqual(["soundcloud:a"]);
    expect(r.peek("soundcloud", "a")).toBe("url-a");
  });
  it("concurrent callers share one in-flight request", async () => {
    const { r, calls } = make();
    const [x, y] = await Promise.all([r.resolve("audius", "z"), r.resolve("audius", "z")]);
    expect([x, y]).toEqual(["url-z", "url-z"]); expect(calls.one).toHaveLength(1);
  });
  it("entries expire after the TTL", async () => {
    const { r, calls, advance } = make({ ttlMs: 1000 });
    await r.resolve("soundcloud", "a"); advance(1500);
    expect(r.peek("soundcloud", "a")).toBeNull();
    await r.resolve("soundcloud", "a"); expect(calls.one).toHaveLength(2);
  });
  it("a failed (null) resolution is never cached", async () => {
    const { r, calls } = make();
    expect(await r.resolve("soundcloud", "dead")).toBeNull();
    expect(r.peek("soundcloud", "dead")).toBeNull();
    await r.resolve("soundcloud", "dead"); expect(calls.one).toHaveLength(2);
  });
  it("invalidate + fresh force a new request (expired signed URL retry)", async () => {
    const { r, calls } = make();
    await r.resolve("soundcloud", "a"); r.invalidate("soundcloud", "a");
    expect(r.peek("soundcloud", "a")).toBeNull();
    expect(await r.resolve("soundcloud", "a", { fresh: true })).toBe("url-a-fresh");
    expect(calls.one).toEqual(["soundcloud:a", "soundcloud:a:fresh"]);
    // `fresh` bypasses even a warm cache
    await r.resolve("soundcloud", "a", { fresh: true }); expect(calls.one).toHaveLength(3);
  });
  it("a throwing resolver yields null, never a rejection", async () => {
    const r = createStreamResolver<P>({ resolveOne: async () => { throw new Error("x"); } });
    expect(await r.resolve("audius", "q")).toBeNull();
  });
  it("evicts the oldest entry past maxEntries", async () => {
    const { r } = make({ max: 2 });
    await r.resolve("audius", "1"); await r.resolve("audius", "2"); await r.resolve("audius", "3");
    expect(r.size()).toBe(2); expect(r.peek("audius", "1")).toBeNull(); expect(r.peek("audius", "3")).toBe("url-3");
  });
});

describe("streamResolver — batched prefetch", () => {
  it("prefetching several SoundCloud tracks costs ONE batch request", async () => {
    const { r, calls } = make();
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }, { provider: "soundcloud", id: "c" }]);
    expect(calls.batch).toEqual([["a", "b", "c"]]); expect(calls.one).toHaveLength(0);
    expect(r.peek("soundcloud", "b")).toBe("url-b");
  });
  it("a following next/previous is instant (cache hit, no request)", async () => {
    const { r, calls } = make();
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }]);
    await r.resolve("soundcloud", "b"); expect(calls.one).toHaveLength(0);
  });
  it("already-cached and in-flight tracks are skipped", async () => {
    const { r, calls } = make();
    await r.resolve("soundcloud", "a");
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }, { provider: "soundcloud", id: "c" }]);
    expect(calls.batch).toEqual([["b", "c"]]);
  });
  it("a single track uses the plain endpoint, not a batch", async () => {
    const { r, calls } = make();
    await r.prefetch([{ provider: "soundcloud", id: "a" }]);
    expect(calls.batch).toHaveLength(0); expect(calls.one).toEqual(["soundcloud:a"]);
  });
  it("providers without a batch endpoint resolve individually", async () => {
    const { r, calls } = make();
    await r.prefetch([{ provider: "audius", id: "x" }, { provider: "audius", id: "y" }]);
    expect(calls.batch).toHaveLength(0); expect(calls.one.sort()).toEqual(["audius:x", "audius:y"]);
  });
  it("a track the batch missed falls back to a single resolution; dead tracks stay null", async () => {
    const { r } = make();
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "dead" }]);
    expect(r.peek("soundcloud", "a")).toBe("url-a"); expect(r.peek("soundcloud", "dead")).toBeNull();
  });
  it("if the whole batch fails, every track still resolves via singles", async () => {
    const { r, calls } = make({ failBatch: true });
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }]);
    expect(calls.one.sort()).toEqual(["soundcloud:a", "soundcloud:b"]); expect(r.peek("soundcloud", "a")).toBe("url-a");
  });
  it("a resolve() that arrives mid-batch joins it instead of duplicating the request", async () => {
    const { r, calls } = make();
    const pre = r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }]);
    const joined = r.resolve("soundcloud", "a");
    await pre; expect(await joined).toBe("url-a"); expect(calls.one).toHaveLength(0);
  });
  it("prefetch never rejects", async () => {
    const r = createStreamResolver<P>({ resolveOne: async () => { throw new Error("x"); }, resolveBatch: () => Promise.reject(new Error("y")) });
    await r.prefetch([{ provider: "soundcloud", id: "a" }, { provider: "soundcloud", id: "b" }]);
    expect(r.peek("soundcloud", "a")).toBeNull();
  });
});

describe("isGenuinePause — don't believe a buffering 'paused'", () => {
  it("buffering/playing are NOT a pause", () => { expect(isGenuinePause({ state: "loading" })).toBe(false); expect(isGenuinePause({ state: "playing" })).toBe(false); });
  it("paused / ended / idle are", () => { for (const s of ["paused", "ended", "idle"]) expect(isGenuinePause({ state: s })).toBe(true); });
  it("an unreadable state trusts the event", () => { expect(isGenuinePause(null)).toBe(true); expect(isGenuinePause({})).toBe(true); });
});

describe("source-level guards for code that can't run here", () => {
  const kt = readFileSync("native-plugins/audio-engine/android/src/main/java/com/duospace/audioengine/MediaPlaybackService.kt", "utf8");
  const edge = readFileSync("supabase/functions/soundcloud-search/index.ts", "utf8");
  const ctx = readFileSync("src/contexts/GroicContext.tsx", "utf8");
  it("Android only forwards 'not playing' when playback is genuinely stopped", () => {
    expect(kt).toMatch(/genuinelyStopped = p != null && \(!p\.playWhenReady/);
    expect(kt).toMatch(/if \(isPlaying \|\| genuinelyStopped\) eventListener\?\.onIsPlayingChanged\(isPlaying\)/);
  });
  it("edge function: batch capped, cached, client_id overlapped with auth", () => {
    expect(edge).toMatch(/ids\.length > 6/); expect(edge).toMatch(/STREAM_CACHE_TTL_MS/); expect(edge).toMatch(/clientIdPromise = getClientId\(\)\.catch/);
    expect(edge).toMatch(/track_authorization/); expect(edge).toMatch(/body\?\.fresh === true/);
  });
  it("player: paused events are verified, native errors retry once with a fresh URL before skipping", () => {
    expect(ctx).toMatch(/isGenuinePause\(st\)/); expect(ctx).toMatch(/if \(retryCurrentRef\.current\(\)\) return;/);
    expect(ctx).toMatch(/retriedTrackIdRef\.current === cur\.id\) return false/);
  });
});

describe("SoundCloud proxy mode (blocked-network fix)", () => {
  it("clearProvider drops only that provider's cached URLs", async () => {
    const r = createStreamResolver<string>({ resolveOne: async (p, id) => `u:${p}:${id}` });
    await r.resolve("soundcloud", "1"); await r.resolve("audius", "2");
    r.clearProvider("soundcloud");
    expect(r.peek("soundcloud", "1")).toBeNull();
    expect(r.peek("audius", "2")).toBe("u:audius:2");
  });
  it("proxied HLS URLs carry .m3u8 in the PATH (ExoPlayer is only told 'HLS' from the path) and the app probes before the first play", () => {
    const edge = readFileSync("supabase/functions/soundcloud-search/index.ts", "utf8");
    const ctx = readFileSync("src/contexts/GroicContext.tsx", "utf8");
    expect(edge).toMatch(/\/playlist\.m3u8/);
    expect(readFileSync("src/lib/music/soundcloudProvider.ts", "utf8")).toMatch(/probeSoundCloudReachability/);
    expect(ctx).toMatch(/soundCloudProbeVerdict\(\) === null/);
    expect(ctx).toMatch(/clearProvider\("soundcloud"\)/);
  });
});
