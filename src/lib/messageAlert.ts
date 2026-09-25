/**
 * /important and /urgent message alerts — client side.
 *
 * Two tiers, deliberately different in sound AND feel. The tier ids, sound
 * files, and vibration patterns exist in several places that cannot share an
 * import; src/test/messageAlert.test.ts fails if any of them drift:
 *   - here (in-app alert while the chat is open + Settings preview)
 *   - supabase/functions/_shared/messageAlert.ts (send-push: channels, iOS sound)
 *   - native/android/MessageAlertService.kt (the real ringer when the app is
 *     closed/backgrounded: alarm-stream audio + long vibration that get
 *     through silent mode and Do Not Disturb) and NotificationChannels.kt
 *   - bundled assets: public/sounds/alert_<tier>.m4a,
 *     native/android/res_raw/alert_<tier>.ogg, native/ios/Sounds/alert_<tier>.caf
 *     (regenerate with scripts/generate-alert-sounds.py)
 *
 * WHEN THE JS SIDE PLAYS: the server skips the push while the recipient is
 * looking at the thread (send-push "recipient_viewing_chat"), so with the chat
 * open the ONLY signal is the realtime insert — which used to play the plain
 * message ping. useChatRealtimeMessages now calls startInAppMessageAlert()
 * for flagged messages. When the app is closed/backgrounded the native
 * service rings instead (Android) or the push's own sound does (iOS).
 */
import { Capacitor } from "@capacitor/core";
import { Haptics } from "@capacitor/haptics";
import { DuospaceCallKitBridge } from "duospace-callkit-bridge";
import type { MessageAlertStatus } from "duospace-callkit-bridge";

export type MessageAlertLevel = "important" | "urgent";

export interface AlertTier {
  level: MessageAlertLevel;
  label: string;
  description: string;
  /** Bundled web asset — a short loop unit, played on repeat. */
  soundFile: string;
  /**
   * Vibration timings in ms: [wait, on, off, on, ...] — even indices are
   * "off". Loops from `repeatFrom`. Identical to IMPORTANT_VIBRATION /
   * URGENT_VIBRATION in MessageAlertService.kt.
   */
  pattern: number[];
  repeatFrom: number;
  /** How long the native service rings before giving up. */
  nativeMaxMs: number;
  /** How long the in-app alert runs if nobody taps the screen. */
  inAppMs: number;
}

export const ALERT_TIERS: Readonly<Record<MessageAlertLevel, AlertTier>> = {
  important: {
    level: "important",
    label: "Important",
    description: "Rising three-note bell with three long pulses, about 20 seconds",
    soundFile: "/sounds/alert_important.m4a",
    pattern: [0, 700, 250, 700, 250, 700, 1200],
    repeatFrom: 1,
    nativeMaxMs: 20_000,
    inAppMs: 10_000,
  },
  urgent: {
    level: "urgent",
    label: "Urgent",
    description: "Two-tone siren and rapid beeps with heavy pulses, until you stop it (up to a minute)",
    soundFile: "/sounds/alert_urgent.m4a",
    pattern: [0, 1500, 150, 1500, 150, 300, 100, 300, 100, 300, 600],
    repeatFrom: 1,
    nativeMaxMs: 60_000,
    inAppMs: 20_000,
  },
};

/** Which tier a message row belongs to (urgent wins over important), or null. */
export function messageAlertLevel(msg: { important?: boolean | null; urgent?: boolean | null }): MessageAlertLevel | null {
  if (msg.urgent) return "urgent";
  if (msg.important) return "important";
  return null;
}

const isAndroidNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

// ── in-app alert (sound loop + long haptics), stoppable ────────────────────

let audio: HTMLAudioElement | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
let active = false;
let stopHandlers: (() => void) | null = null;

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function nativeVibrate(duration: number) {
  // Capacitor's plugin (native) has no arbitrary-pattern API, so a pattern is
  // played as a chain of timed pulses.
  void Haptics.vibrate({ duration }).catch(() => { /* best effort */ });
}

/** Runs the tier's pattern in a loop until `until` (epoch ms) or stop. */
function runHaptics(tier: AlertTier, until: number) {
  const native = Capacitor.isNativePlatform();
  const loop = tier.pattern.slice(tier.repeatFrom); // starts with an "on" segment
  const cycleMs = loop.reduce((a, b) => a + b, 0);
  const cycle = () => {
    if (!active || Date.now() >= until) return;
    if (native) {
      let t = 0;
      loop.forEach((ms, i) => {
        if (i % 2 === 0) timers.push(setTimeout(() => active && nativeVibrate(ms), t));
        t += ms;
      });
    } else if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(loop); } catch { /* best effort */ }
    }
    timers.push(setTimeout(cycle, cycleMs));
  };
  cycle();
}

/** Stops the in-app alert (sound + haptics). Safe to call any time. */
export function stopInAppMessageAlert() {
  active = false;
  clearTimers();
  try { audio?.pause(); } catch { /* best effort */ }
  audio = null;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(0);
  } catch { /* best effort */ }
  if (stopHandlers) { stopHandlers(); stopHandlers = null; }
}

/**
 * Rings the tier's sound and long haptic pattern inside the app. Stops on the
 * first tap anywhere, when the app goes to the background, or after
 * `durationMs` (default: the tier's inAppMs). A new alert replaces a running one.
 *
 * Deliberately ignores the Settings "haptics" switch: that switch is for UI
 * feedback, and these are messages the sender explicitly flagged to get through.
 */
export function startInAppMessageAlert(level: MessageAlertLevel, durationMs?: number) {
  const tier = ALERT_TIERS[level];
  stopInAppMessageAlert();
  // The native service may also be ringing for the same message (push and
  // realtime racing) — one alert at a time.
  if (isAndroidNative()) void stopNativeMessageAlert();

  active = true;
  const until = Date.now() + (durationMs ?? tier.inAppMs);

  try {
    const a = new Audio(tier.soundFile);
    a.loop = true;
    a.volume = 1;
    audio = a;
    void a.play().catch(() => { /* autoplay blocked — haptics still run */ });
  } catch { /* no audio support — haptics still run */ }

  runHaptics(tier, until);
  timers.push(setTimeout(stopInAppMessageAlert, until - Date.now()));

  const onTap = () => stopInAppMessageAlert();
  const onHidden = () => { if (document.visibilityState === "hidden") stopInAppMessageAlert(); };
  window.addEventListener("pointerdown", onTap, { capture: true, once: true });
  document.addEventListener("visibilitychange", onHidden);
  stopHandlers = () => {
    window.removeEventListener("pointerdown", onTap, true);
    document.removeEventListener("visibilitychange", onHidden);
  };
}

// ── native (Android) bridge ────────────────────────────────────────────────

/** Stops a ringing native alert. No-op off Android. Never throws. */
export async function stopNativeMessageAlert(): Promise<void> {
  if (!isAndroidNative()) return;
  try { await DuospaceCallKitBridge.stopMessageAlert(); } catch { /* not ringing / older build */ }
}

/**
 * Settings "Test" button. On Android this starts the REAL service — same
 * alarm-stream sound and vibration a live alert uses — so the person can check
 * it really does ring on silent / in Do Not Disturb. Elsewhere it plays the
 * in-app version for a few seconds.
 */
export async function previewMessageAlert(level: MessageAlertLevel): Promise<void> {
  if (isAndroidNative()) {
    try {
      await DuospaceCallKitBridge.previewMessageAlert({ level });
      return;
    } catch { /* older native build without the method — fall back to in-app */ }
  }
  startInAppMessageAlert(level, 6_000);
}

export async function stopMessageAlertPreview(): Promise<void> {
  stopInAppMessageAlert();
  await stopNativeMessageAlert();
}

const UNSUPPORTED: MessageAlertStatus = {
  supported: false,
  dndAccessGranted: false,
  ringerMode: "normal",
  interruptionFilter: "unknown",
  alarmVolumePercent: 0,
};

export async function getMessageAlertStatus(): Promise<MessageAlertStatus> {
  if (!isAndroidNative()) return UNSUPPORTED;
  try { return await DuospaceCallKitBridge.getMessageAlertStatus(); } catch { return UNSUPPORTED; }
}

export async function openDndAccessSettings(): Promise<void> {
  if (!isAndroidNative()) return;
  try { await DuospaceCallKitBridge.openDndAccessSettings(); } catch { /* best effort */ }
}
