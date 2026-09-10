import { useEffect, useRef } from "react";

interface Props {
  /** Full lifespan of this message's timer, in ms (disappear_at - created_at). */
  totalMs: number;
  /** How much is left right now, in ms (disappear_at - Date.now()) at mount/update time. */
  remainingMs: number;
  size?: number;
  className?: string;
}

/**
 * A small ring that visually depletes from full to empty exactly as a
 * disappearing message counts down — the same convention Signal, Telegram,
 * and Instagram all use for ephemeral content, and a much more premium,
 * glanceable signal than a static clock glyph or a ticking "0:07" label.
 *
 * Deliberately has zero React re-renders for the countdown itself: the ring
 * is set to its correct starting position, then handed a single CSS
 * transition running for exactly `remainingMs` — the browser's compositor
 * drives the rest for free. A ticking-text version would mean re-rendering
 * every message bubble once a second for as long as any message is pending,
 * which is both unnecessary work and, honestly, less elegant.
 */
const DisappearRing = ({ totalMs, remainingMs, size = 13, className }: Props) => {
  const circleRef = useRef<SVGCircleElement>(null);
  const r = (size - 2) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;

  useEffect(() => {
    const el = circleRef.current;
    if (!el) return;
    const clampedMs = Math.max(0, remainingMs);
    // Snap to the correct "already elapsed" starting position with no
    // transition, force the browser to register it, then switch the
    // transition back on and set the end state (fully depleted). Skipping
    // the reflow-forcing step risks the browser coalescing both writes into
    // one frame and silently skipping the animation.
    el.style.transition = "none";
    el.style.strokeDashoffset = String(circumference * (1 - fraction));
    void el.getBoundingClientRect();
    el.style.transition = `stroke-dashoffset ${clampedMs}ms linear`;
    el.style.strokeDashoffset = String(circumference);
  }, [totalMs, remainingMs, circumference, fraction]);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={1.6} />
      <circle
        ref={circleRef}
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={1.6}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

export default DisappearRing;
