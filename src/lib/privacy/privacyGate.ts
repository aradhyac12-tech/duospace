/**
 * PrivacyGate — the one required checkpoint every sensitive processing
 * pipeline must pass through before it runs. See .ai/PRIVACY_MODEL.md.
 *
 *   FEATURE REQUEST
 *     -> policy matrix      (is this classification ever allowed at this destination? DENY = never)
 *     -> capability check   (is this feature even built/enabled?)
 *     -> consent check      (did the user grant this specific consent?)
 *     -> destination consent (cloud / partner / analytics / logs need their own explicit consent)
 *     -> explicit-share     (partner egress of reflection/AI data needs a per-item owner action)
 *     -> ALLOW / DENY, with a reason
 *
 * Every step fails closed: unknown classification, unknown destination,
 * missing user, unreadable consent — all DENY.
 *
 * This module does not "process" anything itself — it only answers the
 * question "is this allowed", so it can be called from anywhere (a React
 * hook, a local processor, a future edge function) without pulling in UI
 * or processing code. Every caller MUST check `.allowed` and refuse to
 * proceed on false — this module cannot enforce that from here, which is
 * exactly why .ai/DO_NOT_CHANGE.md and code review are the second line of
 * defense: a gate nobody calls is not a gate.
 */

import { DataClassification, ProcessingLocation, policyVerdict, ABSOLUTE_DENY_RULES } from "./dataClassification";
import { ConsentFeature } from "./consentFeatures";
import { hasConsent } from "./consent";

export interface PrivacyCheckRequest {
  userId: string;
  /** Which consent-gated capability this request belongs to. */
  feature: ConsentFeature;
  /** Sensitivity of the specific data being processed right now. */
  classification: DataClassification;
  /** Where the processing would run / where the data would go. */
  destination: ProcessingLocation;
  /** Set false to skip the feature-flag check for features not yet capability-gated — see FEATURE_CAPABILITIES below. */
  requireCapability?: boolean;
  /**
   * The owner explicitly chose to share THIS item with their partner (a tap
   * on a share control, not a setting). Only meaningful for destination
   * PARTNER with SENSITIVE/HIGHLY_SENSITIVE data; anything else ignores it.
   * Absent = false = not shared.
   */
  explicitShare?: boolean;
}

export interface PrivacyCheckResult {
  allowed: boolean;
  reason: string;
}

/**
 * Extra consent a DESTINATION demands on top of the feature's own consent.
 * "Cloud transmission is explicit": sending anything to a cloud AI needs
 * CLOUD_AI_PROCESSING even when the feature itself is consented;
 * showing something to the partner needs SHARED_INSIGHTS; feeding an
 * analytics/diagnostic sink needs ANALYTICS / CRASH_DIAGNOSTICS.
 */
export const DESTINATION_CONSENT: Readonly<Partial<Record<ProcessingLocation, ConsentFeature>>> = {
  [ProcessingLocation.CLOUD_AI]: ConsentFeature.CLOUD_AI_PROCESSING,
  [ProcessingLocation.PARTNER]: ConsentFeature.SHARED_INSIGHTS,
  [ProcessingLocation.ANALYTICS]: ConsentFeature.ANALYTICS,
  [ProcessingLocation.LOGS]: ConsentFeature.CRASH_DIAGNOSTICS,
};

/**
 * Capability gate: is this feature even built and enabled? Distinct from
 * consent — a feature can be fully consented-to and still capability-off
 * (e.g. a kill switch, or "not implemented yet"). Flip a capability to
 * true only when the feature behind it is actually implemented and
 * reviewed — this table is meant to be a second lock, not a formality.
 *
 * Phase 1.6 reconciliation with the real code: the ON-DEVICE camera
 * features (Peek Guard, Daily Mood, face enrollment) exist and ship, so
 * CAMERA_ANALYSIS and MOOD_PROCESSING are true — marking them false while
 * they run was the lie this table had drifted into. Everything that would
 * be relationship AI stays false (see .ai/DO_NOT_BUILD.md).
 */
export const FEATURE_CAPABILITIES: Record<ConsentFeature, boolean> = {
  // Phase 2A (Relationship Intelligence V1): the on-device, explicit-input-only
  // Relationship Reflection feature ships (src/lib/relationship/). These three
  // are the ONLY relationship-AI capabilities turned on. Consent for each is
  // still default-off and evaluated at processing time; CLOUD_AI_PROCESSING
  // stays false because no cloud provider exists (see .ai/LOCAL_AI_ARCHITECTURE.md).
  AI_PROCESSING: true,
  RELATIONSHIP_INSIGHTS: true,
  MOOD_PROCESSING: true, // Daily Mood (MoodDetector.tsx) ships; its server write is gated here.
  VOICE_PROCESSING: false,
  VIDEO_PROCESSING: false,
  CAMERA_ANALYSIS: true, // Peek Guard / mood / face enrollment analyse the camera on-device.
  MICROPHONE_ANALYSIS: false, // Nothing analyses microphone audio (voice messages are recorded, not analysed).
  CLOUD_AI_PROCESSING: false,
  SHARED_INSIGHTS: true, // Phase 2A: explicit per-item partner sharing of reflection items exists; still needs consent + a per-item action.
  ANALYTICS: true, // Analytics/crash diagnostics infra already exists (telemetry.ts) — gate is consent-only, not capability-off.
  CRASH_DIAGNOSTICS: true,
};

const deny = (reason: string): PrivacyCheckResult => ({ allowed: false, reason });

export interface PrivacyGateDeps {
  hasConsent: (userId: string, feature: ConsentFeature) => Promise<boolean>;
}

/** `deps` exists so the gate's decision logic can be tested against an in-memory consent ledger; production callers omit it. */
export async function canProcess(
  req: PrivacyCheckRequest,
  deps: PrivacyGateDeps = { hasConsent },
): Promise<PrivacyCheckResult> {
  // 1. Absolute policy — checked first, cannot be overridden by consent or
  // capability. FAILS CLOSED on any unknown classification/destination.
  const verdict = policyVerdict(req.classification, req.destination);
  if (verdict === "DENY") {
    const rule = ABSOLUTE_DENY_RULES.find(
      (r) => r.classification === req.classification && r.destination === req.destination,
    );
    return deny(`Denied by policy: ${rule?.reason ?? `unknown classification/destination pair (${String(req.classification)} -> ${String(req.destination)}) — failing closed.`}`);
  }

  // 2. Capability check.
  if (req.requireCapability !== false && !FEATURE_CAPABILITIES[req.feature]) {
    return deny(`Feature "${req.feature}" is not enabled in this build.`);
  }

  // 3. Consent check. Fails closed — hasConsent() itself fails closed on
  // any read error, so a network hiccup denies rather than silently
  // allows.
  if (!req.userId) {
    return deny("No authenticated user — cannot check consent.");
  }
  if (!(await deps.hasConsent(req.userId, req.feature))) {
    return deny(`User has not granted consent for "${req.feature}".`);
  }

  // 4. Destination-specific consent ("cloud/partner/analytics is explicit").
  const destinationConsent = DESTINATION_CONSENT[req.destination];
  if (destinationConsent && destinationConsent !== req.feature) {
    // CONSENT verdicts and every non-DEVICE destination with a listed
    // destination-consent both land here; a PUBLIC->ANALYTICS request needs
    // ANALYTICS consent too, which is what "explicit" means.
    if (!(await deps.hasConsent(req.userId, destinationConsent))) {
      return deny(`Destination "${req.destination}" requires separate consent for "${destinationConsent}", which has not been granted.`);
    }
  }

  // 5. Explicit-share requirement for partner egress of reflection/AI data.
  if (verdict === "EXPLICIT_SHARE" && req.explicitShare !== true) {
    return deny("Sharing this data with a partner requires an explicit, per-item share action by its owner.");
  }

  // 6. Belt-and-braces: even if the matrix above were edited wrongly, the
  // two highest-risk classes are re-checked independently. Defense in
  // depth, not redundancy — a bug in (1) alone must not be able to leak raw
  // sensor data or a secret.
  if (req.classification === DataClassification.DEVICE_ONLY && req.destination !== ProcessingLocation.DEVICE) {
    return deny("DEVICE_ONLY data may only be processed on-device.");
  }
  if (req.classification === DataClassification.SECRET) {
    return deny("SECRET data is never routed through PrivacyGate-gated processing at all.");
  }

  return { allowed: true, reason: "OK" };
}

/** Convenience wrapper: throws instead of returning a result, for call
 * sites that want fail-fast (e.g. inside a local processor's entrypoint)
 * rather than branching on `.allowed` themselves. */
export async function requireCanProcess(req: PrivacyCheckRequest): Promise<void> {
  const result = await canProcess(req);
  if (!result.allowed) {
    throw new Error(`PrivacyGate denied: ${result.reason}`);
  }
}
