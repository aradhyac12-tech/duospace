import { describe, it, expect } from "vitest";
import { createStartupTracer, median } from "@/lib/music/startupTrace";

const clock = () => { let t = 0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

describe("startupTracer", () => {
  it("splits tap-to-audio into ui / resolve / load / native stages", () => {
    const c = clock(); const tr = createStartupTracer(c.now);
    tr.begin("a", "soundcloud");
    c.advance(5);   tr.mark("uiCommitted", "a");
    c.advance(1);   tr.mark("resolveStart", "a"); tr.setResolveSource("a", "network");
    c.advance(400); tr.mark("resolved", "a");
    c.advance(1);   tr.mark("loadStart", "a");
    c.advance(30);  tr.mark("loadReturned", "a");
    c.advance(250); tr.audible("a");
    expect(tr.reports()).toEqual([{
      trackId: "a", provider: "soundcloud", outcome: "audible", resolveSource: "network",
      uiMs: 5, resolveMs: 400, loadMs: 30, nativeMs: 250, totalMs: 687,
    }]);
  });

  it("reports a cache hit with ~0 resolve time", () => {
    const c = clock(); const tr = createStartupTracer(c.now);
    tr.begin("a", "audius"); tr.mark("uiCommitted", "a");
    tr.mark("resolveStart", "a"); tr.setResolveSource("a", "cache"); tr.mark("resolved", "a");
    tr.mark("loadStart", "a"); c.advance(20); tr.mark("loadReturned", "a"); c.advance(100); tr.audible("a");
    const r = tr.reports()[0];
    expect(r.resolveSource).toBe("cache");
    expect(r.resolveMs).toBe(0);
    expect(r.totalMs).toBe(120);
  });

  it("a newer tap supersedes the pending trace and never double-reports", () => {
    const c = clock(); const tr = createStartupTracer(c.now);
    tr.begin("a", "p"); c.advance(10);
    tr.begin("b", "p"); c.advance(10);
    tr.audible("a");            // stale event for the old track: ignored
    tr.audible("b");
    const [first, second] = tr.reports();
    expect(first).toMatchObject({ trackId: "a", outcome: "superseded", totalMs: null });
    expect(second).toMatchObject({ trackId: "b", outcome: "audible", totalMs: 10 });
    tr.audible("b");            // duplicate playing event: ignored
    expect(tr.reports()).toHaveLength(2);
  });

  it("marks for a different track are ignored and failure has no total", () => {
    const c = clock(); const tr = createStartupTracer(c.now);
    tr.begin("a", "p"); tr.mark("resolved", "zzz"); tr.fail("zzz");
    expect(tr.isTracing("a")).toBe(true);
    tr.setResolveSource("a", "none"); tr.fail("a");
    expect(tr.reports()[0]).toMatchObject({ outcome: "failed", resolveSource: "none", totalMs: null, resolveMs: null });
  });

  it("a throwing listener cannot break playback and history is bounded", () => {
    const tr = createStartupTracer(() => 0);
    tr.subscribe(() => { throw new Error("boom"); });
    for (let i = 0; i < 60; i++) { tr.begin(`t${i}`, "p"); tr.audible(`t${i}`); }
    expect(tr.reports()).toHaveLength(50);
  });

  it("median handles empty, odd and even lists", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
  });
});
