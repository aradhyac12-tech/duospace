/**
 * LOCAL VALIDATION — the first stage of the pipeline
 * (USER INPUT -> LOCAL VALIDATION -> PRIVACY GATE -> ...).
 *
 * Hand-written and dependency-free on purpose: it runs before anything is
 * stored or handed to a provider, must behave identically in tests and on
 * device, and must never echo the input back in an error (errors carry only
 * a fixed code — see errors.ts).
 */
import { RelationshipError } from "./errors";
import { getQuestion } from "./questions";
import {
  ALL_VALUE_CATEGORIES, AnswerMode, ExpectationType, Importance, REFLECTION_FIELD_KEYS,
  type ReflectionFields, type ValueCategory,
} from "./types";

export const LIMITS = {
  noteMax: 500,
  statementMin: 3,
  statementMax: 280,
  reflectionFieldMax: 2000,
  reflectionTotalMax: 6000,
  correctionNoteMax: 500,
} as const;

/** Strips control characters (keeps \n and \t), normalises line endings, trims. */
export function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

const bad = (): never => { throw new RelationshipError("VALIDATION"); };

// ── Values ────────────────────────────────────────────────────────────────

export interface ValueAnswerInput {
  questionId: string;
  mode: AnswerMode;
  choiceId?: string | null;
  note?: string | null;
}
export interface CleanValueAnswerInput {
  questionId: string;
  category: ValueCategory;
  mode: AnswerMode;
  choiceId: string | null;
  note: string | null;
}

export function validateValueAnswerInput(input: ValueAnswerInput): CleanValueAnswerInput {
  if (!input || typeof input !== "object") return bad();
  const question = getQuestion(input.questionId);
  if (!question) return bad();
  if (!Object.values(AnswerMode).includes(input.mode)) return bad();

  if (input.mode !== AnswerMode.ANSWERED) {
    // "Not sure" / "prefer not to answer" retain NOTHING: no choice, no text.
    return { questionId: question.id, category: question.category, mode: input.mode, choiceId: null, note: null };
  }
  const choiceId = input.choiceId ?? null;
  if (!choiceId || !question.options.some((o) => o.id === choiceId)) return bad();
  const note = sanitizeText(input.note);
  if (note.length > LIMITS.noteMax) return bad();
  return { questionId: question.id, category: question.category, mode: AnswerMode.ANSWERED, choiceId, note: note || null };
}

// ── Expectations ──────────────────────────────────────────────────────────

export interface ExpectationInput {
  category: ValueCategory;
  statement: string;
  /** REQUIRED. There is no default and nothing infers it. */
  type: ExpectationType;
  importance: Importance;
  /** Must be exactly `true` for type BOUNDARY — the user's explicit confirmation. */
  confirmedBoundary?: boolean;
}
export interface CleanExpectationInput {
  category: ValueCategory;
  statement: string;
  type: ExpectationType;
  importance: Importance;
}

export function validateExpectationInput(input: ExpectationInput): CleanExpectationInput {
  if (!input || typeof input !== "object") return bad();
  if (!ALL_VALUE_CATEGORIES.includes(input.category)) return bad();
  if (!Object.values(ExpectationType).includes(input.type)) return bad();
  if (!Object.values(Importance).includes(input.importance)) return bad();
  const statement = sanitizeText(input.statement);
  if (statement.length < LIMITS.statementMin || statement.length > LIMITS.statementMax) return bad();
  if (input.type === ExpectationType.BOUNDARY && input.confirmedBoundary !== true) {
    throw new RelationshipError("BOUNDARY_NOT_CONFIRMED");
  }
  return { category: input.category, statement, type: input.type, importance: input.importance };
}

// ── Reflection ────────────────────────────────────────────────────────────

export type ReflectionInput = Partial<Record<keyof ReflectionFields, string | null | undefined>>;

/**
 * Returns only the fields the user actually filled in. At least one is required
 * — an empty reflection is never sent anywhere.
 */
export function validateReflectionInput(input: ReflectionInput): Partial<ReflectionFields> {
  if (!input || typeof input !== "object") return bad();
  const out: Partial<ReflectionFields> = {};
  let total = 0;
  for (const key of REFLECTION_FIELD_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") return bad();
    const text = sanitizeText(raw);
    if (text.length > LIMITS.reflectionFieldMax) return bad();
    if (text) { out[key] = text; total += text.length; }
  }
  if (Object.keys(out).length === 0 || total > LIMITS.reflectionTotalMax) return bad();
  return out;
}

export function validateCorrectionNote(note: string | null | undefined): string | undefined {
  if (note === undefined || note === null) return undefined;
  const t = sanitizeText(note);
  if (t.length > LIMITS.correctionNoteMax) return bad();
  return t || undefined;
}
