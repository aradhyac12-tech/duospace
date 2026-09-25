/**
 * Data classification for relationship-reflection data.
 * Uses the EXISTING seven-tier model (src/lib/privacy/dataClassification.ts) —
 * nothing here defines a new tier. See .ai/DATA_CLASSIFICATION.md.
 *
 *   values answer            SENSITIVE; HIGHLY_SENSITIVE for intimacy/boundaries
 *                            or when the person added free text (which can hold anything)
 *   expectation              SENSITIVE; HIGHLY_SENSITIVE for a boundary, or intimacy /
 *                            boundaries / finances / family content
 *   private reflection       HIGHLY_SENSITIVE always
 *   AI-derived insight       HIGHLY_SENSITIVE (unless explicitly shared)
 *   shared snapshot (server) COUPLE
 *
 * Deliberately NEVER PRIVATE: these are not ordinary application data.
 */
import { DataClassification } from "../privacy/dataClassification";
import { ValueCategory, ExpectationType, type AnswerMode } from "./types";

const HIGH_SENSITIVITY_CATEGORIES: readonly ValueCategory[] = [ValueCategory.INTIMACY, ValueCategory.BOUNDARIES];
const HIGH_SENSITIVITY_EXPECTATION_CATEGORIES: readonly ValueCategory[] = [
  ValueCategory.INTIMACY, ValueCategory.BOUNDARIES, ValueCategory.FINANCES, ValueCategory.FAMILY,
];

export function classifyValueAnswer(category: ValueCategory, note: string | null, _mode?: AnswerMode): DataClassification {
  if (HIGH_SENSITIVITY_CATEGORIES.includes(category)) return DataClassification.HIGHLY_SENSITIVE;
  if (note && note.trim().length > 0) return DataClassification.HIGHLY_SENSITIVE;
  return DataClassification.SENSITIVE;
}

export function classifyExpectation(category: ValueCategory, type: ExpectationType): DataClassification {
  if (type === ExpectationType.BOUNDARY) return DataClassification.HIGHLY_SENSITIVE;
  if (HIGH_SENSITIVITY_EXPECTATION_CATEGORIES.includes(category)) return DataClassification.HIGHLY_SENSITIVE;
  return DataClassification.SENSITIVE;
}

export const REFLECTION_CLASSIFICATION = DataClassification.HIGHLY_SENSITIVE;
export const INSIGHT_CLASSIFICATION = DataClassification.HIGHLY_SENSITIVE;
export const SHARED_SNAPSHOT_CLASSIFICATION = DataClassification.COUPLE;
