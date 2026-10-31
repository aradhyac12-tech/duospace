/**
 * hapticEngine — the low-level half of DuoSpace's haptics.
 *
 * `lib/haptics.ts` is the public, semantic API the whole app already calls
 * (hapticLight, hapticSuccess, withHaptic, …). This module is what makes those
 * calls *feel* premium instead of cheap:
 *
 *  1. Native tier ladder (best available wins)
 *       "duo"        duospace-haptics plugin — Android VibrationEffect
 *                    primitives (CLICK/TICK/LOW_TICK/THUD/rise/fall), iOS
 *                    generators + Core Haptics.
 *       "capacitor"  @capacitor/haptics — only if the installed APK/IPA
 *                    predates the plugin (web bundle updated, native shell
 *                    not). Still works, just the old generic feel.
 *       "web"        navigator.vibrate with short, crisp pulses.
 *  2. A haptic *design language* (PATTERNS below): every interaction has a
 *     named pattern with a deliberate intensity, so taps are soft and short,
 *     weight is reserved for impact/error, and success has a rising shape.
 *  3. Anti-mush gating: a lower-priority haptic fired within ~45 ms of a
 *     stronger one is dropped. This collapses double-fires (a call site's
 *     own haptic + the global tap haptic, a toggle + its click) into a single
 *     clean pulse instead of a buzz.
 *  4. User preferences applied at the single choke point (on/off from the
 *     shared `duo-settings` blob, Subtle/Standard/Strong intensity).
 *
 * This file must stay free of imports from `@/lib/haptics` — UI components
 * (sheet/dialog/slider) import from here, and some tests mock `@/lib/haptics`
 * with a partial factory.
 */
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { DuospaceHaptics } from "duospace-haptics";
import type { HapticCapabilities, HapticEvent, HapticSystemEffect } from "duospace-haptics";
import storage from "@/lib/storage";

export type { HapticCapabilities, HapticEvent, HapticSystemEffect };

// ── User preferences ────────────────────────────────────────────────────────

let prefRaw: string | null | undefined;
let prefEnabled = true;
/** Master on/off — Settings → Haptics (`duo-settings.hapticFeedback`). */
export const hapticsEnabled = (): boolean => {
  try {
    const raw = storage.get("duo-settings");
    if (raw !== prefRaw) {
      prefRaw = raw;
      // Default on, matches ThemeContext's defaultSettings.
      prefEnabled = raw ? JSON.parse(raw)?.hapticFeedback !== false : true;
    }
    return prefEnabled;
  } catch {
    return true;
  }
};

export type HapticIntensity = "subtle" | "standard" | "strong";
const INTENSITY_KEY = "duo-haptic-intensity";

export const getHapticIntensity = (): HapticIntensity => {
  const v = storage.get(INTENSITY_KEY);
  return v === "subtle" || v === "strong" ? v : "standard";
};
export const setHapticIntensity = (level: HapticIntensity) => storage.set(INTENSITY_KEY, level);

/** Continuous multiplier: subtle ≈ -40 %, strong ≈ +30 % (clamped to 1 per event). */
const intensityScale = () => {
  const i = getHapticIntensity();
  return i === "strong" ? 1.3 : i === "subtle" ? 0.6 : 1;
};

// ── Platform tier ───────────────────────────────────────────────────────────

type Tier = "duo" | "capacitor" | "web" | "none";
let tierCache: Tier | null = null;

const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

const tier = (): Tier => {
  if (tierCache) return tierCache;
  let t: Tier = "none";
  try {
    if (Capacitor.isNativePlatform()) {
      t = Capacitor.isPluginAvailable("DuospaceHaptics") ? "duo" : "capacitor";
    } else if (canVibrate()) {
      t = "web";
    }
  } catch {
    t = canVibrate() ? "web" : "none";
  }
  tierCache = t;
  return t;
};

/** Which implementation is active — handy for diagnostics / the haptic lab. */
export const hapticTier = (): Tier => tier();

let capsPromise: Promise<HapticCapabilities | null> | null = null;
export const getHapticCapabilities = (): Promise<HapticCapabilities | null> => {
  if (!capsPromise) {
    capsPromise =
      tier() === "duo" ? DuospaceHaptics.getCapabilities().catch(() => null) : Promise.resolve(null);
  }
  return capsPromise;
};

// ── Gating / dedupe ─────────────────────────────────────────────────────────

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

let lastAt = -1e9;
let lastPriority = 0;

/** ms since any (non-bypassed) haptic last fired. */
export const msSinceLastHaptic = () => now() - lastAt;

const gate = (priority: number, minGapMs = 45): boolean => {
  const t = now();
  if (t - lastAt < minGapMs && priority <= lastPriority) return false;
  lastAt = t;
  lastPriority = priority;
  return true;
};

// ── Warm-up (lower first-tap latency on iOS) ────────────────────────────────

let lastPrepareAt = -1e9;
export const prepareHaptics = () => {
  if (tier() !== "duo") return;
  const t = now();
  if (t - lastPrepareAt < 2500) return;
  lastPrepareAt = t;
  void DuospaceHaptics.prepare().catch(() => undefined);
};

// ── Dispatch ────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const scaleEvents = (events: HapticEvent[], k = 1): HapticEvent[] => {
  const s = intensityScale() * k;
  return events.map((e) => ({ ...e, intensity: clamp01((e.intensity ?? 1) * s) }));
};

const impactStyleFor = (e: HapticEvent): ImpactStyle => {
  const i = e.intensity ?? 1;
  if (e.kind === "thud") return ImpactStyle.Heavy;
  return i < 0.5 ? ImpactStyle.Light : i < 0.85 ? ImpactStyle.Medium : ImpactStyle.Heavy;
};

const WEB_ON_MS: Record<string, number> = {
  tick: 6, lowTick: 8, click: 10, thud: 22, quickRise: 30, slowRise: 60, fall: 30, spin: 45,
};

/** Events → navigator.vibrate pattern (short pulses = taps, not buzz). */
const toVibratePattern = (events: HapticEvent[]): number[] => {
  const pattern: number[] = [];
  let cursor = 0;
  for (const e of [...events].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))) {
    const at = e.atMs ?? 0;
    const on = Math.max(4, Math.round((WEB_ON_MS[e.kind] ?? 10) * (0.5 + (e.intensity ?? 1) * 0.7)));
    const gap = Math.max(0, at - cursor);
    if (pattern.length === 0) {
      if (gap > 0) pattern.push(0, 0); // can't start with a gap; vibrate(0) no-ops
      pattern.push(on);
    } else {
      pattern.push(gap > 0 ? gap : 1, on);
    }
    cursor = Math.max(at, cursor) + on;
  }
  return pattern;
};

const playScaled = async (events: HapticEvent[]): Promise<void> => {
  if (events.length === 0) return;
  switch (tier()) {
    case "duo":
      return DuospaceHaptics.play({ events });
    case "capacitor": {
      const sorted = [...events].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
      let prev = 0;
      for (const e of sorted) {
        const at = e.atMs ?? 0;
        if (at - prev > 0) await new Promise((r) => setTimeout(r, at - prev));
        prev = at;
        await Haptics.impact({ style: impactStyleFor(e) });
      }
      return;
    }
    case "web":
      navigator.vibrate(toVibratePattern(events));
      return;
    default:
  }
};

const performScaled = async (effect: HapticSystemEffect, intensity: number): Promise<void> => {
  switch (tier()) {
    case "duo":
      return DuospaceHaptics.perform({ effect, intensity: clamp01(intensity) });
    case "capacitor":
      switch (effect) {
        case "selection":
          // selectionStart/End alone never ticks — selectionChanged is the actual tick.
          await Haptics.selectionStart();
          await Haptics.selectionChanged();
          return Haptics.selectionEnd();
        case "success": return Haptics.notification({ type: NotificationType.Success });
        case "warning": return Haptics.notification({ type: NotificationType.Warning });
        case "error": return Haptics.notification({ type: NotificationType.Error });
        case "impactSoft":
        case "impactLight": return Haptics.impact({ style: ImpactStyle.Light });
        case "impactHeavy": return Haptics.impact({ style: ImpactStyle.Heavy });
        case "impactRigid": return Haptics.impact({ style: ImpactStyle.Heavy });
        default: return Haptics.impact({ style: ImpactStyle.Medium });
      }
    case "web": {
      const patterns: Record<string, number[]> = {
        selection: [6], impactSoft: [8], impactLight: [10], impactMedium: [14], impactHeavy: [26],
        impactRigid: [12], success: [8, 60, 14], warning: [14, 80, 14], error: [16, 50, 16, 50, 24],
      };
      navigator.vibrate((patterns[effect] ?? [10]).map((ms) => Math.max(3, Math.round(ms * (0.5 + intensity * 0.7)))));
      return;
    }
    default:
  }
};

// ── Design language ─────────────────────────────────────────────────────────
//
// Principles (Apple HIG "Playing haptics" / Android haptics design guidance /
// WWDC21 Causality-Harmony-Utility):
//  • Every haptic answers a visible or audible event — nothing fires "just
//    because".
//  • Most taps are light & short. Weight (thud / heavy) is reserved for
//    impact, hold-complete and destructive moments, otherwise it reads as
//    cheap and fatiguing.
//  • Shape carries meaning: success rises, error steps down, a toggle snaps,
//    a heartbeat is lub-dub.
//  • Base intensities sit at 0.4–0.9 so "Strong" has headroom.

type Def =
  | { p: number; effect: HapticSystemEffect; i?: number; gapMs?: number }
  | { p: number; events: HapticEvent[]; gapMs?: number };

const PATTERNS = {
  // ── Micro feedback — every one is a layered pair, never a lone pulse ──
  tick: { p: 1, events: [{ kind: "tick", intensity: 0.5 }, { kind: "lowTick", intensity: 0.3, atMs: 22 }], gapMs: 30 },
  selection: { p: 1, events: [{ kind: "tick", intensity: 0.55 }, { kind: "lowTick", intensity: 0.4, atMs: 24 }], gapMs: 30 },
  sliderStep: { p: 1, events: [{ kind: "tick", intensity: 0.4 }, { kind: "lowTick", intensity: 0.2, atMs: 18 }], gapMs: 55 },
  sliderCommit: { p: 2, events: [{ kind: "click", intensity: 0.65 }, { kind: "fall", intensity: 0.3, atMs: 40 }] },
  // ── Taps — a crisp strike followed by a soft settle ──
  soft: { p: 2, events: [{ kind: "lowTick", intensity: 0.75 }, { kind: "lowTick", intensity: 0.35, atMs: 34 }] },
  light: { p: 2, events: [{ kind: "tick", intensity: 0.6 }, { kind: "click", intensity: 0.4, atMs: 26 }] },
  medium: { p: 2, events: [{ kind: "click", intensity: 0.75 }, { kind: "lowTick", intensity: 0.45, atMs: 32 }, { kind: "tick", intensity: 0.25, atMs: 62 }] },
  rigid: { p: 2, events: [{ kind: "click", intensity: 0.9 }, { kind: "tick", intensity: 0.5, atMs: 24 }] },
  heavy: { p: 4, events: [{ kind: "thud", intensity: 0.85 }, { kind: "click", intensity: 0.55, atMs: 35 }, { kind: "lowTick", intensity: 0.35, atMs: 80 }] },
  swipe: { p: 2, events: [{ kind: "quickRise", intensity: 0.3 }, { kind: "tick", intensity: 0.7, atMs: 45 }, { kind: "lowTick", intensity: 0.35, atMs: 80 }] },
  // ── State changes ──
  toggleOn: { p: 3, events: [{ kind: "tick", intensity: 0.55 }, { kind: "click", intensity: 0.85, atMs: 40 }, { kind: "lowTick", intensity: 0.35, atMs: 85 }] },
  toggleOff: { p: 2, events: [{ kind: "click", intensity: 0.5 }, { kind: "lowTick", intensity: 0.4, atMs: 45 }, { kind: "tick", intensity: 0.2, atMs: 80 }] },
  // ── Surfaces ──
  sheetOpen: { p: 2, events: [{ kind: "quickRise", intensity: 0.3 }, { kind: "lowTick", intensity: 0.55, atMs: 70 }, { kind: "tick", intensity: 0.3, atMs: 105 }] },
  sheetClose: { p: 1, events: [{ kind: "fall", intensity: 0.3 }, { kind: "tick", intensity: 0.4, atMs: 50 }] },
  dialogOpen: { p: 2, events: [{ kind: "lowTick", intensity: 0.65 }, { kind: "click", intensity: 0.4, atMs: 45 }] },
  menuOpen: { p: 2, events: [{ kind: "tick", intensity: 0.5 }, { kind: "lowTick", intensity: 0.5, atMs: 30 }, { kind: "tick", intensity: 0.3, atMs: 60 }] },
  // ── Messaging ──
  // Send: a quick wind-up, the release, then a soft "whoosh" fall as it leaves.
  send: { p: 3, events: [{ kind: "quickRise", intensity: 0.25 }, { kind: "click", intensity: 0.8, atMs: 55 }, { kind: "fall", intensity: 0.35, atMs: 100 }, { kind: "lowTick", intensity: 0.25, atMs: 150 }] },
  // Delivered/seen: a faint double "tick-tick", clearly lighter than send.
  delivered: { p: 2, events: [{ kind: "tick", intensity: 0.35 }, { kind: "tick", intensity: 0.45, atMs: 70 }] },
  // Receive: a soft knock-knock-settle so it's recognisable without looking.
  receive: { p: 3, events: [{ kind: "click", intensity: 0.55 }, { kind: "click", intensity: 0.4, atMs: 85 }, { kind: "lowTick", intensity: 0.3, atMs: 160 }] },
  double: { p: 3, events: [{ kind: "click", intensity: 0.5 }, { kind: "click", intensity: 0.35, atMs: 90 }] },
  reaction: { p: 3, events: [{ kind: "lowTick", intensity: 0.5 }, { kind: "click", intensity: 0.8, atMs: 55 }, { kind: "tick", intensity: 0.4, atMs: 100 }, { kind: "lowTick", intensity: 0.25, atMs: 140 }] },
  // Reaction picker scrub: each emoji passed under the finger.
  reactionScrub: { p: 1, events: [{ kind: "tick", intensity: 0.45 }, { kind: "lowTick", intensity: 0.3, atMs: 20 }], gapMs: 40 },
  // Swipe-to-reply: arming (threshold) then commit.
  replyArmed: { p: 3, events: [{ kind: "tick", intensity: 0.5 }, { kind: "click", intensity: 0.8, atMs: 30 }, { kind: "lowTick", intensity: 0.4, atMs: 70 }] },
  replyCommit: { p: 3, events: [{ kind: "click", intensity: 0.6 }, { kind: "fall", intensity: 0.3, atMs: 40 }] },
  // Message actions
  copy: { p: 3, events: [{ kind: "click", intensity: 0.6 }, { kind: "tick", intensity: 0.5, atMs: 45 }, { kind: "tick", intensity: 0.3, atMs: 85 }] },
  pin: { p: 3, events: [{ kind: "lowTick", intensity: 0.5 }, { kind: "click", intensity: 0.9, atMs: 50 }, { kind: "thud", intensity: 0.5, atMs: 95 }] },
  deleteMsg: { p: 4, events: [{ kind: "click", intensity: 0.8 }, { kind: "thud", intensity: 0.7, atMs: 55 }, { kind: "fall", intensity: 0.4, atMs: 120 }] },
  nudge: { p: 4, events: [{ kind: "thud", intensity: 0.8 }, { kind: "thud", intensity: 0.6, atMs: 110 }, { kind: "click", intensity: 0.8, atMs: 220 }, { kind: "thud", intensity: 0.5, atMs: 300 }] },
  scrollBottom: { p: 2, events: [{ kind: "fall", intensity: 0.3 }, { kind: "click", intensity: 0.5, atMs: 50 }] },
  // Voice notes
  voiceStart: { p: 4, events: [{ kind: "quickRise", intensity: 0.5 }, { kind: "click", intensity: 0.85, atMs: 60 }, { kind: "lowTick", intensity: 0.4, atMs: 105 }] },
  voiceLock: { p: 4, events: [{ kind: "click", intensity: 0.7 }, { kind: "click", intensity: 0.9, atMs: 50 }, { kind: "thud", intensity: 0.5, atMs: 95 }] },
  voiceCancel: { p: 4, events: [{ kind: "click", intensity: 0.7 }, { kind: "fall", intensity: 0.5, atMs: 45 }, { kind: "lowTick", intensity: 0.35, atMs: 110 }] },
  voicePlay: { p: 2, events: [{ kind: "tick", intensity: 0.5 }, { kind: "click", intensity: 0.65, atMs: 30 }, { kind: "lowTick", intensity: 0.3, atMs: 65 }] },
  // ── Gestures ──
  longPress: { p: 3, events: [{ kind: "quickRise", intensity: 0.55 }, { kind: "click", intensity: 0.95, atMs: 110 }, { kind: "lowTick", intensity: 0.4, atMs: 160 }] },
  pullThreshold: { p: 3, events: [{ kind: "tick", intensity: 0.5 }, { kind: "click", intensity: 0.75, atMs: 35 }, { kind: "fall", intensity: 0.25, atMs: 80 }] },
  shutter: { p: 4, events: [{ kind: "click", intensity: 1 }, { kind: "thud", intensity: 0.6, atMs: 40 }, { kind: "lowTick", intensity: 0.3, atMs: 90 }] },
  // ── Outcomes (system-tuned on iOS, composed multi-beat on Android) ──
  success: { p: 5, effect: "success" },
  warning: { p: 5, effect: "warning" },
  error: { p: 5, effect: "error" },
  // ── Calls ──
  callConnect: { p: 5, events: [{ kind: "tick", intensity: 0.5 }, { kind: "click", intensity: 0.8, atMs: 70 }, { kind: "click", intensity: 1, atMs: 150 }, { kind: "fall", intensity: 0.35, atMs: 210 }] },
  callEnd: { p: 5, events: [{ kind: "click", intensity: 0.9 }, { kind: "thud", intensity: 0.7, atMs: 70 }, { kind: "fall", intensity: 0.5, atMs: 140 }] },
  // ── Couples-app signatures ──
  heartbeat: { p: 3, events: [{ kind: "thud", intensity: 0.45 }, { kind: "thud", intensity: 0.75, atMs: 140 }, { kind: "fall", intensity: 0.3, atMs: 230 }] },
  // One incoming-call ring cycle — a rolling heartbeat rather than 3 equal buzzes.
  ringPulse: {
    p: 6,
    events: [
      { kind: "quickRise", intensity: 0.5 },
      { kind: "click", intensity: 1, atMs: 90 },
      { kind: "thud", intensity: 0.9, atMs: 125 },
      { kind: "click", intensity: 0.6, atMs: 340 },
      { kind: "thud", intensity: 0.5, atMs: 375 },
    ],
  },
} satisfies Record<string, Def>;

export type HapticPatternName = keyof typeof PATTERNS;
export const HAPTIC_PATTERN_NAMES = Object.keys(PATTERNS) as HapticPatternName[];

/**
 * Fire a named pattern. Honors on/off + intensity, applies gating, never
 * throws. `bypassGate` is for internally sequenced playback (ring loop).
 */
export const fireNamed = (name: HapticPatternName, opts?: { bypassGate?: boolean }): Promise<void> => {
  try {
    if (!hapticsEnabled() || tier() === "none") return Promise.resolve();
    const def: Def = PATTERNS[name];
    if (!opts?.bypassGate && !gate(def.p, def.gapMs)) return Promise.resolve();
    if ("effect" in def) {
      // Success/warning/error are recognised as a category (like a system
      // sound), so they don't get scaled; everything else follows intensity.
      const category = def.effect === "success" || def.effect === "warning" || def.effect === "error";
      const k = category ? 1 : clamp01((def.i ?? 1) * intensityScale());
      return performScaled(def.effect, k).catch(() => undefined);
    }
    return playScaled(scaleEvents(def.events)).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
};

/** Play an ad-hoc pattern (used by lab/preview + bespoke sequences). */
export const playPattern = (events: HapticEvent[], opts?: { priority?: number; bypassGate?: boolean }): Promise<void> => {
  try {
    if (!hapticsEnabled() || tier() === "none") return Promise.resolve();
    if (!opts?.bypassGate && !gate(opts?.priority ?? 3)) return Promise.resolve();
    return playScaled(scaleEvents(events)).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
};

/** Stop whatever is playing (call ringing, long ramps). */
export const cancelHaptics = () => {
  try {
    if (tier() === "duo") void DuospaceHaptics.cancel().catch(() => undefined);
    else if (tier() === "web" && canVibrate()) navigator.vibrate(0);
  } catch { /* silent */ }
};
