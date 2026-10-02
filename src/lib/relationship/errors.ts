/**
 * Relationship-feature errors.
 *
 * Every error carries a machine-readable `code` (safe to log / put in
 * telemetry) and a FIXED, user-safe message. Messages are never built from
 * user input, provider output, or an underlying error's message — those can
 * contain the very text this feature exists to protect.
 */
export type RelationshipErrorCode =
  | "VALIDATION"
  | "CONSENT_DENIED"
  | "CONSENT_MISSING"
  | "PROVIDER_NOT_ALLOWED"
  | "CLOUD_NOT_SUPPORTED"
  | "PROVIDER_FAILURE"
  | "PROVIDER_TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "NO_VALID_INSIGHTS"
  | "STORAGE_FAILURE"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "BOUNDARY_NOT_CONFIRMED"
  | "SHARE_DENIED"
  | "SHARE_FAILED"
  | "PREVIEW_MISMATCH"
  | "REVOKE_FAILED"
  | "NO_PARTNER"
  | "LOCAL_MODEL_UNAVAILABLE"
  | "E2E_CLOUD_UNAVAILABLE"
  | "AI_UNAVAILABLE";

export const RELATIONSHIP_ERROR_CODES: readonly RelationshipErrorCode[] = [
  "VALIDATION", "CONSENT_DENIED", "CONSENT_MISSING", "PROVIDER_NOT_ALLOWED", "CLOUD_NOT_SUPPORTED",
  "PROVIDER_FAILURE", "PROVIDER_TIMEOUT", "MALFORMED_RESPONSE", "NO_VALID_INSIGHTS", "STORAGE_FAILURE",
  "NOT_FOUND", "ALREADY_EXISTS", "BOUNDARY_NOT_CONFIRMED", "SHARE_DENIED", "SHARE_FAILED",
  "PREVIEW_MISMATCH", "REVOKE_FAILED", "NO_PARTNER", "LOCAL_MODEL_UNAVAILABLE", "E2E_CLOUD_UNAVAILABLE", "AI_UNAVAILABLE",
];

const SAFE_MESSAGE: Readonly<Record<RelationshipErrorCode, string>> = {
  VALIDATION: "Some of what you entered isn't valid. Please check it and try again.",
  CONSENT_DENIED: "This needs your permission first. You can turn it on under Privacy & AI Data.",
  CONSENT_MISSING: "This needs your permission first. You can turn it on under Privacy & AI Data.",
  PROVIDER_NOT_ALLOWED: "This reflection helper isn't available in this build.",
  E2E_CLOUD_UNAVAILABLE: "Encrypted cloud reflection isn't available.",
  AI_UNAVAILABLE: "Reflection isn't available right now. Nothing was sent anywhere.",
  LOCAL_MODEL_UNAVAILABLE: "The on-device reflection model isn't available here, so the built-in reflection rules were used.",
  CLOUD_NOT_SUPPORTED: "Cloud processing isn't available for relationship reflection.",
  PROVIDER_FAILURE: "The reflection helper couldn't finish. Nothing was saved or sent anywhere.",
  PROVIDER_TIMEOUT: "The reflection helper took too long. Nothing was saved or sent anywhere.",
  MALFORMED_RESPONSE: "The reflection helper returned something unusable, so it was discarded.",
  NO_VALID_INSIGHTS: "No suggestions passed the safety check, so none are shown.",
  STORAGE_FAILURE: "Couldn't read or save on this device.",
  NOT_FOUND: "That item no longer exists.",
  ALREADY_EXISTS: "That item already exists.",
  BOUNDARY_NOT_CONFIRMED: "A boundary has to be confirmed by you explicitly.",
  SHARE_DENIED: "This can't be shared right now.",
  SHARE_FAILED: "Couldn't share. Nothing was shared.",
  PREVIEW_MISMATCH: "This item changed after you previewed it. Review it again before sharing.",
  REVOKE_FAILED: "Couldn't stop sharing right now. Try again in a moment.",
  NO_PARTNER: "You need a linked partner to share with.",
};

export class RelationshipError extends Error {
  readonly code: RelationshipErrorCode;
  constructor(code: RelationshipErrorCode) {
    super(SAFE_MESSAGE[code]);
    this.name = "RelationshipError";
    this.code = code;
  }
}

/** Maps anything thrown to a safe code. Never inspects or forwards the thrown value's message. */
export function toErrorCode(err: unknown, fallback: RelationshipErrorCode = "PROVIDER_FAILURE"): RelationshipErrorCode {
  if (err instanceof RelationshipError) return err.code;
  return fallback;
}
