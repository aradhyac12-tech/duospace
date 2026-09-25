import { Capacitor } from "@capacitor/core";

/**
 * GAP FIX (calling-reliability follow-up): DuospaceCallKitBridge's
 * reportOutgoingCall/reportCallConnected/reportCallEnded existed on both
 * platforms (native-plugins/callkit-bridge) but were never actually called
 * from anywhere in this app's call-initiation code — dead bridge methods.
 * Net effect: outgoing calls never registered with iOS CallKit or Android
 * Telecom, never got a system "Calling…" notification the way incoming
 * calls already do, and the screen never blanked against your ear during a
 * voice call the way a real phone call does (see
 * native/android/CallOngoingService.kt and CallKitManager.swift's
 * reportCallConnected for the actual mechanism on each platform).
 *
 * This module is the one place that wires those three moments —
 * dialing-started / really-connected / ended — so Calls.tsx, Chat.tsx, and
 * CallContext.tsx (the three outgoing/accept call sites) can't drift out of
 * sync with each other on how/when they call the bridge. Best-effort by
 * design, same as every other native-bridge call in this codebase: a
 * failure here (plugin not registered, running on web, mid-rollout native
 * build without the new plugin methods yet) must never block or fail the
 * call itself, which works via the call engine/WebRTC independent of this layer.
 */

type Bridge = {
  reportOutgoingCall(options: { callId: string; calleeName: string; isVideo: boolean }): Promise<void>;
  reportCallConnected(options: { callId: string; isVideo: boolean }): Promise<void>;
  reportCallEnded(options?: { reason?: string }): Promise<void>;
};

let bridgePromise: Promise<Bridge | null> | null = null;

function getBridge(): Promise<Bridge | null> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  if (!bridgePromise) {
    bridgePromise = import("duospace-callkit-bridge")
      .then((m) => (m as unknown as { DuospaceCallKitBridge: Bridge }).DuospaceCallKitBridge)
      .catch(() => null);
  }
  return bridgePromise;
}

/** Call the instant an outgoing call starts dialing — as early as the real
 *  callId and callee display name are known (see call sites: Calls.tsx/
 *  Chat.tsx call this right after the call_history row insert resolves). */
export async function reportOutgoingCallStarted(callId: string, calleeName: string, isVideo: boolean): Promise<void> {
  try {
    const bridge = await getBridge();
    await bridge?.reportOutgoingCall({ callId, calleeName: calleeName || "Partner", isVideo });
  } catch {
    /* best-effort, see module doc comment */
  }
}

/** Call once real remote audio is confirmed (waitForRemoteAudioReady) — NOT
 *  at tap-to-call, NOT at local call.join() resolution. This is what flips
 *  CallKit/Telecom out of "Calling…" and turns on proximity screen-off for
 *  voice calls. Covers both the outgoing-caller path and the incoming-accept
 *  path (CallContext.tsx) — either way, "connected" only really means
 *  something once remote audio is up. */
export async function reportCallNowConnected(callId: string, isVideo: boolean): Promise<void> {
  try {
    const bridge = await getBridge();
    await bridge?.reportCallConnected({ callId, isVideo });
  } catch {
    /* best-effort */
  }
}

/** Call at every call-ending path — end button, cancel-before-answer,
 *  decline, timeout, or an exception during setup — so a call that never
 *  reported connected still gets its "Calling…" notification/Telecom
 *  registration torn down rather than left dangling. Safe to call even if
 *  reportOutgoingCallStarted was never called for this attempt (e.g. it
 *  failed before the callId existed) — both native sides no-op on "nothing
 *  registered right now" rather than throwing. */
export async function reportCallEndedNative(reason?: "remoteEnded" | "failed" | "unanswered" | "declinedElsewhere" | "answeredElsewhere"): Promise<void> {
  try {
    const bridge = await getBridge();
    await bridge?.reportCallEnded(reason ? { reason } : undefined);
  } catch {
    /* best-effort */
  }
}
