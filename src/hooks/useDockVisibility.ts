import { useLocation } from "react-router-dom";
import { useCall } from "@/contexts/CallContext";
import { useIsImmersive } from "@/hooks/useImmersiveMode";

// Pages where the floating dock never renders at all.
export const DOCK_HIDDEN_PAGES = ["/settings", "/profile"];

/**
 * Shell-redesign FIX: this used to hide/show the dock on scroll direction
 * (hide on scroll-down, show on scroll-up, with hysteresis tuning to fight
 * flicker from touch-scroll noise). That whole mechanism is gone. Per the
 * redesign brief: the dock is a stable, always-visible part of the app
 * shell — it should never disappear just because the user scrolled a list.
 * A user shouldn't have to wonder where their primary navigation went.
 *
 * The dock now only steps aside for a genuine full-screen interaction it
 * would otherwise sit on top of:
 *   - an active call (joining/joined) — read directly from CallContext,
 *     since AppLayout already sits inside CallProvider
 *   - any other registered immersive surface (photo/video viewer, camera)
 *     — see useImmersiveMode.ts/useSetImmersive, since those live deep
 *     inside routed page components with no prop path to FloatingDock
 *     (a sibling, not an ancestor, in AppLayout's tree)
 *
 * Both of those are deliberate, explicit signals — not a heuristic guessing
 * at scroll intent — so there's no more flicker/jank class of bug possible
 * here at all, not just a better-tuned version of the old one.
 */
export function useDockVisibility() {
  const location = useLocation();
  const isHidden = DOCK_HIDDEN_PAGES.includes(location.pathname);
  const { callState } = useCall();
  const isImmersive = useIsImmersive();
  const isInActiveCall = callState === "joining" || callState === "joined";

  return { isVisible: !isImmersive && !isInActiveCall, isHidden };
}
