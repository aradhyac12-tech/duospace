/**
 * CALL-HISTORY VALIDATION FIX: call_history.status used to be written as
 * only ever 'in_progress' -> 'completed' or 'missed', collapsing several
 * genuinely different outcomes into one bucket:
 *   - a call that connected and was talked on ('completed', duration > 0)
 *   - a call ended before it ever connected, by the caller ('completed',
 *     duration === 0 — indistinguishable from the line above at the DB
 *     level until CallHistoryRow re-derived it client-side)
 *   - a call that rang out unanswered ('missed', declined_at IS NULL)
 *   - a call the receiver actively rejected ('missed', declined_at IS NOT
 *     NULL — also only distinguishable via a second column)
 *   - a call cancelled by the caller before the receiver ever claimed it
 *     (cancel_call() already wrote 'cancelled' distinctly — the one outcome
 *     that WAS already correct)
 *   - the partner-busy pre-check bailout (never reached call_history at
 *     all — no row is ever created for it, so it's not a status to derive)
 *   - a setup exception (network failure, the call engine error, permission denial)
 *     that previously left the row silently stuck at 'in_progress' forever,
 *     since the FAILED machine-state transition never wrote to the DB
 *
 * This module is the single place that turns a call_history row into one
 * of a small set of outcomes, so every UI (CallHistoryRow, any future
 * export/summary) reads the same classification instead of each
 * re-deriving its own "duration === 0 means X" heuristic.
 */

export type CallOutcome =
  | "answered"
  | "missed"       // rang out, nobody declined or picked up
  | "declined"     // receiver explicitly rejected
  | "cancelled"    // caller ended it before it connected
  | "busy"         // partner was already on another DuoSpace call
  | "failed";      // setup/network/media error, never reached ringing properly

export interface CallOutcomeInput {
  status: string;
  duration_seconds: number;
  declined_at: string | null;
  cancel_reason?: string | null;
}

export function classifyCallOutcome(call: CallOutcomeInput): CallOutcome {
  if (call.status === "completed") {
    // A 'completed' row with zero duration only happens via a stale/older
    // write predating this fix, or a race where ended_at landed before
    // duration_seconds did — treat it as cancelled rather than a real
    // answered call, since a genuinely answered call always has duration.
    return call.duration_seconds > 0 ? "answered" : "cancelled";
  }
  if (call.status === "cancelled") return "cancelled";
  if (call.status === "busy") return "busy";
  if (call.status === "failed") return "failed";
  if (call.status === "missed") return call.declined_at ? "declined" : "missed";
  // Anything else (still 'in_progress' — e.g. a row the expire-stale-calls
  // sweep hasn't reached yet) reads as missed rather than crashing a label
  // lookup on an unrecognized status.
  return "missed";
}

/** True for any outcome that should show the destructive/"you didn't
 *  connect" treatment in the UI (red icon, no duration). Kept separate from
 *  classifyCallOutcome so call sites that only care about this binary
 *  (e.g. unread-missed-call badges) don't need a switch over every case. */
export function isUnconnectedOutcome(outcome: CallOutcome): boolean {
  return outcome !== "answered";
}
