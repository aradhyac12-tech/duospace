/**
 * DuoSpace Error System — shared types.
 *
 * This is the single source of truth for what an "error" IS in DuoSpace.
 * Every error surfaced anywhere in the app (React render errors, network
 * failures, Supabase failures, media/upload failures, call failures, theme
 * failures, navigation failures, or anything uncaught) is normalized into
 * a `DuoSpaceErrorPayload` before it reaches the UI or the log store.
 */

/** Module segment of a `DS-<MODULE>-<NUMBER>` error code. */
export type ErrorModule =
  | "AUTH"
  | "NET"
  | "DB"
  | "SUPA"
  | "CHAT"
  | "CALL"
  | "VOICE"
  | "VIDEO"
  | "MEDIA"
  | "DOWNLOAD"
  | "NOTIFY"
  | "PERM"
  | "STORAGE"
  | "THEME"
  | "ICON"
  | "WL"
  | "SETTINGS"
  | "PROFILE"
  | "NAV"
  | "ROUTE"
  | "DEEPLINK"
  | "SYNC"
  | "OFFLINE"
  | "CRYPTO"
  | "BACKUP"
  | "RESTORE"
  | "RATE"
  | "SECURITY"
  | "DEV"
  | "API"
  | "UNKNOWN";

export type ErrorCategory =
  | "Authentication"
  | "Network"
  | "Database"
  | "Supabase"
  | "Messaging"
  | "Calls"
  | "Voice"
  | "Video"
  | "Media Upload"
  | "Downloads"
  | "Notifications"
  | "Permissions"
  | "Storage"
  | "Theme Studio"
  | "Icon Studio"
  | "White Label"
  | "Settings"
  | "Profile"
  | "Navigation"
  | "Routing"
  | "Deep Links"
  | "Cloud Sync"
  | "Offline Mode"
  | "Encryption"
  | "Backup"
  | "Restore"
  | "Rate Limits"
  | "Security"
  | "Developer"
  | "Unknown";

export type ErrorSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "FATAL";

/** Names of built-in recovery strategies (see `recovery.ts`). */
export type RecoveryAction =
  | "retry-network"
  | "retry-supabase"
  | "refresh-session"
  | "resume-upload"
  | "reconnect-socket"
  | "restore-previous-theme"
  | "none";

/** Static metadata for a known error code — lives in `registry.ts`. */
export interface ErrorDefinition {
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  title: string;
  /** User-friendly technical description shown in the (collapsed) card body. */
  message: string;
  /** Short, actionable recovery suggestion shown to the user. */
  recoverySuggestion: string;
  retryable: boolean;
  recoveryAction: RecoveryAction;
}

/** Device/runtime context captured automatically at the point of failure. */
export interface DeviceInfo {
  platform: string; // "ios" | "android" | "web"
  isNative: boolean;
  userAgent: string;
  online: boolean;
  viewport: string; // "390x844"
}

/** Everything captured about a single error occurrence. */
export interface DuoSpaceErrorPayload {
  /** Unique per-occurrence id (not the error code — many occurrences share a code). */
  id: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  title: string;
  message: string;
  recoverySuggestion: string;
  retryable: boolean;
  recoveryAction: RecoveryAction;

  screen?: string;
  component?: string;
  action?: string;

  timestamp: string; // ISO 8601
  sessionId: string;
  appVersion: string;
  device: DeviceInfo;

  /** Arbitrary structured debug metadata (API response, props, etc). Never rendered in production UI. */
  details?: Record<string, unknown>;
  /** Stack trace — captured always, but only ever displayed when Developer Mode is on. */
  stack?: string;

  /** Number of times this same (code + message) has occurred this session. */
  occurrenceCount: number;
}

/** Options accepted when raising a new error through the manager. */
export interface CaptureOptions {
  screen?: string;
  component?: string;
  action?: string;
  details?: Record<string, unknown>;
  /** Underlying caught error/exception, used to extract a stack trace. */
  cause?: unknown;
  /** Override the retryable flag for this specific occurrence. */
  retryable?: boolean;
}
