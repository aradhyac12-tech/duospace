/**
 * Safety validator — direct AND euphemistic prohibited claims, in every
 * free-text field, plus things that MUST remain allowed (user-described
 * concerns, hedged, user-attributed).
 */
import { describe, it, expect } from "vitest";
import { validateInsight } from "@/lib/ai/outputValidator";
import { PROHIBITED } from "./safetyPhrases";

const base = {
  id: "i", feature: "RELATIONSHIP_INSIGHTS", userId: "u", createdAt: "2026-09-23T00:00:00Z",
  observation: "You described a six-hour gap before a reply.", confidence: "LOW",
  uncertainty: "Based only on what you wrote about one situation.",
  possibleExplanations: ["This might have been a busy day.", "It could reflect different texting habits."],
  suggestedAction: "You could mention what kind of reply timing feels okay to you.",
  evidence: ["Your description of what happened"], analysisKind: "COMMUNICATION_REFLECTION",
  source: "LOCAL_MODEL", modelVersion: "m@1", dataClassification: "HIGHLY_SENSITIVE", processingLocation: "DEVICE",
  consentReference: "c", expiresAt: null,
};
const v = (over: Record<string, unknown>) => validateInsight({ ...base, ...over } as never);


describe("safety validator rejects prohibited claims (direct + euphemistic)", () => {
  for (const [cat, phrases] of Object.entries(PROHIBITED)) {
    for (const text of phrases) {
      it(`${cat}: "${text}" rejected in observation, explanations and context`, () => {
        expect(v({ observation: `You wrote about this. ${text}` }).valid, "observation").toBe(false);
        expect(v({ possibleExplanations: [text, "It could also be a busy week."] }).valid, "explanation").toBe(false);
        expect(v({ context: text }).valid, "context").toBe(false);
      });
    }
  }
});

describe("safety validator still allows grounded, user-attributed, hedged reflection", () => {
  const OK = [
    { observation: "You experienced a six-hour delay in communication." },
    { observation: "You described feeling worried that something was being kept from you." },
    { observation: "You wrote that you felt hurt when the plan was cancelled." },
    { possibleExplanations: ["The reason for the delay is unknown from the information provided, and it might have been ordinary.", "It could reflect different expectations about reply times."] },
    { suggestedAction: "You could ask how they experienced the evening, if that feels right." },
  ];
  for (const over of OK) it(JSON.stringify(over).slice(0, 80), () => {
    const r = v(over);
    expect(r.issues).toEqual([]);
  });
});
