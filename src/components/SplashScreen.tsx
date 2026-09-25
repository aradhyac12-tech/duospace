import { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import storage from "@/lib/storage";
import { resolveColorMode } from "@/lib/themeEngine";
import type { ThemeModePreference, ColorMode } from "@/lib/themeEngine";

interface SplashScreenProps {
  appName?: string;
  onComplete: () => void;
  /**
   * Gate on real readiness (auth resolving), not just a timer — see the
   * effect below. Defaults to true so a caller that never passes it keeps
   * the simplest possible behavior (hold the fixed hand-off beat, then go).
   */
  ready?: boolean;
}

/**
 * This is NOT the native splash — the native Capacitor SplashScreen (config:
 * capacitor.config.json) owns the actual cold-start screen and is what's on
 * screen from process start until this component's first paint.
 * `launchAutoHide` is false there specifically so the native splash holds
 * until useLaunchPermissions() calls SplashScreen.hide() on mount, i.e.
 * right as this component takes over — no fixed guessed duration, no gap.
 *
 * This component is only the brief, sanctioned hand-off frame described in
 * the redesign brief (~150-250ms): same logo mark, same background, same
 * optical position as the native splash, so the transition reads as one
 * continuous image instead of "native splash -> different loading screen ->
 * app". It exists at all only because the native layer can't render the
 * "DuoSpace" wordmark next to the mark (Android 12+'s SplashScreen API and
 * iOS's launch-screen storyboard both only support a background + a single
 * centered icon, no arbitrary text) — this is the one frame that can.
 *
 * Deliberately minimal: no tagline, no progress/spinner, no decorative
 * glows, no language switcher (that lived here before as the app's only
 * language entry point; it needs a real home in Settings, not this
 * hand-off). Logo + wordmark, then gone.
 */
const HOLD_MS = 180;  // logo + wordmark visible
const EXIT_MS = 160;  // crossfade into the real app
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Mirrors ThemeContext's own resolveColorMode call, read-only and
 *  independent of it, so this component knows light vs dark on its very
 *  first render — it can't wait for ThemeProvider's effect (that toggles
 *  the `dark` class on <html>) without risking a flash of the wrong theme
 *  during a window this short. */
function readColorModeSync(): ColorMode {
  const manual = storage.get("duo-color-mode");
  const themeMode = (storage.get("duo-theme-mode") as ThemeModePreference | null) ?? (manual ? (manual as ColorMode) : "auto");
  const manualFallback: ColorMode = manual === "light" || manual === "dark" ? manual : "dark";
  return resolveColorMode(themeMode, {
    manualFallback,
    scheduleDarkStart: storage.get("duo-schedule-start") || "19:00",
    scheduleDarkEnd: storage.get("duo-schedule-end") || "07:00",
  });
}

const SplashScreen = ({ appName = "DuoSpace", onComplete, ready = true }: SplashScreenProps) => {
  const [exiting, setExiting] = useState(false);
  const [colorMode] = useState<ColorMode>(readColorModeSync);
  const cancelled = useRef(false);
  const readyToExit = useRef(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const beginExit = useCallback(() => {
    if (cancelled.current) return;
    setExiting(true);
  }, []);

  useEffect(() => {
    cancelled.current = false;
    const t = window.setTimeout(() => {
      if (cancelled.current) return;
      readyToExit.current = true;
      if (readyRef.current) beginExit();
    }, HOLD_MS);
    return () => {
      cancelled.current = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If `ready` (auth) resolves after the hold window already elapsed, exit
  // immediately rather than waiting on a timer that already fired — same
  // "never hand off onto a blank frame" guarantee the old version had.
  useEffect(() => {
    if (ready && readyToExit.current) beginExit();
  }, [ready, beginExit]);

  useEffect(() => {
    if (!exiting) return;
    const t = window.setTimeout(() => {
      if (!cancelled.current) onComplete();
    }, EXIT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting]);

  const isDark = colorMode === "dark";
  const background = isDark ? "#121316" : "#F6F6F9";
  const markSrc = isDark ? "/duospace-splash-mark-dark.png" : "/duospace-splash-mark.png";
  const textColor = isDark ? "rgba(255,255,255,0.95)" : "rgba(20,20,24,0.92)";

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center"
      style={{ background }}
      animate={{ opacity: exiting ? 0 : 1 }}
      transition={{ duration: EXIT_MS / 1000, ease: EASE }}
    >
      <div className="flex flex-col items-center">
        {/* Same asset, same footprint, same optical center as the native
            splash's resources/splash*.png — see the comment above. Plain
            <img>, no crop/cover: the transparent padding baked into the
            asset is what keeps it safe across every aspect ratio. */}
        <motion.img
          src={markSrc}
          alt={appName}
          draggable={false}
          className="h-[104px] w-[104px] select-none"
          style={{ objectFit: "contain" }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.22, ease: EASE }}
        />
        <motion.span
          className="mt-4 text-[19px] font-semibold tracking-[-0.02em]"
          style={{ color: textColor }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.05, ease: EASE }}
        >
          {appName}
        </motion.span>
      </div>
    </motion.div>
  );
};

export default SplashScreen;
