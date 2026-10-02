/**
 * callUiState — Phase 4 (Calls redesign).
 *
 * The underlying call state machine (the call engine adapter's `callState`:
 * "idle" | "joining" | "joined" | "error") is intentionally coarse — it
 * mirrors the call engine's own lifecycle 1:1 and is NOT changed by this file or
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
 * Nothing here calls into the call engine, Supabase RPCs, CallKit/FCM, or
 * authorization — it only reads state that already exists and reshapes it.
 */

export type CallUiState =
  /** No call session active. */
  | "idle"
  /** Permission probe or create-and-token round trip in flight, or the call engine's
   *  own "joining" phase — before the local participant has actually
   *  joined the room. */
  | "connecting"
  /** Joined the room, but no one else has ever joined it yet — this is
   *  "ringing" from the caller's point of view. */
  | "ringing"
  /** Joined the room with another participant present. */
  | "connected"
  /** Sustained poor network while connected — the call is still up (the call engine
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
  /** the call engine adapter surfaced callState === "error". */
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
  /** True once remote audio is actually PLAYING (engine mediaStage
   *  "call_connected"). When provided and false, a joined room with the
   *  partner present still shows the existing "connecting" state — a
   *  LiveKit room join is not a usable call. Omitted = legacy behaviour. */
  remoteAudioReady?: boolean;
  /** OUTGOING CALLER ONLY: true once the CALL_OFFER has been confirmed
   *  DELIVERED (or RECIPIENT_OFFLINE, still a confirmed ring) by the
   *  signaling server — i.e. the callee's device is actually ringing —
   *  regardless of whether our own LiveKit room join has finished yet.
   *  FIX (stuck on "Connecting…" while the callee is audibly ringing):
   *  this used to be entirely absent from this function, so "ringing" was
   *  only ever derived from callState === "joined" (our media join
   *  completing) — the offer round trip, and the caller's own join to
   *  LiveKit (token fetch + room connect + mic publish, each individually
   *  bounded up to tens of seconds), all happened *underneath* a caller
   *  screen that still said "Connecting…", even though the callee's phone
   *  was already ringing the entire time. Once this is true, "connecting"
   *  is shown as "ringing" instead — matching what is actually happening
   *  on the other end, exactly like a real phone call. Omitted/false =
   *  previous behaviour (receiver side never sets this). */
  offerRinging?: boolean;
  /** Which side of the call this device is (from the call state machine's
   *  session). INSTANT-CALL FIX: when provided, the screen never shows
   *  "Connecting…" on the normal path, like a phone call:
   *    - outgoing: "ringing" from the very tap (setup + offer + our own media
   *      join all happen behind the ringing screen, no Connecting → Ringing →
   *      Connecting → Ringing flicker);
   *    - incoming: the in-call screen ("connected") from the Accept tap,
   *      the claim/token/join happen behind it.
   *  Failures still surface through "error" / the outcome screens / toasts;
   *  the timer only starts when remote audio actually plays (mediaStage).
   *  Omitted = previous behaviour (explicit "connecting" stage). */
  direction?: "outgoing" | "incoming" | null;
}

export function deriveCallUiState(input: CallUiStateInput): CallUiState {
  const { callState, isStartingCall, participantCount, everConnected, networkQuality, remoteAudioReady, offerRinging, direction } = input;

  if (callState === "error") return "error";
  if (callState === "idle" && !isStartingCall) return "idle";

  const preMedia = callState === "idle" || callState === "joining" || (isStartingCall && callState !== "joined");
  if (preMedia) {
    if (direction === "incoming") return "connected"; // answered: in-call screen immediately
    if (direction === "outgoing") return everConnected ? "partner-left" : "ringing"; // dialing/ringing from the tap
    return offerRinging ? "ringing" : "connecting";
  }

  // callState === "joined" from here on.
  if (participantCount > 1) {
    // Partner is in the room. Audio may still be starting: with a known
    // direction that's invisible (the call screen is already up); legacy
    // callers keep the explicit "connecting" stage.
    if (remoteAudioReady === false && !direction) return "connecting";
    return networkQuality === "poor" ? "reconnecting" : "connected";
  }
  if (direction === "incoming" && !everConnected) return "connected"; // caller's own join still finishing
  return everConnected ? "partner-left" : "ringing";
}

/** Terminal outcomes — shown briefly AFTER leaveCall() has already run,
 *  never a substitute for it. Purely about what message to show. */
export type CallOutcome =
  /** The receiver explicitly tapped Decline. Distinguished from no-answer
   *  via call_history.declined_at (see migration
   *  20260824_call_declined_marker.sql). Rows written before that migration
   *  is applied to the live project carry declined_at = null and surface as
   *  "no-answer" instead — honest degradation, never a wrong claim. */
  | { type: "declined" }
  /** Receiver decline could not be confirmed — ring lapsed server-side,
   *  unreachable device, or a pre-marker-migration decline. */
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
