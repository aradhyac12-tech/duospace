import type { CSSProperties } from "react";

/**
 * Single source of truth for how much bottom space AppLayout's outer
 * <main> should reserve for the floating dock — architecturally separated
 * from FloatingDock's own visual show/hide animation (Phase: Dock overlay
 * architecture / "total glass feel").
 *
 * ALWAYS ZERO OUTER RESERVE, on every route including /chat: every page
 * the dock floats over gets its dock clearance from its OWN content, not
 * from this outer layout padding — Calls/Gallery pb-24, Groic pb-36, Map's
 * own safe-area-aware overlay positioning, and — as of this pass — Chat's
 * composer reserving its own bottom clearance directly (see
 * MessageComposer.tsx's dockClearance). That's what lets the dock's glass
 * material (.glass-dock — real blur+saturate, not a flat tint; see
 * index.css) actually read as glass: something real (a message bubble,
 * the composer's own surface, a photo, a map) sits directly behind it to
 * refract, instead of the plain app background AppLayout used to hold
 * open beneath the dock — which looks the same as a flat translucent pill
 * no matter how good the underlying material is.
 *
 * Chat used to be the one exception (an outer reserve applied only on
 * /chat), because its composer sits in normal document flow with nothing
 * else holding it clear of the dock. That's now solved at the composer
 * itself instead of here, so this hook no longer needs route awareness —
 * every page gets the same answer, and the only thing left to reserve for
 * globally is the safe-area inset itself (notches/home-indicator), not
 * the dock.
 */
export function useDockLayoutReserve(): CSSProperties {
  return {
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    transition: "padding-bottom var(--dur-med) var(--ease-smooth)",
  };
}
