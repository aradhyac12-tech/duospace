import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

// Pages where the floating dock never renders at all.
export const DOCK_HIDDEN_PAGES = ["/settings", "/profile"];

/**
 * Shared "hide on scroll-down, show on scroll-up" visibility state for the
 * floating bottom dock.
 *
 * BUG FIX ("annoying gap between chat box and the bottom when the dock
 * hides"): this used to live entirely inside FloatingDock.tsx as local
 * state. FloatingDock is `position: fixed`, so it doesn't take up any
 * layout space either way — but AppLayout.tsx reserves a constant
 * ~84px of paddingBottom under the page content specifically to keep
 * that fixed dock from covering the last message / compose bar. That
 * padding never changed, so the moment the dock animated off-screen
 * (scroll down), the reserved space stayed reserved — leaving a dead,
 * empty gap between the chat composer and the bottom of the screen where
 * the dock used to be.
 *
 * Lifting this state up (instead of duplicating a second scroll listener)
 * lets AppLayout animate its bottom padding down in lockstep with the
 * dock's own hide/show animation, so the content actually reclaims that
 * space instead of leaving a hole.
 */
export function useDockVisibility() {
  const location = useLocation();
  const [isVisible, setIsVisible] = useState(true);
  const lastScrollY = useRef(0);
  const isHidden = DOCK_HIDDEN_PAGES.includes(location.pathname);

  // Chat/Calls/Settings each scroll their own internal overflow-y-auto div,
  // not the window (the page root is h-[100dvh] overflow-hidden) — so a
  // window-only scroll listener never fires here. "scroll" events don't
  // bubble, but capture-phase dispatch still passes through document, so
  // listening on document with capture:true catches scrolling from
  // whichever container is actually scrolling on the current screen.
  useEffect(() => {
    if (isHidden) return;
    let ticking = false;
    const onScroll = (e: Event) => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const target = e.target as HTMLElement | Document | null;
        const top = !target || target === document
          ? window.scrollY
          : (target as HTMLElement).scrollTop ?? 0;
        const dy = top - lastScrollY.current;
        if (dy > 8 && top > 60) setIsVisible(false);
        else if (dy < -8 || top < 20) setIsVisible(true);
        lastScrollY.current = top;
        ticking = false;
      });
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [isHidden]);

  useEffect(() => { setIsVisible(true); lastScrollY.current = 0; }, [location.pathname]);

  return { isVisible, isHidden };
}
