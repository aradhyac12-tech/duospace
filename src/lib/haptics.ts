/**
 * Haptics — rich, situation-aware feedback.
 *
 * Layered engine:
 *   - Native (Capacitor Haptics): Impact / Notification / Vibrate.
 *   - Web (navigator.vibrate): patterns for Android browser.
 *   - Silent no-op on unsupported platforms.
 *
 * Range spans micro-ticks (~8ms selection) to sustained ramps (200ms long-press).
 * Use `withHaptic(kind, fn)` to bind any handler to a haptic kind.
 */
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Capacitor } from "@capacitor/core";

const isNative = () => Capacitor.isNativePlatform();
const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

const safe = async (fn: () => Promise<unknown> | unknown) => {
  try { await fn(); } catch { /* silent */ }
};

/** Sub-8ms micro tick — for list selection, tab focus. */
export const hapticTick = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Light });
    if (canVibrate()) navigator.vibrate(8);
  });

/** Selection change (radio, segmented control, slider notch). */
export const hapticSelection = () =>
  safe(async () => {
    if (isNative()) return Haptics.selectionStart().then(() => Haptics.selectionEnd());
    if (canVibrate()) navigator.vibrate(10);
  });

export const hapticLight = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Light });
    if (canVibrate()) navigator.vibrate(20);
  });

export const hapticMedium = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Medium });
    if (canVibrate()) navigator.vibrate(40);
  });

export const hapticHeavy = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Heavy });
    if (canVibrate()) navigator.vibrate(80);
  });

/** Sharp/rigid tap — camera shutter, snap-into-place. */
export const hapticRigid = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Heavy });
    if (canVibrate()) navigator.vibrate([30]);
  });

/** Soft, damped — subtle confirmation. */
export const hapticSoft = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Light });
    if (canVibrate()) navigator.vibrate([15, 15, 15]);
  });

/** Two light pulses — used for receiving a message. */
export const hapticDouble = () =>
  safe(async () => {
    if (isNative()) {
      await Haptics.impact({ style: ImpactStyle.Light });
      await new Promise(r => setTimeout(r, 70));
      return Haptics.impact({ style: ImpactStyle.Light });
    }
    if (canVibrate()) navigator.vibrate([20, 60, 20]);
  });

/** Long-press ramp — hold-to-record, context menu open. */
export const hapticLongPress = () =>
  safe(async () => {
    if (isNative()) {
      await Haptics.impact({ style: ImpactStyle.Medium });
      await new Promise(r => setTimeout(r, 90));
      return Haptics.impact({ style: ImpactStyle.Heavy });
    }
    if (canVibrate()) navigator.vibrate([30, 60, 100]);
  });

/** Swipe threshold reached. */
export const hapticSwipe = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Medium });
    if (canVibrate()) navigator.vibrate(35);
  });

export const hapticToggleOn = () => hapticMedium();
export const hapticToggleOff = () => hapticLight();

/** Sharp release on message send. */
export const hapticSend = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Medium });
    if (canVibrate()) navigator.vibrate([25]);
  });

/** Soft double for message receive. */
export const hapticReceive = () => hapticDouble();

/** Camera shutter — rigid single tap. */
export const hapticCameraShutter = () =>
  safe(async () => {
    if (isNative()) return Haptics.impact({ style: ImpactStyle.Heavy });
    if (canVibrate()) navigator.vibrate([12, 30, 12]);
  });

/** Success / warning / error notifications. */
export const hapticSuccess = () =>
  safe(async () => {
    if (isNative()) return Haptics.notification({ type: NotificationType.Success });
    if (canVibrate()) navigator.vibrate([30, 50, 30]);
  });
export const hapticWarning = () =>
  safe(async () => {
    if (isNative()) return Haptics.notification({ type: NotificationType.Warning });
    if (canVibrate()) navigator.vibrate([50, 50, 50]);
  });
export const hapticError = () =>
  safe(async () => {
    if (isNative()) return Haptics.notification({ type: NotificationType.Error });
    if (canVibrate()) navigator.vibrate([80, 40, 80]);
  });

/** Legacy aliases kept for existing call sites. */
export const hapticNotification = (t: "success" | "warning" | "error" = "success") =>
  t === "success" ? hapticSuccess() : t === "warning" ? hapticWarning() : hapticError();
export const hapticMessageSent = () => hapticSend();
export const hapticMessageReceived = () => hapticReceive();

/** Bind a haptic kind to any handler. Fires haptic then invokes the handler. */
export type HapticKind =
  | "tick" | "selection" | "light" | "medium" | "heavy" | "rigid" | "soft"
  | "double" | "longPress" | "swipe" | "toggleOn" | "toggleOff" | "send"
  | "receive" | "shutter" | "success" | "warning" | "error";

const KIND_TO_FN: Record<HapticKind, () => Promise<void> | void> = {
  tick: hapticTick, selection: hapticSelection, light: hapticLight, medium: hapticMedium,
  heavy: hapticHeavy, rigid: hapticRigid, soft: hapticSoft, double: hapticDouble,
  longPress: hapticLongPress, swipe: hapticSwipe, toggleOn: hapticToggleOn, toggleOff: hapticToggleOff,
  send: hapticSend, receive: hapticReceive, shutter: hapticCameraShutter,
  success: hapticSuccess, warning: hapticWarning, error: hapticError,
};

export const fireHaptic = (kind: HapticKind) => KIND_TO_FN[kind]?.();

export const withHaptic = <T extends (...args: never[]) => unknown>(
  kind: HapticKind, fn?: T,
): T => (((...args: never[]) => { fireHaptic(kind); return fn?.(...args); }) as T);

// ── Incoming-call pattern (kept from previous implementation) ─────────────
let callVibrationInterval: ReturnType<typeof setInterval> | null = null;

export const startCallVibration = () => {
  if (!isNative() && !canVibrate()) return;
  const pulse = async () => {
    await hapticHeavy();
    setTimeout(hapticMedium, 200);
    setTimeout(hapticHeavy, 400);
  };
  pulse();
  callVibrationInterval = setInterval(pulse, 1500);
};

export const stopCallVibration = () => {
  if (callVibrationInterval) {
    clearInterval(callVibrationInterval);
    callVibrationInterval = null;
  }
};
