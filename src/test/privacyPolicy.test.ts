/**
 * Phase 1.6 — data classification, the policy matrix, consent semantics and
 * the PrivacyGate's destination / explicit-share / revocation behaviour.
 * Uses PrivacyGate's `deps` seam with an in-memory consent ledger, so no
 * Supabase and no module mocking is involved.
 */
import { describe, it, expect } from "vitest";
import {
  DataClassification, ProcessingLocation, POLICY_MATRIX, policyVerdict, ABSOLUTE_DENY_RULES,
} from "@/lib/privacy/dataClassification";
import { ConsentFeature, ALL_CONSENT_FEATURES, isConsentActive, CONSENT_SCHEMA_VERSION } from "@/lib/privacy/consentFeatures";
import { canProcess, FEATURE_CAPABILITIES, DESTINATION_CONSENT } from "@/lib/privacy/privacyGate";

const CLASSES = Object.values(DataClassification);
const DESTS = Object.values(ProcessingLocation);

/** In-memory consent ledger: grant/revoke like the real service, isConsentActive() decides. */
function ledger() {
  const rec = new Map<string, { granted: boolean; revokedAt: string | null; version: number }>();
  return {
    grant: (f: ConsentFeature) => rec.set(f, { granted: true, revokedAt: null, version: CONSENT_SCHEMA_VERSION }),
    revoke: (f: ConsentFeature) => rec.set(f, { granted: false, revokedAt: new Date().toISOString(), version: CONSENT_SCHEMA_VERSION }),
    deps: { hasConsent: async (_u: string, f: ConsentFeature) => isConsentActive(rec.get(f)) },
  };
}

describe("data classification: the seven canonical classes", () => {
  it("defines exactly the required classes", () => {
    expect(CLASSES.sort()).toEqual(
      ["COUPLE", "DEVICE_ONLY", "HIGHLY_SENSITIVE", "PRIVATE", "PUBLIC", "SECRET", "SENSITIVE"].sort(),
    );
  });
  it("matrix is complete: every class has an explicit verdict for every destination", () => {
    for (const c of CLASSES) for (const d of DESTS) {
      expect(["ALLOW", "CONSENT", "EXPLICIT_SHARE", "DENY"]).toContain(POLICY_MATRIX[c][d]);
    }
  });
  it("ABSOLUTE_DENY_RULES is exactly the DENY cells of the matrix", () => {
    const denyCells = CLASSES.flatMap((c) => DESTS.filter((d) => POLICY_MATRIX[c][d] === "DENY").map((d) => `${c}>${d}`)).sort();
    expect(ABSOLUTE_DENY_RULES.map((r) => `${r.classification}>${r.destination}`).sort()).toEqual(denyCells);
  });
  it("fails closed on an unknown classification or destination", () => {
    expect(policyVerdict("MADE_UP" as never, ProcessingLocation.DEVICE)).toBe("DENY");
    expect(policyVerdict(DataClassification.PUBLIC, "NOWHERE" as never)).toBe("DENY");
  });
});

describe("policy matrix: the leaks the spec names", () => {
  it("DEVICE_ONLY can only ever be DEVICE", () => {
    for (const d of DESTS) expect(policyVerdict(DataClassification.DEVICE_ONLY, d)).toBe(d === "DEVICE" ? "ALLOW" : "DENY");
  });
  it("raw audio/video (DEVICE_ONLY) -> logs is denied", () => {
    expect(policyVerdict(DataClassification.DEVICE_ONLY, ProcessingLocation.LOGS)).toBe("DENY");
  });
  it("SECRET goes nowhere, including analytics and logs", () => {
    for (const d of DESTS) expect(policyVerdict(DataClassification.SECRET, d)).toBe("DENY");
  });
  it("HIGHLY_SENSITIVE is never analytics/logs and reaches a partner only by explicit share", () => {
    expect(policyVerdict(DataClassification.HIGHLY_SENSITIVE, ProcessingLocation.ANALYTICS)).toBe("DENY");
    expect(policyVerdict(DataClassification.HIGHLY_SENSITIVE, ProcessingLocation.LOGS)).toBe("DENY");
    expect(policyVerdict(DataClassification.HIGHLY_SENSITIVE, ProcessingLocation.PARTNER)).toBe("EXPLICIT_SHARE");
  });
  it("PRIVATE data never reaches the partner", () => {
    expect(policyVerdict(DataClassification.PRIVATE, ProcessingLocation.PARTNER)).toBe("DENY");
  });
  it("COUPLE data may go to the partner but not to analytics/logs", () => {
    expect(policyVerdict(DataClassification.COUPLE, ProcessingLocation.PARTNER)).toBe("ALLOW");
    expect(policyVerdict(DataClassification.COUPLE, ProcessingLocation.ANALYTICS)).toBe("DENY");
  });
});

describe("consent semantics", () => {
  it("covers every required consent feature", () => {
    expect([...ALL_CONSENT_FEATURES].sort()).toEqual([
      "AI_PROCESSING", "ANALYTICS", "CAMERA_ANALYSIS", "CLOUD_AI_PROCESSING", "CRASH_DIAGNOSTICS", "MICROPHONE_ANALYSIS",
      "MOOD_PROCESSING", "RELATIONSHIP_INSIGHTS", "SHARED_INSIGHTS", "VIDEO_PROCESSING", "VOICE_PROCESSING",
    ]);
  });
  it("missing / not granted / revoked / stale-version are all NOT active", () => {
    expect(isConsentActive(undefined)).toBe(false);
    expect(isConsentActive(null)).toBe(false);
    expect(isConsentActive({ granted: false, revokedAt: null, version: CONSENT_SCHEMA_VERSION })).toBe(false);
    expect(isConsentActive({ granted: true, revokedAt: "2026-01-01T00:00:00Z", version: CONSENT_SCHEMA_VERSION })).toBe(false);
    expect(isConsentActive({ granted: true, revokedAt: null, version: CONSENT_SCHEMA_VERSION - 1 })).toBe(false);
  });
  it("a current grant is active", () => {
    expect(isConsentActive({ granted: true, revokedAt: null, version: CONSENT_SCHEMA_VERSION })).toBe(true);
  });
  it("every capability that has no feature behind it stays off", () => {
    for (const f of ["VOICE_PROCESSING", "VIDEO_PROCESSING", "MICROPHONE_ANALYSIS", "CLOUD_AI_PROCESSING"] as const) {
      expect(FEATURE_CAPABILITIES[f]).toBe(false);
    }
  });
  it("Phase 2A turns on exactly the on-device relationship-reflection capabilities", () => {
    for (const f of ["AI_PROCESSING", "RELATIONSHIP_INSIGHTS", "SHARED_INSIGHTS"] as const) {
      expect(FEATURE_CAPABILITIES[f]).toBe(true);
    }
  });
});

describe("PrivacyGate: consent revocation is enforced", () => {
  const req = {
    userId: "u1",
    feature: ConsentFeature.MOOD_PROCESSING,
    classification: DataClassification.HIGHLY_SENSITIVE,
    destination: ProcessingLocation.SUPABASE,
  };
  it("denies with no consent, allows after grant, denies again after revoke", async () => {
    const l = ledger();
    expect((await canProcess(req, l.deps)).allowed).toBe(false);
    l.grant(ConsentFeature.MOOD_PROCESSING);
    expect((await canProcess(req, l.deps)).allowed).toBe(true);
    l.revoke(ConsentFeature.MOOD_PROCESSING);
    const after = await canProcess(req, l.deps);
    expect(after.allowed).toBe(false);
    expect(after.reason).toMatch(/consent/i);
  });
});

describe("PrivacyGate: destinations", () => {
  it("cloud AI needs CLOUD_AI_PROCESSING on top of the feature consent (and the capability)", async () => {
    const l = ledger();
    l.grant(ConsentFeature.MOOD_PROCESSING);
    const req = { userId: "u1", feature: ConsentFeature.MOOD_PROCESSING, classification: DataClassification.SENSITIVE, destination: ProcessingLocation.CLOUD_AI };
    const r = await canProcess(req, l.deps);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/CLOUD_AI_PROCESSING/);
    l.grant(ConsentFeature.CLOUD_AI_PROCESSING);
    expect((await canProcess({ ...req, requireCapability: false }, l.deps)).allowed).toBe(true);
  });
  it("DEVICE_ONLY -> cloud/server/logs is denied even with every consent granted", async () => {
    const l = ledger();
    for (const f of ALL_CONSENT_FEATURES) l.grant(f);
    for (const d of [ProcessingLocation.CLOUD_AI, ProcessingLocation.SUPABASE, ProcessingLocation.LOGS, ProcessingLocation.PARTNER, ProcessingLocation.ANALYTICS]) {
      const r = await canProcess({ userId: "u1", feature: ConsentFeature.CAMERA_ANALYSIS, classification: DataClassification.DEVICE_ONLY, destination: d, requireCapability: false }, l.deps);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/policy/i);
    }
  });
  it("SECRET -> analytics is denied even with every consent granted", async () => {
    const l = ledger();
    for (const f of ALL_CONSENT_FEATURES) l.grant(f);
    const r = await canProcess({ userId: "u1", feature: ConsentFeature.ANALYTICS, classification: DataClassification.SECRET, destination: ProcessingLocation.ANALYTICS }, l.deps);
    expect(r.allowed).toBe(false);
  });
  it("analytics destination requires ANALYTICS consent", async () => {
    const l = ledger();
    l.grant(ConsentFeature.CRASH_DIAGNOSTICS);
    const req = { userId: "u1", feature: ConsentFeature.CRASH_DIAGNOSTICS, classification: DataClassification.PUBLIC, destination: ProcessingLocation.ANALYTICS };
    expect((await canProcess(req, l.deps)).allowed).toBe(false);
    l.grant(ConsentFeature.ANALYTICS);
    expect((await canProcess(req, l.deps)).allowed).toBe(true);
  });
  it("every destination consent names a real consent feature", () => {
    for (const f of Object.values(DESTINATION_CONSENT)) expect(ALL_CONSENT_FEATURES).toContain(f);
  });
});

describe("PrivacyGate: sharing with a partner (private AI insight -> partner)", () => {
  const base = { userId: "u1", feature: ConsentFeature.RELATIONSHIP_INSIGHTS, classification: DataClassification.HIGHLY_SENSITIVE, destination: ProcessingLocation.PARTNER, requireCapability: false };
  it("is denied without SHARED_INSIGHTS consent", async () => {
    const l = ledger();
    l.grant(ConsentFeature.RELATIONSHIP_INSIGHTS);
    const r = await canProcess({ ...base, explicitShare: true }, l.deps);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/SHARED_INSIGHTS/);
  });
  it("is denied without an explicit per-item share, even with every consent", async () => {
    const l = ledger();
    l.grant(ConsentFeature.RELATIONSHIP_INSIGHTS); l.grant(ConsentFeature.SHARED_INSIGHTS);
    expect((await canProcess(base, l.deps)).allowed).toBe(false);
    expect((await canProcess({ ...base, explicitShare: false }, l.deps)).allowed).toBe(false);
  });
  it("is allowed only with consent + SHARED_INSIGHTS + an explicit share", async () => {
    const l = ledger();
    l.grant(ConsentFeature.RELATIONSHIP_INSIGHTS); l.grant(ConsentFeature.SHARED_INSIGHTS);
    expect((await canProcess({ ...base, explicitShare: true }, l.deps)).allowed).toBe(true);
    l.revoke(ConsentFeature.SHARED_INSIGHTS);
    expect((await canProcess({ ...base, explicitShare: true }, l.deps)).allowed).toBe(false);
  });
  it("PRIVATE data can never go to a partner via the gate", async () => {
    const l = ledger();
    for (const f of ALL_CONSENT_FEATURES) l.grant(f);
    expect((await canProcess({ ...base, classification: DataClassification.PRIVATE, explicitShare: true }, l.deps)).allowed).toBe(false);
  });
});

describe("PrivacyGate: fails closed", () => {
  it("unknown classification/destination", async () => {
    const l = ledger();
    for (const f of ALL_CONSENT_FEATURES) l.grant(f);
    const r1 = await canProcess({ userId: "u1", feature: ConsentFeature.AI_PROCESSING, classification: "MADE_UP" as never, destination: ProcessingLocation.DEVICE, requireCapability: false }, l.deps);
    const r2 = await canProcess({ userId: "u1", feature: ConsentFeature.AI_PROCESSING, classification: DataClassification.PUBLIC, destination: "MARS" as never, requireCapability: false }, l.deps);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
  });
  it("a consent backend that throws is a denial, not an allow", async () => {
    // hasConsent() itself catches read errors; this asserts the gate does not turn a thrown backend into an allow.
    const boom = { hasConsent: async () => { throw new Error("db down"); } };
    await expect(
      canProcess({ userId: "u1", feature: ConsentFeature.ANALYTICS, classification: DataClassification.PUBLIC, destination: ProcessingLocation.DEVICE }, boom),
    ).rejects.toThrow();
  });
});
