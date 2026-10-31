/**
 * lowLight — pure helpers for dark-room face detection.
 *
 * Why this exists: Peek Guard used to treat "dark" as "give up". Frame quality
 * was multiplied by 0.3, which sat right at the quality gate, so in a dim room
 * the guard went blind (no lock) AND could never auto-recover (the owner's
 * match score drops in noisy landmarks, so the unlock bar was never met), which
 * is what forced the manual tap.
 *
 * The fix is to *repair the frame before detection* instead of discarding it:
 *   1. measure luma percentiles on a tiny sample,
 *   2. build a gamma + levels-stretch lookup table from them,
 *   3. apply it to the frame in the worker (see faceDetection.worker.ts).
 *
 * Everything here is DOM-free so it's unit-testable and shared by the worker
 * and the main thread.
 */

export type LightLevel = "bright" | "dim" | "dark";

/** Effective-brightness (0-255) cutoffs. Kept in one place so the hook, the
 *  worker and the UI all agree on what "dark" means. */
export const DARK_BELOW = 30;
export const DIM_BELOW = 60;
/** Frames brighter than this are never enhanced (pure cost, no benefit). */
export const ENHANCE_BELOW = 85;

export const classifyLight = (effectiveBrightness: number): LightLevel =>
  effectiveBrightness < DARK_BELOW ? "dark" : effectiveBrightness < DIM_BELOW ? "dim" : "bright";

export interface LumaStats {
  mean: number;
  /** ~2nd percentile (black point). */
  lo: number;
  /** ~98th percentile (white point). */
  hi: number;
}

/** Luma stats from RGBA pixel data (any size, typically a ~32x24 sample). */
export const lumaStatsFromRgba = (rgba: Uint8ClampedArray | Uint8Array): LumaStats => {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { mean: 0, lo: 0, hi: 255 };
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const y = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
    hist[y]++;
    sum += y;
  }
  const pct = (q: number) => {
    const target = n * q;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  return { mean: sum / n, lo: pct(0.02), hi: pct(0.98) };
};

export interface EnhancePlan {
  /** False when the frame is bright enough to leave alone. */
  enhance: boolean;
  gamma: number;
  lo: number;
  hi: number;
}

/** Target mean luma after enhancement. Mid-grey-ish: bright enough for the
 *  landmark model, low enough not to blow out a screen-lit face. */
const TARGET_MEAN = 105;
/** Never amplify more than this (gamma floor): below it the gain mostly lifts
 *  sensor noise, which hurts landmark stability more than it helps. */
const MIN_GAMMA = 0.38;

export const planEnhancement = (stats: LumaStats): EnhancePlan => {
  if (stats.mean >= ENHANCE_BELOW) return { enhance: false, gamma: 1, lo: 0, hi: 255 };
  // Levels stretch: pull the black point up to the real black and the white
  // point out, but keep a minimum span so a near-flat dark frame (lens
  // covered) isn't stretched into pure noise.
  const lo = Math.min(stats.lo, 40);
  const hi = Math.max(stats.hi, lo + 48);
  // Mean after the linear stretch, then solve gamma so mean -> TARGET_MEAN.
  const stretchedMean = Math.min(0.98, Math.max(0.02, (stats.mean - lo) / (hi - lo)));
  const gamma = Math.min(
    1,
    Math.max(MIN_GAMMA, Math.log(TARGET_MEAN / 255) / Math.log(stretchedMean)),
  );
  return { enhance: true, gamma, lo, hi };
};

/** 256-entry lookup table implementing the plan. */
export const buildEnhanceLut = (plan: EnhancePlan): Uint8ClampedArray => {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(1, plan.hi - plan.lo);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - plan.lo) / span));
    lut[v] = Math.round(255 * Math.pow(t, plan.gamma));
  }
  return lut;
};

/** Applies the LUT to RGBA data in place (alpha untouched). */
export const applyLut = (rgba: Uint8ClampedArray, lut: Uint8ClampedArray): void => {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = lut[rgba[i]];
    rgba[i + 1] = lut[rgba[i + 1]];
    rgba[i + 2] = lut[rgba[i + 2]];
  }
};

/** What the detection worker reports back about the frame it just scored. */
export interface DetectionMeta {
  /** Mean luma of the whole frame (0-255), pre-enhancement. */
  meanLuma: number;
  /** Mean luma of the largest face crop (0-255), pre-enhancement, or null. */
  faceLuma: number | null;
  /** True when the frame was brightened before detection. */
  enhanced: boolean;
  gamma: number;
}
