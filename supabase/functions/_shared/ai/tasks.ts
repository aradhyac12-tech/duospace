/**
 * DuoSpace AI gateway — task vocabulary. Pure (no Deno globals, no I/O) so it
 * is unit-testable under vitest and importable as a TYPE by the client.
 */
export const AI_TASKS = [
  "UNDERSTAND",
  "QUICK_REPLY",
  "TODAY",
  "FACT_EXTRACTION",
  "ADAPTIVE_QUESTION",
  "MEMORY_SUGGESTION",
  "COMPATIBILITY_EXPLAIN",
  "COMPATIBILITY_DEEP",
  "LONGITUDINAL_ANALYSIS",
  "COMPLEX_CONFLICT",
  "NORMALIZE_LANGUAGE",
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export type QuotaBucket = "AI_STANDARD" | "AI_DEEP";

/** Model tier a task needs. Tiers map to concrete models ONLY in config.ts. */
export type ModelTier =
  | "STANDARD_HIGH_VOLUME"
  | "STANDARD_REASONING"
  | "DEEP_RELATIONSHIP"
  | "INDIC_SPECIALIST"
  | "SECONDARY_REASONING";

export const TASK_TIER: Readonly<Record<AiTask, ModelTier>> = {
  UNDERSTAND: "STANDARD_REASONING",
  QUICK_REPLY: "STANDARD_HIGH_VOLUME",
  TODAY: "STANDARD_HIGH_VOLUME",
  FACT_EXTRACTION: "STANDARD_HIGH_VOLUME",
  ADAPTIVE_QUESTION: "STANDARD_REASONING",
  MEMORY_SUGGESTION: "STANDARD_HIGH_VOLUME",
  COMPATIBILITY_EXPLAIN: "STANDARD_REASONING",
  COMPATIBILITY_DEEP: "DEEP_RELATIONSHIP",
  LONGITUDINAL_ANALYSIS: "DEEP_RELATIONSHIP",
  COMPLEX_CONFLICT: "DEEP_RELATIONSHIP",
  NORMALIZE_LANGUAGE: "STANDARD_HIGH_VOLUME",
};

/** Deep tasks consume the separate AI_DEEP quota. The client never picks this. */
export const TASK_BUCKET: Readonly<Record<AiTask, QuotaBucket>> = {
  UNDERSTAND: "AI_STANDARD",
  QUICK_REPLY: "AI_STANDARD",
  TODAY: "AI_STANDARD",
  FACT_EXTRACTION: "AI_STANDARD",
  ADAPTIVE_QUESTION: "AI_STANDARD",
  MEMORY_SUGGESTION: "AI_STANDARD",
  COMPATIBILITY_EXPLAIN: "AI_STANDARD",
  COMPATIBILITY_DEEP: "AI_DEEP",
  LONGITUDINAL_ANALYSIS: "AI_DEEP",
  COMPLEX_CONFLICT: "AI_DEEP",
  NORMALIZE_LANGUAGE: "AI_STANDARD",
};

export const isAiTask = (t: unknown): t is AiTask => typeof t === "string" && (AI_TASKS as readonly string[]).includes(t);
