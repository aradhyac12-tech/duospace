import { useEffect, useRef } from "react";

interface Options {
  onSwipeLeft?: () => void;  // finger moved left -> "next" (forward)
  onSwipeRight?: () => void; // finger moved right -> "prev" (back)
  enabled?: boolean;
  minDistance?: number; // px
  maxOffAxis?: number;  // vertical tolerance ratio
}

/**
 * Detects a horizontal swipe on touch, evaluated only at touchend (not a
 * live drag-follow). This deliberately avoids Framer Motion's `drag` prop
 * at the page level, which would capture every pointer event inside the
 * page and break nested horizontal scrollers (e.g. the wallpaper picker in
 * Settings) and native vertical momentum scrolling. Elements — or any
 * ancestor — can opt out entirely with `data-swipe-nav-ignore`.
 */
export function useSwipeNav<T extends HTMLElement>({
  onSwipeLeft, onSwipeRight, enabled = true, minDistance = 70, maxOffAxis = 0.6,
}: Options) {
  const ref = useRef<T>(null);
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const ignored = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      ignored.current = !!target.closest("[data-swipe-nav-ignore]");
      if (ignored.current) return;
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (ignored.current || !start.current) { start.current = null; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - start.current.x;
      const dy = t.clientY - start.current.y;
      const dt = Date.now() - start.current.t;
      start.current = null;

      if (Math.abs(dx) < minDistance) return;
      if (Math.abs(dy) > Math.abs(dx) * maxOffAxis) return; // too vertical, was a scroll
      if (dt > 700) return; // too slow to be a deliberate swipe

      if (dx < 0) onSwipeLeft?.();
      else onSwipeRight?.();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled, onSwipeLeft, onSwipeRight, minDistance, maxOffAxis]);

  return ref;
}
