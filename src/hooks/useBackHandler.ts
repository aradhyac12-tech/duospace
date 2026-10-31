import { useEffect, useRef } from "react";
import { pushBackHandler } from "@/lib/backStack";

/**
 * While `active` is true, the Android back button calls `handler` (typically
 * "close this overlay") instead of leaving the page. Return `false` from the
 * handler to let back fall through to the next layer.
 */
export function useBackHandler(active: boolean, handler: () => boolean | void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => ref.current());
  }, [active]);
}
