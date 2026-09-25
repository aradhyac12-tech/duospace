/**
 * Relationship Intelligence V1 (Phase 2A) — domain types.
 *
 * Scope is deliberately narrow: everything here is built from information the
 * user EXPLICITLY typed or selected. Nothing is inferred from messages,
 * calls, sensors or the partner. See docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1.md.
 *
 * These types are pure (no React, no Supabase, no Capacitor) so the whole
 * domain is unit-testable and provider-neutral.
 */
import type { DataClassification } from "../privacy/dataClassification";

// ── Values ────────────────────────────────────────────────────────────────

export const ValueCategory = {
  COMMUNICATION: "COMMUNICATION",
  AFFECTION: "AFFECTION",
  INDEPENDENCE: "INDEPENDENCE",
  TRUST: "TRUST",
  QUALITY_TIME: "QUALITY_TIME",
  PERSONAL_SPACE: "PERSONAL_SPACE",
  CONFLICT_HANDLING: "CONFLICT_HANDLING",
  EMOTIONAL_SUPPORT: "EMOTIONAL_SUPPORT",
  FINANCES: "FINANCES",
  FAMILY: "FAMILY",
  FUTURE_PLANNING: "FUTURE_PLANNING",
  LIFESTYLE: "LIFESTYLE",
  BOUNDARIES: "BOUNDARIES",
  INTIMACY: "INTIMACY",
  PERSONAL_GROWTH: "PERSONAL_GROWTH",
} as const;
export type ValueCategory = (typeof ValueCategory)[keyof typeof ValueCategory];
export const ALL_VALUE_CATEGORIES: readonly ValueCategory[] = Object.values(ValueCategory);

/** Person-readable category names. Never show the enum key raw. */
export const CATEGORY_LABEL: Readonly<Record<ValueCategory, string>> = {
  COMMUNICATION: "Communication",
  AFFECTION: "Affection",
  INDEPENDENCE: "Independence",
  TRUST: "Trust",
  QUALITY_TIME: "Quality time",
  PERSONAL_SPACE: "Personal space",
  CONFLICT_HANDLING: "Handling disagreements",
  EMOTIONAL_SUPPORT: "Emotional support",
  FINANCES: "Finances",
  FAMILY: "Family",
  FUTURE_PLANNING: "Future planning",
  LIFESTYLE: "Lifestyle",
  BOUNDARIES: "Boundaries",
  INTIMACY: "Intimacy",
  PERSONAL_GROWTH: "Personal growth",
};

/**
 * Every question can be answered, marked "not sure", or declined. "Not sure"
 * and "prefer not to answer" are first-class answers, not missing data — and a
 * declined answer never retains a choice or any text.
 */
export const AnswerMode = {
  ANSWERED: "ANSWERED",
  NOT_SURE: "NOT_SURE",
  PREFER_NOT_TO_ANSWER: "PREFER_NOT_TO_ANSWER",
} as const;
export type AnswerMode = (typeof AnswerMode)[keyof typeof AnswerMode];

/** PRIVATE = only on this device. SHARED_WITH_PARTNER = the owner explicitly shared a snapshot (see sharing.ts). */
export const Visibility = {
  PRIVATE: "PRIVATE",
  SHARED_WITH_PARTNER: "SHARED_WITH_PARTNER",
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

export interface ValueQuestionOption {
  id: string;
  label: string;
}
export interface ValueQuestion {
  id: string;
  category: ValueCategory;
  prompt: string;
  options: readonly ValueQuestionOption[];
}

export interface ValueAnswer {
  /** Same as questionId: one answer per question. */
  id: string;
  questionId: string;
  category: ValueCategory;
  mode: AnswerMode;
  choiceId: string | null;
  /** Optional free text. Always null unless mode === ANSWERED. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
  visibility: Visibility;
  /** Server id of the active share snapshot, if visibility === SHARED_WITH_PARTNER. */
  shareId: string | null;
  dataClassification: DataClassification;
}

export interface ValuesRecord {
  version: 1;
  answers: ValueAnswer[];
  /** Categories the user said don't apply to their relationship — not every category is relevant to every couple. */
  skippedCategories: ValueCategory[];
}

// ── Expectations ──────────────────────────────────────────────────────────

/**
 * PREFERENCE  — would like, can reasonably compromise.
 * EXPECTATION — reasonably expects within the relationship.
 * BOUNDARY    — necessary for the user. ONLY ever set by the user's explicit
 *               confirmation; nothing (no answer, no AI output) becomes one.
 */
export const ExpectationType = {
  PREFERENCE: "PREFERENCE",
  EXPECTATION: "EXPECTATION",
  BOUNDARY: "BOUNDARY",
} as const;
export type ExpectationType = (typeof ExpectationType)[keyof typeof ExpectationType];

export const TYPE_LABEL: Readonly<Record<ExpectationType, string>> = {
  PREFERENCE: "Preference",
  EXPECTATION: "Expectation",
  BOUNDARY: "Boundary",
};

export const Importance = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" } as const;
export type Importance = (typeof Importance)[keyof typeof Importance];
export const IMPORTANCE_LABEL: Readonly<Record<Importance, string>> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

/** ACTIVE, or ARCHIVED = "not relevant any more" (kept for the user's own history until they delete it). */
export type ExpectationStatus = "ACTIVE" | "ARCHIVED";

export interface Expectation {
  id: string;
  category: ValueCategory;
  statement: string;
  type: ExpectationType;
  importance: Importance;
  createdAt: string;
  updatedAt: string;
  visibility: Visibility;
  shareId: string | null;
  dataClassification: DataClassification;
  status: ExpectationStatus;
}

// ── Communication reflection ──────────────────────────────────────────────

/** The five prompts. All optional individually; at least one must be filled. */
export interface ReflectionFields {
  whatHappened: string;
  hoped: string;
  felt: string;
  partnerUnderstood: string;
  nextTime: string;
}
export const REFLECTION_FIELD_KEYS: readonly (keyof ReflectionFields)[] = [
  "whatHappened", "hoped", "felt", "partnerUnderstood", "nextTime",
];
export const REFLECTION_PROMPTS: Readonly<Record<keyof ReflectionFields, string>> = {
  whatHappened: "What happened?",
  hoped: "What were you hoping would happen?",
  felt: "What did you feel?",
  partnerUnderstood: "What do you think your partner may have understood?",
  nextTime: "What would you want to communicate differently next time?",
};

/** A reflection the user chose to KEEP on this device. By default nothing is kept — only the insight. Always HIGHLY_SENSITIVE. */
export interface StoredReflection extends ReflectionFields {
  id: string;
  createdAt: string;
  updatedAt: string;
  visibility: "PRIVATE"; // raw reflections can never be shared — there is deliberately no other value
  dataClassification: DataClassification;
}

// ── Sharing ───────────────────────────────────────────────────────────────

export type ShareKind = "VALUE_ANSWER" | "EXPECTATION" | "INSIGHT";

export interface ValueSharePayload {
  v: 1;
  kind: "VALUE_ANSWER";
  questionId: string;
  category: ValueCategory;
  prompt: string;
  mode: "ANSWERED" | "NOT_SURE";
  choiceId: string | null;
  choiceLabel: string | null;
  note?: string;
}
export interface ExpectationSharePayload {
  v: 1;
  kind: "EXPECTATION";
  category: ValueCategory;
  statement: string;
  type: ExpectationType;
  importance: Importance;
}
export interface InsightSharePayload {
  v: 1;
  kind: "INSIGHT";
  observation: string;
  possibleExplanations: string[];
  uncertainty: string;
  suggestedAction?: string;
  /** Honest provenance label, e.g. "Suggested by a simple rule on the sender's device — a guess, not a fact". */
  provenanceLabel: string;
}
export type SharePayload = ValueSharePayload | ExpectationSharePayload | InsightSharePayload;

/** What the owner sees BEFORE sharing: exactly the payload that will be sent, plus a hash binding the two together. */
export interface SharePreview {
  kind: ShareKind;
  itemRef: string;
  payload: SharePayload;
  payloadHash: string;
  /** Human-readable lines for the confirmation screen, derived from `payload` only. */
  lines: { label: string; value: string }[];
}

/** A share row as the server returns it (own or received). */
export interface ShareRow {
  id: string;
  ownerId: string;
  recipientId: string;
  kind: ShareKind;
  itemRef: string;
  payload: SharePayload;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
