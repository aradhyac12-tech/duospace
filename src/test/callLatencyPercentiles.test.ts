import { describe, it, expect } from "vitest";
import { computeLatencyPercentiles } from "@/lib/callLatencyPercentiles";

describe("computeLatencyPercentiles", () => {
  it("returns all-null for an empty batch", () => {
    const result = computeLatencyPercentiles([]);
    expect(result).toEqual({ p50: null, p75: null, p90: null, p95: null, sampleSize: 0 });
  });

  it("computes percentiles over a simple ascending batch", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const result = computeLatencyPercentiles(values);
    expect(result.sampleSize).toBe(100);
    expect(result.p50).toBe(50);
    expect(result.p90).toBe(90);
    expect(result.p95).toBe(95);
  });

  it("ignores non-finite values", () => {
    const result = computeLatencyPercentiles([100, NaN, 200, Infinity, 300]);
    expect(result.sampleSize).toBe(3);
  });

  it("handles a single-value batch", () => {
    const result = computeLatencyPercentiles([500]);
    expect(result).toEqual({ p50: 500, p75: 500, p90: 500, p95: 500, sampleSize: 1 });
  });
});
