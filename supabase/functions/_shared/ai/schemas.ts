/**
 * Canonical structured-output schemas (Zod). Every semantic model call is
 * validated against one of these; prose is never parsed into a result.
 *
 * Design rules:
 *  - No optional fields: absent values are explicit `null`, so the same shape
 *    works for OpenAI strict mode and Gemini responseSchema.
 *  - `.strict()` everywhere: unknown keys (e.g. a hallucinated `score`) make the
 *    whole output invalid. Nothing is silently coerced.
 *  - There is NO numeric compatibility field anywhere. Not a score, not a
 *    percentage, not a grade. Numbers that exist are counts/caps only.
 *  - Evidence fields hold short quotes/references, never reasoning traces.
 */
import { z } from "zod";

export const DIMENSIONS = [
  "communication", "relationship_direction", "pace", "affection", "independence", "boundaries",
  "trust", "conflict", "support", "quality_time", "lifestyle", "finances", "family",
  "future_planning", "intimacy", "personal_growth",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DimensionSchema = z.enum(DIMENSIONS);

export const RELATIONSHIP_STAGES = ["CRUSH", "GETTING_TO_KNOW", "EARLY_DATING", "COMMITTED", "LONG_TERM", "ENGAGED_OR_PLANNING", "UNKNOWN"] as const;
export const RelationshipStageSchema = z.enum(RELATIONSHIP_STAGES);
export type RelationshipStage = z.infer<typeof RelationshipStageSchema>;

export const COMPAT_STATES = ["ALIGNED", "DIFFERENT", "DISCOVERING", "INSUFFICIENT_DATA"] as const;
export const CompatStateSchema = z.enum(COMPAT_STATES);
export type CompatState = z.infer<typeof CompatStateSchema>;

export const ConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const SCRIPTS = ["latin", "devanagari", "bengali", "gurmukhi", "gujarati", "odia", "tamil", "telugu", "kannada", "malayalam", "mixed", "other"] as const;

export const LanguageInfoSchema = z.object({
  code: z.string().min(2).max(12),
  script: z.enum(SCRIPTS),
  codeMixed: z.boolean(),
}).strict();

const short = (n: number) => z.string().max(n);

// ── MessageUnderstanding ─────────────────────────────────────────────────
export const MESSAGE_INTENTS = ["REQUEST", "QUESTION", "UNCERTAINTY", "BOUNDARY", "FEELING_EXPRESSED", "APOLOGY", "ACKNOWLEDGEMENT", "EVENT", "CONFLICT_TOPIC", "OTHER"] as const;
export const MessageUnderstandingSchema = z.object({
  language: LanguageInfoSchema,
  /** ONE sentence, what the sender said — attributed, never a hidden motive. */
  summary: short(200),
  intent: z.enum(MESSAGE_INTENTS),
  /** Exact phrases from the message that support `summary`. */
  evidence: z.array(short(140)).max(3),
  /** Optional one-line "why", same evidence only. */
  why: short(220).nullable(),
  offerReply: z.boolean(),
  /** true when the message is too short/ambiguous to read reliably. */
  cannotTell: z.boolean(),
  confidence: ConfidenceSchema,
}).strict();

// ── ReplySuggestion ──────────────────────────────────────────────────────
export const REPLY_MODES = ["normal", "softer", "casual", "shorter", "ask_first"] as const;
export const ReplySuggestionSchema = z.object({
  suggestions: z.array(z.object({
    text: short(320),
    mode: z.enum(REPLY_MODES),
    /** Which part of the supplied context this reply responds to. */
    respondsTo: short(160),
  }).strict()).max(3),
  insufficientContext: z.boolean(),
}).strict();

// ── RelationshipFact ─────────────────────────────────────────────────────
export const FACT_SUBJECTS = ["USER", "PARTNER", "BOTH", "UNKNOWN"] as const;
export const FACT_CATEGORIES = [...DIMENSIONS, "relationship_stage", "relationship_duration", "user_goal", "other"] as const;

/** What a MODEL may propose. It cannot set ids, sources, consent or timestamps. */
export const FactDraftSchema = z.object({
  category: z.enum(FACT_CATEGORIES),
  subject: z.enum(FACT_SUBJECTS),
  value: short(200),
  /** Must be an exact substring of the text the user supplied. Checked server-side. */
  exactEvidence: short(240),
  /** false = the model is inferring; such drafts never become strong facts. */
  isExplicit: z.boolean(),
  /** true if the speaker hedged ("maybe", "I think", "not sure"). Caps confidence. */
  hedged: z.boolean(),
  language: LanguageInfoSchema,
}).strict();
export const FactExtractionSchema = z.object({ facts: z.array(FactDraftSchema).max(12) }).strict();

export const FACT_SOURCE_TYPES = ["USER_EXPLICIT", "PARTNER_SHARED_EXPLICIT", "CHAT_EXPLICIT", "USER_CONFIRMED_MEMORY", "AI_INFERENCE"] as const;
/** Canonical stored fact. Built by the server/engine (facts.ts), never by a model. */
export const RelationshipFactSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(FACT_CATEGORIES),
  subject: z.enum(FACT_SUBJECTS),
  value: short(200),
  sourceType: z.enum(FACT_SOURCE_TYPES),
  sourceId: z.string().max(64).nullable(),
  exactEvidence: short(240),
  confidence: ConfidenceSchema,
  observedAt: z.string().max(40),
  lastConfirmedAt: z.string().max(40).nullable(),
  expiresAt: z.string().max(40).nullable(),
  language: z.string().max(12),
  script: z.enum(SCRIPTS),
  isExplicit: z.boolean(),
  isUserProvided: z.boolean(),
  isInferred: z.boolean(),
  consentReference: z.string().max(64).nullable(),
}).strict();
export type RelationshipFact = z.infer<typeof RelationshipFactSchema>;
export type FactDraft = z.infer<typeof FactDraftSchema>;

// ── AdaptiveQuestion (phrasing only; selection is deterministic, Stage 2) ─
export const AdaptiveQuestionSchema = z.object({
  decision: z.enum(["ASK", "ENOUGH_INFORMATION"]),
  dimension: DimensionSchema.nullable(),
  text: short(240).nullable(),
}).strict();

// ── Compatibility ────────────────────────────────────────────────────────
export const IMPORTANCE = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
/** Produced by the DETERMINISTIC engine (Stage 2); the model only explains it. */
export const CompatibilityDimensionSchema = z.object({
  dimension: DimensionSchema,
  state: CompatStateSchema,
  userEvidence: short(200).nullable(),
  partnerEvidence: short(200).nullable(),
  alignmentReason: short(200).nullable(),
  differenceReason: short(200).nullable(),
  confidence: ConfidenceSchema,
  uncertainty: short(200).nullable(),
  importance: z.enum(IMPORTANCE),
  lastUpdated: short(40).nullable(),
  nextBestQuestion: short(240).nullable(),
}).strict();
export type CompatibilityDimension = z.infer<typeof CompatibilityDimensionSchema>;

export const CompatibilityAnalysisSchema = z.object({
  /** Natural-language explanation of the deterministic result. No numbers. */
  headline: short(240),
  clearestDifference: DimensionSchema.nullable(),
  stillDiscovering: z.array(DimensionSchema).max(8),
  suggestedDiscussion: short(200).nullable(),
  /** ONE_SIDE → UI must say "Based on what you've shared". */
  basis: z.enum(["BOTH_PARTNERS", "ONE_PARTNER"]),
}).strict();

// ── Today / Memory / Conflict / Longitudinal / Normalize ─────────────────
export const TodayInsightSchema = z.object({
  hasInsight: z.boolean(),
  kind: z.enum(["NONE", "CLARIFY", "ALIGNED_PLAN", "NOT_DISCUSSED", "OBSERVATION"]),
  text: short(160).nullable(),
}).strict();

export const MemorySuggestionSchema = z.object({
  shouldSuggest: z.boolean(),
  text: short(200).nullable(),
  category: z.enum(["PREFERENCE", "BOUNDARY", "NEED", "AGREEMENT", "RECURRING_TOPIC"]).nullable(),
  evidence: short(200).nullable(),
  sensitive: z.boolean(),
}).strict();

export const ConflictAnalysisSchema = z.object({
  topic: short(120).nullable(),
  statements: z.array(z.object({ who: z.enum(["USER", "PARTNER"]), statement: short(200), evidence: short(140) }).strict()).max(4),
  unknowns: z.array(short(160)).max(3),
  repairStep: short(240).nullable(),
  possibleHarm: z.boolean(),
}).strict();

export const LongitudinalInsightSchema = z.object({
  headline: short(240),
  changes: z.array(z.object({ topic: short(80), statement: short(200), evidence: short(140) }).strict()).max(4),
  staleAreas: z.array(DimensionSchema).max(8),
}).strict();

export const NormalizedLanguageSchema = z.object({
  language: LanguageInfoSchema,
  semantic: short(320),
}).strict();

import type { AiTask } from "./tasks.ts";
export const TASK_SCHEMA = {
  UNDERSTAND: MessageUnderstandingSchema,
  QUICK_REPLY: ReplySuggestionSchema,
  TODAY: TodayInsightSchema,
  FACT_EXTRACTION: FactExtractionSchema,
  ADAPTIVE_QUESTION: AdaptiveQuestionSchema,
  MEMORY_SUGGESTION: MemorySuggestionSchema,
  COMPATIBILITY_EXPLAIN: CompatibilityAnalysisSchema,
  COMPATIBILITY_DEEP: CompatibilityAnalysisSchema,
  LONGITUDINAL_ANALYSIS: LongitudinalInsightSchema,
  COMPLEX_CONFLICT: ConflictAnalysisSchema,
  NORMALIZE_LANGUAGE: NormalizedLanguageSchema,
} as const satisfies Record<AiTask, z.ZodTypeAny>;
export type TaskOutput<T extends AiTask> = z.infer<(typeof TASK_SCHEMA)[T]>;
