/**
 * Phase 3A — structured dyadic data model.
 *
 * Canonical principle: DuoSpace AI facilitates evidence-grounded mutual
 * understanding, responsiveness, constructive communication and repair.
 * It does not judge partners or predict relationship outcomes.
 *
 * Every item carries provenance. Nothing here is inferred: an item exists
 * only because its owner explicitly answered (self) or explicitly shared
 * (partner). There is intentionally NO numeric field anywhere in a result
 * that could be read as a compatibility / health / match score.
 */
import type { ValueCategory } from "../types";

export type PartnerRole = "SELF" | "PARTNER";

/** How the owner answered. NOT_SURE / DECLINED are first-class and always compare as UNKNOWN. */
export type DyadicAnswerState = "ANSWERED" | "NOT_SURE" | "DECLINED";

export type DyadicItemKind = "VALUE_ANSWER" | "EXPECTATION";

export interface DyadicProvenance {
  /** Always explicit self-report — DuoSpace never derives these. */
  source: "user_self_report";
  owner: PartnerRole;
  /** SELF items may be private: they are only ever rendered on the owner's own device. PARTNER items are always shared. */
  sharedWithPartner: boolean;
  /** Share-row id for partner items (the RLS-protected snapshot this came from). */
  shareId: string | null;
  confidence: "explicit";
  createdAt: string;
  /** Last time the owner changed/shared this answer — drives staleness. */
  updatedAt: string;
}

export interface DyadicItem {
  kind: DyadicItemKind;
  /** questionId for values; a per-category key for expectations. */
  key: string;
  category: ValueCategory;
  prompt: string | null;
  state: DyadicAnswerState;
  choiceId: string | null;
  /** The owner's own words / chosen option label — the ONLY text a result may attribute to them. */
  statement: string | null;
  /** Owner-added context ("only on weekdays", …), from corrections. */
  context: string | null;
  provenance: DyadicProvenance;
}

export type ComparisonStatus = "ALIGNED" | "DIFFERENT" | "UNKNOWN";

export type UnknownReason =
  | "SELF_NOT_ANSWERED"
  | "PARTNER_NOT_SHARED"
  | "NOT_SURE"
  | "DECLINED"
  | "AMBIGUOUS_ANSWER"
  | "FREE_TEXT_NOT_COMPARABLE"
  | "MARKED_OUTDATED"
  | "MARKED_WRONG";

export interface StalenessInfo {
  selfUpdatedAt: string | null;
  partnerUpdatedAt: string | null;
  /** Days between the two answers' last updates (null if one side is missing). */
  gapDays: number | null;
  /** True when either answer is old, or the two were given far apart in time. */
  needsClarification: boolean;
}

/** Deterministic output — the single source of truth the AI only explains. */
export interface DyadicComparison {
  key: string;
  kind: DyadicItemKind;
  category: ValueCategory;
  prompt: string | null;
  status: ComparisonStatus;
  unknownReason: UnknownReason | null;
  self: DyadicItem | null;
  partner: DyadicItem | null;
  staleness: StalenessInfo;
}

/** Phase 3A output contract (extends the Phase 2 insight contract's spirit; stored/rendered separately). */
export interface DyadicResult {
  id: string;
  comparisonKey: string;
  area: string;
  status: ComparisonStatus;
  /** OBSERVED — what each person explicitly stated. */
  observation: string;
  selfEvidence: string | null;
  partnerEvidence: string | null;
  /** COMPARISON — what aligns/differs, derived only from the statuses. */
  comparison: string;
  /** POSSIBLE INTERPRETATIONS — hedged, plural, optional. Never presented as true. */
  possibleExplanations: string[];
  /** UNKNOWN — what the system cannot know. Always non-empty. */
  unknowns: string[];
  conversationPrompt: string;
  suggestedAction: string | null;
  /** Qualitative only. Describes support for the OBSERVATION, never the relationship. */
  confidence: "explicit" | "partial";
  uncertainty: string;
  source: "user_self_report";
  modelVersion: string;
  classification: "RELATIONSHIP_SENSITIVE";
  processingLocation: "ON_DEVICE";
  consentReference: string | null;
  createdAt: string;
  expiresAt: string;
  /** Present when the rule layer could not safely explain. */
  insufficientInformation: boolean;
}

export type CorrectionKind =
  | "NOT_WHAT_I_MEANT"
  | "OUTDATED"
  | "COMPARISON_WRONG"
  | "DONT_SHARE"
  | "ADD_CONTEXT";

export interface DyadicCorrection {
  comparisonKey: string;
  kind: CorrectionKind;
  /** Only for ADD_CONTEXT / NOT_WHAT_I_MEANT; the user's own words. */
  note: string | null;
  createdAt: string;
}
