/**
 * Phase 2A pipeline, end to end (real pipeline code, in-memory encrypted-store
 * stand-in): input → minimization → PrivacyGate → provider → schema →
 * safety → provenance → expiry → persistence, plus Phase 2B fallback rules.
 */
import { describe, it, expect, vi } from "vitest";
import { analyzeValues, analyzeExpectations, analyzeReflection, listRelationshipInsights } from "@/lib/relationship/pipeline";
import { buildValuesInput, buildReflectionInput } from "@/lib/relationship/provider";
import { localRuleProvider } from "@/lib/relationship/providers/localRuleProvider";
import { createLocalModelProvider } from "@/lib/relationship/providers/localModelProvider";
import { USER, makeDeps, answer, values, expectation, scriptedProvider, goodDraft } from "./fixtures";

const reflection = {
  whatHappened: "My partner replied six hours after my message about dinner plans.",
  hoped: "A quick reply so we could decide.", felt: "Unsure and a bit anxious.",
  partnerUnderstood: "Maybe that it wasn't urgent.", nextTime: "Say when I need an answer by.",
};

describe("values", () => {
  it("valid answers → validated, provenance-stamped, expiring insights persisted", async () => {
    const { deps, mem } = makeDeps();
    const r = await analyzeValues(USER, values([answer("comm-1"), answer("comm-2", 1), answer("trust-1")]), deps);
    expect(r.saved.length).toBeGreaterThan(0);
    for (const i of r.saved) {
      expect(i.processingLocation).toBe("DEVICE");
      expect(i.source).toBe("LOCAL_RULE");
      expect(i.modelVersion).toBe(localRuleProvider.info.modelVersion);
      expect(i.consentReference).toBe("consent-ref-1");
      expect(i.dataClassification).toBe("HIGHLY_SENSITIVE");
      expect(i.sharing).toBe("PRIVATE");
      expect(Date.parse(i.expiresAt!)).toBeGreaterThan(Date.parse(i.createdAt));
      expect(i.evidence.length).toBeGreaterThan(0);
    }
    expect(mem.writes.length).toBeGreaterThan(0);
    const reloaded = await listRelationshipInsights(USER, deps);
    expect(reloaded.map((i) => i.id).sort()).toEqual(r.saved.map((i) => i.id).sort());
  });

  it("'prefer not to answer' and skipped categories are never sent to the provider (minimization)", () => {
    const input = buildValuesInput(values([answer("comm-1"), answer("trust-1", 0, { mode: "PREFER_NOT_TO_ANSWER", choiceId: null })], ["FINANCES"]));
    expect(input.answers.map((a) => a.category)).toEqual(["COMMUNICATION"]);
    const json = JSON.stringify(input);
    expect(json).not.toMatch(/createdAt|updatedAt|visibility|questionId|"id"/);
  });

  it("free-text notes are excluded unless explicitly requested", () => {
    const rec = values([answer("comm-1", 0, { note: "SECRET-NOTE-XYZ" })]);
    expect(JSON.stringify(buildValuesInput(rec))).not.toContain("SECRET-NOTE-XYZ");
  });
});

describe("expectations", () => {
  it("preference / expectation / explicit boundary with importance → insights", async () => {
    const { deps } = makeDeps();
    const r = await analyzeExpectations(USER, [
      expectation({ type: "PREFERENCE", importance: "LOW" }),
      expectation({ type: "EXPECTATION", importance: "MEDIUM" }),
      expectation({ type: "BOUNDARY", importance: "HIGH", category: "PERSONAL_SPACE" }),
    ], deps);
    expect(r.saved.length).toBeGreaterThan(0);
  });

  it("inactive items are not processed", async () => {
    const provider = scriptedProvider({ insights: [] });
    const spy = vi.spyOn(provider, "analyzeExpectations");
    const { deps } = makeDeps({ provider, allowNonProductionProvider: true });
    await analyzeExpectations(USER, [expectation({ status: "ARCHIVED" as never, statement: "ARCHIVED-ITEM" })], deps).catch(() => {});
    expect(JSON.stringify(spy.mock.calls)).not.toContain("ARCHIVED-ITEM");
  });
});

describe("reflection", () => {
  it("valid reflection → insights; nothing claims to know the partner's mind", async () => {
    const { deps } = makeDeps();
    const r = await analyzeReflection(USER, reflection, deps);
    expect(r.saved.length).toBeGreaterThan(0);
    for (const i of r.saved) expect(i.observation).not.toMatch(/partner (thinks|feels|ignored|doesn'?t care)/i);
  });

  it("incomplete input still yields grounded output; evidence only for fields supplied", () => {
    const input = buildReflectionInput({ whatHappened: "A plan was cancelled." });
    expect(input.evidenceCatalog).toEqual(["Your description of what happened"]);
  });

  it("consent denied → CONSENT_DENIED, provider never called, NO fallback", async () => {
    const provider = scriptedProvider({ insights: [goodDraft("Your description of what happened")] });
    const fallback = scriptedProvider({ insights: [] }, "LOCAL_RULE");
    const { deps, mem } = makeDeps({ provider, fallbackProvider: fallback, allowNonProductionProvider: true, gate: { hasConsent: async () => false } });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "CONSENT_DENIED" });
    expect(provider.calls + fallback.calls).toBe(0);
    expect(mem.writes).toHaveLength(0);
  });

  it("missing consent record → CONSENT_MISSING, nothing processed", async () => {
    const { deps, mem } = makeDeps({ getConsentReference: async () => null });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "CONSENT_MISSING" });
    expect(mem.writes).toHaveLength(0);
  });

  it("provider failure with no fallback → safe PROVIDER_FAILURE", async () => {
    const bad = scriptedProvider(null);
    bad.analyzeCommunicationReflection = async () => { throw new Error("boom"); };
    const { deps } = makeDeps({ provider: bad, allowNonProductionProvider: true });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
});

describe("Phase 2B: fallback, device-only, provenance", () => {
  it("local model unavailable → local-rule-v1 fallback (never cloud)", async () => {
    const localModel = createLocalModelProvider({ capabilities: () => ({ modelAvailable: false } as never) });
    const { deps } = makeDeps({ provider: localModel, fallbackProvider: localRuleProvider, allowNonProductionProvider: true });
    const r = await analyzeReflection(USER, reflection, deps);
    expect(r.saved.every((i) => i.source === "LOCAL_RULE")).toBe(true);
  });

  it("malformed model output → rejected, fallback used, malformed text never persisted", async () => {
    const provider = scriptedProvider("Sure! Your partner is clearly upset with you.");
    const { deps, mem } = makeDeps({ provider, fallbackProvider: localRuleProvider, allowNonProductionProvider: true });
    const r = await analyzeReflection(USER, reflection, deps);
    expect(r.saved.every((i) => i.source === "LOCAL_RULE")).toBe(true);
    expect(JSON.stringify(mem.writes)).not.toContain("clearly upset");
  });

  it("FABRICATED evidence (not in the supplied catalog) is rejected", async () => {
    const provider = scriptedProvider({ insights: [goodDraft("Your partner's chat history")] });
    const { deps, mem } = makeDeps({ provider, allowNonProductionProvider: true });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "NO_VALID_INSIGHTS" });
    expect(mem.writes).toHaveLength(0);
  });

  it("a valid model draft grounded in supplied evidence is accepted and stamped LOCAL_MODEL", async () => {
    const provider = scriptedProvider({ insights: [goodDraft("Your description of what happened")] });
    const { deps } = makeDeps({ provider, allowNonProductionProvider: true });
    const r = await analyzeReflection(USER, reflection, deps);
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].source).toBe("LOCAL_MODEL");
    expect(r.saved[0].modelVersion).toBe("scripted-test-double@0");
  });

  it("a CLOUD provider is refused outright — even with consent — and no fallback masks it", async () => {
    const cloud = scriptedProvider({ insights: [goodDraft("Your description of what happened")] }, "CLOUD_MODEL", "CLOUD_AI");
    const { deps } = makeDeps({ provider: cloud, fallbackProvider: localRuleProvider, allowNonProductionProvider: true });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "CLOUD_NOT_SUPPORTED" });
    expect(cloud.calls).toBe(0);
  });

  it("a non-production provider is refused unless explicitly allowed", async () => {
    const provider = scriptedProvider({ insights: [goodDraft("Your description of what happened")] });
    const { deps } = makeDeps({ provider });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
    expect(provider.calls).toBe(0);
  });

  it("both providers fail → safe error, nothing stored", async () => {
    const provider = scriptedProvider("garbage");
    const fb = scriptedProvider("more garbage", "LOCAL_RULE");
    const { deps, mem } = makeDeps({ provider, fallbackProvider: fb, allowNonProductionProvider: true });
    await expect(analyzeReflection(USER, reflection, deps)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(mem.writes).toHaveLength(0);
  });
});

describe("telemetry never carries private content", () => {
  it("events contain only op/outcome/latency/providerType/errorCategory/count", async () => {
    const secretNote = "SECRET-NOTE-ABC";
    const { deps, events } = makeDeps();
    await analyzeValues(USER, values([answer("comm-1", 0, { note: secretNote })]), deps);
    await analyzeReflection(USER, reflection, deps);
    const bad = scriptedProvider({ insights: [goodDraft("Your partner's chat history")] });
    await analyzeReflection(USER, reflection, { ...deps, provider: bad, allowNonProductionProvider: true }).catch(() => {});
    const blob = JSON.stringify(events);
    for (const s of [secretNote, "six hours", "anxious", "dinner", "partner", "chat history", USER, "consent-ref-1", "comm-1"]) {
      expect(blob, s).not.toContain(s);
    }
    for (const e of events) {
      expect(Object.keys(e).every((k) => ["op", "outcome", "latencyMs", "providerType", "errorCategory", "count"].includes(k))).toBe(true);
    }
  });
});
