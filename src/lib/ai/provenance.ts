/**
 * Provenance rules for AI-derived statements — PURE (types only).
 *
 * The rule this file exists to enforce: an AI-derived statement is never
 * stored, shown or shared as if the user had said it. Two halves:
 *
 *  - checkAIProvenance(): what an insight PRODUCED BY A PROCESSOR must look
 *    like (a model/rule source, produced on-device, classed HIGHLY_SENSITIVE,
 *    traceable to a consent). A processor result claiming USER_REPORTED or
 *    USER_ENTERED is rejected.
 *  - describeProvenance(): the honest, user-facing label for each source, so
 *    any UI that renders an insight has one place to get "this was a guess by
 *    a model on your phone" instead of inventing its own wording.
 */
import { InsightSource, type NewAIInsight } from "./types";
import { DataClassification, ProcessingLocation } from "../privacy/dataClassification";

export interface ProvenanceIssue {
  field: string;
  message: string;
}

/** Sources a processor is allowed to emit. Everything else is a person's own statement or data. */
export const AI_DERIVED_SOURCES: readonly InsightSource[] = [
  InsightSource.LOCAL_MODEL,
  InsightSource.LOCAL_RULE,
  InsightSource.CLOUD_MODEL,
];

export function isAIDerived(source: InsightSource): boolean {
  return AI_DERIVED_SOURCES.includes(source);
}

export interface ProvenanceExpectations {
  /** The feature the processor declared; the insight must carry the same one. */
  feature: string;
  /** Local processors may only run on-device; cloud processors are a separate, consent-gated path. */
  allowedLocations: readonly ProcessingLocation[];
  allowedSources: readonly InsightSource[];
}

export const LOCAL_PROCESSOR_EXPECTATIONS = (feature: string): ProvenanceExpectations => ({
  feature,
  allowedLocations: [ProcessingLocation.DEVICE],
  allowedSources: [InsightSource.LOCAL_MODEL, InsightSource.LOCAL_RULE],
});

export function checkAIProvenance(draft: NewAIInsight, expect: ProvenanceExpectations): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  if (!expect.allowedSources.includes(draft.source)) {
    issues.push({
      field: "source",
      message: `A processor result may not claim source "${draft.source}" — AI output must never be labelled as something the user reported or entered.`,
    });
  }
  if (!expect.allowedLocations.includes(draft.processingLocation)) {
    issues.push({ field: "processingLocation", message: `Processing location "${draft.processingLocation}" is not allowed for this processor.` });
  }
  if (draft.dataClassification !== DataClassification.HIGHLY_SENSITIVE) {
    issues.push({ field: "dataClassification", message: "AI-derived relationship observations must be classified HIGHLY_SENSITIVE." });
  }
  if (draft.feature !== expect.feature) {
    issues.push({ field: "feature", message: `Insight feature "${draft.feature}" does not match the processor's declared feature "${expect.feature}".` });
  }
  if (!draft.consentReference) {
    issues.push({ field: "consentReference", message: "consentReference is required." });
  }
  if (draft.expiresAt !== null && draft.expiresAt !== undefined && Number.isNaN(Date.parse(draft.expiresAt))) {
    issues.push({ field: "expiresAt", message: "expiresAt must be null or a valid ISO date." });
  }
  return issues;
}

/** Honest user-facing label per source. */
export function describeProvenance(source: InsightSource): { label: string; isUserStatement: boolean } {
  switch (source) {
    case InsightSource.USER_REPORTED:
      return { label: "You told us this", isUserStatement: true };
    case InsightSource.USER_ENTERED:
      return { label: "From an answer you entered", isUserStatement: true };
    case InsightSource.SHARED_COUPLE_DATA:
      return { label: "Based on information you both already share", isUserStatement: false };
    case InsightSource.LOCAL_RULE:
      return { label: "Suggested by a simple rule on your device — a guess, not a fact", isUserStatement: false };
    case InsightSource.LOCAL_MODEL:
      return { label: "Estimated by a model on your device — a guess, not a fact", isUserStatement: false };
    case InsightSource.CLOUD_MODEL:
      return { label: "Estimated by a cloud model you allowed — a guess, not a fact", isUserStatement: false };
    default:
      // Unknown provenance is never presented as the user's own words.
      return { label: "Automatically generated — a guess, not a fact", isUserStatement: false };
  }
}
