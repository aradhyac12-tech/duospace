import { describe, it, expect } from "vitest";
import { pickNextIndex, resolveAdvance } from "@/lib/music/queueLogic";

// Deterministic "random" for shuffle tests — always picks the first
// candidate, so assertions can be exact instead of "is a valid index".
const fixedRandom = () => 0;

describe("pickNextIndex", () => {
  it("returns -1 for an empty or single-track queue", () => {
    expect(pickNextIndex(0, -1, false)).toBe(-1);
    expect(pickNextIndex(1, 0, false)).toBe(-1);
    expect(pickNextIndex(1, 0, true)).toBe(-1);
  });

  it("advances sequentially when shuffle is off", () => {
    expect(pickNextIndex(5, 0, false)).toBe(1);
    expect(pickNextIndex(5, 3, false)).toBe(4);
  });

  it("returns -1 sequentially at the end of the queue", () => {
    expect(pickNextIndex(5, 4, false)).toBe(-1);
  });

  it("shuffle never returns the current index", () => {
    for (let trial = 0; trial < 20; trial++) {
      const random = () => trial / 20; // sweep across the [0,1) range
      const idx = pickNextIndex(5, 2, true, random);
      expect(idx).not.toBe(2);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(5);
    }
  });

  it("shuffle picks the first remaining candidate when random() is 0", () => {
    // Candidates for currentIndex=2 in a 5-length queue: [0,1,3,4]
    expect(pickNextIndex(5, 2, true, fixedRandom)).toBe(0);
  });
});

describe("resolveAdvance", () => {
  it("repeat-one always restarts the current track, ignoring queue position", () => {
    const result = resolveAdvance(5, 2, "one", false);
    expect(result).toEqual({ index: 2, repeatCurrent: true });
  });

  it("repeat-one wins even with shuffle on and at the end of the queue", () => {
    const result = resolveAdvance(3, 2, "one", true);
    expect(result.repeatCurrent).toBe(true);
    expect(result.index).toBe(2);
  });

  it("repeat off, mid-queue: advances sequentially", () => {
    const result = resolveAdvance(4, 1, "off", false);
    expect(result).toEqual({ index: 2, repeatCurrent: false });
  });

  it("repeat off, end of queue: reports nowhere to go (stop)", () => {
    const result = resolveAdvance(4, 3, "off", false);
    expect(result).toEqual({ index: -1, repeatCurrent: false });
  });

  it("repeat-all wraps to the start at the end of the queue", () => {
    const result = resolveAdvance(4, 3, "all", false);
    expect(result).toEqual({ index: 0, repeatCurrent: false });
  });

  it("repeat-all + shuffle still wraps (to a random index) instead of stopping", () => {
    const result = resolveAdvance(4, 3, "all", true, fixedRandom);
    expect(result.repeatCurrent).toBe(false);
    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.index).toBeLessThan(4);
  });

  it("a single-track queue with repeat-all still loops (repeat current effectively)", () => {
    const result = resolveAdvance(1, 0, "all", false);
    // pickNextIndex(1, 0, false) === -1, then repeat-all wraps to index 0
    expect(result).toEqual({ index: 0, repeatCurrent: false });
  });

  it("an empty queue never produces a playable index regardless of mode", () => {
    expect(resolveAdvance(0, -1, "off", false).index).toBe(-1);
    expect(resolveAdvance(0, -1, "all", false).index).toBe(-1);
    // repeat-one is the one exception — it "restarts current" even with
    // an empty queue, since it doesn't consult the queue at all. Callers
    // (GroicContext) only reach this with a real current track, so index
    // here is whatever currentIndex was passed, not a promise there's a
    // track at that position in an empty array.
    expect(resolveAdvance(0, -1, "one", false)).toEqual({ index: -1, repeatCurrent: true });
  });
});
