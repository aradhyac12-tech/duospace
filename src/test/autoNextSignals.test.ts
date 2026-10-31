import { describe, it, expect } from "vitest";
import { buildTimeAffinity, dayPartOf, rankCandidates, withLikedTaste } from "@/lib/music/autoNext";
import type { GroicTrack } from "@/lib/music/types";

const mk = (id: string, title: string, artist: string): GroicTrack =>
  ({ id, title, artist, provider: "soundcloud", providerTrackId: id, videoId: id, thumbnail: null, duration: 200, isStreamable: true } as unknown as GroicTrack);

describe("auto-next taste signals", () => {
  it("dayPartOf buckets local hours", () => {
    expect(dayPartOf(new Date(2026, 0, 1, 3).getTime())).toBe("night");
    expect(dayPartOf(new Date(2026, 0, 1, 9).getTime())).toBe("morning");
    expect(dayPartOf(new Date(2026, 0, 1, 14).getTime())).toBe("afternoon");
    expect(dayPartOf(new Date(2026, 0, 1, 21).getTime())).toBe("evening");
  });
  it("time affinity needs repeat plays in the same day-part and ignores skips", () => {
    const at = (h: number) => new Date(2026, 0, 1, h).getTime();
    const log = [
      { key: "a", artist: "Arijit Singh", at: at(21) }, { key: "b", artist: "Arijit Singh", at: at(22) }, { key: "c", artist: "Arijit Singh", at: at(20) },
      { key: "d", artist: "Once Only", at: at(21) }, { key: "e", artist: "Skipped Guy", at: at(21), skipped: true }, { key: "f", artist: "Skipped Guy", at: at(21), skipped: true },
      { key: "g", artist: "Morning Guy", at: at(8) }, { key: "h", artist: "Morning Guy", at: at(9) },
    ];
    const m = buildTimeAffinity(log, at(19));
    expect(m.get("arijit singh")).toBeGreaterThan(0);
    expect(m.has("once only")).toBe(false);
    expect(m.has("skipped guy")).toBe(false);
    expect(m.has("morning guy")).toBe(false);
  });
  it("a liked artist outranks an otherwise equal unknown artist and counts as related", () => {
    const cands = [mk("1", "Song One", "Unknown Band"), mk("2", "Song Two", "Liked Artist")];
    const out = rankCandidates(cands, {
      current: mk("0", "Now", "Someone Else"), excludeKeys: new Set(), taste: [], relatedOnly: true,
      likedArtists: new Map([["liked artist", 2]]), random: () => 0,
    }, 5);
    expect(out.map((t) => t.id)).toEqual(["2"]);
  });
  it("liked artists are merged into the taste profile and sorted by weight", () => {
    const t = withLikedTaste([{ key: "a", name: "A", score: 1 }], new Map([["b", 4], ["a", 1]]));
    expect(t[0].key).toBe("b");
    expect(t.find((x) => x.key === "a")!.score).toBeCloseTo(1.75);
  });
});
