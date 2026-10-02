/**
 * Partner unlink — shared pieces for the two-sided (consent) flow.
 *
 * Unlinking is no longer something one phone can do to the other. The flow is:
 *
 *   1. A taps "Unlink" → request_unlink() RPC → an `unlink_requests` row is
 *      created and B is notified (in-app via realtime + a push).
 *   2. B sees an approval dialog (UnlinkRequestHost, mounted app-wide) and
 *      answers with respond_unlink(): Allow ends the pairing on BOTH accounts
 *      in one transaction; Decline leaves everything as it was.
 *   3. A is told the outcome (toast + push).
 *
 * All of that is enforced in the database (see
 * supabase/migrations/20260920150000_partner_unlink_consent.sql) — the client
 * can't skip step 2. This file only holds the small helpers both screens use.
 */
import { clearCachedPartner } from "@/lib/partnerCache";

/** Window event: "something about unlink requests may have changed, re-check". */
export const UNLINK_REQUESTS_CHANGED_EVENT = "duo:unlink-requests-changed";

/** sessionStorage flag so the reload that follows an unlink can still say what happened. */
const UNLINK_NOTICE_KEY = "duo-unlink-notice";

export type UnlinkRequestStatus = "pending" | "approved" | "declined" | "cancelled" | "expired";

export interface UnlinkRequest {
  id: string;
  requester_id: string;
  partner_id: string; // the person being asked (the receiver)
  status: UnlinkRequestStatus;
  created_at: string;
  expires_at: string;
  responded_at: string | null;
}

/** Error codes the unlink RPCs return in `{ error }` (never thrown). */
export type UnlinkErrorCode =
  | "NOT_SIGNED_IN"
  | "NOT_LINKED"
  | "NOT_FOUND"
  | "ALREADY_HANDLED"
  | "EXPIRED"
  | "INVALID_ARGUMENT";

/** Person-readable text for an RPC error code. */
export function describeUnlinkError(code: string | undefined): string {
  switch (code) {
    case "NOT_LINKED":
      return "You're not linked with anyone anymore.";
    case "EXPIRED":
      return "That request has expired. Ask again if you still want to unlink.";
    case "ALREADY_HANDLED":
    case "NOT_FOUND":
      return "That request was already answered or withdrawn.";
    case "NOT_SIGNED_IN":
      return "Please sign in again and retry.";
    default:
      return "Something went wrong on our end — please try again in a moment.";
  }
}

/** Is this request still open (pending and not past its expiry)? */
export function isOpenRequest(r: Pick<UnlinkRequest, "status" | "expires_at">, now = Date.now()): boolean {
  if (r.status !== "pending") return false;
  const exp = Date.parse(r.expires_at);
  return !Number.isFinite(exp) || exp > now;
}

/**
 * This device's record of who the partner is must go the moment the pairing
 * ends — otherwise the next cold start pre-fills the ex-partner into Chat.
 * Also leaves a one-shot note so the post-unlink reload can confirm it.
 */
export function markPartnerUnlinked(userId: string): void {
  clearCachedPartner(userId);
  // The on-device copy of the OLD conversation (messages + cached media) must
  // go with the pairing, or the ex-partner's history would sit on this phone
  // and could reappear. Dynamic import keeps this module light for its tests
  // and callers; failure is harmless (best-effort, the server is unaffected).
  void import("@/lib/localDb").then((m) => m.wipeLocalConversationData(userId)).catch(() => {});
  try { sessionStorage.setItem(UNLINK_NOTICE_KEY, "1"); } catch { /* storage unavailable — the reload still happens */ }
}

/** True once (and only once) after an unlink-triggered reload. */
export function consumeUnlinkNotice(): boolean {
  try {
    if (sessionStorage.getItem(UNLINK_NOTICE_KEY) !== "1") return false;
    sessionStorage.removeItem(UNLINK_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}

