/**
 * Tests for PrivacyGate (src/lib/privacy/privacyGate.ts) — the
 * capability -> consent -> classification -> destination pipeline. Phase
 * 1 privacy/AI foundation — see .ai/PRIVACY_MODEL.md.
 *
 * hasConsent() is mocked here rather than hitting Supabase — this suite
 * is testing the gate's own decision logic (deny rules, capability
 * gating, fail-closed behavior), not consent.ts's persistence layer,
 * which is a separate concern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { canProcess, requireCanProcess, FEATURE_CAPABILITIES } from "@/lib/privacy/privacyGate";
import { DataClassification, ProcessingLocation } from "@/lib/privacy/dataClassification";
import { ConsentFeature } from "@/lib/privacy/consent";

vi.mock("@/lib/privacy/consent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/privacy/consent")>("@/lib/privacy/consent");
  return { ...actual, hasConsent: vi.fn() };
});

import { hasConsent } from "@/lib/privacy/consent";
const mockedHasConsent = vi.mocked(hasConsent);

describe("PrivacyGate: absolute deny rules (cannot be overridden by consent)", () => {
  beforeEach(() => {
    mockedHasConsent.mockResolvedValue(true); // even with consent granted...
  });

  it("denies DEVICE_ONLY data routed to CLOUD_AI regardless of consent", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.CLOUD_AI_PROCESSING,
      classification: DataClassification.DEVICE_ONLY,
      destination: ProcessingLocation.CLOUD_AI,
      requireCapability: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/policy/i);
  });

  it("denies DEVICE_ONLY data routed to SUPABASE regardless of consent", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.AI_PROCESSING,
      classification: DataClassification.DEVICE_ONLY,
      destination: ProcessingLocation.SUPABASE,
      requireCapability: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("denies SECRET data routed to CLOUD_AI regardless of consent", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.CLOUD_AI_PROCESSING,
      classification: DataClassification.SECRET,
      destination: ProcessingLocation.CLOUD_AI,
      requireCapability: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("still denies SECRET data even to DEVICE processing, via the secondary check", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.AI_PROCESSING,
      classification: DataClassification.SECRET,
      destination: ProcessingLocation.DEVICE,
      requireCapability: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("allows DEVICE_ONLY data processed on DEVICE with consent and capability", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.AI_PROCESSING,
      classification: DataClassification.DEVICE_ONLY,
      destination: ProcessingLocation.DEVICE,
      requireCapability: false,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("PrivacyGate: capability gate", () => {
  beforeEach(() => {
    mockedHasConsent.mockResolvedValue(true);
  });

  it("denies a feature that is not capability-enabled, even with consent", async () => {
    // Phase 2A enabled RELATIONSHIP_INSIGHTS; VOICE_PROCESSING is still off.
    expect(FEATURE_CAPABILITIES[ConsentFeature.VOICE_PROCESSING]).toBe(false);
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.VOICE_PROCESSING,
      classification: DataClassification.SENSITIVE,
      destination: ProcessingLocation.DEVICE,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not enabled/i);
  });

  it("skips the capability check when requireCapability is false", async () => {
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.VOICE_PROCESSING,
      classification: DataClassification.SENSITIVE,
      destination: ProcessingLocation.DEVICE,
      requireCapability: false,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("PrivacyGate: consent check (fails closed)", () => {
  it("denies when consent has not been granted", async () => {
    mockedHasConsent.mockResolvedValue(false);
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.ANALYTICS,
      classification: DataClassification.PRIVATE,
      destination: ProcessingLocation.DEVICE,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/consent/i);
  });

  it("denies when there is no authenticated userId, without even checking consent", async () => {
    mockedHasConsent.mockClear(); // calls from earlier tests must not count here
    const result = await canProcess({
      userId: "",
      feature: ConsentFeature.ANALYTICS,
      classification: DataClassification.PRIVATE,
      destination: ProcessingLocation.DEVICE,
    });
    expect(result.allowed).toBe(false);
    expect(mockedHasConsent).not.toHaveBeenCalled();
  });

  it("allows when consent is granted, capability is on, and no deny rule applies", async () => {
    mockedHasConsent.mockResolvedValue(true);
    const result = await canProcess({
      userId: "u1",
      feature: ConsentFeature.ANALYTICS,
      classification: DataClassification.PRIVATE,
      destination: ProcessingLocation.DEVICE,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("requireCanProcess", () => {
  it("resolves when allowed", async () => {
    mockedHasConsent.mockResolvedValue(true);
    await expect(
      requireCanProcess({
        userId: "u1",
        feature: ConsentFeature.ANALYTICS,
        classification: DataClassification.PRIVATE,
        destination: ProcessingLocation.DEVICE,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when denied", async () => {
    mockedHasConsent.mockResolvedValue(false);
    await expect(
      requireCanProcess({
        userId: "u1",
        feature: ConsentFeature.ANALYTICS,
        classification: DataClassification.PRIVATE,
        destination: ProcessingLocation.DEVICE,
      }),
    ).rejects.toThrow(/PrivacyGate denied/);
  });
});
