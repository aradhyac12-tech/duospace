/**
 * Surprise 3.0 §3: device capability adapter.
 *
 * Every existing haptic primitive (lib/haptics.ts) already degrades safely
 * per-call — native Capacitor impact where available, navigator.vibrate
 * pattern otherwise, silent no-op if neither exists, all wrapped in
 * try/catch. This module does NOT duplicate that. What it adds is the one
 * thing per-call safety can't give you: knowing ahead of time how RICH a
 * multi-step sequence this device can actually render as one coherent
 * gesture, so a Haptic DNA rhythm (lib/surpriseHapticDNA.ts) can be shaped
 * to fit the hardware instead of firing five finely-timed beats into a
 * platform that can only really do one.
 */
import { Capacitor } from "@capacitor/core";
import { playHapticSequence, type HapticSequence } from "@/lib/surpriseHaptics";

export type HapticTier = "advanced" | "standard" | "vibration" | "visual-only";

const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

let cachedTier: HapticTier | null = null;

/**
 * Best available haptic tier on this device/session. Cached — platform
 * capability doesn't change mid-session, and this is called on every
 * dispatch, so no reason to recompute the two capability checks each time.
 *
 *  - "advanced"   — Capacitor native shell AND navigator.vibrate both
 *                    answer (Android native/WebView): full custom-waveform
 *                    sequences render faithfully.
 *  - "standard"   — Capacitor native shell, no navigator.vibrate (iOS
 *                    native): only discrete impact/notification kinds are
 *                    available, no arbitrary-duration pattern — a long
 *                    finely-timed sequence would just read as noise here.
 *  - "vibration"  — plain browser with navigator.vibrate (Android browser,
 *                    no native shell): pattern sequences work.
 *  - "visual-only" — neither. Every haptic call becomes a no-op via the
 *                    existing fireHaptic() safety net; the visual/motion
 *                    channel is this device's only channel.
 */
export const detectHapticTier = (): HapticTier => {
  if (cachedTier) return cachedTier;
  const native = Capacitor.isNativePlatform();
  const vibrate = canVibrate();
  cachedTier = native ? (vibrate ? "advanced" : "standard") : vibrate ? "vibration" : "visual-only";
  return cachedTier;
};

/** Only "advanced"/"vibration" can render an arbitrary multi-beat rhythm as
 *  a genuine waveform rather than a string of same-feeling discrete taps. */
export const supportsCustomWaveform = (): boolean => {
  const tier = detectHapticTier();
  return tier === "advanced" || tier === "vibration";
};

/**
 * Plays a Haptic DNA sequence at whatever richness this device can actually
 * render, then falls back to lib/haptics.ts's own per-call safety (global
 * on/off, intensity, native-vs-vibrate-vs-nothing) same as every other
 * haptic call in the app — this never bypasses user preferences, it only
 * decides sequence SHAPE ahead of firing. Never throws: playHapticSequence
 * itself is already try/catch-safe underneath.
 */
export const playCapabilityAwareSequence = (sequence: HapticSequence): (() => void) => {
  if (sequence.length === 0) return () => {};
  const tier = detectHapticTier();
  // "standard" (native iOS, no raw vibrate pattern) can't render fine
  // inter-beat timing as a felt rhythm — collapse to first + last beat
  // (anticipation + climax) so it still reads as ONE composed gesture
  // instead of a handful of identical, unrelated-feeling taps.
  const shaped = tier === "standard" && sequence.length > 2
    ? [sequence[0], sequence[sequence.length - 1]]
    : sequence;
  return playHapticSequence(shaped);
};
