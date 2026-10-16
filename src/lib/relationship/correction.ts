/**
 * User correction of a relationship insight (brief §20): accurate / partly
 * accurate / not accurate / not relevant any more. This NEVER retrains or
 * silently edits the model or the provider — there is no model to retrain
 * (LOCAL_RULE). It only records the user's verdict on the insight record
 * itself, using the existing InsightCorrection shape (types.ts), and moves
 * the insight's lifecycle to CORRECTED — the original is retained, never
 * overwritten, per .ai/RELATIONSHIP_MEMORY_SPEC.md's "preserve provenance" rule.
 */
import type { AIInsight, InsightCorrection } from "../ai/types";
import { listLocalInsights, updateLocalInsight } from "../ai/localInsightStore";
import type { InsightBackend } from "../ai/localInsightStore";
import { validateInsight } from "../ai/outputValidator";
import { RelationshipError } from "./errors";
import { validateCorrectionNote } from "./validation";

export type CorrectionVerdict = InsightCorrection["verdict"];

export interface CorrectInsightInput {
  insightId: string;
  verdict: "CORRECT" | "PARTLY_ACCURATE" | "NOT_ACCURATE" | "NOT_RELEVANT";
  note?: string | null;
}

export async function correctInsight(
  userId: string, input: CorrectInsightInput, ctx: { backend: InsightBackend; now: () => Date },
): Promise<AIInsight> {
  const items = await listLocalInsights(userId, ctx.backend, ctx.now());
  const existing = items.find((i) => i.id === input.insightId);
  if (!existing) throw new RelationshipError("NOT_FOUND");
  const note = validateCorrectionNote(input.note);

  const corrected: AIInsight = {
    ...existing,
    lifecycle: "CORRECTED",
    correction: { verdict: input.verdict, note, correctedAt: ctx.now().toISOString() },
  };
  try {
    await updateLocalInsight(userId, corrected, ctx.backend);
  } catch {
    throw new RelationshipError("VALIDATION");
  }
  return corrected;
}
