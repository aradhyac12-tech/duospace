/**
 * Device-local, encrypted persistence for the user's OWN relationship input:
 * values answers, expectations, and (only if they choose to keep them) written
 * reflections. Backend = secureStorage (software AES-256-GCM — see
 * .ai/SECURITY_MODEL.md for the honest limitation) via the same injectable
 * `InsightBackend` seam localInsightStore uses.
 *
 * Nothing in this file talks to a network or to Supabase. Nothing here can
 * change an item's `visibility` to shared — only sharing.ts does, after its
 * own gate. Editing an item always resets it to PRIVATE, because a snapshot a
 * partner can see must not silently drift from what the owner now believes.
 */
import type { InsightBackend } from "../ai/localInsightStore";
import { RelationshipError } from "./errors";
import { classifyExpectation, classifyValueAnswer, REFLECTION_CLASSIFICATION } from "./classification";
import {
  validateExpectationInput, validateReflectionInput, validateValueAnswerInput,
  type ExpectationInput, type ReflectionInput, type ValueAnswerInput,
} from "./validation";
import {
  ALL_VALUE_CATEGORIES, Visibility,
  type Expectation, type ReflectionFields, type StoredReflection, type ValueAnswer, type ValueCategory, type ValuesRecord,
} from "./types";

export const STORAGE_KEYS = {
  values: "rel_values_v1",
  expectations: "rel_expectations_v1",
  reflections: "rel_reflections_v1",
} as const;

export interface StoreCtx {
  backend: InsightBackend;
  now: () => Date;
  newId: () => string;
}

async function read<T>(ctx: StoreCtx, userId: string, key: string): Promise<T | null> {
  if (!userId) throw new RelationshipError("VALIDATION");
  try {
    return await ctx.backend.get<T>(userId, key);
  } catch {
    throw new RelationshipError("STORAGE_FAILURE");
  }
}
async function write(ctx: StoreCtx, userId: string, key: string, value: unknown): Promise<void> {
  if (!userId) throw new RelationshipError("VALIDATION");
  try {
    await ctx.backend.set(userId, key, value);
  } catch {
    throw new RelationshipError("STORAGE_FAILURE");
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

// ── Values ────────────────────────────────────────────────────────────────

export async function loadValues(userId: string, ctx: StoreCtx): Promise<ValuesRecord> {
  const raw = await read<ValuesRecord>(ctx, userId, STORAGE_KEYS.values);
  if (!isObj(raw) || !Array.isArray(raw.answers)) return { version: 1, answers: [], skippedCategories: [] };
  return {
    version: 1,
    answers: raw.answers.filter((a) => isObj(a) && typeof a.questionId === "string" && typeof a.id === "string"),
    skippedCategories: Array.isArray(raw.skippedCategories)
      ? raw.skippedCategories.filter((c): c is ValueCategory => ALL_VALUE_CATEGORIES.includes(c))
      : [],
  };
}

export async function createValueAnswer(userId: string, input: ValueAnswerInput, ctx: StoreCtx): Promise<ValueAnswer> {
  const clean = validateValueAnswerInput(input);
  const rec = await loadValues(userId, ctx);
  if (rec.answers.some((a) => a.questionId === clean.questionId)) throw new RelationshipError("ALREADY_EXISTS");
  const ts = ctx.now().toISOString();
  const answer: ValueAnswer = {
    id: clean.questionId,
    questionId: clean.questionId,
    category: clean.category,
    mode: clean.mode,
    choiceId: clean.choiceId,
    note: clean.note,
    createdAt: ts,
    updatedAt: ts,
    visibility: Visibility.PRIVATE,
    shareId: null,
    dataClassification: classifyValueAnswer(clean.category, clean.note, clean.mode),
  };
  await write(ctx, userId, STORAGE_KEYS.values, { ...rec, answers: [...rec.answers, answer] });
  return answer;
}

/** Edits an existing answer. The result is always PRIVATE again (see file header); `previous` lets the caller revoke a stale share. */
export async function updateValueAnswer(
  userId: string, input: ValueAnswerInput, ctx: StoreCtx,
): Promise<{ answer: ValueAnswer; previous: ValueAnswer }> {
  const clean = validateValueAnswerInput(input);
  const rec = await loadValues(userId, ctx);
  const previous = rec.answers.find((a) => a.questionId === clean.questionId);
  if (!previous) throw new RelationshipError("NOT_FOUND");
  const answer: ValueAnswer = {
    ...previous,
    mode: clean.mode,
    choiceId: clean.choiceId,
    note: clean.note,
    updatedAt: ctx.now().toISOString(),
    visibility: Visibility.PRIVATE,
    shareId: null,
    dataClassification: classifyValueAnswer(clean.category, clean.note, clean.mode),
  };
  await write(ctx, userId, STORAGE_KEYS.values, {
    ...rec, answers: rec.answers.map((a) => (a.questionId === clean.questionId ? answer : a)),
  });
  return { answer, previous };
}

export async function deleteValueAnswer(userId: string, questionId: string, ctx: StoreCtx): Promise<ValueAnswer | null> {
  const rec = await loadValues(userId, ctx);
  const removed = rec.answers.find((a) => a.questionId === questionId) ?? null;
  if (!removed) return null;
  await write(ctx, userId, STORAGE_KEYS.values, { ...rec, answers: rec.answers.filter((a) => a.questionId !== questionId) });
  return removed;
}

export async function setCategorySkipped(userId: string, category: ValueCategory, skipped: boolean, ctx: StoreCtx): Promise<ValuesRecord> {
  if (!ALL_VALUE_CATEGORIES.includes(category)) throw new RelationshipError("VALIDATION");
  const rec = await loadValues(userId, ctx);
  const set = new Set(rec.skippedCategories);
  if (skipped) set.add(category); else set.delete(category);
  const next = { ...rec, skippedCategories: Array.from(set) };
  await write(ctx, userId, STORAGE_KEYS.values, next);
  return next;
}

// ── Expectations ──────────────────────────────────────────────────────────

export async function loadExpectations(userId: string, ctx: StoreCtx): Promise<Expectation[]> {
  const raw = await read<Expectation[]>(ctx, userId, STORAGE_KEYS.expectations);
  return Array.isArray(raw) ? raw.filter((e) => isObj(e) && typeof e.id === "string" && typeof e.statement === "string") : [];
}

/**
 * Creates an expectation. `input.type` is required and is used verbatim: a
 * BOUNDARY exists only if the caller passes confirmedBoundary === true, which
 * the UI sets only from an explicit checkbox. No provider output ever reaches
 * this function (providers return insights, never items).
 */
export async function createExpectation(userId: string, input: ExpectationInput, ctx: StoreCtx): Promise<Expectation> {
  const clean = validateExpectationInput(input);
  const items = await loadExpectations(userId, ctx);
  const ts = ctx.now().toISOString();
  const item: Expectation = {
    id: ctx.newId(),
    ...clean,
    createdAt: ts,
    updatedAt: ts,
    visibility: Visibility.PRIVATE,
    shareId: null,
    dataClassification: classifyExpectation(clean.category, clean.type),
    status: "ACTIVE",
  };
  await write(ctx, userId, STORAGE_KEYS.expectations, [...items, item]);
  return item;
}

/** Full edit (includes changing type/importance — the user's own correction). Resets to PRIVATE. */
export async function updateExpectation(
  userId: string, id: string, input: ExpectationInput, ctx: StoreCtx,
): Promise<{ item: Expectation; previous: Expectation }> {
  const clean = validateExpectationInput(input);
  const items = await loadExpectations(userId, ctx);
  const previous = items.find((e) => e.id === id);
  if (!previous) throw new RelationshipError("NOT_FOUND");
  const item: Expectation = {
    ...previous,
    ...clean,
    updatedAt: ctx.now().toISOString(),
    visibility: Visibility.PRIVATE,
    shareId: null,
    dataClassification: classifyExpectation(clean.category, clean.type),
  };
  await write(ctx, userId, STORAGE_KEYS.expectations, items.map((e) => (e.id === id ? item : e)));
  return { item, previous };
}

/** "Not relevant any more". Archived items are never compared or shared; the user can restore or delete them. */
export async function setExpectationStatus(
  userId: string, id: string, status: "ACTIVE" | "ARCHIVED", ctx: StoreCtx,
): Promise<{ item: Expectation; previous: Expectation }> {
  const items = await loadExpectations(userId, ctx);
  const previous = items.find((e) => e.id === id);
  if (!previous) throw new RelationshipError("NOT_FOUND");
  const item: Expectation = {
    ...previous, status, updatedAt: ctx.now().toISOString(),
    // An archived item must not stay visible to the partner.
    ...(status === "ARCHIVED" ? { visibility: Visibility.PRIVATE, shareId: null } : {}),
  };
  await write(ctx, userId, STORAGE_KEYS.expectations, items.map((e) => (e.id === id ? item : e)));
  return { item, previous };
}

export async function deleteExpectation(userId: string, id: string, ctx: StoreCtx): Promise<Expectation | null> {
  const items = await loadExpectations(userId, ctx);
  const removed = items.find((e) => e.id === id) ?? null;
  if (!removed) return null;
  await write(ctx, userId, STORAGE_KEYS.expectations, items.filter((e) => e.id !== id));
  return removed;
}

// ── Reflections the user chose to keep ────────────────────────────────────

export async function listReflections(userId: string, ctx: StoreCtx): Promise<StoredReflection[]> {
  const raw = await read<StoredReflection[]>(ctx, userId, STORAGE_KEYS.reflections);
  return Array.isArray(raw) ? raw.filter((r) => isObj(r) && typeof r.id === "string") : [];
}

/** Only called when the user explicitly ticks "keep this on my device". Default is to keep nothing. */
export async function saveReflection(userId: string, input: ReflectionInput, ctx: StoreCtx): Promise<StoredReflection> {
  const clean = validateReflectionInput(input);
  const items = await listReflections(userId, ctx);
  const ts = ctx.now().toISOString();
  const full: ReflectionFields = {
    whatHappened: clean.whatHappened ?? "", hoped: clean.hoped ?? "", felt: clean.felt ?? "",
    partnerUnderstood: clean.partnerUnderstood ?? "", nextTime: clean.nextTime ?? "",
  };
  const item: StoredReflection = {
    id: ctx.newId(), ...full, createdAt: ts, updatedAt: ts,
    visibility: "PRIVATE", dataClassification: REFLECTION_CLASSIFICATION,
  };
  await write(ctx, userId, STORAGE_KEYS.reflections, [...items, item]);
  return item;
}

export async function deleteReflection(userId: string, id: string, ctx: StoreCtx): Promise<boolean> {
  const items = await listReflections(userId, ctx);
  if (!items.some((r) => r.id === id)) return false;
  await write(ctx, userId, STORAGE_KEYS.reflections, items.filter((r) => r.id !== id));
  return true;
}

// ── Share bookkeeping (called only by sharing.ts) ─────────────────────────

export async function setValueShareState(
  userId: string, questionId: string, state: { visibility: Visibility; shareId: string | null }, ctx: StoreCtx,
): Promise<void> {
  const rec = await loadValues(userId, ctx);
  if (!rec.answers.some((a) => a.questionId === questionId)) return;
  await write(ctx, userId, STORAGE_KEYS.values, {
    ...rec, answers: rec.answers.map((a) => (a.questionId === questionId ? { ...a, ...state } : a)),
  });
}

export async function setExpectationShareState(
  userId: string, id: string, state: { visibility: Visibility; shareId: string | null }, ctx: StoreCtx,
): Promise<void> {
  const items = await loadExpectations(userId, ctx);
  if (!items.some((e) => e.id === id)) return;
  await write(ctx, userId, STORAGE_KEYS.expectations, items.map((e) => (e.id === id ? { ...e, ...state } : e)));
}
