/**
 * When the full player folds into the mini bar, the artwork lands on the bar's thumbnail. A tiny
 * "settle" pulse on the bar at that moment makes the landing read as physical instead of the bar
 * just being there. Web Animations API on the bar's own element (no transform writer conflicts:
 * the bar's entry/exit transform lives on its wrapper), skipped for reduced motion.
 */
export function pulseMiniBar(): void {
  if (typeof document === "undefined") return;
  try {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const el = document.querySelector<HTMLElement>("[data-groic-mini-bar]");
    el?.animate?.(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.03)", offset: 0.4 },
        { transform: "scale(1)" },
      ],
      { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  } catch { /* cosmetic only */ }
}
