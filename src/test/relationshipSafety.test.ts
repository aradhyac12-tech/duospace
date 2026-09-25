/**
 * Tests for the Phase 2A additions to the AI safety validator
 * (src/lib/ai/outputValidator.ts's checkRelationshipRules + the new
 * prohibited-claim patterns). See .ai/AI_SAFETY_SPEC.md and the brief's §8/§16.
 */
import { describe, it, expect } from "vitest";
import { validateInsight } from "@/lib/ai/outputValidator";
import { InsightSource, InsightConfidence, type NewAIInsight } from "@/lib/ai/types";
import { DataClassification, ProcessingLocation } from "@/lib/privacy/dataClassification";

function relationshipDraft(overrides: Partial<NewAIInsight> = {}): NewAIInsight {
  return {
    feature: "RELATIONSHIP_INSIGHTS",
    userId: "user-1",
    observation: "You described several situations where you felt your requests were not acknowledged.",
    confidence: InsightConfidence.MEDIUM,
    uncertainty: "This is based only on what you reported.",
    context: undefined,
    possibleExplanations: [
      "This may reflect different communication styles.",
      "It could also reflect situational stress unrelated to the relationship.",
    ],
    suggestedAction: "You could try naming the request directly next time.",
    evidence: ["Your reflection answers"],
    analysisKind: "COMMUNICATION_REFLECTION",
    source: InsightSource.LOCAL_RULE,
    modelVersion: "local-rule-v1",
    dataClassification: DataClassification.HIGHLY_SENSITIVE,
    processingLocation: ProcessingLocation.DEVICE,
    consentReference: "consent-123",
    expiresAt: null,
    ...overrides,
  } as NewAIInsight;
}

describe("relationship insights: structural rules", () => {
  it("accepts a well-formed relationship draft", () => {
    const result = validateInsight(relationshipDraft());
    expect(result.valid).toBe(true);
  });

  it("rejects an observation not attributed to the user", () => {
    const result = validateInsight(relationshipDraft({ observation: "Your partner ignored your requests several times." }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "observation")).toBe(true);
  });

  it("requires at least one evidence reference", () => {
    const result = validateInsight(relationshipDraft({ evidence: [] }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "evidence")).toBe(true);
  });

  it("requires analysisKind to be declared and valid", () => {
    const result = validateInsight(relationshipDraft({ analysisKind: undefined }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "analysisKind")).toBe(true);
  });

  it("rejects an unhedged possible explanation", () => {
    const result = validateInsight(relationshipDraft({
      possibleExplanations: ["Your partner does not respect your time."],
    }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "possibleExplanations")).toBe(true);
  });

  it("rejects a suggested action phrased as a command to the user", () => {
    const result = validateInsight(relationshipDraft({ suggestedAction: "You must confront your partner about this tonight." }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "suggestedAction")).toBe(true);
  });
});

describe("relationship insights: prohibited claims (brief §8)", () => {
  const casesByField = (text: string, field: "observation" | "context" | "suggestedAction" | "uncertainty") =>
    validateInsight(relationshipDraft({ [field]: text } as Partial<NewAIInsight>));

  it("blocks an assertion of cheating/attraction to someone else", () => {
    const result = casesByField("You mentioned your partner seems attracted to someone else at work.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks an assertion of abuse", () => {
    const result = casesByField("What you described sounds like emotional abuse.", "context");
    expect(result.valid).toBe(false);
  });

  it("blocks a personality-disorder / diagnostic label", () => {
    const result = casesByField("This pattern suggests your partner may be a narcissist.", "context");
    expect(result.valid).toBe(false);
  });

  it("blocks a toxicity claim", () => {
    const result = casesByField("This dynamic you described sounds toxic.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a relationship-failure claim", () => {
    const result = casesByField("Based on this, the relationship is not going to last.", "context");
    expect(result.valid).toBe(false);
  });

  it("blocks a breakup-necessity suggestion", () => {
    const result = casesByField("You should consider ending the relationship.", "suggestedAction");
    expect(result.valid).toBe(false);
  });

  it("blocks assigning partner guilt", () => {
    const result = casesByField("It's your partner's fault this keeps happening.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a stated claim about the partner's mental state", () => {
    const result = casesByField("Your partner feels unappreciated by you.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a deception/lying claim", () => {
    const result = casesByField("It sounds like your partner is not being honest with you.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a verdict that the partner disrespects the user", () => {
    const result = casesByField("Your partner does not respect your boundaries.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a numeric relationship score", () => {
    const result = casesByField("Your relationship compatibility is 82%.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks a ratio-style score", () => {
    const result = casesByField("You two scored 7 out of 10 on communication.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks the word compatibility used as a score", () => {
    const result = casesByField("Your compatibility here seems strong.", "context");
    expect(result.valid).toBe(false);
  });

  it("allows the brief's worked-example GOOD output (delayed response)", () => {
    const result = validateInsight(relationshipDraft({
      observation: "You experienced a delayed response and interpreted it as a possible communication issue.",
    }));
    expect(result.valid).toBe(true);
  });

  it("blocks the brief's worked-example BAD output (ignoring you)", () => {
    const result = casesByField("Your partner is ignoring you.", "observation");
    expect(result.valid).toBe(false);
  });

  it("blocks the brief's worked-example BAD output (doesn't care)", () => {
    const result = casesByField("They don't care about you.", "context");
    expect(result.valid).toBe(false);
  });

  it("allows the brief's worked-example GOOD output (cancelled plan)", () => {
    const result = validateInsight(relationshipDraft({
      observation: "You described disappointment after the plan was cancelled.",
    }));
    expect(result.valid).toBe(true);
  });

  it("blocks the brief's worked-example BAD output (cheating)", () => {
    const result = casesByField("They are cheating.", "observation");
    expect(result.valid).toBe(false);
  });

  it("allows the brief's worked-example GOOD output (talking to someone else)", () => {
    const result = validateInsight(relationshipDraft({
      observation: "The information you provided does not establish why they were speaking with that person.",
    }));
    expect(result.valid).toBe(true);
  });
});

describe("relationship insights: uncertainty and evidence are scanned too", () => {
  it("blocks a prohibited claim hidden in the uncertainty field", () => {
    const result = validateInsight(relationshipDraft({ uncertainty: "It's likely your partner is lying about this." }));
    expect(result.valid).toBe(false);
  });

  it("blocks a prohibited claim hidden in an evidence reference", () => {
    const result = validateInsight(relationshipDraft({ evidence: ["Your partner is emotionally abusive based on this"] }));
    expect(result.valid).toBe(false);
  });
});

describe("relationship insights: non-relationship features are unaffected", () => {
  it("does not apply relationship structural rules to a different feature", () => {
    const result = validateInsight({
      feature: "MOOD_PROCESSING",
      userId: "user-1",
      observation: "Mood logged as lower three days this week.",
      confidence: InsightConfidence.LOW,
      uncertainty: "Based on a small self-reported sample.",
      // The general contract (AI_OUTPUT_CONTRACT.md) requires ≥2 explanations
      // for EVERY feature; the fixture had one, so it tested the wrong thing.
      possibleExplanations: ["Could reflect many unrelated factors.", "Might be a normal fluctuation in a short sample."],
      source: InsightSource.USER_REPORTED,
      dataClassification: DataClassification.SENSITIVE,
      processingLocation: ProcessingLocation.DEVICE,
      consentReference: "consent-123",
      expiresAt: null,
    } as NewAIInsight);
    // No evidence/analysisKind required outside RELATIONSHIP_INSIGHTS.
    expect(result.valid).toBe(true);
  });
});
