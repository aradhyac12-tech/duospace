import { useLocation } from "react-router-dom";
import { useCall } from "@/contexts/CallContext";
import { useIsImmersive } from "@/hooks/useImmersiveMode";
import { useIsScrollHidden } from "@/lib/dockScrollHide";

// Pages where the floating dock never renders at all.
export const DOCK_HIDDEN_PAGES = ["/settings", "/profile"];

/**
 * UPDATE (iOS/Instagram-style auto-hide, restored per direct request): the
 * dock now hides on three independent signals, all combined below:
 *   - an active call (joining/joined) — read directly from CallContext
 *   - any registered immersive surface (photo/video viewer, camera) — see
 *     useImmersiveMode.ts/useSetImmersive
 *   - scroll direction (hide on scroll-down, show instantly on scroll-up
 *     or return-to-top) and composer focus/typing — see
 *     lib/dockScrollHide.ts, fed by useDockCompactReporter (scroll) and
 *     MessageComposer's input focus/blur (typing), both using the same
 *     hysteresis/dead-zone tuning that fixed the old flicker issues, so
 *     this isn't a naive re-add of the original jank-prone version.
 *
 * A prior pass here deliberately removed scroll-hide in favor of an
 * always-visible dock. This pass reverses that specific call — kept as a
 * separate flag (isScrollHidden) rather than merged into isImmersive, since
 * the two have different semantics (immersive = truly blocked by another
 * surface; scroll-hide = softer and instantly reversible) and callers may
 * want to reason about them independently later.
 */
export function useDockVisibility() {
  const location = useLocation();
  const isHidden = DOCK_HIDDEN_PAGES.includes(location.pathname);
  const { callState } = useCall();
  const isImmersive = useIsImmersive();
  const isScrollHidden = useIsScrollHidden();
  const isInActiveCall = callState === "joining" || callState === "joined";

  return { isVisible: !isImmersive && !isInActiveCall && !isScrollHidden, isHidden };
}
