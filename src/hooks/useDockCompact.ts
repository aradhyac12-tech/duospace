import { useEffect, useRef, useState, type RefObject } from "react";
import { setScrollHidden } from "@/lib/dockScrollHide";

// ─── useDockCompact ──────────────────────────────────────────────────────────
// Phase 1 (redesign continuation) addition.
//
// UPDATE (Instagram/iOS-style auto-hide, per direct request): the dock now
// DOES fully hide on scroll again — the "never disappear" rule below was a
// deliberate earlier design decision, and this pass deliberately reverses
// it for the scroll case specifically (typing-triggered hide is separate,
// see MessageComposer.tsx). Kept as its own flag in lib/dockScrollHide.ts
// rather than folding into useDockVisibility's isImmersive check, so the
// two mechanisms with different semantics (immersive = something's truly
// covering the dock's spot; scroll-hide = softer, reversed instantly on
// scroll-up or return-to-top) stay independently reasoned about.
//
// What follows is the original, still-accurate "compress, don't hide"
// cosmetic step — it now runs ALONGSIDE the full hide below, giving a
// slightly-shrunk dock in the ~90ms window before the fuller hide kicks in,
// which reads as an intentional, springy exit rather than an instant cut.
//
// FloatingDock is a sibling of the routed page content in AppLayout (not an
// ancestor/descendant), so there's no normal prop path from e.g. Chat's
// message list up to the dock. Rather than route this through page props,
// AppLayout, and back down (three files touched for a purely cosmetic
// signal), this uses the same lightweight pattern already established in
// this codebase for exactly this kind of cross-tree signal — see
// CallContext's `duospace-call-control` window CustomEvent and
// useImmersiveMode's module-level subscriber set. A tiny shared module
// state + listener set is simpler and lower-risk here than introducing a
// new context provider just for one boolean.

type Listener = (compact: boolean) => void;
const listeners = new Set<Listener>();
let compactState = false;

function setCompact(next: boolean) {
  if (next === compactState) return;
  compactState = next;
  listeners.forEach((l) => l(compactState));
}

/** Consumed by FloatingDock to read the current compact/restored state. */
export function useDockCompactState(): boolean {
  const [compact, setLocal] = useState(compactState);
  useEffect(() => {
    listeners.add(setLocal);
    return () => { listeners.delete(setLocal); };
  }, []);
  return compact;
}

/**
 * Attach to a page's own scrollable container to report scroll activity.
 * Compresses the dock ~90ms after scrolling starts (avoids compressing for
 * a single-pixel rubber-band flick), restores it automatically ~260ms after
 * scrolling stops, and restores it immediately whenever the container is
 * back within `restoreThreshold` px of the top — so returning toward the
 * top of a conversation always reads as "navigation is back," not just
 * "scrolling paused."
 */
export function useDockCompactReporter(
  ref: RefObject<HTMLElement>,
  opts?: { restoreThreshold?: number },
) {
  const restoreThreshold = opts?.restoreThreshold ?? 24;
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();
  const startTimer = useRef<ReturnType<typeof setTimeout>>();
  // Direction tracking for the full hide, kept separate from the compact
  // timers above since it needs to react per-frame, not on a delay.
  const lastScrollTop = useRef(0);
  // Small dead-zone so sub-pixel rubber-band jitter (iOS bounce, trackpad
  // noise) can't flip direction back and forth — a real swipe clears this
  // easily, a stray 1-2px wobble doesn't.
  const DIRECTION_THRESHOLD = 6;
  // FIX (dock flickering while scrolling): the old logic flipped
  // setScrollHidden on every single scroll event as soon as that event's
  // own per-frame delta crossed DIRECTION_THRESHOLD, with no memory of
  // what it had just decided. A real scroll gesture's per-frame delta
  // isn't monotonic — momentum/inertial scroll decelerates unevenly and
  // rubber-banding produces small reversed deltas even while the overall
  // gesture is still headed one way — so consecutive events routinely
  // alternated sign around the threshold, and each one immediately fired
  // its own setScrollHidden(true)/(false), yanking the dock's spring
  // in and out mid-gesture instead of committing to one direction.
  // Fixed with two changes: (1) accumulate delta within the *current*
  // direction rather than reacting to one event's raw delta, and reset
  // the accumulator when the direction actually flips, so a couple of
  // stray opposite-sign frames can't each independently trigger a flip;
  // (2) a minimum interval between committed hide/show decisions, so even
  // a genuine direction change can't re-fire faster than the dock's own
  // hide/show spring can visually resolve.
  const accumulatedDelta = useRef(0);
  const lastDirection = useRef<1 | -1 | 0>(0);
  const lastDecisionAt = useRef(0);
  const MIN_DECISION_INTERVAL_MS = 120;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    lastScrollTop.current = el.scrollTop;

    const handleScroll = () => {
      const top = el.scrollTop;
      const delta = top - lastScrollTop.current;
      lastScrollTop.current = top;

      if (top <= restoreThreshold) {
        clearTimeout(startTimer.current);
        clearTimeout(idleTimer.current);
        setCompact(false);
        setScrollHidden(false); // back near the top always reads as "nav is back"
        accumulatedDelta.current = 0;
        lastDirection.current = 0;
      } else {
        const direction: 1 | -1 | 0 = delta > 0 ? 1 : delta < 0 ? -1 : 0;
        if (direction !== 0) {
          // Same direction as the run we're already tracking: keep
          // building on it. Direction flipped: the previous run is over,
          // start a fresh one from this event instead of letting a single
          // opposite frame partially cancel it out.
          accumulatedDelta.current = direction === lastDirection.current
            ? accumulatedDelta.current + delta
            : delta;
          lastDirection.current = direction;
        }

        const now = performance.now();
        const readyForDecision = now - lastDecisionAt.current > MIN_DECISION_INTERVAL_MS;
        if (readyForDecision && accumulatedDelta.current > DIRECTION_THRESHOLD) {
          setScrollHidden(true); // sustained scroll down — get out of the reader's way
          lastDecisionAt.current = now;
          accumulatedDelta.current = 0;
        } else if (readyForDecision && accumulatedDelta.current < -DIRECTION_THRESHOLD) {
          setScrollHidden(false); // sustained scroll up — bring it right back, iOS/IG style
          lastDecisionAt.current = now;
          accumulatedDelta.current = 0;
        }
      }

      if (top > restoreThreshold) {
        if (!startTimer.current) {
          startTimer.current = setTimeout(() => { setCompact(true); startTimer.current = undefined; }, 90);
        }
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setCompact(false), 260);
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      clearTimeout(idleTimer.current);
      clearTimeout(startTimer.current);
      setCompact(false); // leaving the page — never strand the dock compact
      setScrollHidden(false); // …or hidden
      accumulatedDelta.current = 0;
      lastDirection.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, restoreThreshold]);
}
