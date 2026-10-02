/**
 * The canonical list of consent-gated capabilities.
 *
 * Lives in its own dependency-free module (no Supabase, no React, no
 * Capacitor) so the pure policy code — privacyGate's decision logic,
 * sensorPolicy, the tests — can import the vocabulary without dragging in
 * the network client. consent.ts re-exports these unchanged, so every
 * existing `import { ConsentFeature } from "@/lib/privacy/consent"` keeps
 * working. See .ai/CONSENT_MODEL.md.
 */
export const ConsentFeature = {
  AI_PROCESSING: "AI_PROCESSING",
  RELATIONSHIP_INSIGHTS: "RELATIONSHIP_INSIGHTS",
  MOOD_PROCESSING: "MOOD_PROCESSING",
  VOICE_PROCESSING: "VOICE_PROCESSING",
  VIDEO_PROCESSING: "VIDEO_PROCESSING",
  CAMERA_ANALYSIS: "CAMERA_ANALYSIS",
  MICROPHONE_ANALYSIS: "MICROPHONE_ANALYSIS",
  CLOUD_AI_PROCESSING: "CLOUD_AI_PROCESSING",
  SHARED_INSIGHTS: "SHARED_INSIGHTS",
  ANALYTICS: "ANALYTICS",
  CRASH_DIAGNOSTICS: "CRASH_DIAGNOSTICS",
} as const;

export type ConsentFeature = (typeof ConsentFeature)[keyof typeof ConsentFeature];

export const ALL_CONSENT_FEATURES: readonly ConsentFeature[] = Object.values(ConsentFeature);

/** The current schema version for consent *language* — bump when the disclosure text for a feature materially changes, so old grants can be treated as stale and re-prompted rather than silently trusted forever. */
export const CONSENT_SCHEMA_VERSION = 1;

/** The minimal shape isConsentActive() needs — ConsentRecord in consent.ts satisfies it. */
export interface ConsentLike {
  granted: boolean;
  revokedAt: string | null;
  version: number;
}

/**
 * The ONE definition of "this consent currently authorises processing".
 * Missing record = not active. Revoked, not granted, or granted under an
 * older disclosure version = not active. Pure, so revocation semantics are
 * unit-testable without a database.
 */
export function isConsentActive(rec: ConsentLike | null | undefined): boolean {
  if (!rec) return false;
  if (!rec.granted) return false;
  if (rec.revokedAt) return false;
  if (rec.version < CONSENT_SCHEMA_VERSION) return false;
  return true;
}
