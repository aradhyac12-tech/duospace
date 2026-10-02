/**
 * Production wiring for RelationshipDeps (see deps.ts). This is the ONLY
 * file in the feature that is allowed to import secureStorage, consent.ts
 * and the default provider together — everything else takes them injected,
 * which is what makes the rest of the feature testable without a device.
 */
import { secureGet, secureSet, secureRemove } from "@/lib/privacy/secureStorage";
import { hasConsent, getAllConsents } from "@/lib/privacy/consent";
import { ConsentFeature } from "@/lib/privacy/consentFeatures";
import type { InsightBackend } from "../ai/localInsightStore";
import type { RelationshipDeps } from "./deps";
import { defaultClock, defaultNewId } from "./deps";
import { selectProviders } from "./registry";
import { defaultTelemetrySink } from "./telemetry";

const backend: InsightBackend = { get: secureGet, set: secureSet, remove: secureRemove };

async function getConsentReference(userId: string, feature: ConsentFeature): Promise<string | null> {
  const all = await getAllConsents(userId);
  const rec = all.find((c) => c.feature === feature && c.granted && !c.revokedAt);
  return rec?.id ?? null;
}

export function buildProductionRelationshipDeps(): RelationshipDeps {
  return {
    backend,
    now: () => new Date(),
    newId: defaultNewId,
    gate: { hasConsent },
    getConsentReference,
    ...(() => {
      const { primary, fallback, usesLocalModel } = selectProviders();
      // local-model-v1 is not yet production-graded (quality gates must pass
      // on real devices first); it only runs where the build opted in and a
      // verified model is present, and local-rule-v1 always backs it.
      return { provider: primary, fallbackProvider: fallback, allowNonProductionProvider: usesLocalModel };
    })(),
    telemetry: defaultTelemetrySink,
    clock: defaultClock,
  };
}
