import { describe, it, expect } from "vitest";
import { THEMES, THEME_CATEGORIES, THEME_IDENTITIES } from "@/contexts/ThemeContext";
import { WALLPAPERS } from "@/lib/wallpapers";
import { deriveTokens, contrastRatio, parseHslString } from "@/lib/themeEngine";

// Guards the theme picker's catalog: every preset must be selectable, grouped
// into exactly one category, and readable in BOTH modes — themeEngine's
// header claims 4.5:1 on every text/background pair, so new presets must hold
// that line too.
describe("theme catalog", () => {
  it("lists every identity exactly once", () => {
    const ids = THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(THEME_IDENTITIES).sort());
  });

  it("puts every theme in a known category", () => {
    const known = new Set(THEME_CATEGORIES.map(c => c.id));
    for (const t of THEMES) expect(known.has(t.category)).toBe(true);
    // No empty filter chips.
    for (const c of THEME_CATEGORIES) {
      expect(THEMES.some(t => t.category === c.id)).toBe(true);
    }
  });

  it("clears 4.5:1 on every text pair in light and dark", () => {
    const pairs: Array<[string, string]> = [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--primary-foreground", "--primary"],
      ["--secondary-foreground", "--secondary"],
      ["--muted-foreground", "--muted"],
      ["--accent-foreground", "--accent"],
    ];
    for (const t of THEMES) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = deriveTokens(THEME_IDENTITIES[t.id], mode);
        for (const [fg, bg] of pairs) {
          const ratio = contrastRatio(parseHslString(tokens[fg]), parseHslString(tokens[bg]));
          expect(ratio, `${t.id} ${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("wallpaper catalog", () => {
  it("has unique ids and both a light and dark variant", () => {
    const ids = WALLPAPERS.map(w => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of WALLPAPERS) {
      expect(w.light.length).toBeGreaterThan(0);
      expect(w.dark.length).toBeGreaterThan(0);
    }
  });
});
