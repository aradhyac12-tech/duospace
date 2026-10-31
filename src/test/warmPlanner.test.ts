import { describe, it, expect, vi } from "vitest";
import { planWarmTargets, createWarmRunner, type WarmTrackLike } from "@/lib/music/warmPlanner";

const t = (provider: string, id: string, extra: Partial<WarmTrackLike> = {}): WarmTrackLike => ({ provider, providerTrackId: id, ...extra });
const none = () => null;

describe("planWarmTargets", () => {
  it("caps per provider and in total, in input order", () => {
    const tracks = [...Array(10)].map((_, i) => t("soundcloud", `s${i}`))
      .concat([...Array(5)].map((_, i) => t("audius", `a${i}`)), [...Array(5)].map((_, i) => t("jamendo", `j${i}`)));
    const out = planWarmTargets(tracks, none);
    expect(out.length).toBe(6);
    expect(out.filter((x) => x.provider === "soundcloud").length).toBe(4);
    expect(out.filter((x) => x.provider === "audius").length).toBe(2);
  });
  it("skips cached, duplicate, local/youtube, non-streamable, tracks with a direct streamUrl, and everything when offline", () => {
    const peek = (p: string, id: string) => (id === "cached" ? "u" : null);
    const out = planWarmTargets([t("soundcloud", "cached"), t("soundcloud", "x"), t("soundcloud", "x"), t("youtube", "y"),
      t("local", "l"), t("audius", "dead", { isStreamable: false }), t("jamendo", "j", { streamUrl: "https://direct" })], peek);
    expect(out).toEqual([{ provider: "soundcloud", id: "x" }]);
    expect(planWarmTargets([t("soundcloud", "x")], none, false)).toEqual([]);
  });
});

describe("createWarmRunner", () => {
  it("de-dupes the same set within the gap", async () => {
    let clock = 0;
    const prefetch = vi.fn(async () => {});
    const r = createWarmRunner({ peek: none, prefetch, now: () => clock });
    r.warm([t("soundcloud", "a")]); r.warm([t("soundcloud", "a")]);
    expect(prefetch).toHaveBeenCalledTimes(1);
    clock = 61_000; r.warm([t("soundcloud", "a")]);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });
  it("a tap (cancel) or newer query stops queued per-track lookups", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const prefetch = vi.fn(async (items: { provider: string; id: string }[]) => { started.push(items[0].id); await gate; });
    const r = createWarmRunner({ peek: none, prefetch });
    r.warm([t("audius", "a1"), t("audius", "a2")]);
    await Promise.resolve();
    expect(started).toEqual(["a1"]);
    r.cancel();            // user tapped a song
    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(started).toEqual(["a1"]); // a2 never started
  });
  it("does nothing when offline", () => {
    const prefetch = vi.fn(async () => {});
    createWarmRunner({ peek: none, prefetch, isOnline: () => false }).warm([t("soundcloud", "a")]);
    expect(prefetch).not.toHaveBeenCalled();
  });
});
