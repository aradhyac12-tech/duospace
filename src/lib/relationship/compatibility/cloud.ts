/**
 * Phase 3M Stage 3 — product wiring between the deterministic engines and the
 * cloud AI gateway. The model only WORDS things; every decision (which
 * dimension to ask, what state a dimension is in) is made here, and any model
 * output that disagrees is discarded in favour of the deterministic path.
 */
import { callAiGateway, type GatewayInvoker } from "@/lib/ai/cloud/gatewayClient";
import { VALUE_QUESTIONS } from "../questions";
import { CATEGORY_LABEL, categoryFromDimension, dimensionId, type ValueCategory } from "../types";
import type { DyadicComparison } from "../dyadic/types";
import { computeCompatibility, type CompatibilityResult } from "./engine";
import { nextAdaptiveStep, type AdaptiveState } from "./adaptive";

type Opts = { language?: string | null; invoker?: GatewayInvoker };
const clip = (s: string | null | undefined, n = 200) => (s ? s.slice(0, n) : null);

export type ExplainOutcome =
  | { ok: true; headline: string; suggestedDiscussion: string | null; basis: "BOTH_PARTNERS" | "ONE_PARTNER"; result: CompatibilityResult }
  | { ok: false; message: string; result: CompatibilityResult };

/** Gateway-shaped dimensions built ONLY from the deterministic result and the owners' own answers. */
export function toGatewayDimensions(result: CompatibilityResult, comparisons: readonly DyadicComparison[]) {
  return result.dimensions.map((d) => {
    const rows = comparisons.filter((c) => c.category === d.category && d.evidenceKeys.includes(c.key));
    const pick = (side: "self" | "partner") => clip(rows.map((r) => r[side]?.statement).filter(Boolean).join("; "));
    const ts = rows.flatMap((r) => [r.self?.provenance.updatedAt, r.partner?.provenance.updatedAt]).filter(Boolean).sort().pop() ?? null;
    return {
      dimension: dimensionId(d.category) as never,
      state: d.state,
      userEvidence: pick("self"), partnerEvidence: pick("partner"),
      alignmentReason: null, differenceReason: null,
      confidence: d.state === "ALIGNED" || d.state === "DIFFERENT" ? "MEDIUM" as const : "LOW" as const,
      uncertainty: null, importance: "UNKNOWN" as const, lastUpdated: ts, nextBestQuestion: null,
    };
  });
}

export async function explainCompatibility(comparisons: readonly DyadicComparison[], o: Opts = {}): Promise<ExplainOutcome> {
  const result = computeCompatibility(comparisons);
  const none = { ok: false as const, message: "Not enough information right now.", result };
  if (result.basis === "NONE") return none;
  const out = await callAiGateway("COMPATIBILITY_EXPLAIN", { dimensions: toGatewayDimensions(result, comparisons), basis: result.basis }, { language: o.language, invoker: o.invoker });
  if (out.ok !== true) return { ...none, message: (out as { message: string }).message };
  const r = out.result;
  // Defence in depth on top of the server guard: the model may not change the deterministic facts.
  const expectedDiff = result.clearestDifference ? dimensionId(result.clearestDifference) : null;
  const discovering = new Set(result.stillDiscovering.map(dimensionId));
  if (r.basis !== result.basis || r.clearestDifference !== expectedDiff || r.stillDiscovering.some((d) => !discovering.has(d))) return none;
  return { ok: true, headline: r.headline, suggestedDiscussion: r.suggestedDiscussion, basis: r.basis, result };
}

export type AdaptiveOutcome =
  | { done: true; reason: "COVERAGE" | "SESSION_LIMIT" | "NOTHING_LEFT" }
  | { done: false; category: ValueCategory; label: string; text: string; source: "CLOUD_AI" | "QUESTION_BANK"; questionId: string | null };

/** One question at a time. Cloud wording is optional; the static bank is always the fallback. */
export async function nextAdaptiveQuestion(state: AdaptiveState, o: Opts = {}): Promise<AdaptiveOutcome> {
  const step = nextAdaptiveStep(state);
  if (step.decision === "ENOUGH_INFORMATION") return { done: true, reason: step.reason };
  const { category } = step;
  const bank = VALUE_QUESTIONS.find((q) => q.category === category) ?? null;
  const fallback: AdaptiveOutcome = { done: false, category, label: CATEGORY_LABEL[category], text: bank?.prompt ?? `Tell us about ${CATEGORY_LABEL[category].toLowerCase()}.`, source: "QUESTION_BANK", questionId: bank?.id ?? null };
  const out = await callAiGateway("ADAPTIVE_QUESTION", {
    unknownDimensions: step.unknownCategories.map(dimensionId) as never,
    askedDimensions: state.asked.map(dimensionId) as never,
  }, { language: o.language, invoker: o.invoker });
  if (out.ok !== true) return fallback;
  const r = out.result;
  const chosen = r.dimension ? categoryFromDimension(r.dimension) : null;
  if (r.decision !== "ASK" || chosen !== category || !r.text) return fallback;
  return { done: false, category, label: CATEGORY_LABEL[category], text: r.text, source: "CLOUD_AI", questionId: null };
}
