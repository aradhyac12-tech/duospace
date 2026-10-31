import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

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
 * ROOT CAUSE FIX (whole-page flicker on Android browsers, reported via
 * screen recording): the previous version tracked only ONE measurement
 * (visualViewport height, falling back to innerHeight) against its own
 * historical max and called any >threshold drop "keyboard open". On
 * Chrome/Samsung Internet, the address bar + bottom nav bar auto-hide on
 * scroll — that alone shrinks BOTH innerHeight and visualViewport.height by
 * 100-150px, comfortably past the old 120px threshold, so every toolbar
 * hide/show cycle was misread as the keyboard opening/closing. Each
 * misfire flipped `open`, which drives DuoSpaceBottomSurface's fixed
 * `bottom` offset and Chat's scroll-to-bottom correction — while the
 * toolbar animates (dozens of resize events over ~300-500ms), that
 * thrashed the composer position and scroll offset every frame, reading as
 * the whole bottom surface (and, via the scroll-position side effect,
 * message content) flickering in and out.
 *
 * Fix has two parts:
 * 1. Platform-specific signal. On native (Keyboard.resize:"body"), the
 *    keyboard genuinely shrinks window.innerHeight itself, so the old
 *    "current height vs tallest-seen-at-this-width" baseline is correct
 *    and kept as-is — there's no browser chrome there to confuse it.
 *    On web, use the gap between window.innerHeight (layout viewport —
 *    unaffected by an on-screen keyboard, only by real layout changes) and
 *    visualViewport.height (visual viewport — shrinks under an on-screen
 *    keyboard but shrinks IN STEP with innerHeight when only the address
 *    bar/nav bar toggle). That gap stays ~0 through a toolbar animation and
 *    only grows when a keyboard actually overlays the page, so it isn't
 *    fooled by chrome hide/show at all.
 * 2. Debounce. Resize events fire many times over the course of an
 *    animated toolbar transition (or a keyboard sliding in/out); reacting
 *    to every intermediate frame is what made the old code visibly
 *    thrash. Settle for one animation frame + a short delay and only then
 *    read the final geometry, so a transient mid-animation sample never
 *    reaches `setOpen`.
 */
export function useKeyboardOpen(threshold = 120): boolean {
  const [open, setOpen] = useState(false);
  const baseline = useRef({ width: -1, maxHeight: 0 });
  const isNative = useRef(Capacitor.isNativePlatform());

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;

    const computeNative = () => {
      const width = window.innerWidth;
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (width !== baseline.current.width) {
        // Width changed (rotation, split-screen, etc.) — this height is the
        // new "no keyboard" ceiling until proven otherwise, not a shrink.
        baseline.current = { width, maxHeight: height };
        return false;
      }
      if (height > baseline.current.maxHeight) baseline.current.maxHeight = height;
      return baseline.current.maxHeight - height > threshold;
    };

    const computeWeb = () => {
      // Layout viewport vs visual viewport. Address bar / bottom nav bar
      // show-hide moves both together (gap ~0); an on-screen keyboard only
      // shrinks the visual viewport (gap grows large).
      const vv = window.visualViewport;
      if (!vv) return computeNative(); // no visualViewport support — fall back to the old heuristic
      const gap = window.innerHeight - vv.height;
      return gap > threshold;
    };

    const settle = () => {
      setOpen(isNative.current ? computeNative() : computeWeb());
    };

    const scheduleUpdate = () => {
      // Wait for the browser-chrome / keyboard animation to actually
      // finish moving before trusting the geometry — a live sample taken
      // mid-transition is exactly what produced the flicker.
      if (debounceTimer) clearTimeout(debounceTimer);
      if (rafId) cancelAnimationFrame(rafId);
      debounceTimer = setTimeout(() => {
        rafId = requestAnimationFrame(settle);
      }, 120);
    };

    settle();
    window.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    };
  }, [threshold]);

  return open;
}
