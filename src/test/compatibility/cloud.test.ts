import { describe, it, expect } from "vitest";
import { explainCompatibility, nextAdaptiveQuestion } from "@/lib/relationship/compatibility/cloud";
import type { DyadicComparison } from "@/lib/relationship/dyadic/types";

const inv = (data: unknown, error: unknown = null) => ({ invoke: async () => ({ data, error }) });
const item = (statement: string) => ({ statement, provenance: { updatedAt: "2026-09-01T00:00:00Z" } });
const cmp = (category: string, status: string, key: string, unknownReason: string | null = null) =>
  ({ key, kind: "VALUE_ANSWER", category, prompt: null, status, unknownReason, self: item("Slow and steady"), partner: item("I like things to move along") }) as unknown as DyadicComparison;

describe("Stage 3 wiring", () => {
  it("no basis -> never calls the model", async () => {
    let called = false;
    const r = await explainCompatibility([], { invoker: { invoke: async () => { called = true; return { data: null, error: null }; } } });
    expect(r.ok).toBe(false); expect(called).toBe(false);
  });
  it("explanation accepted only when it matches the deterministic result", async () => {
    const comps = [cmp("PACE", "DIFFERENT", "pace-1")];
    const good = { ok: true, meta: {}, result: { headline: "You see pace differently.", clearestDifference: "pace", stillDiscovering: [], suggestedDiscussion: null, basis: "BOTH_PARTNERS" } };
    const a = await explainCompatibility(comps, { invoker: inv(good) });
    expect(a.ok).toBe(true);
    const bad = { ...good, result: { ...good.result, clearestDifference: "trust" } };
    const b = await explainCompatibility(comps, { invoker: inv(bad) });
    expect(b.ok).toBe(false);
  });
  it("adaptive: cloud wording used when it picks the app's dimension, else bank fallback", async () => {
    const st = { answered: [], asked: [], questionsThisSession: 0 };
    const ok = await nextAdaptiveQuestion(st, { invoker: inv({ ok: true, meta: {}, result: { decision: "ASK", dimension: "communication", text: "How do you like to stay in touch?" } }) });
    expect(ok).toEqual({ done: false, category: "COMMUNICATION", label: "Communication", text: "How do you like to stay in touch?", source: "CLOUD_AI", questionId: null });
    const wrong = await nextAdaptiveQuestion(st, { invoker: inv({ ok: true, meta: {}, result: { decision: "ASK", dimension: "trust", text: "x" } }) });
    expect((wrong as { source: string }).source).toBe("QUESTION_BANK");
    const down = await nextAdaptiveQuestion(st, { invoker: inv(null, new Error("net")) });
    expect((down as { source: string }).source).toBe("QUESTION_BANK");
  });
  it("adaptive: stops without calling the model", async () => {
    const r = await nextAdaptiveQuestion({ answered: [], asked: [], questionsThisSession: 8 });
    expect(r).toEqual({ done: true, reason: "SESSION_LIMIT" });
  });
});
