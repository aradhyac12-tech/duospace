/**
 * Explanation contract (spec §21): every user-facing insight is a structured
 * object. Text comes from approved templates; nothing is free-form.
 */
import { STATEMENTS } from "./statements";
import type { Dimension, DimensionResult, Explanation, InferenceTrace } from "./types";
import type { EngineOutput } from "./engine";
import type { KnowledgeSnapshot } from "./snapshot";

const SUPPRESS_STATES = new Set(["unknown"]);

function evidenceSummary(traces: InferenceTrace[]): string {
  // Structured labels only (e.g. "A:communication_preferences.rhythm = known:frequent_short"); never raw text.
  const parts = new Set<string>();
  for (const t of traces) for (const [k, v] of Object.entries(t.inputState)) parts.add(`${k} = ${v}`);
  return [...parts].sort().join("; ");
}

export function explainDimension(r: DimensionResult, snap: KnowledgeSnapshot, now: Date): Explanation[] {
  if (SUPPRESS_STATES.has(r.state) && r.statementKeys.every((k) => k === "unknown.generic")) return [];
  const keys = r.statementKeys.filter((k) => STATEMENTS[k]);
  return keys.map((key) => ({
    statement: STATEMENTS[key].statement, dimension: r.dimension, state: r.state, confidence: r.confidence,
    evidenceSummary: evidenceSummary(r.traces), evidenceSourceType: r.evidenceSourceType, perspective: r.perspective,
    limitations: r.limitations, timestamp: now.toISOString(), knowledgeVersion: snap.knowledgeVersion, ruleVersion: snap.ruleVersion,
  }));
}

export function explainAll(out: EngineOutput, snap: KnowledgeSnapshot, now: Date): Explanation[] {
  return (Object.keys(out.dimensions) as Dimension[]).flatMap((d) => explainDimension(out.dimensions[d], snap, now));
}

export const optionalDetail = (statementKey: string): string | undefined => STATEMENTS[statementKey]?.detail;
