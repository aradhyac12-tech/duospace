/**
 * Surprise 3.0 §5: multi-plane 3D depth.
 *
 * Named multipliers only — no rendering logic here. Different layers move
 * different amounts under the same tilt input so depth reads as real
 * separation ("parallax between layers") instead of the whole scene
 * rotating as one flat sheet. Consumed by SurpriseReveal's glass-phase
 * layers today; the scene components (SurpriseRenderer's per-mood scenes)
 * take tilt via their own getTilt() prop and can import these same
 * multipliers rather than inventing their own numbers.
 */
export const DEPTH_PLANE = {
  background: 0.15,
  particles: 0.4,
  mainObject: 0.8,
  foreground: 1.2,
} as const;

export type DepthPlaneName = keyof typeof DEPTH_PLANE;

/** Max parallax shift, in px, at full tilt (±0.5 on the normalized rawX/rawY
 *  scale SurpriseReveal already uses) for a plane at multiplier 1.0. A
 *  plane's actual shift is this times its own DEPTH_PLANE multiplier. */
export const PARALLAX_AMPLITUDE_PX = 26;

/** Shared spring tuning for parallax motion values, matching the card's
 *  own rotateX/rotateY spring feel so layers don't drift out of sync with
 *  the card they're layered inside. */
export const PARALLAX_SPRING = { stiffness: 120, damping: 16 } as const;
