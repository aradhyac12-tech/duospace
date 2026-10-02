/**
 * Injectable dependencies for the relationship feature. Production wiring is
 * in production.ts; tests build their own (src/test/helpers/relationshipHarness.ts).
 * Keeping every side-effecting collaborator behind this seam is what lets the
 * consent, storage, transport and provider behaviour be tested without a
 * database, a network, or a model.
 */
import type { InsightBackend } from "../ai/localInsightStore";
import type { PrivacyGateDeps } from "../privacy/privacyGate";
import type { ConsentFeature } from "../privacy/consentFeatures";
import type { RelationshipAIProvider } from "./provider";
import type { RelationshipTelemetrySink } from "./telemetry";

export interface RelationshipDeps {
  /** Encrypted device-local storage (secureStorage in production). */
  backend: InsightBackend;
  now: () => Date;
  newId: () => string;
  /** Consent lookup, evaluated at processing time on every call. */
  gate: PrivacyGateDeps;
  /** The id of the user's currently-granted consent record for `feature` (becomes an insight's consentReference), or null. */
  getConsentReference: (userId: string, feature: ConsentFeature) => Promise<string | null>;
  provider: RelationshipAIProvider;
  /** Deterministic on-device fallback (local-rule-v1). Used when `provider`
   *  is unavailable, fails, times out, or yields no valid insight. NEVER a
   *  cloud provider — the pipeline refuses any non-DEVICE provider. */
  fallbackProvider?: RelationshipAIProvider;
  /** false in production builds: a non-production (mock) provider is then refused. */
  allowNonProductionProvider: boolean;
  telemetry: RelationshipTelemetrySink;
  /** Provider call time limit. Default 15 s. */
  timeoutMs?: number;
  /** Monotonic millisecond clock for latency. Default performance.now / Date.now. */
  clock?: () => number;
}

export const defaultNewId = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

export const defaultClock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
