/**
 * duospace-haptics — premium haptics for DuoSpace.
 *
 * Why this exists: @capacitor/haptics on Android plays a fixed, generic
 * `VibrationEffect.createWaveform` buzz for every Light/Medium/Heavy call
 * (that is the "cheap and hard" feel — it ignores the phone's tuned haptic
 * hardware), and on iOS it only exposes Light/Medium/Heavy (no Soft/Rigid, no
 * per-call intensity, no Core Haptics). Its `selectionStart/End` pair also
 * never fires a tick unless `selectionChanged` is called in between.
 *
 * This plugin goes straight to the good APIs:
 *   Android  VibrationEffect.Composition primitives (CLICK/TICK/LOW_TICK/THUD/
 *            rise/fall/spin, each with a 0..1 scale) → predefined effects →
 *            short waveform (last resort).
 *   iOS      UIImpact/UISelection/UINotification generators (incl. Soft/Rigid
 *            + intensity) for single taps, Core Haptics (transient +
 *            continuous events, intensity/sharpness, parameter curves) for
 *            multi-event signature patterns.
 */

/** Building blocks. Same vocabulary on both platforms. */
export type HapticPrimitive =
  | 'tick' // crisp, very light — list/scrub notches
  | 'lowTick' // rounder, lower-pitched light tick — soft confirmations
  | 'click' // the standard crisp tap
  | 'thud' // deep, round impact (not harsh)
  | 'quickRise' // short ramp up
  | 'slowRise' // longer ramp up — "charging" / hold engaged
  | 'fall' // short ramp down — release / settle
  | 'spin'; // quick rolling sensation

export interface HapticEvent {
  kind: HapticPrimitive;
  /** 0..1, default 1. */
  intensity?: number;
  /** Start offset in ms from the start of the pattern, default 0. */
  atMs?: number;
}

/**
 * Named effects whose best implementation is platform-specific.
 * iOS maps these to the UIKit feedback generators; Android maps them to
 * tuned primitive compositions.
 */
export type HapticSystemEffect =
  | 'selection'
  | 'success'
  | 'warning'
  | 'error'
  | 'impactSoft'
  | 'impactLight'
  | 'impactMedium'
  | 'impactHeavy'
  | 'impactRigid';

export interface HapticCapabilities {
  platform: 'android' | 'ios' | 'web';
  /** Device has any vibration/haptic hardware at all. */
  hasHaptics: boolean;
  /** Android 11+ with HAL primitives, or iOS Core Haptics. */
  rich: boolean;
  /** Android: vibrator supports varying amplitude. */
  amplitudeControl: boolean;
  /** Android SDK_INT / iOS major version, 0 on web. */
  osVersion: number;
  /** Android: which primitives the HAL supports. iOS: all of them (emulated). */
  primitives: HapticPrimitive[];
}

export interface DuospaceHapticsPlugin {
  getCapabilities(): Promise<HapticCapabilities>;
  /** Warm up the haptic engine/generators so the next call has minimal latency. */
  prepare(): Promise<void>;
  perform(options: { effect: HapticSystemEffect; intensity?: number }): Promise<void>;
  play(options: { events: HapticEvent[] }): Promise<void>;
  /** Stop any pattern currently playing. */
  cancel(): Promise<void>;
}
