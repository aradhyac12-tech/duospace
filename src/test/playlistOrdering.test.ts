import { describe, it, expect } from "vitest";
import { positionForNewTopEntry, positionForMove, sortByPosition, reconcileRealtimeRow } from "@/lib/music/playlistOrdering";

describe("positionForNewTopEntry", () => {
  it("returns a fresh value for an empty list", () => {
    expect(positionForNewTopEntry([])).toBeGreaterThan(0);
  });

  it("returns something below the current lowest", () => {
    expect(positionForNewTopEntry([500, 1500, 2500])).toBeLessThan(500);
  });
});

describe("positionForMove", () => {
  it("moving to the top sits below the current first item", () => {
    const pos = positionForMove([1000, 2000, 3000], 0);
    expect(pos).toBeLessThan(1000);
  });

  it("moving to the bottom sits above the current last item", () => {
    const pos = positionForMove([1000, 2000, 3000], 3);
    expect(pos).toBeGreaterThan(3000);
  });

  it("moving into the middle sits strictly between its new neighbors", () => {
    const pos = positionForMove([1000, 2000, 3000], 1);
    expect(pos).toBeGreaterThan(1000);
    expect(pos).toBeLessThan(2000);
    expect(pos).toBe(1500);
  });

  it("clamps an out-of-range index instead of throwing", () => {
    expect(() => positionForMove([1000, 2000], 99)).not.toThrow();
    expect(() => positionForMove([1000, 2000], -5)).not.toThrow();
  });

  it("handles an empty list", () => {
    expect(positionForMove([], 0)).toBeGreaterThan(0);
  });

  it("falls back to a fresh value when neighbors have collided", () => {
    // Two positions one float-epsilon apart — the true midpoint would
    // round back to one of them, which must never happen (it would tie
    // with an existing row and make ordering ambiguous).
    const a = 1000;
    const b = 1000 + Number.EPSILON;
    const pos = positionForMove([a, b], 1);
    expect(pos).toBeGreaterThan(b);
  });
});

describe("sortByPosition", () => {
  it("sorts ascending by position", () => {
    const items = [
      { id: "c", position: 300 },
      { id: "a", position: 100 },
      { id: "b", position: 200 },
    ];
    expect(sortByPosition(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks exact ties deterministically by id", () => {
    const items = [
      { id: "b", position: 100 },
      { id: "a", position: 100 },
    ];
    expect(sortByPosition(items).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ id: "b", position: 2 }, { id: "a", position: 1 }];
    const copy = [...items];
    sortByPosition(items);
    expect(items).toEqual(copy);
  });
});

describe("reconcileRealtimeRow", () => {
  const row = (id: string, position: number, updated_at: string) => ({ id, position, updated_at });

  it("inserts a row that isn't present locally yet", () => {
    const prev = [row("a", 100, "2026-08-28T00:00:00.000Z")];
    const incoming = row("b", 50, "2026-08-28T00:00:01.000Z");
    const next = reconcileRealtimeRow(prev, incoming);
    expect(next.map((r) => r.id)).toEqual(["b", "a"]); // re-sorted by position
  });

  it("applies an incoming update that is newer than local state", () => {
    const prev = [row("a", 100, "2026-08-28T00:00:00.000Z")];
    const incoming = row("a", 500, "2026-08-28T00:00:05.000Z");
    const next = reconcileRealtimeRow(prev, incoming);
    expect(next).toEqual([incoming]);
  });

  it("ignores a stale incoming update (older updated_at than local state)", () => {
    const local = row("a", 500, "2026-08-28T00:00:05.000Z");
    const prev = [local];
    // Simulates an out-of-order realtime delivery: this event is from
    // BEFORE the move that produced local state, arriving after it —
    // exactly the "two users editing simultaneously" race the brief
    // calls out. It must not clobber the newer local position.
    const stale = row("a", 100, "2026-08-28T00:00:00.000Z");
    const next = reconcileRealtimeRow(prev, stale);
    expect(next).toBe(prev); // same reference — proves it was a true no-op, not a re-sort-to-same-values
    expect(next[0].position).toBe(500);
  });

  it("ignores an incoming update with an identical updated_at (duplicate delivery)", () => {
    const local = row("a", 500, "2026-08-28T00:00:05.000Z");
    const prev = [local];
    const duplicate = row("a", 999, "2026-08-28T00:00:05.000Z");
    const next = reconcileRealtimeRow(prev, duplicate);
    expect(next).toBe(prev);
    expect(next[0].position).toBe(500);
  });

  it("resolves rapid back-and-forth drags from two partners to the last-committed position, regardless of delivery order", () => {
    // Partner A drags at t=1 (position 200), partner B drags the same
    // song at t=2 (position 900). If B's event is DELIVERED first
    // (network jitter), then A's arrives — A's must still lose, because
    // it's older by updated_at even though it arrived second.
    const initial = row("song1", 100, "2026-08-28T00:00:00.000Z");
    const bMove = row("song1", 900, "2026-08-28T00:00:02.000Z");
    const aMove = row("song1", 200, "2026-08-28T00:00:01.000Z");

    let songs = [initial];
    songs = reconcileRealtimeRow(songs, bMove); // arrives first
    songs = reconcileRealtimeRow(songs, aMove);  // arrives second, but older

    expect(songs[0].position).toBe(900); // B's (newer) move wins
  });
});
