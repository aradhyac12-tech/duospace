/**
 * Human-readable failure for a self-hosted call that could not be
 * signaled. There is deliberately NO fallback here: when the dedicated
 * signaling layer is unavailable the self-hosted call fails clearly and
 * quickly. Switching to the call engine is a provider decision the user/config
 * makes — it never happens implicitly behind their back.
 */
import type { ReadyResult, SignalingResult } from "./types";

export class SignalingUnavailableError extends Error {
  constructor(readonly detail: string, message = "Can't reach the calling service right now. Check your connection and try again.") {
    super(message);
    this.name = "SignalingUnavailableError";
  }
}

export function signalingNotReadyError(r: ReadyResult): SignalingUnavailableError {
  return r.reason === "NOT_CONFIGURED"
    ? new SignalingUnavailableError("not_configured", "Self-hosted calling isn't set up on this build.")
    : new SignalingUnavailableError(`not_ready:${r.reason ?? "unknown"}`);
}

/** For an OFFER whose result is not "server accepted it". */
export function inviteFailureError(r: SignalingResult): SignalingUnavailableError {
  if (r.status === "REJECTED") {
    if (r.reason === "NOT_PARTNERS") return new SignalingUnavailableError("not_partners", "You can only call your partner.");
    return new SignalingUnavailableError(`invite_rejected:${r.reason}`, "The call couldn't be started. Please try again.");
  }
  return new SignalingUnavailableError(`invite_${r.status.toLowerCase()}`);
}
