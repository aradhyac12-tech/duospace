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
 *
 * BUG FIX ("dock jumping/flickering", worst right after a cold start or a
 * page switch — i.e. whenever the chat's message list first mounts near
 * the bottom of a tall conversation): `AppLayout.tsx` used to animate its
 * reserved bottom padding off this hook's combined `isVisible` — which
 * includes scroll-hide. That's a real feedback loop, not a coincidence:
 * shrinking that padding grows the chat's own scroll container by the
 * same ~84px, which shifts its scrollTop and fires a genuine native
 * `scroll` event with no user touch behind it; `useDockCompactReporter`
 * has no way to tell that apart from a real upward scroll, so it
 * immediately calls `setScrollHidden(false)` again — which grows the
 * padding back, shrinks the container, fires another synthetic scroll
 * event, and flips it right back to hidden. Once started this can
 * self-sustain for as long as the container keeps producing these
 * layout-driven scroll events, which reads exactly like what was
 * reported: a rapid, unrelenting flicker rather than a single clean
 * transition. `isLayoutCollapsed` below is the fix: it's true only for
 * the genuinely infrequent, non-scroll cases (an active call, a
 * photo/video viewer, the camera) that `AppLayout` should actually
 * animate its layout for. Scroll-hide still fully hides the dock's own
 * pill visually — `isVisible` is unchanged for that — it just no longer
 * touches the height of the container it's being measured against.
 */
export function useDockVisibility() {
  const location = useLocation();
  const isHidden = DOCK_HIDDEN_PAGES.includes(location.pathname);
  const { callState } = useCall();
  const isImmersive = useIsImmersive();
  const isScrollHidden = useIsScrollHidden();
  const isInActiveCall = callState === "joining" || callState === "joined";

  return {
    isVisible: !isImmersive && !isInActiveCall && !isScrollHidden,
    isHidden,
    // Deliberately excludes isScrollHidden — see the BUG FIX note above.
    isLayoutCollapsed: isImmersive || isInActiveCall,
  };
}
