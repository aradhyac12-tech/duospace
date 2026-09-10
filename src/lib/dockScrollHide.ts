import { useEffect, useState } from "react";

/**
 * Scroll-direction dock hide — Instagram/iOS-style.
 *
 * Deliberately separate from lib/immersiveMode.ts: immersive surfaces
 * (camera, photo/video viewer, active call) mean "something is covering
 * the dock's spot and it must get fully out of the way, full stop."
 * Scroll-hide means something softer — "the user is reading, reclaim the
 * space, but the instant they scroll up (or reach the top) bring it right
 * back." Keeping these as two independent flags means a scroll-hide never
 * has to know or care about immersive state and vice versa; they're
 * combined where it matters, in useDockVisibility.
 *
 * Same tiny module-scope pub-sub shape as useDockCompact.ts /
 * lib/immersiveMode.ts — not a new state system.
 */

type Listener = (hidden: boolean) => void;
const listeners = new Set<Listener>();
let hiddenState = false;

function setScrollHidden(next: boolean) {
  if (next === hiddenState) return;
  hiddenState = next;
  listeners.forEach((l) => l(hiddenState));
}

/** Consumed by useDockVisibility to fold scroll-hide into overall dock visibility. */
export function useIsScrollHidden(): boolean {
  const [hidden, setLocal] = useState(hiddenState);
  useEffect(() => {
    listeners.add(setLocal);
    return () => { listeners.delete(setLocal); };
  }, []);
  return hidden;
}

export { setScrollHidden };
