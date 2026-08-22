import { useEffect, useRef, useState } from "react";

/**
 * True while the on-screen keyboard is very likely open.
 *
 * Phase 2.5 keyboard audit: capacitor.config.json has Keyboard.resize set
 * to "body", meaning the WebView's own layout viewport (window.innerHeight)
 * already shrinks to sit above the keyboard — that's what lets 100dvh/flex
 * layouts reflow without any JS. The known failure mode with that resize
 * mode, especially on iOS, is env(safe-area-inset-bottom) NOT going back to
 * 0 once the keyboard is up: the inset keeps reporting the home-indicator
 * height even though the keyboard already covers that area, leaving a dead
 * gap between the composer and the keyboard ("double safe-area padding" /
 * composer looking like it jumped away from the keyboard).
 *
 * Deliberately NOT using @capacitor/keyboard here — that's a native plugin,
 * and this sandbox has no way to verify the corresponding iOS/Android
 * native-project wiring would actually build. This is a pure web-API
 * fallback (window/visualViewport resize) that needs no new dependency and
 * no native changes, at the cost of being a heuristic rather than an exact
 * keyboard-visible event.
 *
 * Tracks the tallest viewport height seen at the *current width* as the
 * "keyboard closed" baseline, and reports open once the live height drops
 * more than `threshold`px below it. Resetting the baseline on every width
 * change (not just once) matters: an orientation change is a legitimate
 * height drop that must not be mistaken for a keyboard appearing.
 */
export function useKeyboardOpen(threshold = 120): boolean {
  const [open, setOpen] = useState(false);
  const baseline = useRef({ width: -1, maxHeight: 0 });

  useEffect(() => {
    const getHeight = () => window.visualViewport?.height ?? window.innerHeight;

    const update = () => {
      const width = window.innerWidth;
      const height = getHeight();
      if (width !== baseline.current.width) {
        // Width changed (rotation, split-screen, etc.) — this height is the
        // new "no keyboard" ceiling until proven otherwise, not a shrink.
        baseline.current = { width, maxHeight: height };
        setOpen(false);
        return;
      }
      if (height > baseline.current.maxHeight) baseline.current.maxHeight = height;
      setOpen(baseline.current.maxHeight - height > threshold);
    };

    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [threshold]);

  return open;
}
