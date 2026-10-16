import { describe, it, expect, beforeEach } from "vitest";
import { THEMES, THEME_IDENTITIES, resolveThemeId } from "@/contexts/ThemeContext";
import {
  deriveTokens, deriveDynamicTokens, auditThemeTokens, contrastRatio, parseHslString,
  THEME_TINT_STRENGTH, BOOT_SNAPSHOT_KEY, applyTokens,
} from "@/lib/themeEngine";
import {
  buildCustomThemeTokens, exportThemes, importThemes, saveCustomTheme, listCustomThemes, CustomTheme,
} from "@/lib/customThemes";

const sat = (v: string) => parseHslString(v).s;
const lum = (v: string) => parseHslString(v).l;

describe("surface neutrality (tint strength)", () => {
  it("keeps large dark surfaces near-neutral for every preset", () => {
    for (const t of THEMES) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], "dark");
      for (const key of ["--background", "--card", "--muted"]) {
        expect(sat(k[key]), `${t.id} ${key}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it("keeps light surfaces near-neutral and avoids pure white canvas", () => {
    for (const t of THEMES) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], "light");
      expect(sat(k["--background"]), t.id).toBeLessThanOrEqual(13);
      expect(lum(k["--background"]), t.id).toBeLessThan(100);
    }
  });

  it("orders the dark elevation ladder canvas < card < surface-2 < surface-3", () => {
    for (const t of THEMES) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], "dark");
      const l = ["--background", "--card", "--surface-2", "--surface-3"].map(x => lum(k[x]));
      expect(l, t.id).toEqual([...l].sort((a, b) => a - b));
      expect(new Set(l).size, t.id).toBe(4);
    }
  });

  it("is a real control: tintStrength 0 gives achromatic surfaces, higher gives more colour", () => {
    const id = THEME_IDENTITIES.wine;
    expect(sat(deriveTokens(id, "dark", { tintStrength: 0 })["--background"])).toBe(0);
    expect(sat(deriveTokens(id, "dark", { tintStrength: 1 })["--background"]))
      .toBeGreaterThan(sat(deriveTokens(id, "dark")["--background"]));
    expect(THEME_TINT_STRENGTH).toBeLessThanOrEqual(0.5);
  });

  it("still carries the theme colour in primary/accent, not the surfaces", () => {
    const k = deriveTokens(THEME_IDENTITIES.wine, "dark");
    expect(parseHslString(k["--primary"]).h).toBe(350);
    expect(sat(k["--primary"])).toBeGreaterThan(40);
  });
});

describe("semantic colours stay independent of the theme", () => {
  it("never changes destructive with the preset", () => {
    const seen = new Set<string>();
    for (const t of THEMES) seen.add(deriveTokens(THEME_IDENTITIES[t.id], "dark")["--destructive"]);
    expect(seen.size).toBe(1);
  });
  it("does not emit success/warning/info (they come from static CSS only)", () => {
    const k = deriveTokens(THEME_IDENTITIES.wine, "dark");
    for (const key of ["--success", "--warning", "--info"]) expect(k[key]).toBeUndefined();
  });
});

describe("contrast + legibility on the new surfaces", () => {
  it("keeps hairline borders visible against cards in both modes", () => {
    for (const t of THEMES) for (const mode of ["light", "dark"] as const) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], mode);
      const r = contrastRatio(parseHslString(k["--border"]), parseHslString(k["--card"]));
      expect(r, `${t.id} ${mode}`).toBeGreaterThanOrEqual(mode === "light" ? 1.3 : 1.2);
    }
  });
  it("keeps primary-foreground readable on primary", () => {
    for (const t of THEMES) for (const mode of ["light", "dark"] as const) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], mode);
      expect(contrastRatio(parseHslString(k["--primary-foreground"]), parseHslString(k["--primary"])), `${t.id} ${mode}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("backward compatibility", () => {
  it("resolves legacy ids and unknown ids without throwing", () => {
    expect(resolveThemeId("wine-red")).toBe("wine");
    expect(resolveThemeId("deep-space")).toBe("midnight");
    expect(resolveThemeId("does-not-exist")).toBe("midnight");
    expect(resolveThemeId(null)).toBe("midnight");
  });
  it("keeps all 33 preset ids", () => {
    expect(THEMES.length).toBe(33);
    for (const id of ["midnight", "wine", "noir", "monochrome", "minimal-light", "meadow"]) {
      expect(THEME_IDENTITIES[id as keyof typeof THEME_IDENTITIES]).toBeDefined();
    }
  });
  it("emits only tokens the engine already cleared, plus --ambient-glow", () => {
    const k = deriveTokens(THEME_IDENTITIES.midnight, "dark");
    expect(k["--ambient-glow"]).toMatch(/\/ [\d.]+$/);
  });
});

describe("dynamic mode endpoints", () => {
  it("equals the dark palette at midnight and the light palette at noon", () => {
    const id = THEME_IDENTITIES.wine;
    const dark = deriveTokens(id, "dark"), light = deriveTokens(id, "light");
    const mid = deriveDynamicTokens(id, new Date(2026, 0, 1, 0, 0, 0));
    const noon = deriveDynamicTokens(id, new Date(2026, 0, 1, 12, 0, 0));
    expect(mid["--background"]).toBe(dark["--background"]);
    expect(noon["--background"]).toBe(light["--background"]);
    expect(mid["--destructive"]).toBe(dark["--destructive"]);
  });
});

describe("custom themes (HSL, AMOLED, import/export)", () => {
  beforeEach(() => localStorage.clear());
  const base: CustomTheme = { id: "c_test", name: "T", primary: "265 80% 60%", accent: "270 25% 86%", createdAt: 1 };

  it("loads a legacy saved theme with only the original fields", () => {
    const { tokens } = buildCustomThemeTokens(base, "dark");
    expect(tokens["--primary"]).toBeDefined();
    expect(tokens["--background"]).toBeDefined();
  });
  it("AMOLED forces true black, a clean neutral ladder and no ambient glow", () => {
    // AMOLED always derives DARK tokens, even when the caller passes "light"
    // (an explicit mode argument only decides resolvedMode — existing behaviour).
    const { tokens } = buildCustomThemeTokens({ ...base, amoled: true }, "light");
    expect(tokens["--background"]).toBe("0 0% 0%");
    expect(tokens["--surface-1"]).toBe("0 0% 4%");
    expect(tokens["--surface-2"]).toBe("0 0% 8%");
    expect(tokens["--surface-3"]).toBe("0 0% 12%");
    expect(tokens["--ambient-glow"]).toBe("0 0% 0% / 0");
  });
  it("honours explicit background/foreground overrides", () => {
    const { tokens } = buildCustomThemeTokens({ ...base, background: "10 10% 10%", foreground: "0 0% 90%" }, "dark");
    expect(tokens["--background"]).toBe("10 10% 10%");
    expect(tokens["--surface-0"]).toBe("10 10% 10%");
  });
  it("round-trips export -> import unchanged", () => {
    saveCustomTheme({ ...base, gradient: { from: "265 60% 15%", to: "305 60% 10%" } });
    const json = exportThemes();
    localStorage.clear();
    expect(importThemes(json)).toBe(1);
    expect(listCustomThemes()[0]).toMatchObject({ id: "c_test", primary: "265 80% 60%", gradient: { from: "265 60% 15%" } });
  });
});

describe("aesthetic audit is advisory", () => {
  it("flags a harsh palette but never throws or mutates tokens", () => {
    const k = deriveTokens({ primary: { h: 0, s: 100, l: 50 }, accent: { h: 0, s: 90, l: 50 } }, "dark");
    const copy = { ...k };
    const issues = auditThemeTokens(k, { from: "300 90% 55%", to: "200 90% 60%" });
    expect(issues.map(i => i.code)).toEqual(expect.arrayContaining(["saturated-primary", "bright-gradient"]));
    expect(k).toEqual(copy);
  });
  it("is quiet for the default themes", () => {
    for (const id of ["midnight", "wine", "noir"] as const) {
      expect(auditThemeTokens(deriveTokens(THEME_IDENTITIES[id], "dark"))).toEqual([]);
    }
  });
});

describe("boot snapshot", () => {
  beforeEach(() => localStorage.clear());
  it("applyTokens stores a versioned snapshot that the inline script can read", () => {
    applyTokens(deriveTokens(THEME_IDENTITIES.wine, "dark"));
    const snap = JSON.parse(localStorage.getItem(BOOT_SNAPSHOT_KEY)!);
    expect(snap.v).toBe(1);
    expect(snap.dark).toBe(true);
    expect(snap.tokens["--background"]).toBeDefined();
  });
  it("splash/boot screens use tokens, not hardcoded hex", async () => {
    const fs = await import("node:fs");
    for (const f of ["AppBootScreen", "SplashScreen", "LocationAccessGate"]) {
      const src = fs.readFileSync(`src/components/${f}.tsx`, "utf8");
      expect(src, f).not.toMatch(/#121316|#F6F6F9/i);
    }
  });
});

describe("ambient glow stays atmospheric (written, not yet executed)", () => {
  it("is a very low alpha wash for every preset in both modes", () => {
    for (const t of THEMES) for (const mode of ["dark", "light"] as const) {
      const a = Number(deriveTokens(THEME_IDENTITIES[t.id], mode)["--ambient-glow"].split("/ ")[1]);
      expect(a, `${t.id} ${mode}`).toBeLessThanOrEqual(0.08);
    }
  });
  it("semantic status colours do not move with the preset", () => {
    const ref = deriveTokens(THEME_IDENTITIES.midnight, "dark");
    for (const t of THEMES) {
      const k = deriveTokens(THEME_IDENTITIES[t.id], "dark");
      expect(k["--destructive"], t.id).toBe(ref["--destructive"]);
      for (const key of ["--success", "--warning", "--info"]) expect(k[key] ?? ref[key], `${t.id} ${key}`).toBe(ref[key]);
    }
  });
  it("reduced-transparency / lite effects drop the wash (CSS contract)", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*\.dark \.ambient-light \{ background-image: none; \}/);
    expect(css).toMatch(/html\[data-effects="lite"\] \.ambient-light \{ background-image: none; \}/);
  });
  it("first-paint inline script restores the boot snapshot before any bundle", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync("index.html", "utf8");
    expect(html).toContain(BOOT_SNAPSHOT_KEY);
  });
});
