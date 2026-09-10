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
 *
 * Two user-facing preferences apply globally, at the lowest choke point
 * (`safe()` + the `impact()`/`vibrate()` helpers below) rather than being
 * checked at every call site:
 *   - Settings → Haptics (on/off), stored on the shared `duo-settings` blob.
 *   - Settings → Haptic intensity (Subtle/Standard/Strong), stored separately
 *     so it can be changed without touching the rest of appSettings.
 */
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Capacitor } from "@capacitor/core";
import storage from "@/lib/storage";

const isNative = () => Capacitor.isNativePlatform();
const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

// ── User preferences ────────────────────────────────────────────────────────
// Reads the same "duo-settings" blob Settings/ThemeContext already writes to
// (appSettings.hapticFeedback) — no second source of truth for the on/off switch.
const hapticsEnabled = () => {
  try {
    const raw = storage.get("duo-settings");
    if (!raw) return true; // default on, matches ThemeContext's defaultSettings
    const parsed = JSON.parse(raw);
    return parsed?.hapticFeedback !== false;
  } catch { return true; }
};

export type HapticIntensity = "subtle" | "standard" | "strong";
const INTENSITY_KEY = "duo-haptic-intensity";

export const getHapticIntensity = (): HapticIntensity => {
  const v = storage.get(INTENSITY_KEY);
  return v === "subtle" || v === "strong" ? v : "standard";
};
export const setHapticIntensity = (level: HapticIntensity) => storage.set(INTENSITY_KEY, level);

// Native impact styles are discrete (Light/Medium/Heavy), so intensity shifts
// by one tier rather than a continuous multiplier; web vibration durations
// scale continuously since they accept arbitrary milliseconds.
const IMPACT_UP: Record<ImpactStyle, ImpactStyle> = {
  [ImpactStyle.Light]: ImpactStyle.Medium,
  [ImpactStyle.Medium]: ImpactStyle.Heavy,
  [ImpactStyle.Heavy]: ImpactStyle.Heavy,
};
const IMPACT_DOWN: Record<ImpactStyle, ImpactStyle> = {
  [ImpactStyle.Light]: ImpactStyle.Light,
  [ImpactStyle.Medium]: ImpactStyle.Light,
  [ImpactStyle.Heavy]: ImpactStyle.Medium,
};
const resolveImpactStyle = (style: ImpactStyle): ImpactStyle => {
  const intensity = getHapticIntensity();
  if (intensity === "strong") return IMPACT_UP[style];
  if (intensity === "subtle") return IMPACT_DOWN[style];
  return style;
};
const vibrateDurationScale = () => {
  const intensity = getHapticIntensity();
  return intensity === "strong" ? 1.4 : intensity === "subtle" ? 0.6 : 1;
};

const safe = async (fn: () => Promise<unknown> | unknown) => {
  if (!hapticsEnabled()) return;
  try { await fn(); } catch { /* silent */ }
};

/** Native impact tap, adjusted one tier by the user's intensity preference. */
const impact = (style: ImpactStyle) => Haptics.impact({ style: resolveImpactStyle(style) });

/** navigator.vibrate, with durations scaled by the user's intensity preference. */
const vibrate = (pattern: number | number[]) => {
  const scale = vibrateDurationScale();
  const scaled: number | number[] = Array.isArray(pattern)
    ? pattern.map(ms => Math.max(1, Math.round(ms * scale)))
    : Math.max(1, Math.round(pattern * scale));
  navigator.vibrate(scaled);
};

/** Sub-8ms micro tick — for list selection, tab focus. */
export const hapticTick = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Light);
    if (canVibrate()) vibrate(8);
  });

/** Selection change (radio, segmented control, slider notch). */
export const hapticSelection = () =>
  safe(async () => {
    if (isNative()) return Haptics.selectionStart().then(() => Haptics.selectionEnd());
    if (canVibrate()) vibrate(10);
  });

export const hapticLight = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Light);
    if (canVibrate()) vibrate(20);
  });

export const hapticMedium = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Medium);
    if (canVibrate()) vibrate(40);
  });

export const hapticHeavy = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Heavy);
    if (canVibrate()) vibrate(80);
  });

/** Sharp/rigid tap — camera shutter, snap-into-place. */
export const hapticRigid = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Heavy);
    if (canVibrate()) vibrate([30]);
  });

/** Soft, damped — subtle confirmation. */
export const hapticSoft = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Light);
    if (canVibrate()) vibrate([15, 15, 15]);
  });

/** Two light pulses — used for receiving a message. */
export const hapticDouble = () =>
  safe(async () => {
    if (isNative()) {
      await impact(ImpactStyle.Light);
      await new Promise(r => setTimeout(r, 70));
      return impact(ImpactStyle.Light);
    }
    if (canVibrate()) vibrate([20, 60, 20]);
  });

/** Long-press ramp — hold-to-record, context menu open. */
export const hapticLongPress = () =>
  safe(async () => {
    if (isNative()) {
      await impact(ImpactStyle.Medium);
      await new Promise(r => setTimeout(r, 90));
      return impact(ImpactStyle.Heavy);
    }
    if (canVibrate()) vibrate([30, 60, 100]);
  });

/** Swipe threshold reached — a light tap, not a heavier confirmation. */
export const hapticSwipe = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Light);
    if (canVibrate()) vibrate(18);
  });

export const hapticToggleOn = () => hapticMedium();
export const hapticToggleOff = () => hapticLight();


/** Sharp release on message send. */
export const hapticSend = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Medium);
    if (canVibrate()) vibrate([25]);
  });

/** Soft double for message receive. */
export const hapticReceive = () => hapticDouble();

/** Camera shutter — rigid single tap. */
export const hapticCameraShutter = () =>
  safe(async () => {
    if (isNative()) return impact(ImpactStyle.Heavy);
    if (canVibrate()) vibrate([12, 30, 12]);
  });

/**
 * Success / warning / error notifications. These stay at their native
 * OS-defined pattern regardless of the intensity preference — they're
 * meant to be recognized as a distinct category (like a system sound),
 * not felt as more or less forceful.
 */
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
