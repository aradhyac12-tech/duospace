import { describe, it, expect, beforeEach } from "vitest";
import {
  artistKey, buildSeedQueries, buildTaste, cleanArtist, fetchAutoNext, rankCandidates, trackKey,
  __clearAutoNextCache, type AutoNextDeps,
} from "@/lib/music/autoNext";
import { recordPlayed, recordSkipped, readPlayLog, type PlayLogEntry } from "@/lib/music/playHistory";
import type { GroicTrack } from "@/lib/music/types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const track = (title: string, artist: string, extra: Partial<GroicTrack> = {}): GroicTrack => ({
  id: `soundcloud:${title}|${artist}`,
  provider: "soundcloud",
  providerTrackId: `${title}|${artist}`,
  videoId: `${title}|${artist}`,
  title, artist,
  thumbnail: null,
  duration: 200,
  isStreamable: true,
  ...extra,
});
const entry = (artist: string, daysAgo: number, skipped = false): PlayLogEntry =>
  ({ key: `${artist}-${daysAgo}`, artist, at: NOW - daysAgo * DAY, skipped });

describe("artist normalization", () => {
  it("strips YouTube channel noise", () => {
    expect(cleanArtist("Adele - Topic")).toBe("Adele");
    expect(cleanArtist("AdeleVEVO")).toBe("Adele");
    expect(cleanArtist("Arijit Singh Official")).toBe("Arijit Singh");
    expect(artistKey("Adele - Topic")).toBe(artistKey("ADELE"));
  });
});

describe("trackKey", () => {
  it("does not collapse non-Latin titles into one empty key", () => {
    expect(trackKey({ title: "तुम हो" })).not.toBe(trackKey({ title: "मेरे साथ" }));
  });
});

describe("buildTaste", () => {
  it("ranks frequent, recent artists first", () => {
    const taste = buildTaste([entry("A", 1), entry("A", 2), entry("A", 3), entry("B", 1)], NOW);
    expect(taste.map((a) => a.name)).toEqual(["A", "B"]);
  });
  it("lets old plays fade", () => {
    const taste = buildTaste([entry("Old", 120), entry("New", 1)], NOW);
    expect(taste[0].name).toBe("New");
  });
  it("counts early skips against an artist and drops net-negative ones", () => {
    const taste = buildTaste([entry("Skipped", 1), entry("Skipped", 1, true), entry("Skipped", 1, true), entry("Liked", 1)], NOW);
    expect(taste.map((a) => a.name)).toEqual(["Liked"]);
  });
  it("ignores unknown artists", () => {
    expect(buildTaste([entry("Unknown Artist", 1), entry("", 1)], NOW)).toEqual([]);
  });
});

describe("buildSeedQueries", () => {
  it("seeds from the current artist, then other taste artists — nothing fixed", () => {
    const taste = buildTaste([entry("Taste One", 1), entry("Taste Two", 1), entry("Current", 1)], NOW);
    const seeds = buildSeedQueries({ title: "X", artist: "Current" }, taste, { maxSeeds: 3, random: () => 0.1 });
    expect(seeds[0]).toBe("Current");
    expect(seeds.slice(1).sort()).toEqual(["Taste One", "Taste Two"]);
  });
  it("falls back to the current title only when there is no usable artist anywhere", () => {
    expect(buildSeedQueries({ title: "Some Song (Official Video)", artist: "Unknown" }, [])).toEqual(["some song"]);
  });
  it("returns nothing when there is no signal at all", () => {
    expect(buildSeedQueries(null, [])).toEqual([]);
  });
});

describe("rankCandidates", () => {
  const ctx = (over = {}) => ({
    current: track("Now Playing", "Current"),
    excludeKeys: new Set<string>(),
    taste: buildTaste([entry("Fav", 1), entry("Fav", 2)], NOW),
    random: () => 0,
    ...over,
  });

  it("drops already-played/queued songs, the current song, duplicates and unstreamable tracks", () => {
    const out = rankCandidates([
      track("Played Before", "Fav"),
      track("Now Playing", "Current"),
      track("Fresh", "Fav"),
      track("Fresh", "Fav", { id: "youtube:dup", provider: "youtube" }),
      track("Blocked", "Fav", { isStreamable: false }),
    ], ctx({ excludeKeys: new Set([trackKey({ title: "Played Before" })]) }));
    expect(out.map((t) => t.title)).toEqual(["Fresh"]);
  });

  it("rejects mixes, karaoke and out-of-range durations", () => {
    const out = rankCandidates([
      track("Best Songs 10 Hours", "Fav"),
      track("Song (Karaoke)", "Fav"),
      track("Too Short", "Fav", { duration: 20 }),
      track("Hour Long Set", "Fav", { duration: 3 * 3600 }),
      track("Good One", "Fav"),
    ], ctx());
    expect(out.map((t) => t.title)).toEqual(["Good One"]);
  });

  it("prefers liked artists and de-prioritises covers/remixes", () => {
    const out = rankCandidates([
      track("Stranger Song", "Nobody"),
      track("Fav Remix", "Fav", { id: "x1" }),
      track("Fav Original", "Fav", { id: "x2" }),
    ], ctx());
    expect(out[0].title).toBe("Fav Original");
    expect(out.map((t) => t.title).indexOf("Fav Remix")).toBeGreaterThan(out.map((t) => t.title).indexOf("Fav Original"));
  });

  it("keeps any single artist to two tracks in the first pass", () => {
    const many = Array.from({ length: 6 }, (_, i) => track(`Fav ${i}`, "Fav"));
    const others = [track("O1", "Other One"), track("O2", "Other Two")];
    const out = rankCandidates([...many, ...others], ctx(), 4);
    expect(out.filter((t) => t.artist === "Fav").length).toBeLessThanOrEqual(2);
    expect(out.length).toBe(4);
  });

  it("penalises artists that just played to avoid runs", () => {
    const out = rankCandidates(
      [track("A1", "Recent"), track("B1", "Fresh")],
      ctx({ taste: [], recentArtists: [artistKey("Recent")] }),
    );
    expect(out[0].artist).toBe("Fresh");
  });
});

describe("fetchAutoNext", () => {
  beforeEach(() => { localStorage.clear(); __clearAutoNextCache(); });

  const deps = (map: Record<string, GroicTrack[]>): AutoNextDeps & { calls: string[] } => {
    const calls: string[] = [];
    const get = (q: string) => { calls.push(q); return Promise.resolve(map[q] ?? []); };
    return { calls, searchSoundCloud: get, searchAudius: () => Promise.resolve([]), searchYouTube: () => Promise.resolve([]) };
  };

  it("searches only for seeds derived from the listener, and excludes the queue", async () => {
    const d = deps({
      Current: [track("Next Up", "Current"), track("Already Queued", "Current")],
      Favourite: [track("Deep Cut", "Favourite")],
    });
    const out = await fetchAutoNext({
      current: track("Now Playing", "Current"),
      queue: [track("Already Queued", "Current")],
      log: [entry("Favourite", 1), entry("Favourite", 2)],
      now: NOW,
      random: () => 0,
      recentKeys: new Set(),
    }, d);
    expect(new Set(d.calls)).toEqual(new Set(["Current", "Favourite"]));
    expect(out.map((t) => t.title).sort()).toEqual(["Deep Cut", "Next Up"]);
  });

  it("returns [] (and makes no requests) when there is no listening signal", async () => {
    const d = deps({});
    expect(await fetchAutoNext({ current: null, queue: [], log: [], now: NOW }, d)).toEqual([]);
    expect(d.calls).toEqual([]);
  });

  it("survives a failing provider", async () => {
    const d: AutoNextDeps = {
      searchSoundCloud: () => Promise.reject(new Error("down")),
      searchAudius: () => Promise.reject(new Error("down")),
      searchYouTube: () => Promise.resolve([track("Still Works", "Current", { provider: "youtube", id: "youtube:1" })]),
    };
    const out = await fetchAutoNext({ current: track("Now", "Current"), queue: [], log: [], now: NOW, recentKeys: new Set() }, d);
    expect(out.map((t) => t.title)).toEqual(["Still Works"]);
  });
});

describe("play log", () => {
  beforeEach(() => localStorage.clear());
  it("records artists and flags early skips", () => {
    recordPlayed("Song One", "Artist A");
    recordPlayed("Song Two", "Artist B");
    recordSkipped("Song Two", "Artist B");
    const log = readPlayLog();
    expect(log.map((e) => e.artist)).toEqual(["Artist B", "Artist A"]);
    expect(log[0].skipped).toBe(true);
    expect(log[1].skipped).toBeUndefined();
  });
  it("still works without an artist (key-only history unchanged)", () => {
    recordPlayed("Song One");
    expect(readPlayLog()).toEqual([]);
  });
});
