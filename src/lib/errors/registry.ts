/**
 * DuoSpace Error Registry.
 *
 * Static catalog of every known `DS-<MODULE>-<NUMBER>` error code and its
 * metadata (category, severity, user-facing copy, recovery action).
 *
 * Adding a new error code is a two-line change: add the code to the
 * `ErrorModule` union in `types.ts` if it's a new module, then add an entry
 * here. Every other part of the system (UI, logging, recovery, filtering)
 * works off this table plus whatever is passed to `capture()` at the call site.
 */
import type { ErrorDefinition } from "./types";

export const ERROR_REGISTRY: Record<string, ErrorDefinition> = {
  // ── Authentication ────────────────────────────────────────────────────
  "DS-AUTH-001": {
    code: "DS-AUTH-001", category: "Authentication", severity: "ERROR",
    title: "Incorrect email or password",
    message: "The credentials you entered don't match an account.",
    recoverySuggestion: "Double-check your email and password, or reset your password.",
    retryable: true, recoveryAction: "none",
  },
  "DS-AUTH-002": {
    code: "DS-AUTH-002", category: "Authentication", severity: "WARNING",
    title: "Your session expired",
    message: "You were signed out because your session token expired.",
    recoverySuggestion: "We'll try to refresh your session automatically.",
    retryable: true, recoveryAction: "refresh-session",
  },
  "DS-AUTH-003": {
    code: "DS-AUTH-003", category: "Authentication", severity: "ERROR",
    title: "Google sign-in failed",
    message: "Google didn't return a valid sign-in response.",
    recoverySuggestion: "Try signing in again, or use email and password instead.",
    retryable: true, recoveryAction: "none",
  },
  "DS-AUTH-004": {
    code: "DS-AUTH-004", category: "Authentication", severity: "ERROR",
    title: "Permission denied",
    message: "This account doesn't have permission to do that.",
    recoverySuggestion: "Sign in with the correct account, or ask your partner for access.",
    retryable: false, recoveryAction: "none",
  },

  // ── Network ────────────────────────────────────────────────────────────
  "DS-NET-001": {
    code: "DS-NET-001", category: "Network", severity: "WARNING",
    title: "No internet connection",
    message: "This device appears to be offline.",
    recoverySuggestion: "Check your Wi-Fi or mobile data and try again.",
    retryable: true, recoveryAction: "retry-network",
  },
  "DS-NET-002": {
    code: "DS-NET-002", category: "Network", severity: "ERROR",
    title: "Connection timed out",
    message: "The request took too long to respond.",
    recoverySuggestion: "We'll retry automatically — or tap retry now.",
    retryable: true, recoveryAction: "retry-network",
  },
  "DS-NET-003": {
    code: "DS-NET-003", category: "Network", severity: "ERROR",
    title: "Server unreachable",
    message: "DuoSpace's servers couldn't be reached.",
    recoverySuggestion: "This is usually temporary. Try again in a moment.",
    retryable: true, recoveryAction: "retry-network",
  },

  // ── Messaging ──────────────────────────────────────────────────────────
  "DS-CHAT-001": {
    code: "DS-CHAT-001", category: "Messaging", severity: "ERROR",
    title: "Message didn't send",
    message: "Your message couldn't be delivered.",
    recoverySuggestion: "Tap retry to send it again.",
    retryable: true, recoveryAction: "retry-network",
  },
  "DS-CHAT-002": {
    code: "DS-CHAT-002", category: "Messaging", severity: "WARNING",
    title: "Chat sync failed",
    message: "Recent messages couldn't be synced from the server.",
    recoverySuggestion: "We'll keep retrying in the background.",
    retryable: true, recoveryAction: "retry-supabase",
  },
  "DS-CHAT-003": {
    code: "DS-CHAT-003", category: "Messaging", severity: "ERROR",
    title: "Attachment failed",
    message: "A photo or file attached to this message failed to upload.",
    recoverySuggestion: "Check your connection and try attaching it again.",
    retryable: true, recoveryAction: "resume-upload",
  },
  "DS-CHAT-014": {
    code: "DS-CHAT-014", category: "Messaging", severity: "WARNING",
    title: "Reaction didn't save",
    message: "Your message reaction couldn't be saved to the server.",
    recoverySuggestion: "Tap the reaction again to retry.",
    retryable: true, recoveryAction: "retry-supabase",
  },

  // ── Calls / Voice / Video ──────────────────────────────────────────────
  "DS-CALL-001": {
    code: "DS-CALL-001", category: "Calls", severity: "ERROR",
    title: "Call connection failed",
    message: "DuoSpace couldn't establish the call.",
    recoverySuggestion: "Check your connection and try calling again.",
    retryable: true, recoveryAction: "reconnect-socket",
  },
  "DS-CALL-002": {
    code: "DS-CALL-002", category: "Calls", severity: "ERROR",
    title: "Microphone permission missing",
    message: "DuoSpace doesn't have permission to use the microphone.",
    recoverySuggestion: "Enable microphone access in your device settings.",
    retryable: false, recoveryAction: "none",
  },
  "DS-CALL-003": {
    code: "DS-CALL-003", category: "Calls", severity: "ERROR",
    title: "Camera permission missing",
    message: "DuoSpace doesn't have permission to use the camera.",
    recoverySuggestion: "Enable camera access in your device settings.",
    retryable: false, recoveryAction: "none",
  },
  "DS-CALL-007": {
    code: "DS-CALL-007", category: "Calls", severity: "WARNING",
    title: "Call reconnecting",
    message: "The call connection dropped and is being restored.",
    recoverySuggestion: "Hang tight — reconnecting automatically.",
    retryable: true, recoveryAction: "reconnect-socket",
  },

  // ── Storage / Media / Downloads ────────────────────────────────────────
  "DS-STORAGE-001": {
    code: "DS-STORAGE-001", category: "Storage", severity: "ERROR",
    title: "Storage full",
    message: "There isn't enough space to complete this action.",
    recoverySuggestion: "Free up space on your device and try again.",
    retryable: true, recoveryAction: "none",
  },
  "DS-STORAGE-002": {
    code: "DS-STORAGE-002", category: "Storage", severity: "WARNING",
    title: "File too large",
    message: "This file is larger than DuoSpace's upload limit.",
    recoverySuggestion: "Try a smaller file, or compress it first.",
    retryable: false, recoveryAction: "none",
  },
  "DS-STORAGE-003": {
    code: "DS-STORAGE-003", category: "Storage", severity: "ERROR",
    title: "Upload failed",
    message: "This file couldn't be uploaded.",
    recoverySuggestion: "We'll resume the upload from where it left off.",
    retryable: true, recoveryAction: "resume-upload",
  },

  // ── Cloud Sync ──────────────────────────────────────────────────────────
  "DS-SYNC-001": {
    code: "DS-SYNC-001", category: "Cloud Sync", severity: "WARNING",
    title: "Sync failed",
    message: "Your latest changes couldn't be synced.",
    recoverySuggestion: "We'll try again automatically once you're back online.",
    retryable: true, recoveryAction: "retry-supabase",
  },
  "DS-SYNC-002": {
    code: "DS-SYNC-002", category: "Cloud Sync", severity: "WARNING",
    title: "Sync conflict detected",
    message: "The same item was changed on two devices at once.",
    recoverySuggestion: "The most recent change was kept automatically.",
    retryable: false, recoveryAction: "none",
  },
  "DS-SYNC-010": {
    code: "DS-SYNC-010", category: "Cloud Sync", severity: "INFO",
    title: "Sync delayed",
    message: "Sync is taking longer than usual.",
    recoverySuggestion: "This usually resolves on its own within a minute.",
    retryable: true, recoveryAction: "retry-supabase",
  },

  // ── Theme / Icon / White Label ─────────────────────────────────────────
  "DS-THEME-001": {
    code: "DS-THEME-001", category: "Theme Studio", severity: "WARNING",
    title: "Theme failed to load",
    message: "A saved theme couldn't be loaded.",
    recoverySuggestion: "Restoring your previous theme.",
    retryable: true, recoveryAction: "restore-previous-theme",
  },
  "DS-THEME-002": {
    code: "DS-THEME-002", category: "Theme Studio", severity: "WARNING",
    title: "Invalid theme",
    message: "This theme's data is malformed or corrupted.",
    recoverySuggestion: "Restoring your previous theme.",
    retryable: false, recoveryAction: "restore-previous-theme",
  },
  "DS-ICON-001": {
    code: "DS-ICON-001", category: "Icon Studio", severity: "ERROR",
    title: "Icon generation failed",
    message: "DuoSpace couldn't generate this app icon.",
    recoverySuggestion: "Try a different image or preset.",
    retryable: true, recoveryAction: "none",
  },
  "DS-ICON-002": {
    code: "DS-ICON-002", category: "Icon Studio", severity: "ERROR",
    title: "Icon export failed",
    message: "The generated icon couldn't be exported.",
    recoverySuggestion: "Try exporting again.",
    retryable: true, recoveryAction: "none",
  },
  "DS-ICON-004": {
    code: "DS-ICON-004", category: "Icon Studio", severity: "WARNING",
    title: "Icon preview unavailable",
    message: "A live preview of this icon couldn't be rendered.",
    recoverySuggestion: "The icon can still be saved and applied normally.",
    retryable: true, recoveryAction: "none",
  },
  "DS-WL-001": {
    code: "DS-WL-001", category: "White Label", severity: "ERROR",
    title: "Brand configuration invalid",
    message: "This white-label brand configuration is missing required fields.",
    recoverySuggestion: "Check the brand config file and try again.",
    retryable: false, recoveryAction: "none",
  },

  // ── Notifications / Permissions ────────────────────────────────────────
  "DS-NOTIFY-006": {
    code: "DS-NOTIFY-006", category: "Notifications", severity: "WARNING",
    title: "Notification delivery failed",
    message: "A push notification couldn't be delivered to this device.",
    recoverySuggestion: "Check notification permissions in your device settings.",
    retryable: true, recoveryAction: "none",
  },

  // ── API / Supabase ──────────────────────────────────────────────────────
  "DS-API-001": {
    code: "DS-API-001", category: "Supabase", severity: "ERROR",
    title: "Unexpected server response",
    message: "The server returned a response DuoSpace didn't expect.",
    recoverySuggestion: "Try again, or contact support if it keeps happening.",
    retryable: true, recoveryAction: "retry-supabase",
  },
  "DS-API-002": {
    code: "DS-API-002", category: "Rate Limits", severity: "WARNING",
    title: "Too many requests",
    message: "You're doing that a bit too fast.",
    recoverySuggestion: "Wait a moment and try again.",
    retryable: true, recoveryAction: "retry-network",
  },
  "DS-API-011": {
    code: "DS-API-011", category: "Supabase", severity: "ERROR",
    title: "Server function unavailable",
    message: "A required server function isn't reachable right now.",
    recoverySuggestion: "This is usually temporary — try again shortly.",
    retryable: true, recoveryAction: "retry-supabase",
  },

  // ── Fallback ─────────────────────────────────────────────────────────────
  "DS-UNKNOWN-001": {
    code: "DS-UNKNOWN-001", category: "Unknown", severity: "ERROR",
    title: "Something went wrong",
    message: "An unexpected error occurred.",
    recoverySuggestion: "Try again. If this keeps happening, report the bug below.",
    retryable: true, recoveryAction: "none",
  },
};

/** Look up a code's static definition, falling back to DS-UNKNOWN-001. */
export function getErrorDefinition(code: string): ErrorDefinition {
  return ERROR_REGISTRY[code] ?? ERROR_REGISTRY["DS-UNKNOWN-001"];
}

/** All distinct categories currently present in the registry (for filter UIs). */
export function listCategories(): string[] {
  return Array.from(new Set(Object.values(ERROR_REGISTRY).map((d) => d.category))).sort();
}
