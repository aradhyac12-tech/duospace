/**
 * Phase 3M Stage 2 — adaptive onboarding: ONE question at a time, with a
 * deterministic stopping rule. The app (not the model) picks the dimension;
 * the gateway task ADAPTIVE_QUESTION only words the question.
 */
import { ALL_VALUE_CATEGORIES, type ValueCategory } from "../types";

export const MIN_DIMENSIONS_COVERED = 6;   // stop once this many dimensions have an answer...
export const MAX_QUESTIONS_PER_SESSION = 8; // ...or after this many questions, whichever is first.

export interface AdaptiveState {
  /** Dimensions with at least one answered question. */
  answered: readonly ValueCategory[];
  /** Dimensions already asked this session (answered, not sure or declined). */
  asked: readonly ValueCategory[];
  questionsThisSession: number;
}

export type AdaptiveDecision =
  | { decision: "ASK"; category: ValueCategory; unknownCategories: ValueCategory[] }
  | { decision: "ENOUGH_INFORMATION"; reason: "COVERAGE" | "SESSION_LIMIT" | "NOTHING_LEFT" };

export function nextAdaptiveStep(s: AdaptiveState): AdaptiveDecision {
  if (s.questionsThisSession >= MAX_QUESTIONS_PER_SESSION) return { decision: "ENOUGH_INFORMATION", reason: "SESSION_LIMIT" };
  if (s.answered.length >= MIN_DIMENSIONS_COVERED) return { decision: "ENOUGH_INFORMATION", reason: "COVERAGE" };
  const unknown = ALL_VALUE_CATEGORIES.filter((c) => !s.answered.includes(c) && !s.asked.includes(c));
  if (unknown.length === 0) return { decision: "ENOUGH_INFORMATION", reason: "NOTHING_LEFT" };
  return { decision: "ASK", category: unknown[0], unknownCategories: [...unknown] };
}
