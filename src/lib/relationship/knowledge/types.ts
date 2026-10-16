/**
 * Phase 4 — Relationship Knowledge & Evidence Engine: shared types.
 *
 *   RESEARCH EVIDENCE → STRUCTURED KNOWLEDGE → EVIDENCE MODEL → DETERMINISTIC
 *   REASONING → SAFETY CONSTRAINTS → OPTIONAL AI LANGUAGE LAYER → OUTPUT
 *
 * Pure types/constants only (no I/O). Erasable TypeScript syntax only.
 */

export const KNOWLEDGE_VERSION = "2026.10.0";
export const RULE_VERSION = "2026.10.0";
export const TAXONOMY_VERSION = "2026.10.0";

// ── evidence ────────────────────────────────────────────────────────────────

/** Where an observation came from. */
export type SourceType = "self_report" | "partner_report" | "observed_pattern" | "inferred";

/**
 * Evidence hierarchy (spec §9). `unconfirmed_partner_report` is the honest
 * name for "A said something about B and B hasn't confirmed it" — it sits
 * between observed patterns and inference and is NOT B's own statement.
 */
export type EvidenceTier =
  | "mutually_confirmed"
  | "explicit_self_report"
  | "confirmed_partner_report"
  | "observed_pattern"
  | "unconfirmed_partner_report"
  | "inferred";

export const TIER_RANK: Readonly<Record<EvidenceTier, number>> = {
  mutually_confirmed: 5,
  explicit_self_report: 4,
  confirmed_partner_report: 3,
  observed_pattern: 2,
  unconfirmed_partner_report: 1,
  inferred: 0,
};

export type ConfirmationStatus = "unconfirmed" | "confirmed" | "disputed" | "withdrawn";
export type Perspective = "A_to_A" | "A_to_B" | "B_to_A" | "B_to_B" | "dyad";
export type Party = "A" | "B" | "DYAD";
export type TemporalScope = "current" | "recent" | "historical" | "habitual";

/** Spec §10. `unknown` is a first-class state, never coerced. */
export type EvidenceState =
  | "known" | "reported" | "confirmed" | "observed" | "inferred" | "unknown" | "contradictory" | "stale";

export type AttrValue = string | boolean | number;

export interface Observation {
  observationId: string;
  relationshipId: string;
  observerUserId: string;
  /** Whose state this describes. null = the dyad itself. */
  subjectUserId: string | null;
  /** Who the statement is directed at (A→B: target is B). */
  targetUserId: string | null;
  constructId: string;
  attributeKey: string;
  value: AttrValue;
  normalizedValue?: string;
  sourceType: SourceType;
  /** Stored tier. deriveTier() recomputes it so a bad row can't self-promote. */
  evidenceTier: EvidenceTier;
  sourceReference?: string;
  confidence: number; // 0..1, engineering parameter — not a research effect size
  explicitness: "explicit" | "implicit";
  temporalScope: TemporalScope;
  perspective: Perspective;
  confirmationStatus: ConfirmationStatus;
  validFrom: string;
  validUntil?: string | null;
  observedAt: string;
  lastConfirmedAt?: string | null;
  expiresAt?: string | null;
  stalenessThresholdDays?: number;
  confidenceHalfLifeDays?: number;
}

export interface Dyad { relationshipId: string; userA: string; userB: string }

/** The resolved, current value of one attribute for one party (or the dyad). */
export interface EffectiveFact {
  party: Party;
  constructId: string;
  attributeKey: string;
  state: EvidenceState;
  value?: AttrValue;
  tier?: EvidenceTier;
  /** Effective confidence after temporal decay, 0..1. */
  confidence: number;
  observationIds: string[];
  /** Why this state was chosen — kept for the explanation trace. */
  reason: string;
  /** Values disagreeing at the same authority (state === contradictory). */
  conflictingValues?: AttrValue[];
  /**
   * What the OTHER partner reported about this party when it differs from this
   * party's own statement. Kept visible, never merged and never treated as true.
   */
  discrepantPartnerReport?: AttrValue;
  /** Age in days of the evidence the state is based on. */
  ageDays?: number;
}

// ── dimensions & states ─────────────────────────────────────────────────────

export const DIMENSIONS = [
  "communication", "conflict", "responsiveness", "relationship_satisfaction", "commitment",
  "support", "boundaries", "trust", "quality_time", "relationship_direction", "safety",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type DimensionState =
  | "aligned" | "different" | "positive_evidence" | "negative_evidence"
  | "mixed" | "unknown" | "insufficient_evidence" | "contradictory";

export type ConfidenceLabel = "unknown" | "low" | "moderate" | "high";
export type EvidenceCertainty = "very_low" | "low" | "moderate" | "high" | "unknown";

export type RelationshipStage =
  | "crush" | "early_relationship" | "committed" | "long_term" | "taking_time_to_decide" | "uncertain" | "separated";
export const ALL_STAGES: readonly RelationshipStage[] = [
  "crush", "early_relationship", "committed", "long_term", "taking_time_to_decide", "uncertain", "separated",
];

// ── safety ──────────────────────────────────────────────────────────────────

export type SafetyState =
  | "none" | "possible_safety_concern" | "reported_safety_concern" | "confirmed_safety_concern" | "urgent_safety_concern";
export const SAFETY_RANK: Readonly<Record<SafetyState, number>> = {
  none: 0, possible_safety_concern: 1, reported_safety_concern: 2, confirmed_safety_concern: 3, urgent_safety_concern: 4,
};

// ── knowledge ───────────────────────────────────────────────────────────────

export type ReviewStatus =
  | "discovered" | "metadata_verified" | "under_review" | "evidence_extracted"
  | "quality_assessed" | "approved" | "rejected" | "superseded" | "retracted";

export interface Construct {
  constructId: string;
  canonicalName: string;
  displayName: string;
  definition: string;
  parentConstructId: string | null;
  aliases: string[];
  relatedConstructs: string[];
  opposingOrDistinctConstructs: string[];
  applicableRelationshipStages: RelationshipStage[];
  applicableContexts: string[];
  measurementNotes: string;
  version: string;
  status: "active" | "deprecated" | "proposed";
  /** Engineering default (days) after which a self-report is no longer treated as current. */
  stalenessThresholdDays: number;
}

export interface ResearchSource {
  sourceKey: string;
  sourceType: "journal_article" | "systematic_review" | "meta_analysis" | "book_chapter" | "guideline" | "agency_report" | "instrument_manual" | "other";
  title: string;
  authors: { name: string; orcid?: string }[];
  publication: string | null;
  publicationYear: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  openalexId: string | null;
  semanticScholarId: string | null;
  url: string | null;
  license: string | null;
  /** True only when a human/adapter has matched the identifiers against a registry. */
  identifiersVerified: boolean;
  retractionStatus: "none_known" | "unknown" | "corrected" | "retracted" | "expression_of_concern";
  reviewStatus: ReviewStatus;
  version: number;
  note?: string;
}

export interface CertaintyDimensions {
  study_quality?: string; study_design?: string; sample_size?: string; replication?: string;
  consistency?: string; directness?: string; precision?: string; risk_of_bias?: string;
  publication_bias?: string; population_fit?: string; temporal_evidence?: string;
}

export interface EvidenceClaim {
  claimKey: string;
  constructId: string;
  claimText: string;
  claimType: "definition" | "measurement" | "association" | "longitudinal_association" | "process" | "methodological" | "safety_framework";
  evidenceType: string;
  direction: "positive" | "negative" | "mixed" | "none" | "not_applicable";
  associationType: "cross_sectional" | "longitudinal" | "experimental" | "qualitative" | "psychometric" | "none";
  causalClaim: boolean;
  causalBasis?: string;
  certainty: EvidenceCertainty;
  certaintyDimensions: CertaintyDimensions;
  /** Never set true unless a formal GRADE assessment was actually performed. */
  gradeFormallyAssessed: boolean;
  limitations: string[];
  sourceKeys: string[];
  reviewStatus: ReviewStatus;
  knowledgeVersion: string;
  version: number;
}

// ── rules ───────────────────────────────────────────────────────────────────

export type Op = "eq" | "ne" | "in" | "exists" | "missing";
/** X / Y are role variables: asymmetric rules are tried with (X=A,Y=B) and (X=B,Y=A). */
export type FactParty = Party | "X" | "Y";
export interface FactRef { party: FactParty; construct: string; key: string }
export interface Condition {
  fact: FactRef;
  op: Op;
  value?: AttrValue | AttrValue[];
  /** Compare against another fact instead of a literal (eq/ne only). */
  other?: FactRef;
}

export interface ConfidencePolicy {
  /** Highest confidence this rule may ever emit. */
  cap: ConfidenceLabel;
  /** Minimum tier every referenced fact must have (inferred never satisfies unless allowInferred). */
  minTier: EvidenceTier;
  allowInferred?: boolean;
}

export interface Rule {
  ruleKey: string;
  name: string;
  description: string;
  ruleBasis: "descriptive_comparison" | "evidence_claim" | "safety_policy";
  dimension: Dimension;
  conditions: Condition[];
  requiredEvidence: { distinctParties?: number };
  excludedEvidence: { states?: EvidenceState[] };
  outputState: DimensionState;
  /** Approved templates only; the AI layer may rephrase but never add. */
  statementKey: string;
  confidencePolicy: ConfidencePolicy;
  applicableStages: RelationshipStage[]; // empty = all
  applicableContexts: string[];
  safetyPriority: number;
  claimKeys: string[];
  limitations: string[];
  /** Things this rule must never be read as saying (used by validators). */
  forbiddenInferences: string[];
  version: string;
  status: "draft" | "under_review" | "approved" | "rejected" | "superseded";
}

// ── outputs ─────────────────────────────────────────────────────────────────

export interface InferenceTrace {
  ruleKey: string;
  ruleVersion: string;
  knowledgeVersion: string;
  taxonomyVersion: string;
  observationIds: string[];
  claimKeys: string[];
  sourceKeys: string[];
  inputState: Record<string, string>; // "A:communication.rhythm" → "known:frequent_short"
}

export interface DimensionResult {
  dimension: Dimension;
  state: DimensionState;
  confidence: ConfidenceLabel;
  evidenceSourceType: string;
  perspective: string;
  limitations: string[];
  /** One trace per rule that fired — the answer to "why did DuoSpace say this?". */
  traces: InferenceTrace[];
  statementKeys: string[];
  /** Why the dimension is withheld (never shown to users). */
  suppressedBecause?: string;
}

/** Spec §21 explanation contract. */
export interface Explanation {
  statement: string;
  dimension: Dimension;
  state: DimensionState;
  confidence: ConfidenceLabel;
  evidenceSummary: string;
  evidenceSourceType: string;
  perspective: string;
  limitations: string[];
  timestamp: string;
  knowledgeVersion: string;
  ruleVersion: string;
}

export const ENGINE_NOW = (): string => new Date().toISOString();
