/**
 * Tests for the AI insight safety validator (src/lib/ai/outputValidator.ts).
 * Phase 1 privacy/AI foundation — see .ai/AI_SAFETY_SPEC.md.
 */
import { describe, it, expect } from "vitest";
import { validateInsight, assertValidInsight } from "@/lib/ai/outputValidator";
import { InsightSource, InsightConfidence, type NewAIInsight } from "@/lib/ai/types";
import { DataClassification, ProcessingLocation } from "@/lib/privacy/dataClassification";

function baseDraft(overrides: Partial<NewAIInsight> = {}): NewAIInsight {
  return {
    feature: "MOOD_PROCESSING",
    userId: "user-1",
    observation: "You logged a lower mood rating three days this week.",
    confidence: InsightConfidence.LOW,
    uncertainty: "This is based on a small number of self-reports and could reflect many things.",
    context: "Self-reported, no other signal involved.",
    possibleExplanations: ["A busy or stressful week unrelated to the relationship.", "Something relationship-related worth reflecting on."],
    suggestedAction: "You might jot a note about what felt different this week.",
    source: InsightSource.USER_REPORTED,
    modelVersion: undefined,
    dataClassification: DataClassification.SENSITIVE,
    processingLocation: ProcessingLocation.DEVICE,
    consentReference: "consent-123",
    expiresAt: null,
    ...overrides,
  };
}

describe("outputValidator: structural checks", () => {
  it("accepts a well-formed draft", () => {
    const result = validateInsight(baseDraft());
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a missing observation", () => {
    const result = validateInsight(baseDraft({ observation: "" }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "observation")).toBe(true);
  });

  it("rejects a missing uncertainty", () => {
    const result = validateInsight(baseDraft({ uncertainty: "" }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "uncertainty")).toBe(true);
  });

  it("rejects fewer than two possible explanations", () => {
    const result = validateInsight(baseDraft({ possibleExplanations: ["Only one."] }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "possibleExplanations")).toBe(true);
  });

  it("rejects a model source with no modelVersion", () => {
    const result = validateInsight(baseDraft({ source: InsightSource.LOCAL_MODEL, modelVersion: undefined, confidence: InsightConfidence.LOW }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "modelVersion")).toBe(true);
  });

  it("rejects a missing consentReference", () => {
    const result = validateInsight(baseDraft({ consentReference: "" }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "consentReference")).toBe(true);
  });
});

describe("outputValidator: confidence ceiling", () => {
  it("allows USER_REPORTED to claim HIGH confidence", () => {
    const result = validateInsight(baseDraft({ source: InsightSource.USER_REPORTED, confidence: InsightConfidence.HIGH }));
    expect(result.valid).toBe(true);
  });

  it("rejects LOCAL_MODEL claiming HIGH confidence", () => {
    const result = validateInsight(
      baseDraft({ source: InsightSource.LOCAL_MODEL, modelVersion: "v1", confidence: InsightConfidence.HIGH }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "confidence")).toBe(true);
  });

  it("rejects CLOUD_MODEL claiming HIGH confidence", () => {
    const result = validateInsight(
      baseDraft({ source: InsightSource.CLOUD_MODEL, modelVersion: "v1", confidence: InsightConfidence.HIGH }),
    );
    expect(result.valid).toBe(false);
  });

  it("allows LOCAL_MODEL claiming MEDIUM confidence", () => {
    const result = validateInsight(
      baseDraft({ source: InsightSource.LOCAL_MODEL, modelVersion: "v1", confidence: InsightConfidence.MEDIUM }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("outputValidator: prohibited phrases", () => {
  const prohibited = [
    "Your partner is cheating on you.",
    "It looks like they are lying to you.",
    "Your partner is definitely angry about this.",
    "Your partner doesn't love you anymore.",
    "This relationship will fail.",
    "You should break up with them.",
    "Your partner is toxic.",
    "You can trust this person 100%.",
    "Your partner is definitely hiding something.",
    "This proves deception on their part.",
  ];

  for (const phrase of prohibited) {
    it(`rejects an observation containing: "${phrase}"`, () => {
      const result = validateInsight(baseDraft({ observation: phrase }));
      expect(result.valid).toBe(false);
    });

    it(`rejects a possibleExplanation containing: "${phrase}"`, () => {
      const result = validateInsight(baseDraft({ possibleExplanations: [phrase, "A more mundane explanation."] }));
      expect(result.valid).toBe(false);
    });
  }

  it("rejects a suggestedAction directed at the partner", () => {
    const result = validateInsight(baseDraft({ suggestedAction: "Your partner should apologize first." }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "suggestedAction")).toBe(true);
  });

  it("allows a suggestedAction directed at the user themselves", () => {
    const result = validateInsight(baseDraft({ suggestedAction: "You might bring this up gently next time you talk." }));
    expect(result.valid).toBe(true);
  });
});

describe("assertValidInsight", () => {
  it("does not throw for a valid draft", () => {
    expect(() => assertValidInsight(baseDraft())).not.toThrow();
  });

  it("throws with a readable message for an invalid draft", () => {
    expect(() => assertValidInsight(baseDraft({ observation: "Your partner is cheating." }))).toThrow(/prohibited/i);
  });
});
