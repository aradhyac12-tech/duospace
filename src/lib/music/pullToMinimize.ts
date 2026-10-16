/**
 * Pure maths for the full player's pull-down-to-minimise gesture, kept out of
 * the component so the thresholds are unit-tested (the gesture itself lives in
 * GroicFullPlayer's touch listeners and drives a framer-motion value).
 */
export interface PullSample { t: number; y: number }

/** Fraction of the collapse (0..1) past which releasing commits a minimise. */
export const DISMISS_COMMIT = 0.3;
/** px/ms — a quick downward flick also commits, even if the pull was short. */
export const DISMISS_VELOCITY = 0.7;
/** Travel before we take the touch over from native scrolling (filters taps/jitter). */
export const PULL_ENGAGE_PX = 6;

/** Finger travel (px) that equals a full collapse. The artwork has a long way
 *  to go to reach the mini bar, so scale the pull to it — thumbnail stays
 *  roughly under the finger instead of racing ahead — within sane bounds. */
export const pullRange = (artTravelPx: number): number =>
  Math.min(380, Math.max(220, Math.abs(artTravelPx) * 0.62));

/** 0..1 collapse progress for the current finger travel. */
export const pullProgress = (rawPullPx: number, range: number): number =>
  Math.min(1, Math.max(0, rawPullPx / range));

/** Release velocity over the sampled window, px/ms (positive = downward). */
export const releaseVelocity = (samples: PullSample[]): number => {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
};

/** Should releasing here minimise the player (vs. springing back open)? */
export const shouldMinimize = (rawPullPx: number, range: number, velocityPxPerMs: number): boolean =>
  rawPullPx / range > DISMISS_COMMIT || (velocityPxPerMs > DISMISS_VELOCITY && rawPullPx > 20);

/** True when a touch should be claimed for pull-to-minimise instead of left to
 *  native scrolling: already at the very top, moving clearly DOWN, and more
 *  vertical than horizontal (so the artwork's left/right track-swipe survives). */
export const shouldEngagePull = (dx: number, dy: number, scrollTop: number): boolean =>
  scrollTop <= 0 && dy > PULL_ENGAGE_PX && Math.abs(dx) <= Math.abs(dy);
