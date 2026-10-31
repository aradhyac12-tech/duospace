import { describe, it, expect } from "vitest";
import { toneFor, WINE_SURFACE } from "@/lib/music/palette";
import { GENRES } from "@/lib/music/genres";
import { pushBackHandler, runTopBackHandler } from "@/lib/backStack";

describe("music palette", () => {
  it("toneFor is stable and always returns a literal gradient class", () => {
    for (const g of GENRES) {
      expect(toneFor(g.id)).toBe(toneFor(g.id));
      expect(toneFor(g.id)).toMatch(/^bg-gradient-to-br from-\[hsl\(/);
    }
    expect(toneFor("anything")).toBeTruthy();
  });
  it("the palette stays restrained: no rainbow utility colours", () => {
    const all = [WINE_SURFACE, ...GENRES.map((g) => toneFor(g.id))].join(" ");
    expect(all).not.toMatch(/(violet|fuchsia|emerald|sky|pink|indigo|teal|lime)-\d/);
  });
});

describe("Android back ordering (genre page → full player / overlays)", () => {
  it("closes the topmost layer first and falls through only when it declines", () => {
    const log: string[] = [];
    const offGenre = pushBackHandler(() => { log.push("genre"); });
    const offOverlay = pushBackHandler(() => { log.push("overlay"); return true; });
    expect(runTopBackHandler()).toBe(true);
    expect(log).toEqual(["overlay"]);          // menu opened over the genre page closes first
    offOverlay();
    expect(runTopBackHandler()).toBe(true);
    expect(log).toEqual(["overlay", "genre"]); // then the genre page
    offGenre();
    expect(runTopBackHandler()).toBe(false);   // nothing left → app navigation proceeds
  });
  it("a handler that returns false lets Back fall through to the layer beneath", () => {
    const log: string[] = [];
    const a = pushBackHandler(() => { log.push("page"); });
    const b = pushBackHandler(() => false);
    expect(runTopBackHandler()).toBe(true);
    expect(log).toEqual(["page"]);
    a(); b();
  });
});
