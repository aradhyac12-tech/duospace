/**
 * nativeIncomingCall — JS -> native "the incoming call is no longer ringing".
 *
 * On Android the ringing you hear/feel when the app isn't the thing showing
 * the call (looping ringtone + vibration from CallRingingService, the
 * full-screen "Incoming call" notification, and the ringing Telecom
 * connection) is started by the FCM push alone — it never looks at what the
 * web layer is doing. Until this existed, the ONLY things that could stop it
 * were the notification's own Accept/Decline buttons, a call_ended /
 * missed_call / call_rejected push, or its 45s self-timeout. Answering or
 * declining from the in-app overlay, or the caller hanging up while the app
 * was open, stopped only the JS ringtone/haptics: the phone kept vibrating
 * and the notification stayed up. Every in-app "this call is no longer
 * ringing" path now calls this too.
 *
 * Best-effort by the same rule as nativeCallReporting.ts: this must never be
 * able to break a call, so every failure is swallowed.
 */
import { Capacitor } from "@capacitor/core";

type IncomingCallBridge = {
  dismissIncomingCall(options?: { callId?: string }): Promise<void>;
  isIncomingRinging(): Promise<{ ringing: boolean }>;
};

let bridgePromise: Promise<IncomingCallBridge | null> | null = null;

function getBridge(): Promise<IncomingCallBridge | null> {
  if (Capacitor.getPlatform() !== "android" && Capacitor.getPlatform() !== "ios") return Promise.resolve(null);
  if (!bridgePromise) {
    bridgePromise = import("duospace-callkit-bridge")
      .then((m) => (m as unknown as { DuospaceCallKitBridge: IncomingCallBridge }).DuospaceCallKitBridge)
      .catch(() => null);
  }
  return bridgePromise;
}

/** Silence + dismiss the native incoming-call ringing for `callId` (or
 *  whatever is ringing, if omitted). Safe to call when nothing is ringing,
 *  and safe to call repeatedly. No-op off Android. */
export async function stopNativeIncomingRinging(callId?: string): Promise<void> {
  try {
    const bridge = await getBridge();
    await bridge?.dismissIncomingCall(callId ? { callId } : undefined);
  } catch {
    /* best-effort */
  }
}

/**
 * Is the OS already ringing an incoming call (Android CallRingingService /
 * iOS CallKit)? `true` → the phone is playing the chosen ringtone natively
 * and the in-app overlay must not add a second copy. `null` → unknown (web,
 * or a native build that predates the method): the caller should ring in-app.
 */
export async function isNativeIncomingRinging(): Promise<boolean | null> {
  try {
    const bridge = await getBridge();
    if (!bridge) return null;
    const res = await bridge.isIncomingRinging();
    return typeof res?.ringing === "boolean" ? res.ringing : null;
  } catch {
    return null;
  }
}
