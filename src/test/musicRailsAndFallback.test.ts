import { describe, it, expect, beforeEach } from "vitest";
import { dedupeRails } from "@/lib/music/railDedupe";
import { buildUpNextPool, trackKey, songKey } from "@/lib/music/queueQuality";
import { fetchAutoNext, __clearAutoNextCache, type AutoNextDeps } from "@/lib/music/autoNext";
import type { GroicTrack } from "@/lib/music/types";

const t = (title: string, artist = "A", extra: Partial<GroicTrack> = {}): GroicTrack => ({
  id: `soundcloud:${title}|${artist}`, provider: "soundcloud", providerTrackId: `${title}|${artist}`,
  videoId: `${title}|${artist}`, title, artist, thumbnail: null, duration: 200, isStreamable: true, ...extra,
});

describe("trackKey (non-Latin safe identity)", () => {
  it("songKey collapses non-Latin titles to \"\" — the root of the vanishing rails", () => {
    expect(songKey("तुम हो")).toBe("");
    expect(songKey("مرحبا")).toBe("");
  });
  it("trackKey keeps them distinct and noise-insensitive", () => {
    expect(trackKey("तुम हो")).not.toBe(trackKey("मेरे साथ"));
    expect(trackKey("तुम हो (Official Video)")).toBe(trackKey("तुम हो"));
  });
  it("is identical to songKey for Latin titles (stored history stays valid)", () => {
    expect(trackKey("Bad Guy (Official Video)")).toBe(songKey("Bad Guy (Official Video)"));
  });
});

describe("buildUpNextPool with non-Latin titles", () => {
  it("keeps the other Hindi songs in the up-next pool", () => {
    const pool = ["तुम हो", "मेरे साथ", "कहाँ हो", "चलो चलें"].map((x) => t(x));
    const rest = buildUpNextPool(pool, pool[0], (x) => x.id, () => 0.5);
    expect(rest.map((x) => x.title).sort()).toEqual(["कहाँ हो", "चलो चलें", "मेरे साथ"].sort());
  });
});

describe("dedupeRails", () => {
  const rail = (id: string, titles: string[]) => ({ id, items: titles.map((x) => t(x)) });

  it("removes songs repeated in a rail ABOVE, keeps rail order", () => {
    const out = dedupeRails([
      rail("a", ["one", "two", "three", "four", "five"]),
      rail("b", ["two", "six", "seven", "eight", "nine"]),
    ], { minKeep: 2 });
    expect(out.a.map((x) => x.title)).toEqual(["one", "two", "three", "four", "five"]);
    expect(out.b.map((x) => x.title)).toEqual(["six", "seven", "eight", "nine"]);
  });

  it("never empties a rail: shared songs are put back up to minKeep", () => {
    const same = ["s1", "s2", "s3", "s4"];
    const out = dedupeRails([rail("a", same), rail("b", same)], { minKeep: 3 });
    expect(out.b.map((x) => x.title)).toEqual(["s1", "s2", "s3"]);
  });

  it("does not collapse a rail of Devanagari titles to one card", () => {
    const hi = ["तुम हो", "मेरे साथ", "कहाँ हो", "चलो चलें", "प्यार"];
    const out = dedupeRails([rail("hindi", hi)]);
    expect(out.hindi).toHaveLength(5);
  });

  it("drops repeats inside one rail", () => {
    const out = dedupeRails([rail("a", ["x", "x (Official Video)", "y"])], { minKeep: 1 });
    expect(out.a.map((v) => v.title)).toEqual(["x", "y"]);
  });

  it("has no playback input: a rail is identical before and after its songs are queued", () => {
    const rails = [rail("hindi", ["तुम हो", "मेरे साथ", "कहाँ हो", "चलो चलें"])];
    expect(dedupeRails(rails)).toEqual(dedupeRails(rails));
    expect(dedupeRails(rails).hindi.length).toBe(4);
  });
});

describe("fetchAutoNext fallback ladder", () => {
  beforeEach(() => { localStorage.clear(); __clearAutoNextCache(); });
  const base = (searchTrending?: AutoNextDeps["searchTrending"], sc: GroicTrack[] = []): AutoNextDeps => ({
    searchSoundCloud: () => Promise.resolve(sc),
    searchAudius: () => Promise.resolve([]),
    searchYouTube: () => Promise.resolve([]),
    searchTrending,
  });

  it("relaxes the recent-play window instead of returning nothing", async () => {
    const cands = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((x) => t(x, "Cur"));
    // everything was played "recently" — strict pass finds nothing
    const recent = new Set(cands.map((c) => trackKey(c.title)));
    // …but only the newest ALWAYS_EXCLUDE_NEWEST (10) stay excluded; 7 < 10, so
    // use a long history where the candidates are OLD entries.
    const newest = Array.from({ length: 10 }, (_, i) => `newest${i}`);
    const recentList = new Set([...newest, ...recent]);
    const out = await fetchAutoNext({
      current: t("Now", "Cur"), queue: [], log: [], now: 1_800_000_000_000, recentKeys: recentList, random: () => 0,
    }, base(undefined, cands));
    expect(out.length).toBeGreaterThanOrEqual(6);
  });

  it("falls back to the user's language trending when artist seeds come up short", async () => {
    const asked: string[] = [];
    const trending = (id: string) => { asked.push(id); return Promise.resolve(
      ["गाना १", "गाना २", "गाना ३", "गाना ४", "गाना ५", "गाना ६"].map((x) => t(x, "Singer", { id: `yt:${x}` })),
    ); };
    const out = await fetchAutoNext({
      current: t("Now", "Cur"), queue: [], log: [], now: 1_800_000_000_000, recentKeys: new Set(),
      langs: ["hindi"], random: () => 0,
    }, base(trending, []));
    expect(asked).toEqual(["hindi"]);
    expect(out.length).toBe(6);
    expect(new Set(out.map((x) => x.title)).size).toBe(6); // distinct Devanagari titles
  });

  it("does not use the language fallback for the home rail (current = null)", async () => {
    let called = false;
    const out = await fetchAutoNext({ current: null, queue: [], log: [], now: 1_800_000_000_000 },
      base(() => { called = true; return Promise.resolve([]); }));
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("per-rail minKeep (language rails stay >= 15)", () => {
  it("puts shared songs back up to the rail's own floor", () => {
    const mk = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ title: `${p} song ${i}` }));
    const shared = mk("shared", 20);
    const out = dedupeRails([
      { id: "forYou", items: shared },
      { id: "lang:hindi", items: [...shared, ...mk("h", 2)], minKeep: 15 },
    ]);
    expect(out["lang:hindi"].length).toBe(15);
    expect(out.forYou.length).toBe(20);
  });
});
