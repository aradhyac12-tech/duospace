import { describe, it, expect } from "vitest";
import { pickUnplayedIndex, resolveAdvanceWithBag, tracksAhead } from "@/lib/music/queueLogic";

const ids = ["a", "b", "c", "d"];
// Deterministic "random" that walks a fixed sequence.
const seq = (...vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };

describe("pickUnplayedIndex", () => {
  it("only returns tracks that are neither current nor already played", () => {
    const played = new Set(["a", "b"]); // a is current, b already heard
    for (let t = 0; t < 20; t++) {
      const idx = pickUnplayedIndex(ids, "a", played, () => t / 20);
      expect(["c", "d"]).toContain(ids[idx]);
    }
  });
  it("returns -1 once every other track has been played", () => {
    expect(pickUnplayedIndex(ids, "a", new Set(ids))).toBe(-1);
  });
});

describe("resolveAdvanceWithBag", () => {
  it("shuffle plays every track exactly once before repeating", () => {
    const played = new Set<string>(["a"]);
    let current = "a";
    const order = ["a"];
    for (let i = 0; i < 3; i++) {
      const r = resolveAdvanceWithBag({ ids, currentId: current, repeatMode: "off", shuffle: true, played, random: seq(0.9, 0.1, 0.5) });
      expect(r.index).toBeGreaterThanOrEqual(0);
      current = ids[r.index];
      played.add(current);
      order.push(current);
    }
    expect(new Set(order).size).toBe(4);
    const end = resolveAdvanceWithBag({ ids, currentId: current, repeatMode: "off", shuffle: true, played });
    expect(end.index).toBe(-1); // bag empty, repeat off → caller can ask auto-next for more
  });

  it("repeat-all starts a new cycle and avoids replaying the track that just ended", () => {
    const played = new Set(ids);
    for (let t = 0; t < 20; t++) {
      const r = resolveAdvanceWithBag({ ids, currentId: "c", repeatMode: "all", shuffle: true, played, random: () => t / 20 });
      expect(r.newCycle).toBe(true);
      expect(ids[r.index]).not.toBe("c");
    }
  });

  it("shuffle off behaves exactly like sequential advance", () => {
    expect(resolveAdvanceWithBag({ ids, currentId: "b", repeatMode: "off", shuffle: false, played: new Set() }).index).toBe(2);
    expect(resolveAdvanceWithBag({ ids, currentId: "d", repeatMode: "off", shuffle: false, played: new Set() }).index).toBe(-1);
    expect(resolveAdvanceWithBag({ ids, currentId: "d", repeatMode: "all", shuffle: false, played: new Set() }).index).toBe(0);
  });

  it("repeat-one restarts the current track regardless of shuffle", () => {
    const r = resolveAdvanceWithBag({ ids, currentId: "b", repeatMode: "one", shuffle: true, played: new Set() });
    expect(r).toMatchObject({ index: 1, repeatCurrent: true });
  });
});

describe("tracksAhead", () => {
  it("counts remaining tracks in order when not shuffling", () => {
    expect(tracksAhead(ids, "b", false, new Set())).toBe(2);
    expect(tracksAhead(ids, "d", false, new Set())).toBe(0);
  });
  it("counts unplayed tracks when shuffling", () => {
    expect(tracksAhead(ids, "a", true, new Set(["a", "b"]))).toBe(2);
  });
});
