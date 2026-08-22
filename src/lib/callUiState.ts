/**
 * callUiState — Phase 4 (Calls redesign).
 *
 * The underlying call state machine (`useDailyCall`'s `callState`:
 * "idle" | "joining" | "joined" | "error") is intentionally coarse — it
 * mirrors Daily.co's own lifecycle 1:1 and is NOT changed by this file or
 * anything that consumes it. Everything below is a pure, additive
 * presentation layer on top of that plus a couple of existing sibling
 * signals (`isStartingCall`, `participantCount`, `networkQuality`,
 * `autoAudioFallback`) that already exist on `useCall()`. It turns them
 * into the explicit, named states the call screens actually render
 * against, so "what does the UI show right now" has one obvious answer
 * instead of being re-derived ad hoc (and inconsistently) at every call
 * site — which is exactly what had happened: `Calls.tsx` and
 * `CallOverlay.tsx` each independently duplicated a slightly different
 * version of the same "isStartingCall || joining || joined" gate.
 *
 * Nothing here calls into Daily, Supabase RPCs, CallKit/FCM, or
 * authorization — it only reads state that already exists and reshapes it.
 */

export type CallUiState =
  /** No call session active. */
  | "idle"
  /** Permission probe or create-and-token round trip in flight, or Daily's
   *  own "joining" phase — before the local participant has actually
   *  joined the room. */
  | "connecting"
  /** Joined the room, but no one else has ever joined it yet — this is
   *  "ringing" from the caller's point of view. */
  | "ringing"
  /** Joined the room with another participant present. */
  | "connected"
  /** Sustained poor network while connected — the call is still up (Daily
   *  keeps retrying under the hood), just visibly degraded. Distinct from
   *  "connected" so the UI can show a banner instead of pretending
   *  everything is fine. */
  | "reconnecting"
  /** Was connected (another participant joined at some point), and now
   *  no one else is present. Visually identical inputs to "ringing"
   *  (participantCount <= 1) but a completely different meaning to the
   *  person on the call — conflating the two was a confirmed bug (see
   *  useCallOutcome.ts and CALL_GALLERY_QA.md, "call ends unexpectedly"). */
  | "partner-left"
  /** useDailyCall surfaced callState === "error". */
  | "error";

export interface CallUiStateInput {
  callState: "idle" | "joining" | "joined" | "error";
  isStartingCall: boolean;
  participantCount: number;
  /** True once this call session has ever had >1 participant. Callers are
   *  expected to track this in a ref/state that resets when a fresh call
   *  starts — it is NOT derivable from participantCount alone since that
   *  drops back to 1 both before anyone has answered and after they leave. */
  everConnected: boolean;
  networkQuality: "excellent" | "good" | "fair" | "poor";
}

export function deriveCallUiState(input: CallUiStateInput): CallUiState {
  const { callState, isStartingCall, participantCount, everConnected, networkQuality } = input;

  if (callState === "error") return "error";
  if (callState === "idle" && !isStartingCall) return "idle";
  if (callState === "idle" || callState === "joining") return "connecting";
  if (isStartingCall && callState !== "joined") return "connecting";

  // callState === "joined" from here on.
  if (participantCount > 1) {
    return networkQuality === "poor" ? "reconnecting" : "connected";
  }
  return everConnected ? "partner-left" : "ringing";
}

/** Terminal outcomes — shown briefly AFTER leaveCall() has already run,
 *  never a substitute for it. Purely about what message to show. */
export type CallOutcome =
  /** Receiver declined, or the 30s ring timer lapsed — the server can't
   *  and doesn't distinguish these (both land as call_history.status =
   *  'missed'), so neither does this UI; "No answer" is honest either way. */
  | { type: "no-answer" }
  /** The outgoing call was cancelled from another signed-in
   *  device/session before this one connected. (A cancel initiated on
   *  *this* device is handled locally, synchronously — it never needs
   *  this screen.) */
  | { type: "cancelled-elsewhere" }
  /** This device's own call attempt failed outright. */
  | { type: "failed"; message: string };

export const CALL_UI_STATE_LABEL: Record<CallUiState, string> = {
  idle: "",
  connecting: "Connecting…",
  ringing: "Ringing…",
  connected: "",
  reconnecting: "Reconnecting…",
  "partner-left": "left the call",
  error: "Call failed",
};

/**
 * Haptic semantics for call state transitions — documented once here so
 * every call site fires the same weight for the same meaning instead of
 * picking one arbitrarily per component:
 *
 *   - hapticMedium(): every control tap that changes a live call
 *     property (mute, camera, screen share, route/camera picker open).
 *   - hapticHeavy(): ending a connected call (destructive + final).
 *   - hapticWarning(): a call outcome the person didn't choose — no
 *     answer, cancelled elsewhere, reconnect-timeout failure.
 *   - hapticSelection(): picking an item from a sheet/menu (camera,
 *     audio route).
 *   - hapticLight(): opening/closing a non-destructive sheet or toggle
 *     (lip-reading, PiP, camera-picker visibility).
 *   - Accept/decline on the incoming-call screen use the OS-level ring
 *     vibration pattern (startCallVibration/stopCallVibration), not a
 *     one-shot haptic, since the phone is actively ringing up to that
 *     point.
 */
export const CALL_HAPTIC_SEMANTICS = true;
