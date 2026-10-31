import { describe, it, expect } from "vitest";
import { TASK_SCHEMA, CompatibilityAnalysisSchema, FactDraftSchema, DIMENSIONS, COMPAT_STATES } from "../../../../supabase/functions/_shared/ai/schemas";
import { toJsonSchema } from "../../../../supabase/functions/_shared/ai/jsonSchema";
import { AI_TASKS } from "../../../../supabase/functions/_shared/ai/tasks";
import { UNDERSTAND_OK } from "./helpers";

const lang = { code: "en", script: "latin", codeMixed: false };

describe("structured output schemas", () => {
  it("every task has a schema", () => { for (const t of AI_TASKS) expect(TASK_SCHEMA[t]).toBeTruthy(); });
  it("accepts a valid MessageUnderstanding", () => { expect(TASK_SCHEMA.UNDERSTAND.safeParse(UNDERSTAND_OK).success).toBe(true); });
  it("rejects unknown keys (a hallucinated score)", () => {
    expect(TASK_SCHEMA.UNDERSTAND.safeParse({ ...UNDERSTAND_OK, compatibilityScore: 87 }).success).toBe(false);
    expect(CompatibilityAnalysisSchema.safeParse({ headline: "x", clearestDifference: null, stillDiscovering: [], suggestedDiscussion: null, basis: "BOTH_PARTNERS", score: 9 }).success).toBe(false);
  });
  it("rejects missing fields, wrong enums, over-long text — never coerces", () => {
    const { summary: _s, ...missing } = UNDERSTAND_OK;
    expect(TASK_SCHEMA.UNDERSTAND.safeParse(missing).success).toBe(false);
    expect(TASK_SCHEMA.UNDERSTAND.safeParse({ ...UNDERSTAND_OK, intent: "SECRET_FEELING" }).success).toBe(false);
    expect(TASK_SCHEMA.UNDERSTAND.safeParse({ ...UNDERSTAND_OK, summary: "x".repeat(201) }).success).toBe(false);
    expect(TASK_SCHEMA.UNDERSTAND.safeParse({ ...UNDERSTAND_OK, confidence: "high" }).success).toBe(false);
  });
  it("replies are capped at 3", () => {
    const s = { text: "ok", mode: "normal", respondsTo: "x" };
    expect(TASK_SCHEMA.QUICK_REPLY.safeParse({ suggestions: [s, s, s], insufficientContext: false }).success).toBe(true);
    expect(TASK_SCHEMA.QUICK_REPLY.safeParse({ suggestions: [s, s, s, s], insufficientContext: false }).success).toBe(false);
  });
  it("a fact draft cannot carry source, consent or id fields", () => {
    const d = { category: "pace", subject: "USER", value: "v", exactEvidence: "e", isExplicit: true, hedged: false, language: lang };
    expect(FactDraftSchema.safeParse(d).success).toBe(true);
    expect(FactDraftSchema.safeParse({ ...d, sourceType: "USER_EXPLICIT" }).success).toBe(false);
    expect(FactDraftSchema.safeParse({ ...d, consentReference: "x" }).success).toBe(false);
  });
  it("covers exactly the 16 dimensions and 4 states from the brief", () => {
    expect(DIMENSIONS).toHaveLength(16);
    expect([...COMPAT_STATES]).toEqual(["ALIGNED", "DIFFERENT", "DISCOVERING", "INSUFFICIENT_DATA"]);
  });
  it("NO task schema contains a numeric field (no score/percentage can exist)", () => {
    for (const t of AI_TASKS) expect(JSON.stringify(toJsonSchema(TASK_SCHEMA[t], "openai"))).not.toMatch(/"type":"number"|"type":\["number"/);
  });
});

describe("JSON-schema conversion for providers", () => {
  it("OpenAI strict: every property required, additionalProperties false, nullable as type union", () => {
    const j = toJsonSchema(TASK_SCHEMA.UNDERSTAND, "openai") as { required: string[]; properties: Record<string, { type: unknown }>; additionalProperties: boolean };
    expect(j.additionalProperties).toBe(false);
    expect(j.required.sort()).toEqual(Object.keys(j.properties).sort());
    expect(j.properties.why.type).toEqual(["string", "null"]);
  });
  it("Gemini: uppercase types, nullable flag, no additionalProperties", () => {
    const j = toJsonSchema(TASK_SCHEMA.UNDERSTAND, "gemini") as { type: string; additionalProperties?: boolean; properties: Record<string, { type: string; nullable?: boolean }> };
    expect(j.type).toBe("OBJECT");
    expect(j.additionalProperties).toBeUndefined();
    expect(j.properties.why).toMatchObject({ type: "STRING", nullable: true });
  });
  it("throws on an unsupported Zod type instead of emitting a wrong schema", () => {
    expect(() => toJsonSchema(TASK_SCHEMA.UNDERSTAND.constructor === Object ? ({} as never) : ({ _def: { typeName: "ZodMap" } } as never), "openai")).toThrow();
  });
});
