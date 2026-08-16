/**
 * Shared motion tokens — the JS-side mirror of index.css's --ease-*/--dur-*
 * custom properties.
 *
 * FIX (shell redesign, "animations feel cranky and disconnected"): index.css
 * already defined a real duration/easing scale (--dur-fast/med/slow,
 * --ease-smooth/snap/spring) — --ease-smooth is even the exact
 * cubic-bezier(0.22, 1, 0.36, 1) curve premium-motion guidance points to.
 * But CSS custom properties can't be read into a Framer Motion `transition`
 * prop (that's JS, not CSS), so every animated component just invented its
 * own duration/spring values independently — GridMenu's fan items used
 * stiffness:420/damping:28, HubButton used stiffness:380/damping:22, the
 * dock's old tap state used a bare 0.88 scale, etc. Nothing shared a
 * source of truth, which is exactly what reads as "disconnected" even
 * when each individual animation is reasonable on its own.
 *
 * This file is the fix: the same three duration tiers and three eases,
 * as plain JS values, so every Framer Motion component in the app can
 * import from here instead of re-deriving its own numbers. Values are
 * kept numerically identical to their CSS counterparts on purpose.
 */

// Bezier control points mirrored from index.css.
export const EASE_SMOOTH: [number, number, number, number] = [0.22, 1, 0.36, 1]; // mirrors --ease-smooth — default for nearly everything
export const EASE_SNAP: [number, number, number, number] = [0.16, 1, 0.3, 1];    // mirrors --ease-snap — quick, decisive dismissals
export const EASE_SPRING: [number, number, number, number] = [0.34, 1.56, 0.64, 1]; // mirrors --ease-spring — has overshoot, use sparingly (CSS-transition contexts only; Framer Motion springs use gentleSpring below instead)

// Seconds, mirrored from index.css's millisecond values.
export const DUR_FAST = 0.14; // 140ms — MICRO: icon swaps, button feedback, toggles
export const DUR_MED = 0.22;  // 220ms — STANDARD: panels, menus, page elements
export const DUR_SLOW = 0.38; // 380ms — EMPHASIS: hero transitions, major state changes

// Ready-to-spread easing transitions for the three tiers above.
export const microTransition = { duration: DUR_FAST, ease: EASE_SMOOTH };
export const standardTransition = { duration: DUR_MED, ease: EASE_SMOOTH };
export const emphasisTransition = { duration: DUR_SLOW, ease: EASE_SMOOTH };
export const snapTransition = { duration: DUR_FAST, ease: EASE_SNAP };

/**
 * One tuned, restrained spring for the handful of interactions that
 * genuinely communicate physical movement (a shared-layout indicator
 * sliding between tabs, a press that compresses and settles) — not a
 * decoration. Deliberately NOT bouncy: no overshoot, no oscillation.
 * Previously every spring in the app picked its own stiffness/damping
 * ad hoc; this is the one spring config meant to be reused rather than
 * re-tuned per component.
 */
export const gentleSpring = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };

/** Slightly softer variant for larger surfaces (panels) where the same
 * stiffness would feel too snappy for the amount of content moving. */
export const gentlePanelSpring = { type: "spring" as const, stiffness: 320, damping: 32, mass: 1 };
