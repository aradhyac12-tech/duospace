/**
 * Grounding: generated output may not introduce facts (history, frequency,
 * numbers) that the user's own input does not contain. Real pipeline; the
 * provider is a scripted TEST DOUBLE feeding specific drafts.
 */
import { describe, it, expect } from "vitest";
import { checkGrounding } from "@/lib/ai/groundingValidator";
import { analyzeReflection } from "@/lib/relationship/pipeline";
import { USER, makeDeps, scriptedProvider } from "./fixtures";

const draft = (over: Record<string, unknown>) => ({ insights: [{
  observation: "You described dinner being cancelled.", confidence: "LOW", uncertainty: "Based only on what you wrote.",
  possibleExplanations: ["It might have been an unexpected obligation.", "It could reflect a busy day."],
  suggestedAction: "You could share how the change felt for you.", evidence: ["Your description of what happened"], ...over }] });
const input = { whatHappened: "My partner cancelled dinner.", felt: "Disappointed." };

describe("grounding validator", () => {
  const src = JSON.stringify(input);
  it.each([
    ["They have cancelled plans several times.", "several times"],
    ["This keeps happening.", "keeps"],
    ["Last month something similar happened.", "last month"],
    ["They always change plans.", "always"],
    ["It happened three times this week.", "three"],
    ["It has been 2 weeks since you talked.", "2"],
  ])("rejects %s", (text, term) => {
    expect(checkGrounding({ context: text }, src).map((i) => i.term)).toContain(term);
  });

  it("allows the same words when the USER supplied them", () => {
    const s = JSON.stringify({ whatHappened: "My partner didn't answer for six hours again, it happens often." });
    expect(checkGrounding({ observation: "You described waiting six hours, which you said happens again and often." }, s)).toEqual([]);
  });

  it("allows ordinary grounded reflection", () => {
    expect(checkGrounding({ observation: "You described dinner being cancelled and feeling disappointed.", possibleExplanations: ["It might have been an unexpected obligation."] }, src)).toEqual([]);
  });
});

describe("grounding in the real pipeline", () => {
  it("a model draft that invents history is rejected (never persisted)", async () => {
    const { deps, mem } = makeDeps({ provider: scriptedProvider(draft({ context: "They have cancelled plans several times." })), allowNonProductionProvider: true });
    await expect(analyzeReflection(USER, input, deps)).rejects.toMatchObject({ code: "NO_VALID_INSIGHTS" });
    expect(JSON.stringify(mem.writes)).not.toContain("several times");
  });

  it("a grounded model draft passes", async () => {
    const { deps } = makeDeps({ provider: scriptedProvider(draft({})), allowNonProductionProvider: true });
    expect((await analyzeReflection(USER, input, deps)).saved).toHaveLength(1);
  });

  it("local-rule-v1 (code-generated counts) is exempt and still passes the full dataset", async () => {
    const { deps } = makeDeps();
    expect((await analyzeReflection(USER, input, deps)).saved.length).toBeGreaterThan(0);
  });
});
