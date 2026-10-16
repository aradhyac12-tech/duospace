/**
 * themeBoot — apply the PERSISTED theme synchronously, before React renders.
 *
 * Why: ThemeProvider applies tokens in a useEffect, i.e. AFTER the first
 * render. Everything that paints before that (boot screen, splash, the
 * location gate) read hardcoded colours or index.css's static defaults, so a
 * Wine/AMOLED/light user saw default colours for a frame, then the app
 * "changed colour". This runs next to bootFontPreset / bootTextDensity /
 * bootPerfProfile in main.tsx and uses the SAME engine and the SAME storage
 * keys as ThemeProvider — it is not a second theme system, just an earlier
 * call to it. ThemeProvider still owns all later changes and re-applies the
 * identical tokens on mount (idempotent).
 */
import storage from "@/lib/storage";
import {
  deriveTokens, deriveDynamicTokens, applyTokens, resolveColorMode,
  ColorMode, ThemeModePreference,
} from "@/lib/themeEngine";
import { THEME_IDENTITIES, THEME_DEFAULT_MODE, resolveThemeId } from "@/contexts/ThemeContext";
import { restoreActiveCustomTheme } from "@/lib/customThemes";

export function bootTheme(): void {
  if (typeof document === "undefined") return;
  try {
    const theme = resolveThemeId(storage.get("duo-theme"));
    const identity = THEME_IDENTITIES[theme] ?? THEME_IDENTITIES.midnight;

    // Mirrors ThemeProvider's initial-state logic exactly (same keys/defaults).
    const manualSaved = storage.get("duo-color-mode");
    const manualFallback: ColorMode =
      manualSaved === "light" || manualSaved === "dark" ? manualSaved : THEME_DEFAULT_MODE[theme];
    const savedMode = storage.get("duo-theme-mode");
    const themeMode: ThemeModePreference =
      savedMode === "light" || savedMode === "dark" || savedMode === "auto" ||
      savedMode === "schedule" || savedMode === "dynamic"
        ? savedMode
        : manualSaved ? manualFallback : "auto";

    const colorMode = resolveColorMode(themeMode, {
      manualFallback,
      scheduleDarkStart: storage.get("duo-schedule-start") || "19:00",
      scheduleDarkEnd: storage.get("duo-schedule-end") || "07:00",
    });

    applyTokens(themeMode === "dynamic" ? deriveDynamicTokens(identity, new Date()) : deriveTokens(identity, colorMode));
    document.documentElement.classList.toggle("dark", colorMode === "dark");
    // An active custom theme (incl. AMOLED / gradient) overrides the preset,
    // exactly as ThemeProvider does a moment later — do it now so the first
    // frame already has it.
    restoreActiveCustomTheme(colorMode);
  } catch {
    /* boot is best-effort: ThemeProvider applies the theme right after anyway */
  }
}
