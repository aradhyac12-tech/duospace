import { describe, it, expect } from "vitest";
import { GENRES, getGenre } from "@/lib/music/genres";

describe("genre catalogue", () => {
  it("has unique ids", () => { expect(new Set(GENRES.map((g) => g.id)).size).toBe(GENRES.length); });
  it("every genre has a Jamendo tag, a search query and a gradient", () => {
    for (const g of GENRES) { expect(g.jamendoTag).toBeTruthy(); expect(g.query).toBeTruthy(); expect(g.gradient).toMatch(/^bg-gradient-to-br /); }
  });
  it("includes the headline genres", () => {
    for (const id of ["pop", "indie", "hiphop", "rock", "electronic", "jazz"]) expect(getGenre(id)).toBeDefined();
  });
});
