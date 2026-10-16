import { describe, it, expect } from "vitest";
import { pruneOutliers } from "@/lib/enrollmentQuality";

const base = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.37));
const noisy = (amp: number, seed: number) => Float32Array.from(base, (v, i) => v + amp * Math.sin(seed * 31 + i * 1.7));
const other = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.9));

describe("pruneOutliers", () => {
  it("drops a clearly different face but keeps the rest", () => {
    const good = Array.from({ length: 20 }, (_, i) => ({ embedding: noisy(0.02, i), step: ["center", "left", "right", "up", "down"][i % 5] }));
    const withBad = [...good, { embedding: other, step: "center" }];
    const r = pruneOutliers(withBad);
    expect(r.dropped).toBe(1);
    expect(r.kept.length).toBe(20);
  });
  it("keeps everything when the set is consistent", () => {
    const good = Array.from({ length: 20 }, (_, i) => ({ embedding: noisy(0.02, i), step: ["center", "left", "right", "up", "down"][i % 5] }));
    expect(pruneOutliers(good).dropped).toBe(0);
  });
  it("never prunes a pose down to zero samples", () => {
    const good = Array.from({ length: 20 }, (_, i) => ({ embedding: noisy(0.02, i), step: "center" }));
    const r = pruneOutliers([...good, { embedding: other, step: "up" }]);
    expect(r.kept.some((s) => s.step === "up")).toBe(true);
  });
});
