import { useEffect, type RefObject } from "react";

/**
 * Pull-to-refresh for a scroll container — built for smoothness:
 *  - zero React re-renders while dragging: the content/indicator are moved with direct `transform`/`height`
 *    writes (GPU-composited, 60 fps), React only runs when `onRefresh` does;
 *  - rubber-band resistance (exponential), a light haptic the moment the release point is crossed;
 *  - only engages when the list is at the very top and the gesture is mostly VERTICAL, so horizontal rails and
 *    normal scrolling are never hijacked;
 *  - holds the spinner for at least `minMs` so a fast refresh doesn't just flicker.
 *
 * DOM contract: `contentRef` = the element that slides down; `indicatorRef` = an absolutely-positioned strip that
 * sits where the content started (its height is set to the pull distance) and contains an element with
 * `data-ptr-icon` that rotates / spins.
 */
export interface PullToRefreshOptions {
  enabled?: boolean;
  onRefresh: () => Promise<unknown> | void;
  onThreshold?: () => void;   // haptic tick when crossing the release point
  threshold?: number;         // px of (damped) pull needed to trigger
  max?: number;               // px, hard cap of the damped pull
  minMs?: number;             // minimum time the spinner stays visible
}

export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement>, contentRef: RefObject<HTMLElement>, indicatorRef: RefObject<HTMLElement>,
  { enabled = true, onRefresh, onThreshold, threshold = 72, max = 128, minMs = 700 }: PullToRefreshOptions,
) {
  useEffect(() => {
    const sc = scrollRef.current, content = contentRef.current, ind = indicatorRef.current;
    if (!enabled || !sc || !content || !ind) return;
    const icon = ind.querySelector<HTMLElement>("[data-ptr-icon]");
    const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
    let startY = 0, startX = 0, tracking = false, pulling = false, dist = 0, refreshing = false, ticked = false;
    let alive = true;

    const setDist = (d: number, animate: boolean) => {
      dist = d;
      content.style.transition = animate ? `transform 300ms ${EASE}` : "none";
      ind.style.transition = animate ? `height 300ms ${EASE}, opacity 200ms ease` : "none";
      content.style.transform = d > 0 ? `translate3d(0, ${d}px, 0)` : "";
      content.style.willChange = d > 0 ? "transform" : "";
      ind.style.height = `${d}px`;
      const p = Math.min(1, d / threshold);
      ind.style.opacity = String(Math.min(1, p * 1.25));
      if (icon && !refreshing) icon.style.transform = `rotate(${Math.round(p * 300)}deg) scale(${(0.6 + 0.4 * p).toFixed(3)})`;
    };

    const onStart = (e: TouchEvent) => {
      if (refreshing || e.touches.length !== 1 || sc.scrollTop > 0) { tracking = false; return; }
      tracking = true; pulling = false; ticked = false;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (!pulling) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { tracking = false; return; } // horizontal gesture: not ours
        if (dy < -6 || sc.scrollTop > 0) { tracking = false; return; }                          // scrolling down the list
        if (dy < 8) return;                                                                      // dead zone
        pulling = true;
      }
      if (e.cancelable) e.preventDefault(); // stop the native overscroll while we own the gesture
      const d = max * (1 - Math.exp(-Math.max(0, dy - 8) / (max * 0.9)));
      setDist(d, false);
      if (d >= threshold && !ticked) { ticked = true; onThreshold?.(); }
      if (d < threshold - 6) ticked = false;
    };
    const finish = () => {
      refreshing = false;
      icon?.classList.remove("animate-spin");
      if (icon) icon.style.transform = "";
      setDist(0, true);
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!pulling) return;
      pulling = false;
      if (dist >= threshold) {
        refreshing = true;
        if (icon) { icon.style.transform = ""; icon.classList.add("animate-spin"); }
        setDist(56, true);
        const started = Date.now();
        Promise.resolve().then(onRefresh).catch(() => { /* the caller reports its own errors */ })
          .then(() => new Promise<void>((r) => setTimeout(r, Math.max(0, minMs - (Date.now() - started)))))
          .finally(() => { if (alive) finish(); });
      } else {
        setDist(0, true);
      }
    };

    sc.addEventListener("touchstart", onStart, { passive: true });
    sc.addEventListener("touchmove", onMove, { passive: false });
    sc.addEventListener("touchend", onEnd, { passive: true });
    sc.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      alive = false;
      sc.removeEventListener("touchstart", onStart);
      sc.removeEventListener("touchmove", onMove);
      sc.removeEventListener("touchend", onEnd);
      sc.removeEventListener("touchcancel", onEnd);
      content.style.transform = ""; content.style.transition = ""; content.style.willChange = "";
      ind.style.height = "0px"; ind.style.opacity = "0";
      icon?.classList.remove("animate-spin");
    };
  }, [enabled, scrollRef, contentRef, indicatorRef, onRefresh, onThreshold, threshold, max, minMs]);
}
