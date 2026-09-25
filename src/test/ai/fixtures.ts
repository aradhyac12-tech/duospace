/** Shared, SYNTHETIC fixtures for relationship-AI tests. No real user data. */
import type { InsightBackend } from "@/lib/ai/localInsightStore";
import type { RelationshipDeps } from "@/lib/relationship/deps";
import type { RelationshipAIProvider } from "@/lib/relationship/provider";
import { localRuleProvider } from "@/lib/relationship/providers/localRuleProvider";
import { getQuestion } from "@/lib/relationship/questions";
import type { RelationshipEvent } from "@/lib/relationship/telemetry";
import type { Expectation, ValueAnswer, ValuesRecord } from "@/lib/relationship/types";

export const USER = "11111111-1111-4111-8111-111111111111";

/** In-memory stand-in for the encrypted secureStorage backend; records every write. */
export function memoryBackend() {
  const store = new Map<string, unknown>();
  const writes: { key: string; value: unknown }[] = [];
  const backend: InsightBackend = {
    get: async <T,>(u: string, k: string) => (store.get(`${u}:${k}`) as T) ?? null,
    set: async (u: string, k: string, v: unknown) => { store.set(`${u}:${k}`, JSON.parse(JSON.stringify(v))); writes.push({ key: k, value: v }); },
    remove: async (u: string, k: string) => { store.delete(`${u}:${k}`); },
  } as InsightBackend;
  return { backend, store, writes };
}

export function makeDeps(over: Partial<RelationshipDeps> = {}) {
  const mem = memoryBackend();
  const events: RelationshipEvent[] = [];
  let n = 0;
  const deps: RelationshipDeps = {
    backend: mem.backend,
    now: () => new Date("2026-09-23T10:00:00Z"),
    newId: () => `ins-${++n}`,
    gate: { hasConsent: async () => true },
    getConsentReference: async () => "consent-ref-1",
    provider: localRuleProvider,
    allowNonProductionProvider: false,
    telemetry: (e) => events.push(e),
    clock: () => 0,
    ...over,
  };
  return { deps, events, mem };
}

export function answer(questionId: string, optIndex = 0, extra: Partial<ValueAnswer> = {}): ValueAnswer {
  const q = getQuestion(questionId)!;
  return {
    id: questionId, questionId, category: q.category, mode: "ANSWERED", choiceId: q.options[optIndex].id, note: null,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", visibility: "PRIVATE", ...extra,
  } as ValueAnswer;
}

export const values = (answers: ValueAnswer[], skipped: ValuesRecord["skippedCategories"] = []): ValuesRecord => ({ version: 1, answers, skippedCategories: skipped });

export function expectation(over: Partial<Expectation> = {}): Expectation {
  return {
    id: `exp-${Math.random().toString(36).slice(2, 8)}`, category: "COMMUNICATION", statement: "A short message when running late",
    type: "EXPECTATION", importance: "MEDIUM", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    visibility: "PRIVATE", shareId: null, dataClassification: "HIGHLY_SENSITIVE", status: "ACTIVE", ...over,
  } as Expectation;
}

/** A scripted provider that returns a fixed raw object — used to feed
 *  specific (good or adversarial) outputs through the REAL pipeline. It is a
 *  test double, not a model. */
export function scriptedProvider(raw: unknown, kind: "LOCAL_MODEL" | "LOCAL_RULE" | "CLOUD_MODEL" = "LOCAL_MODEL", location = "DEVICE"): RelationshipAIProvider & { calls: number } {
  const p = {
    calls: 0,
    info: { id: `scripted-${kind}`, kind, processingLocation: location, modelVersion: "scripted-test-double@0", isProduction: false, description: "TEST DOUBLE — not a model" },
    async analyzeValues() { p.calls++; return raw as never; },
    async analyzeExpectations() { p.calls++; return raw as never; },
    async analyzeCommunicationReflection() { p.calls++; return raw as never; },
  };
  return p as never;
}

export const goodDraft = (evidence: string) => ({
  observation: "You described wanting a short message when plans change.",
  confidence: "MEDIUM", uncertainty: "This is based only on what you wrote in one reflection.",
  context: "One situation you described.",
  possibleExplanations: ["This might reflect how much predictability matters to you.", "It could also have been an unusually busy day."],
  suggestedAction: "You could share what kind of message would feel enough for you.",
  evidence: [evidence],
});
