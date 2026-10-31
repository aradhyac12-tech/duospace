/**
 * Shared motion tokens for the Groic mini / full player (single place to tune feel).
 * Values match what the mini player already used, so adopting them is not a behaviour change.
 * Deliberately NOT used for the tuned drag / artwork-morph springs in GroicFullPlayer
 * (330/300/420) — those are measured against the gesture code; leave them alone.
 * Reduced motion is handled app-wide (MotionConfig reducedMotion="user" in App.tsx + global CSS).
 */
export const SPRING_SHEET = { type: "spring", stiffness: 360, damping: 32 } as const; // bar / sheet enter-exit
export const SPRING_POP = { type: "spring", stiffness: 380, damping: 28 } as const;   // small icon pop in/out
export const EASE_OUT_SOFT = [0.22, 1, 0.36, 1] as const;
export const COVER_FADE = { duration: 0.4, ease: EASE_OUT_SOFT } as const;           // artwork change
export const CONTENT_FADE = { duration: 0.3, ease: "easeOut" } as const;             // title/artist change
