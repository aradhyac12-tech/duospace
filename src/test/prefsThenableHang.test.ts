import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { createValueAnswer, loadValues, createExpectation, loadExpectations } from "@/lib/relationship/stores";
import { questionsForCategory } from "@/lib/relationship";
describe("Reflection storage on web (Preferences thenable hang regression)", () => {
  it("saves and reloads a Values answer and an Expectation without hanging", async () => {
    const deps = buildProductionRelationshipDeps();
    const ctx = { backend: deps.backend, now: deps.now, newId: deps.newId };
    const q = questionsForCategory("COMMUNICATION" as any)[0] as any;
    await createValueAnswer("u1", { questionId: q.id, mode: "ANSWERED" as any, choiceId: q.options[0].id }, ctx);
    const v = await loadValues("u1", ctx);
    expect(v.answers).toHaveLength(1);
    await createExpectation("u1", { category: "COMMUNICATION" as any, statement: "Hxhxhd", type: "BOUNDARY" as any, importance: "MEDIUM" as any, confirmedBoundary: true }, ctx);
    expect(await loadExpectations("u1", ctx)).toHaveLength(1);
  }, 5000);
});
