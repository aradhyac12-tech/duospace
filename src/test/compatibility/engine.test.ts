import { describe, it, expect } from "vitest";
import { computeCompatibility } from "@/lib/relationship/compatibility/engine";
import { nextAdaptiveStep } from "@/lib/relationship/compatibility/adaptive";
import { ALL_VALUE_CATEGORIES } from "@/lib/relationship/types";
import type { DyadicComparison } from "@/lib/relationship/dyadic/types";

const cmp = (category: string, status: string, unknownReason: string | null = null, key = `${category}-1`) =>
  ({ key, kind: "VALUE_ANSWER", category, prompt: null, status, unknownReason, self: null, partner: null }) as unknown as DyadicComparison;
const state = (r: ReturnType<typeof computeCompatibility>, c: string) => r.dimensions.find((d) => d.category === c)!.state;

describe("compatibility engine", () => {
  it("has exactly 16 dimensions and no score field", () => {
    expect(ALL_VALUE_CATEGORIES.length).toBe(16);
    const r = computeCompatibility([]);
    expect(r.dimensions.length).toBe(16);
    expect(JSON.stringify(r)).not.toMatch(/score|percent/i);
    expect(r.dimensions.every((d) => d.state === "INSUFFICIENT_DATA")).toBe(true);
    expect(r.basis).toBe("NONE");
  });
  it("aligned / different / discovering", () => {
    const r = computeCompatibility([
      cmp("PACE", "ALIGNED"), cmp("TRUST", "DIFFERENT"), cmp("TRUST", "ALIGNED", null, "t2"),
      cmp("FAMILY", "UNKNOWN", "NOT_SURE"), cmp("FINANCES", "ALIGNED"), cmp("FINANCES", "UNKNOWN", "PARTNER_NOT_SHARED", "f2"),
    ]);
    expect(state(r, "PACE")).toBe("ALIGNED");
    expect(state(r, "TRUST")).toBe("DIFFERENT");
    expect(state(r, "FAMILY")).toBe("DISCOVERING");
    expect(state(r, "FINANCES")).toBe("DISCOVERING");
    expect(r.clearestDifference).toBe("TRUST");
    expect(r.stillDiscovering).toContain("FAMILY");
  });
  it("one partner only is flagged and never ALIGNED/DIFFERENT", () => {
    const r = computeCompatibility([cmp("PACE", "UNKNOWN", "PARTNER_NOT_SHARED")]);
    expect(r.basis).toBe("ONE_PARTNER");
    expect(state(r, "PACE")).toBe("DISCOVERING");
  });
  it("adaptive stops by coverage and by session limit", () => {
    expect(nextAdaptiveStep({ answered: [], asked: [], questionsThisSession: 0 }).decision).toBe("ASK");
    const six = ALL_VALUE_CATEGORIES.slice(0, 6);
    expect(nextAdaptiveStep({ answered: six, asked: six, questionsThisSession: 6 })).toEqual({ decision: "ENOUGH_INFORMATION", reason: "COVERAGE" });
    expect(nextAdaptiveStep({ answered: [], asked: [], questionsThisSession: 8 })).toEqual({ decision: "ENOUGH_INFORMATION", reason: "SESSION_LIMIT" });
  });
});
