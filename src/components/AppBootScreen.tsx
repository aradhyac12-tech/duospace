import storage from "@/lib/storage";
import { resolveColorMode } from "@/lib/themeEngine";
import type { ThemeModePreference, ColorMode } from "@/lib/themeEngine";

/**
 * Shared full-screen boot/loading state — used wherever the app has
 * nothing else to show yet (auth resolving, onboarding-status check, etc).
 *
 * FIX (DA-05): this exact markup (badge + pulsing label, centered on a
 * plain background) was duplicated verbatim between AuthRoute and
 * ProtectedRoutes in App.tsx — same classes, same structure, same
 * potential for drifting out of sync on a future copy change. Extracted
 * with no visual change; ProtectedRoutes' third "Setting up..." state
 * (onboarding-status check) used the same wrapper without the badge, so
 * that's folded in here too via `showBadge`.
 *
 * PHASE 3 FIX (splash continuity): "no visual change" above was true
 * relative to the OLD duplicated markup, but it was never actually checked
 * against SplashScreen.tsx — this rendered a plain gray circle with text
 * initials on a flat `bg-background`, while the branded hand-off splash
 * shows the real logo mark on an exact-matched background color. Since
 * SplashScreen's exit is gated on `!authLoading` (App.tsx) but the
 * onboarding-status check that also renders THIS component happens AFTER
 * auth resolves, the branded splash could hand off directly into this
 * mismatched screen — exactly the "native splash -> different loading
 * screen -> app" flash the redesign brief calls out. Now uses the same
 * background-color resolution and logo mark asset as SplashScreen.tsx, so
 * whichever one is on screen it reads as one continuous surface. Keep
 * these two in sync if either changes — small enough (a handful of
 * constants) that a shared module would be more coupling than the
 * duplication is worth for two components that are otherwise independent.
 */
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

export function AppBootScreen({ label = "Loading...", showBadge = true }: { label?: string; showBadge?: boolean }) {
  const isDark = readColorModeSync() === "dark";
  const background = isDark ? "#121316" : "#F6F6F9";
  const markSrc = isDark ? "/duospace-splash-mark-dark.png" : "/duospace-splash-mark.png";
  const textColor = isDark ? "rgba(255,255,255,0.95)" : "rgba(20,20,24,0.92)";

  return (
    <div className="min-h-dvh flex items-center justify-center" style={{ background }}>
      <div className="flex flex-col items-center">
        {showBadge && (
          <img
            src={markSrc}
            alt=""
            draggable={false}
            className="h-[104px] w-[104px] select-none"
            style={{ objectFit: "contain" }}
          />
        )}
        <p
          className="mt-4 text-xs animate-pulse"
          style={{ color: textColor }}
        >
          {label}
        </p>
      </div>
    </div>
  );
}

export default AppBootScreen;
