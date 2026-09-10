import { describe, it, expect } from "vitest";
import { songKey, shuffled, buildUpNextPool } from "@/lib/music/queueQuality";

describe("songKey", () => {
  it("treats differently-annotated uploads of the same song as equal", () => {
    expect(songKey("Bad Guy (Official Video)")).toBe(songKey("Bad Guy [Official Audio]"));
    expect(songKey("Bad Guy - Billie Eilish (Lyrics)")).not.toBe(""); // sanity: not fully stripped to empty
  });

  it("strips featuring credits", () => {
    expect(songKey("Song Title feat. Someone Else")).toBe(songKey("Song Title"));
    expect(songKey("Song Title ft. Someone")).toBe(songKey("Song Title"));
  });

  it("is case- and punctuation-insensitive", () => {
    expect(songKey("Don't Stop Me Now")).toBe(songKey("dont stop me now"));
  });

  it("two genuinely different songs produce different keys", () => {
    expect(songKey("Bad Guy")).not.toBe(songKey("Bad Romance"));
  });
});

describe("shuffled", () => {
  it("returns a permutation of the same elements (never drops/duplicates)", () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffled(input, () => 0.5);
    expect(result).toHaveLength(input.length);
    expect([...result].sort()).toEqual([...input].sort());
  });

  it("does not mutate the input array", () => {
    const input = [1, 2, 3];
    const copy = [...input];
    shuffled(input, () => 0.5);
    expect(input).toEqual(copy);
  });

  it("is deterministic for a fixed random source", () => {
    const a = shuffled([1, 2, 3, 4, 5], () => 0.1);
    const b = shuffled([1, 2, 3, 4, 5], () => 0.1);
    expect(a).toEqual(b);
  });
});

describe("buildUpNextPool", () => {
  interface T { id: string; title: string; }
  const idOf = (t: T) => t.id;

  it("excludes the tapped track itself", () => {
    const tapped: T = { id: "1", title: "Bad Guy" };
    const pool: T[] = [tapped, { id: "2", title: "Bury a Friend" }];
    const result = buildUpNextPool(pool, tapped, idOf, () => 0);
    expect(result.find((t) => t.id === "1")).toBeUndefined();
  });

  it("excludes other uploads of the literal same song — the core 'bad guy everywhere' fix", () => {
    const tapped: T = { id: "1", title: "Bad Guy (Official Video)" };
    const pool: T[] = [
      tapped,
      { id: "2", title: "Bad Guy [Official Audio]" },     // same song, different upload
      { id: "3", title: "Bad Guy - Cover by Someone" },    // same song, a cover
      { id: "4", title: "Bury a Friend" },                 // genuinely different song
    ];
    const result = buildUpNextPool(pool, tapped, idOf, () => 0);
    expect(result.map((t) => t.id).sort()).toEqual(["4"]);
  });

  it("returns an empty pool when every candidate is a duplicate of the tapped song", () => {
    const tapped: T = { id: "1", title: "Bad Guy" };
    const pool: T[] = [tapped, { id: "2", title: "bad guy" }, { id: "3", title: "BAD GUY!!" }];
    const result = buildUpNextPool(pool, tapped, idOf, () => 0);
    expect(result).toEqual([]);
  });

  it("shuffles the remaining pool rather than preserving input order deterministically", () => {
    const tapped: T = { id: "1", title: "Song A" };
    const pool: T[] = [
      tapped,
      { id: "2", title: "Song B" }, { id: "3", title: "Song C" },
      { id: "4", title: "Song D" }, { id: "5", title: "Song E" },
    ];
    const resultLowRandom = buildUpNextPool(pool, tapped, idOf, () => 0);
    const resultHighRandom = buildUpNextPool(pool, tapped, idOf, () => 0.99);
    // Same membership, not necessarily the same order — this is the actual
    // "randomness" fix; asserting the orders differ for two different
    // random sources is a meaningful regression check that shuffling is
    // actually happening, not silently a no-op.
    expect(resultLowRandom.map((t) => t.id).sort()).toEqual(resultHighRandom.map((t) => t.id).sort());
    expect(resultLowRandom.map((t) => t.id)).not.toEqual(resultHighRandom.map((t) => t.id));
  });

  // FIX ("one song should not be suggested again") coverage.
  it("excludes songs whose key is in excludeKeys, even from a different upload", () => {
    const tapped: T = { id: "1", title: "Song A" };
    const pool: T[] = [
      tapped,
      { id: "2", title: "Song B" },
      { id: "3", title: "Song C (Official Video)" }, // already played under a different upload's title
      { id: "4", title: "Song D" },
    ];
    const excludeKeys = new Set([songKey("Song C")]);
    const result = buildUpNextPool(pool, tapped, idOf, () => 0, excludeKeys);
    expect(result.map((t) => t.id).sort()).toEqual(["2", "4"]);
  });

  it("falls back to ignoring history when it would empty the pool", () => {
    const tapped: T = { id: "1", title: "Song A" };
    const pool: T[] = [tapped, { id: "2", title: "Song B" }];
    const excludeKeys = new Set([songKey("Song B")]); // would exclude everything left
    const result = buildUpNextPool(pool, tapped, idOf, () => 0, excludeKeys);
    expect(result.map((t) => t.id)).toEqual(["2"]); // history dropped, base pool used instead
  });
});
