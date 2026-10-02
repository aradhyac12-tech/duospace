/**
 * The canonical AI-insight contract. Every future relationship-AI output
 * must be shaped like this — see .ai/AI_OUTPUT_CONTRACT.md for the full
 * reasoning (confidence ceilings per signal type, the "never state a
 * conclusion the evidence tier doesn't support" rule).
 *
 * This file defines the SHAPE only. No model, no inference logic — this
 * phase builds the contract and its guardrails, not the intelligence
 * that will eventually fill them in (see the feature freeze in
 * .ai/DO_NOT_BUILD.md).
 */

import type { DataClassification, ProcessingLocation } from "../privacy/dataClassification";

export const InsightConfidence = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;
export type InsightConfidence = (typeof InsightConfidence)[keyof typeof InsightConfidence];

/**
 * Where an insight's content actually came from. See .ai/RELATIONSHIP_MEMORY_SPEC.md
 * — an AI-derived conclusion must never be presented, stored, or queried
 * as if it were USER_REPORTED. This is the field that prevents that.
 */
export const InsightSource = {
  USER_REPORTED: "USER_REPORTED", // the user directly stated this
  USER_ENTERED: "USER_ENTERED", // the user filled in a structured field (e.g. a values-comparison answer)
  LOCAL_MODEL: "LOCAL_MODEL", // an on-device model produced this
  LOCAL_RULE: "LOCAL_RULE", // a deterministic on-device rule produced this (no ML)
  SHARED_COUPLE_DATA: "SHARED_COUPLE_DATA", // derived from data both partners already share
  CLOUD_MODEL: "CLOUD_MODEL", // a cloud-hosted model produced this — requires CLOUD_AI_PROCESSING consent, see privacyGate.ts
} as const;
export type InsightSource = (typeof InsightSource)[keyof typeof InsightSource];

export const InsightLifecycle = {
  TEMPORARY: "TEMPORARY", // expires automatically, never graduates to ACTIVE on its own
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  CORRECTED: "CORRECTED", // user has disputed/amended it — original is retained, see AIInsight.correction
  DELETED: "DELETED", // soft-deleted; see ../ai/deleteInsight (future work) for hard deletion
} as const;
export type InsightLifecycle = (typeof InsightLifecycle)[keyof typeof InsightLifecycle];

export const SharingState = {
  PRIVATE: "PRIVATE",
  SHARE_PENDING: "SHARE_PENDING",
  SHARED: "SHARED",
  REVOKED: "REVOKED",
} as const;
export type SharingState = (typeof SharingState)[keyof typeof SharingState];

export interface InsightCorrection {
  /**
   * What the user said about the original observation.
   * Phase 2A (relationship reflection) added PARTLY_ACCURATE and NOT_RELEVANT so
   * the four user-facing choices map 1:1: accurate=CORRECT, partly accurate=
   * PARTLY_ACCURATE, not accurate=NOT_ACCURATE, not relevant any more=NOT_RELEVANT.
   * ADD_CONTEXT is kept for records written before Phase 2A.
   */
  verdict: "NOT_ACCURATE" | "CORRECT" | "ADD_CONTEXT" | "PARTLY_ACCURATE" | "NOT_RELEVANT";
  note?: string;
  correctedAt: string;
}

/**
 * Which relationship-reflection analysis produced an insight (Phase 2A).
 * Additive + optional: insights from other features simply omit it.
 */
export const RelationshipAnalysisKind = {
  VALUES: "VALUES",
  EXPECTATIONS: "EXPECTATIONS",
  COMMUNICATION_REFLECTION: "COMMUNICATION_REFLECTION",
} as const;
export type RelationshipAnalysisKind = (typeof RelationshipAnalysisKind)[keyof typeof RelationshipAnalysisKind];

/**
 * The full contract. Every field here has a reason — see
 * .ai/AI_OUTPUT_CONTRACT.md for the field-by-field rationale. Nothing in
 * this codebase currently produces one of these (feature freeze) — this
 * is the target shape for the first real feature that will.
 */
export interface AIInsight {
  id: string;
  feature: string; // matches a ConsentFeature value, e.g. "MOOD_PROCESSING"
  userId: string;
  createdAt: string;

  /** What was actually observed — specific, falsifiable, described in terms of what was reported, not a labeled conclusion. */
  observation: string;
  confidence: InsightConfidence;
  /** What is unknown or could flip the interpretation. */
  uncertainty: string;
  /** What context could alter the interpretation (mood, external stress, timezone, a bad day). */
  context?: string;
  /** At least two, including a mundane/non-relationship one. */
  possibleExplanations: string[];
  /** A constructive, optional next step for the *user* — never framed as what their partner should do. */
  suggestedAction?: string;
  /**
   * Phase 2A (additive, optional). Concise, human-readable pointers to WHICH of
   * the user's own inputs led to this observation ("Your answers in
   * Communication"). Never chain-of-thought, never the input text itself.
   * Required (non-empty) for RELATIONSHIP_INSIGHTS by the safety validator.
   */
  evidence?: string[];
  /** Phase 2A (additive, optional). Which relationship analysis produced this. */
  analysisKind?: RelationshipAnalysisKind;

  source: InsightSource;
  modelVersion?: string; // required if source is LOCAL_MODEL or CLOUD_MODEL
  dataClassification: DataClassification;
  processingLocation: ProcessingLocation;
  /** Which consent record (consent.ts's ConsentRecord.id) authorized this — an insight with no consentReference should never have been created. */
  consentReference: string;

  lifecycle: InsightLifecycle;
  expiresAt: string | null;

  correction: InsightCorrection | null;

  sharing: SharingState;
  sharedWithUserId: string | null;
  sharedAt: string | null;
}

/**
 * Minimal fields required to construct a new insight — everything else
 * (id, createdAt, lifecycle defaults) is filled in by createInsight() in
 * a future pass once a real local processor exists to call it. Defined
 * here now so that processor's eventual code has a contract to target.
 */
export type NewAIInsight = Pick<
  AIInsight,
  | "feature"
  | "userId"
  | "observation"
  | "confidence"
  | "uncertainty"
  | "context"
  | "possibleExplanations"
  | "suggestedAction"
  | "evidence"
  | "analysisKind"
  | "source"
  | "modelVersion"
  | "dataClassification"
  | "processingLocation"
  | "consentReference"
  | "expiresAt"
>;
