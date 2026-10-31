/**
 * Phase 3A — dyadic understanding: public entry points.
 * UI → RelationshipAIService.compareWithPartner → buildDyadicView (here).
 */
import type { InsightBackend } from "../../ai/localInsightStore";
import type { Expectation, ShareRow, ValuesRecord } from "../types";
import { compareDyad, partnerItemsFromShares, selfItemsFromExpectations, selfItemsFromValues } from "./compare";
import { explainComparison, type DyadicExplainer, type DyadicIssue } from "./explain";
import type { CorrectionKind, DyadicComparison, DyadicCorrection, DyadicResult } from "./types";

export * from "./types";
export { compareDyad, partnerItemsFromShares, selfItemsFromValues, selfItemsFromExpectations, AMBIGUOUS_OPTION_IDS, STALE_AFTER_DAYS, MAX_GAP_DAYS } from "./compare";
export { ruleExplain, validateDyadicResult, explainComparison, RULE_MODEL_VERSION } from "./explain";
export type { DyadicExplainer, DyadicIssue, DyadicModelDraft } from "./explain";
export { buildResponsivenessSupport } from "./responsiveness";
export type { ResponsivenessSupport, ResponsivenessCheck } from "./responsiveness";

// ── corrections (encrypted on-device, like every other relationship record) ─

export const CORRECTIONS_KEY = "rel_dyadic_corrections_v1";
const CORRECTION_KINDS: CorrectionKind[] = ["NOT_WHAT_I_MEANT", "OUTDATED", "COMPARISON_WRONG", "DONT_SHARE", "ADD_CONTEXT"];

export async function loadCorrections(userId: string, backend: InsightBackend): Promise<DyadicCorrection[]> {
  const raw = await backend.get<DyadicCorrection[]>(userId, CORRECTIONS_KEY);
  return Array.isArray(raw) ? raw.filter((c) => c && typeof c.comparisonKey === "string" && CORRECTION_KINDS.includes(c.kind)) : [];
}

export async function addCorrection(
  userId: string, backend: InsightBackend, input: { comparisonKey: string; kind: CorrectionKind; note?: string | null }, now: Date,
): Promise<DyadicCorrection> {
  if (!CORRECTION_KINDS.includes(input.kind)) throw new Error("invalid correction");
  const note = input.note?.trim().slice(0, 300) || null;
  if (input.kind === "ADD_CONTEXT" && !note) throw new Error("context is required");
  const c: DyadicCorrection = { comparisonKey: input.comparisonKey, kind: input.kind, note, createdAt: now.toISOString() };
  const all = await loadCorrections(userId, backend);
  // Keep the newest 200; the latest correction per key is what applies.
  await backend.set(userId, CORRECTIONS_KEY, [...all, c].slice(-200));
  return c;
}

// ── orchestration ──────────────────────────────────────────────────────────

export interface DyadicViewInput {
  userId: string;
  partnerId: string | null;
  values: ValuesRecord;
  expectations: Expectation[];
  sharedWithMe: ShareRow[];
  corrections: DyadicCorrection[];
  nowMs: number;
  newId: () => string;
  consentReference: string | null;
  model?: DyadicExplainer | null;
}

export interface DyadicView {
  aligned: DyadicResult[];
  different: DyadicResult[];
  unknown: DyadicResult[];
  comparisons: DyadicComparison[];
  usedModel: boolean;
  modelRejections: DyadicIssue[];
}

export async function buildDyadicView(i: DyadicViewInput): Promise<DyadicView> {
  const self = [...selfItemsFromValues(i.values), ...selfItemsFromExpectations(i.expectations)];
  const partner = partnerItemsFromShares(i.sharedWithMe, i.userId, i.partnerId, i.nowMs);
  // Only areas where the partner shared something, or you answered and they haven't — never a
  // list of every unanswered question in the catalogue.
  const comparisons = compareDyad(self, partner, i.corrections, i.nowMs)
    .filter((c) => c.partner || (c.self && c.self.state !== "DECLINED"));
  const ctx = { nowMs: i.nowMs, newId: i.newId, consentReference: i.consentReference };
  const view: DyadicView = { aligned: [], different: [], unknown: [], comparisons, usedModel: false, modelRejections: [] };
  for (const c of comparisons) {
    const o = await explainComparison(c, ctx, i.model);
    view.usedModel ||= o.usedModel;
    view.modelRejections.push(...o.rejectedModelIssues);
    (o.result.status === "ALIGNED" ? view.aligned : o.result.status === "DIFFERENT" ? view.different : view.unknown).push(o.result);
  }
  return view;
}
