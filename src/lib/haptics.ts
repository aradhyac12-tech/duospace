/**
 * Haptics — rich, situation-aware feedback (public, semantic API).
 *
 * Every function here is a thin, named entry point into the haptic design
 * language in `lib/hapticEngine.ts`, which picks the best native
 * implementation (duospace-haptics plugin → @capacitor/haptics → web
 * vibrate), applies the user's on/off + intensity preferences, and collapses
 * double-fires. See that file for the design principles.
 *
 * Call sites are unchanged: `hapticLight()`, `hapticSuccess()`,
 * `withHaptic("send", fn)`, `fireHaptic("selection")` …
 *
 * Interactions that don't call anything explicitly still get feedback from
 * `lib/globalHaptics.ts` (buttons, tabs, switches, menu items, …).
 */
import {
  fireNamed, cancelHaptics, hapticTier, prepareHaptics,
  getHapticIntensity, setHapticIntensity, hapticsEnabled,
} from "@/lib/hapticEngine";
import type { HapticIntensity } from "@/lib/hapticEngine";

export { getHapticIntensity, setHapticIntensity, hapticsEnabled, prepareHaptics };
export type { HapticIntensity };

/** Micro tick — list selection, scrubbing, tab focus. */
export const hapticTick = () => fireNamed("tick");

/** Selection change (radio, segmented control, picker notch). */
export const hapticSelection = () => fireNamed("selection");

export const hapticLight = () => fireNamed("light");
export const hapticMedium = () => fireNamed("medium");
export const hapticHeavy = () => fireNamed("heavy");

/** Sharp/rigid tap — snap-into-place. */
export const hapticRigid = () => fireNamed("rigid");

/** Soft, damped — subtle confirmation. */
export const hapticSoft = () => fireNamed("soft");

/** Two light pulses — used for receiving a message. */
export const hapticDouble = () => fireNamed("double");

/** Long-press engaged — a short ramp resolving into a click. */
export const hapticLongPress = () => fireNamed("longPress");

/** Swipe threshold reached — a light tick, not a heavier confirmation. */
export const hapticSwipe = () => fireNamed("swipe");

export const hapticToggleOn = () => fireNamed("toggleOn");
export const hapticToggleOff = () => fireNamed("toggleOff");

/** Crisp release with a soft settle — message send. */
export const hapticSend = () => fireNamed("send");

/** Soft double for message receive. */
export const hapticReceive = () => fireNamed("receive");

/** Mechanical shutter: click + a small thud. */
export const hapticCameraShutter = () => fireNamed("shutter");

/**
 * Success / warning / error. iOS uses the system notification haptics (so they
 * read as the familiar OS category); Android plays tuned compositions
 * (rising two-beat / even double / stepped-down triple). They are not scaled
 * by the intensity preference — like a system sound, they're a category.
 */
export const hapticSuccess = () => fireNamed("success");
export const hapticWarning = () => fireNamed("warning");
export const hapticError = () => fireNamed("error");

// ── New vocabulary ──────────────────────────────────────────────────────────

/** Reaction picked / applied — a quick two-step "pop". */
export const hapticReaction = () => fireNamed("reaction");
/** Lub-dub — hearts, "thinking of you", love letters. */
export const hapticHeartbeat = () => fireNamed("heartbeat");
/** Pull-to-refresh / drag threshold crossed. */
export const hapticPullThreshold = () => fireNamed("pullThreshold");
/** Slider notch (rate-limited) and slider release. */
export const hapticSliderStep = () => fireNamed("sliderStep");
export const hapticSliderCommit = () => fireNamed("sliderCommit");
/** Sheet / drawer / dialog presented or dismissed. */
export const hapticSheetOpen = () => fireNamed("sheetOpen");
export const hapticSheetClose = () => fireNamed("sheetClose");
export const hapticDialogOpen = () => fireNamed("dialogOpen");

// ── Chat / calls vocabulary (all layered multi-pulse) ─────────────────────
export const hapticDelivered = () => fireNamed("delivered");
export const hapticReactionScrub = () => fireNamed("reactionScrub");
export const hapticReplyArmed = () => fireNamed("replyArmed");
export const hapticReplyCommit = () => fireNamed("replyCommit");
export const hapticCopy = () => fireNamed("copy");
export const hapticPin = () => fireNamed("pin");
export const hapticDeleteMessage = () => fireNamed("deleteMsg");
export const hapticNudge = () => fireNamed("nudge");
export const hapticScrollBottom = () => fireNamed("scrollBottom");
export const hapticVoiceStart = () => fireNamed("voiceStart");
export const hapticVoiceLock = () => fireNamed("voiceLock");
export const hapticVoiceCancel = () => fireNamed("voiceCancel");
export const hapticVoicePlay = () => fireNamed("voicePlay");
export const hapticMenuOpen = () => fireNamed("menuOpen");
export const hapticCallConnect = () => fireNamed("callConnect");
export const hapticCallEnd = () => fireNamed("callEnd");

/** Legacy aliases kept for existing call sites. */
export const hapticNotification = (t: "success" | "warning" | "error" = "success") =>
  t === "success" ? hapticSuccess() : t === "warning" ? hapticWarning() : hapticError();
export const hapticMessageSent = () => hapticSend();
export const hapticMessageReceived = () => hapticReceive();

/** Bind a haptic kind to any handler. Fires haptic then invokes the handler. */
export type HapticKind =
  | "tick" | "selection" | "light" | "medium" | "heavy" | "rigid" | "soft"
  | "double" | "longPress" | "swipe" | "toggleOn" | "toggleOff" | "send"
  | "receive" | "shutter" | "success" | "warning" | "error"
  | "reaction" | "heartbeat" | "pullThreshold" | "sliderStep" | "sliderCommit"
  | "sheetOpen" | "sheetClose" | "dialogOpen"
  | "delivered" | "reactionScrub" | "replyArmed" | "replyCommit" | "copy" | "pin"
  | "deleteMsg" | "nudge" | "scrollBottom" | "voiceStart" | "voiceLock" | "voiceCancel"
  | "voicePlay" | "menuOpen" | "callConnect" | "callEnd";

const KIND_TO_FN: Record<HapticKind, () => Promise<void> | void> = {
  tick: hapticTick, selection: hapticSelection, light: hapticLight, medium: hapticMedium,
  heavy: hapticHeavy, rigid: hapticRigid, soft: hapticSoft, double: hapticDouble,
  longPress: hapticLongPress, swipe: hapticSwipe, toggleOn: hapticToggleOn, toggleOff: hapticToggleOff,
  send: hapticSend, receive: hapticReceive, shutter: hapticCameraShutter,
  success: hapticSuccess, warning: hapticWarning, error: hapticError,
  reaction: hapticReaction, heartbeat: hapticHeartbeat, pullThreshold: hapticPullThreshold,
  sliderStep: hapticSliderStep, sliderCommit: hapticSliderCommit,
  sheetOpen: hapticSheetOpen, sheetClose: hapticSheetClose, dialogOpen: hapticDialogOpen,
  delivered: hapticDelivered, reactionScrub: hapticReactionScrub, replyArmed: hapticReplyArmed,
  replyCommit: hapticReplyCommit, copy: hapticCopy, pin: hapticPin, deleteMsg: hapticDeleteMessage,
  nudge: hapticNudge, scrollBottom: hapticScrollBottom, voiceStart: hapticVoiceStart,
  voiceLock: hapticVoiceLock, voiceCancel: hapticVoiceCancel, voicePlay: hapticVoicePlay,
  menuOpen: hapticMenuOpen, callConnect: hapticCallConnect, callEnd: hapticCallEnd,
};

export const fireHaptic = (kind: HapticKind) => KIND_TO_FN[kind]?.();

export const withHaptic = <T extends (...args: never[]) => unknown>(
  kind: HapticKind, fn?: T,
): T => (((...args: never[]) => { fireHaptic(kind); return fn?.(...args); }) as T);

// ── Incoming-call pattern ──────────────────────────────────────────────────
//
// FIX (history — "keeps vibrating, even after answering / after the call
// ended"): this used to overwrite `callVibrationInterval` on every call with
// no "already running?" check. IncomingCallOverlay re-ran its ring logic
// several times per call, so every extra startCallVibration() left an
// orphaned setInterval behind — only the LAST handle was stored, so
// stopCallVibration() could only clear one of them and the rest kept firing
// native haptics every 1.5s forever.
//
// Invariants that stay in force:
//  (1) start is idempotent — a second call while already vibrating is a no-op,
//  (2) stop clears the interval AND cancels any pattern already handed to the
//      OS (native `cancel()` / navigator.vibrate(0)),
//  (3) a hard safety cap stops the loop on its own so a missed stop signal can
//      never turn into unbounded vibration.
//
// Each ring cycle is now ONE native call (`ringPulse`: a rolling heartbeat —
// rise → click/thud → softer click/thud) instead of three JS-timed heavy
// impacts, so timing is exact and nothing is left pending in JS timers.
const CALL_VIBRATION_PULSE_MS = 1500;
// Longer than the 30s in-app auto-decline / 45s native ring window, so it
// only ever fires if every real stop path somehow failed.
const CALL_VIBRATION_MAX_MS = 60_000;

let callVibrationInterval: ReturnType<typeof setInterval> | null = null;
let callVibrationSafetyTimer: ReturnType<typeof setTimeout> | null = null;

export const isCallVibrating = () => callVibrationInterval !== null;

export const startCallVibration = () => {
  if (hapticTier() === "none") return;
  if (callVibrationInterval) return; // already vibrating — never stack a second loop

  const pulse = () => {
    if (!callVibrationInterval) return;
    void fireNamed("ringPulse", { bypassGate: true });
  };

  callVibrationInterval = setInterval(pulse, CALL_VIBRATION_PULSE_MS);
  callVibrationSafetyTimer = setTimeout(() => stopCallVibration(), CALL_VIBRATION_MAX_MS);
  pulse();
};

export const stopCallVibration = () => {
  const wasRunning = callVibrationInterval !== null;
  if (callVibrationInterval) {
    clearInterval(callVibrationInterval);
    callVibrationInterval = null;
  }
  if (callVibrationSafetyTimer) {
    clearTimeout(callVibrationSafetyTimer);
    callVibrationSafetyTimer = null;
  }
  // Cancel a ring pattern already handed to the OS — but only if we were the
  // ones playing it, so a stop() with nothing running can't kill an
  // unrelated haptic (e.g. the "answered" confirmation).
  if (wasRunning) cancelHaptics();
};
