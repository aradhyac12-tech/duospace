/**
 * Phase 1.6 — AI output contract, provenance, safety validator additions,
 * sharing authorization, the local-first pipeline and encrypted local
 * storage (against an in-memory backend). No network, no Supabase.
 */
import { describe, it, expect } from "vitest";
import { validateInsight } from "@/lib/ai/outputValidator";
import { InsightSource, InsightConfidence, InsightLifecycle, SharingState, type AIInsight, type NewAIInsight } from "@/lib/ai/types";
import { checkAIProvenance, describeProvenance, isAIDerived, LOCAL_PROCESSOR_EXPECTATIONS } from "@/lib/ai/provenance";
import { authorizeInsightShare, type ShareContext } from "@/lib/ai/sharing";
import { saveLocalInsight, listLocalInsights, deleteLocalInsight, type InsightBackend } from "@/lib/ai/localInsightStore";
import { DataClassification, ProcessingLocation } from "@/lib/privacy/dataClassification";

function draft(o: Partial<NewAIInsight> = {}): NewAIInsight {
  return {
    feature: "MOOD_PROCESSING",
    userId: "u1",
    observation: "Your last three check-ins were rated lower than your usual.",
    confidence: InsightConfidence.LOW,
    uncertainty: "Only a few self-reports; many everyday things could explain this.",
    context: "No other signal was used.",
    possibleExplanations: ["A busy week at work.", "Something worth reflecting on together."],
    suggestedAction: "You might note what felt different this week.",
    source: InsightSource.LOCAL_MODEL,
    modelVersion: "rules-0.1",
    dataClassification: DataClassification.HIGHLY_SENSITIVE,
    processingLocation: ProcessingLocation.DEVICE,
    consentReference: "consent-1",
    expiresAt: null,
    ...o,
  };
}
function full(o: Partial<AIInsight> = {}): AIInsight {
  return {
    ...draft(),
    id: "ins-1",
    createdAt: "2026-09-20T00:00:00.000Z",
    lifecycle: InsightLifecycle.ACTIVE,
    correction: null,
    sharing: SharingState.PRIVATE,
    sharedWithUserId: null,
    sharedAt: null,
    ...o,
  };
}

describe("AI output contract: every required field exists", () => {
  it("a full insight carries the contract's fields", () => {
    const i = full();
    for (const k of ["id", "feature", "observation", "confidence", "uncertainty", "context", "possibleExplanations", "suggestedAction",
      "source", "modelVersion", "dataClassification", "processingLocation", "consentReference", "createdAt", "expiresAt"]) {
      expect(Object.prototype.hasOwnProperty.call(i, k)).toBe(true);
    }
  });
});

describe("safety validator: conclusions that may never be asserted", () => {
  const banned: Array<[string, string]> = [
    ["cheating", "This pattern suggests your partner is cheating."],
    ["lying", "They lied about where they were."],
    ["deception", "This is clear deception."],
    ["deceiving", "Your partner is deceiving you."],
    ["hidden intentions", "They have hidden intentions."],
    ["hiding", "They are hiding something from you."],
    ["definite anger", "Your partner is definitely angry with you."],
    ["lack of love", "They no longer love you."],
    ["relationship failure", "Your relationship is doomed."],
    ["breakup necessity", "You should break up with them."],
    ["toxic partner", "This is a toxic partner."],
    ["abusive label", "They are an abusive person."],
    ["guaranteed trust", "You can trust them, I guarantee it."],
    ["100% trust", "They are 100% trustworthy."],
  ];
  for (const [name, text] of banned) {
    it(`rejects: ${name}`, () => {
      const r = validateInsight(draft({ observation: text }));
      expect(r.valid).toBe(false);
      expect(r.issues.some((i) => i.field === "observation")).toBe(true);
    });
  }
  it("also rejects the same phrases in context, suggestedAction and explanations", () => {
    expect(validateInsight(draft({ context: "They are cheating." })).valid).toBe(false);
    expect(validateInsight(draft({ suggestedAction: "You should break up with them." })).valid).toBe(false);
    expect(validateInsight(draft({ possibleExplanations: ["Ordinary stress.", "They are hiding something."] })).valid).toBe(false);
  });
  it("accepts calm, uncertainty-labelled wording", () => {
    expect(validateInsight(draft()).valid).toBe(true);
  });
  it("requires observation, confidence ceiling, uncertainty, >=2 explanations", () => {
    expect(validateInsight(draft({ uncertainty: "" })).valid).toBe(false);
    expect(validateInsight(draft({ possibleExplanations: ["one"] })).valid).toBe(false);
    expect(validateInsight(draft({ confidence: InsightConfidence.HIGH })).valid).toBe(false); // model output can't self-declare HIGH
  });
});

describe("provenance: AI output is never labelled as the user's own statement", () => {
  const exp = LOCAL_PROCESSOR_EXPECTATIONS("MOOD_PROCESSING");
  it("accepts a well-formed local-model insight", () => expect(checkAIProvenance(draft(), exp)).toEqual([]));
  it("rejects a processor result claiming USER_REPORTED or USER_ENTERED", () => {
    for (const source of [InsightSource.USER_REPORTED, InsightSource.USER_ENTERED]) {
      expect(checkAIProvenance(draft({ source }), exp).some((i) => i.field === "source")).toBe(true);
    }
  });
  it("rejects cloud/partner-derived sources from a LOCAL processor", () => {
    expect(checkAIProvenance(draft({ source: InsightSource.CLOUD_MODEL }), exp).some((i) => i.field === "source")).toBe(true);
    expect(checkAIProvenance(draft({ source: InsightSource.SHARED_COUPLE_DATA }), exp).some((i) => i.field === "source")).toBe(true);
  });
  it("rejects non-device processing and non-HIGHLY_SENSITIVE classification", () => {
    expect(checkAIProvenance(draft({ processingLocation: ProcessingLocation.CLOUD_AI }), exp).some((i) => i.field === "processingLocation")).toBe(true);
    expect(checkAIProvenance(draft({ dataClassification: DataClassification.PRIVATE }), exp).some((i) => i.field === "dataClassification")).toBe(true);
  });
  it("rejects a feature mismatch and a missing consent reference", () => {
    expect(checkAIProvenance(draft({ feature: "RELATIONSHIP_INSIGHTS" }), exp).some((i) => i.field === "feature")).toBe(true);
    expect(checkAIProvenance(draft({ consentReference: "" }), exp).some((i) => i.field === "consentReference")).toBe(true);
  });
  it("labels: only USER_* sources read as the user's statement", () => {
    expect(describeProvenance(InsightSource.USER_REPORTED).isUserStatement).toBe(true);
    for (const s of [InsightSource.LOCAL_MODEL, InsightSource.LOCAL_RULE, InsightSource.CLOUD_MODEL, InsightSource.SHARED_COUPLE_DATA]) {
      expect(describeProvenance(s).isUserStatement).toBe(false);
    }
    expect(describeProvenance("SOMETHING_NEW" as never).isUserStatement).toBe(false);
    expect(describeProvenance(InsightSource.LOCAL_MODEL).label).toMatch(/guess/i);
    expect(isAIDerived(InsightSource.LOCAL_MODEL)).toBe(true);
    expect(isAIDerived(InsightSource.USER_REPORTED)).toBe(false);
  });
});

describe("sharing authorization (item level)", () => {
  const ctx = (o: Partial<ShareContext> = {}): ShareContext => ({
    requesterUserId: "u1", recipientUserId: "u2", requesterPartnerUserId: "u2",
    explicitShareAction: true, sharedInsightsConsent: true, now: new Date("2026-09-20T12:00:00Z"), ...o,
  });
  it("allows the owner to share an active insight with their partner after an explicit action + consent", () => {
    expect(authorizeInsightShare(full(), ctx()).allowed).toBe(true);
  });
  it("denies: non-owner, self, non-partner, missing consent, no explicit action", () => {
    expect(authorizeInsightShare(full({ userId: "someone-else" }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full(), ctx({ recipientUserId: "u1" })).allowed).toBe(false);
    expect(authorizeInsightShare(full(), ctx({ recipientUserId: "stranger" })).allowed).toBe(false);
    expect(authorizeInsightShare(full(), ctx({ requesterPartnerUserId: null })).allowed).toBe(false);
    expect(authorizeInsightShare(full(), ctx({ sharedInsightsConsent: false })).allowed).toBe(false);
    expect(authorizeInsightShare(full(), ctx({ explicitShareAction: false })).allowed).toBe(false);
  });
  it("denies deleted, expired, revoked, never-shareable classes and provenance-less model output", () => {
    expect(authorizeInsightShare(full({ lifecycle: InsightLifecycle.DELETED }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ lifecycle: InsightLifecycle.EXPIRED }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ expiresAt: "2026-09-19T00:00:00Z" }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ sharing: SharingState.REVOKED }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ dataClassification: DataClassification.DEVICE_ONLY }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ dataClassification: DataClassification.SECRET }), ctx()).allowed).toBe(false);
    expect(authorizeInsightShare(full({ modelVersion: undefined }), ctx()).allowed).toBe(false);
  });
});

function memoryBackend() {
  const data = new Map<string, unknown>();
  const k = (u: string, key: string) => `${u}::${key}`;
  const backend: InsightBackend = {
    get: async <T,>(u: string, key: string) => (data.has(k(u, key)) ? (JSON.parse(JSON.stringify(data.get(k(u, key)))) as T) : null),
    set: async (u, key, v) => { data.set(k(u, key), JSON.parse(JSON.stringify(v))); },
    remove: async (u, key) => { data.delete(k(u, key)); },
  };
  return { backend, data };
}

describe("local-first storage of insights (no Supabase)", () => {
  it("round-trips a validated local insight", async () => {
    const { backend } = memoryBackend();
    await saveLocalInsight("u1", full(), backend);
    const list = await listLocalInsights("u1", backend);
    expect(list.map((i) => i.id)).toEqual(["ins-1"]);
    expect(list[0].source).toBe(InsightSource.LOCAL_MODEL);
  });
  it("refuses to store something that fails safety validation", async () => {
    const { backend } = memoryBackend();
    await expect(saveLocalInsight("u1", full({ observation: "They are cheating." }), backend)).rejects.toThrow(/validation/);
  });
  it("refuses to store an insight labelled as the user's own statement", async () => {
    const { backend } = memoryBackend();
    await expect(saveLocalInsight("u1", full({ source: InsightSource.USER_REPORTED }), backend)).rejects.toThrow(/provenance/);
  });
  it("refuses another user's insight and a cloud-processed one", async () => {
    const { backend } = memoryBackend();
    await expect(saveLocalInsight("u2", full(), backend)).rejects.toThrow();
    await expect(saveLocalInsight("u1", full({ processingLocation: ProcessingLocation.CLOUD_AI }), backend)).rejects.toThrow(/provenance/);
  });
  it("scopes by user and drops expired insights on read", async () => {
    const { backend, data } = memoryBackend();
    await saveLocalInsight("u1", full({ id: "old", expiresAt: "2026-01-01T00:00:00Z" }), backend);
    await saveLocalInsight("u1", full({ id: "new", expiresAt: "2099-01-01T00:00:00Z" }), backend);
    expect((await listLocalInsights("u1", backend, new Date("2026-09-20T00:00:00Z"))).map((i) => i.id)).toEqual(["new"]);
    expect(data.has("u1::ai_insight_old")).toBe(false);
    expect(await listLocalInsights("u2", backend)).toEqual([]);
  });
  it("deletes", async () => {
    const { backend } = memoryBackend();
    await saveLocalInsight("u1", full(), backend);
    await deleteLocalInsight("u1", "ins-1", backend);
    expect(await listLocalInsights("u1", backend)).toEqual([]);
  });
});
