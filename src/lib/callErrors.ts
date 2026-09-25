import { extractErrorMessage } from "@/lib/errorMessage";

/**
 * Centralized call-error taxonomy.
 *
 * Before this, the call engine adapter's `error` state was a raw string produced by
 * extractErrorMessage() — enough to show *something* in the UI, but not
 * enough to answer "is this worth retrying automatically", "how bad is
 * this", or "what actually broke" without re-parsing the message text
 * again at every call site. This gives every call failure a stable code,
 * a severity, a pre-written user-facing message, and explicit
 * recoverable/retryable flags, so the UI and any retry logic can branch on
 * structured data instead of string-matching.
 */
export type CallErrorCode =
  | "JOIN_FAILED"
  | "PERMISSION_DENIED"
  | "NETWORK_TIMEOUT"
  | "DUPLICATE_INSTANCE"
  | "DEVICE_UNAVAILABLE"
  | "TOKEN_EXPIRED"
  | "ROOM_NOT_FOUND"
  | "UNKNOWN";

export interface CallError {
  code: CallErrorCode;
  severity: "critical" | "high" | "medium" | "low";
  /** Safe to show directly in the call UI. */
  message: string;
  /** Raw underlying message, for logging/telemetry only — never render this. */
  detail: string;
  recoverable: boolean;
  retryable: boolean;
}

type ErrorCatalogEntry = Omit<CallError, "detail">;

const CATALOG: Record<CallErrorCode, ErrorCatalogEntry> = {
  JOIN_FAILED: {
    code: "JOIN_FAILED",
    severity: "high",
    message: "Couldn't connect the call. Check your connection and try again.",
    recoverable: true,
    retryable: true,
  },
  PERMISSION_DENIED: {
    code: "PERMISSION_DENIED",
    severity: "medium",
    message: "Camera or microphone access is blocked. Check your device permissions and try again.",
    recoverable: true,
    retryable: true,
  },
  NETWORK_TIMEOUT: {
    code: "NETWORK_TIMEOUT",
    severity: "high",
    message: "Lost connection and couldn't reconnect. Try again when your signal improves.",
    recoverable: true,
    retryable: true,
  },
  DUPLICATE_INSTANCE: {
    code: "DUPLICATE_INSTANCE",
    severity: "medium",
    message: "A call is already in progress.",
    recoverable: true,
    retryable: false,
  },
  DEVICE_UNAVAILABLE: {
    code: "DEVICE_UNAVAILABLE",
    severity: "medium",
    message: "Your camera or microphone is being used by another app.",
    recoverable: true,
    retryable: true,
  },
  TOKEN_EXPIRED: {
    code: "TOKEN_EXPIRED",
    severity: "high",
    message: "Your call session expired. Reconnecting...",
    recoverable: true,
    retryable: true,
  },
  ROOM_NOT_FOUND: {
    code: "ROOM_NOT_FOUND",
    severity: "medium",
    message: "This call has ended or the link is no longer valid.",
    recoverable: false,
    retryable: false,
  },
  UNKNOWN: {
    code: "UNKNOWN",
    severity: "medium",
    message: "Something went wrong with the call. Please try again.",
    recoverable: true,
    retryable: true,
  },
};

/**
 * Turns whatever the call engine / the browser / our own code threw into a
 * structured CallError. Pattern-matches on the extracted message text —
 * not perfectly precise (LiveKit / the livekit-token function don't expose
 * one stable error-code enum across every failure path), but far more
 * useful than a bare string.
 */
export function classifyCallError(raw: unknown): CallError {
  const detail = extractErrorMessage(raw, "Unknown call error");
  const msg = detail.toLowerCase();

  let code: CallErrorCode = "UNKNOWN";
  if (/duplicate/.test(msg)) code = "DUPLICATE_INSTANCE";
  else if (/permission|notallowederror|denied/.test(msg)) code = "PERMISSION_DENIED";
  else if (/notreadableerror|trackstart|in use|device/.test(msg)) code = "DEVICE_UNAVAILABLE";
  else if (/(?<!ring_)expired|401|unauthorized|invalid.*token/.test(msg) && !/no longer ringing/.test(msg)) code = "TOKEN_EXPIRED";
  else if (/not found|404|room.*(gone|deleted|expired)|no longer (active|ringing)|room_unavailable|ring_expired|not_claimed|not_a_participant|not authorized for this call/.test(msg)) code = "ROOM_NOT_FOUND";
  else if (/timeout|network|disconnect/.test(msg)) code = "NETWORK_TIMEOUT";
  else if (msg && msg !== "unknown call error") code = "JOIN_FAILED";

  return { ...CATALOG[code], detail };
}
