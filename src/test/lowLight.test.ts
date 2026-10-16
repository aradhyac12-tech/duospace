import { describe, it, expect } from "vitest";
import {
  classifyLight, lumaStatsFromRgba, planEnhancement, buildEnhanceLut, applyLut,
} from "@/lib/lowLight";

const flat = (v: number, n = 64) => {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { a[i * 4] = v; a[i * 4 + 1] = v; a[i * 4 + 2] = v; a[i * 4 + 3] = 255; }
  return a;
};

describe("lowLight", () => {
  it("classifies light levels", () => {
    expect(classifyLight(10)).toBe("dark");
    expect(classifyLight(45)).toBe("dim");
    expect(classifyLight(140)).toBe("bright");
  });

  it("leaves bright frames alone", () => {
    expect(planEnhancement(lumaStatsFromRgba(flat(150))).enhance).toBe(false);
  });

  it("brightens a dark frame toward the target mean", () => {
    // A dim gradient: values 5..45
    const px = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) { const v = 5 + Math.floor((i / 255) * 40); px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
    const stats = lumaStatsFromRgba(px);
    const plan = planEnhancement(stats);
    expect(plan.enhance).toBe(true);
    applyLut(px, buildEnhanceLut(plan));
    const after = lumaStatsFromRgba(px);
    expect(after.mean).toBeGreaterThan(stats.mean * 2);
  });

  it("caps amplification so noise isn't blown up", () => {
    const plan = planEnhancement({ mean: 6, lo: 5, hi: 8 });
    expect(plan.gamma).toBeGreaterThan(0.37);
  });

  it("LUT is monotonic and in range", () => {
    const lut = buildEnhanceLut(planEnhancement({ mean: 30, lo: 10, hi: 70 }));
    for (let i = 1; i < 256; i++) expect(lut[i] >= lut[i - 1]).toBe(true);
    expect(lut[255]).toBeLessThan(256);
  });
});
