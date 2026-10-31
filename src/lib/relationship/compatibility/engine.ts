/**
 * Phase 3M Stage 2 — deterministic compatibility engine.
 *
 * Extends the existing dyadic comparison (compare.ts); it does not replace it.
 * Input is the per-question DyadicComparison list. Output is one state per
 * dimension: ALIGNED / DIFFERENT / DISCOVERING / INSUFFICIENT_DATA.
 *
 * Hard rules: no score, no percentage, no ranking. DIFFERENT never means
 * incompatible. The AI may only explain this result (server guard enforces it).
 */
import { ALL_VALUE_CATEGORIES, dimensionId, type ValueCategory } from "../types";
import type { DyadicComparison } from "../dyadic/types";

export type CompatibilityState = "ALIGNED" | "DIFFERENT" | "DISCOVERING" | "INSUFFICIENT_DATA";
export type CompatibilityBasis = "BOTH_PARTNERS" | "ONE_PARTNER" | "NONE";

export interface DimensionResult {
  category: ValueCategory;
  /** Server dimension id (lower-case), matches DIMENSIONS in the AI gateway. */
  dimension: string;
  state: CompatibilityState;
  /** Counts only — never rendered as a score. */
  counts: { aligned: number; different: number; unknown: number };
  /** Question keys that decided the state (evidence for grounding). */
  evidenceKeys: string[];
}

export interface CompatibilityResult {
  basis: CompatibilityBasis;
  dimensions: DimensionResult[];
  /** First DIFFERENT dimension in fixed dimension order (deterministic, not ranked). */
  clearestDifference: ValueCategory | null;
  stillDiscovering: ValueCategory[];
}

const NO_DATA_REASONS = new Set(["SELF_NOT_ANSWERED", "PARTNER_NOT_SHARED"]);

export function computeCompatibility(comparisons: readonly DyadicComparison[]): CompatibilityResult {
  const dimensions: DimensionResult[] = ALL_VALUE_CATEGORIES.map((category) => {
    const rows = comparisons.filter((c) => c.category === category);
    const aligned = rows.filter((r) => r.status === "ALIGNED");
    const different = rows.filter((r) => r.status === "DIFFERENT");
    const unknown = rows.filter((r) => r.status === "UNKNOWN");
    const hasAnyAnswer = rows.some((r) => !(r.status === "UNKNOWN" && r.unknownReason !== null && r.unknownReason === "SELF_NOT_ANSWERED"));
    const onlyNoData = rows.length === 0 || rows.every((r) => r.status === "UNKNOWN" && r.unknownReason !== null && NO_DATA_REASONS.has(r.unknownReason) && r.unknownReason === "SELF_NOT_ANSWERED");
    let state: CompatibilityState;
    if (rows.length === 0 || onlyNoData || !hasAnyAnswer) state = "INSUFFICIENT_DATA";
    else if (different.length > 0) state = "DIFFERENT";
    else if (aligned.length > 0 && unknown.length === 0) state = "ALIGNED";
    else state = "DISCOVERING";
    const decisive = state === "DIFFERENT" ? different : state === "ALIGNED" ? aligned : state === "DISCOVERING" ? [...aligned, ...unknown] : [];
    return {
      category, dimension: dimensionId(category), state,
      counts: { aligned: aligned.length, different: different.length, unknown: unknown.length },
      evidenceKeys: decisive.map((r) => r.key),
    };
  });
  const bothSides = comparisons.some((c) => c.status === "ALIGNED" || c.status === "DIFFERENT" || c.unknownReason === "NOT_SURE" || c.unknownReason === "DECLINED");
  const selfOnly = comparisons.some((c) => c.unknownReason === "PARTNER_NOT_SHARED");
  const basis: CompatibilityBasis = bothSides ? "BOTH_PARTNERS" : selfOnly ? "ONE_PARTNER" : "NONE";
  return {
    basis, dimensions,
    clearestDifference: dimensions.find((d) => d.state === "DIFFERENT")?.category ?? null,
    stillDiscovering: dimensions.filter((d) => d.state === "DISCOVERING" || d.state === "INSUFFICIENT_DATA").map((d) => d.category),
  };
}
