import { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
// FIX #9: Use the shared storage wrapper (src/lib/storage.ts) instead of an
// inline duplicate. All localStorage access goes through one safe try/catch
// boundary, consistent with the rest of the app.
import storage from "@/lib/storage";
import { isOnlineNow, subscribeConnectivity } from "@/lib/connectivity";
import { readPersistedSession } from "@/lib/persistedSession";
import { idbGet, idbSet, idbDelete } from "@/lib/idbStore";
import { markAppBackgrounded, clearAppBackgroundedMark, shouldLockOnResume, hasBackgroundedMark, installPickerLockGuard } from "@/lib/appLockTimer";

installPickerLockGuard();
import { deriveTokens, deriveDynamicTokens, applyTokens, ColorMode, ThemeIdentity, ThemeModePreference, resolveColorMode } from "@/lib/themeEngine";

export type ThemeColor =
  | "midnight"
  | "graphite"
  | "ocean"
  | "forest"
  | "arctic"
  | "amber"
  | "rose"
  | "minimal-light"
  | "minimal-dark"
  | "monochrome"
  | "lavender"
  | "mint"
  | "plum"
  | "coral"
  | "slate"
  | "blush"
  | "cocoa"
  | "lagoon"
  | "wine"
  | "sunset"
  | "emerald"
  | "sapphire"
  | "indigo"
  | "gold"
  | "cherry"
  | "olive"
  | "steel"
  | "sand"
  | "peony"
  | "mulberry"
  | "aurora"
  | "meadow"
  | "noir";

// Backward-compat: old preset ids (before the preset system was rebuilt)
// map onto the closest new identity so a saved `duo-theme` value from an
// older session never crashes or silently falls through to a default.
const LEGACY_THEME_ALIASES: Record<string, ThemeColor> = {
  "soft-neutral": "minimal-light",
  "wine-red": "wine",
  "cherry-blossom": "rose",
  "golden-hour": "amber",
  terracotta: "amber",
  lavender: "graphite",
  "slate-dark": "graphite",
  "deep-space": "midnight",
};

const resolveThemeId = (id: string | null): ThemeColor => {
  if (id && (id as ThemeColor) in THEME_IDENTITIES) return id as ThemeColor;
  if (id && LEGACY_THEME_ALIASES[id]) return LEGACY_THEME_ALIASES[id];
  return "midnight";
};

export interface AppSettings {
  biometricLock: boolean;
  /** Minutes the app can sit backgrounded before it re-locks; 0 = lock the
   *  instant it's backgrounded (the old, only, behavior). See
   *  lib/appLockTimer.ts for the resume-time threshold check. */
  appLockTimeout: number;
  notifications: boolean;
  hapticFeedback: boolean;
  privacyMode: boolean;
  peekGuard: boolean;
  // Legacy (kept for backwards compat with PeekGuard component reads)
  peekFaceThreshold: number;
  peekDetectionDelay: number;
  peekCheckInterval: number;
  // New owner-recognition pipeline knobs
  peekMatchThreshold: number;        // 0..1 cosine similarity (default 0.62 — see usePeekDetection.ts DEFAULTS)
  peekConsistencyFrames: number;     // 1..10 (default 1 — true-instant lock; see usePeekDetection.ts DEFAULTS)
  peekLockDelay: number;             // ms (default 30 — see usePeekDetection.ts)
  peekMinFaceArea: number;           // 0..0.2 normalized area (default 0.015)
  peekAlertOnStranger: boolean;      // default true
  peekAlertOnMultipleFaces: boolean; // default true
  peekAlertOnNoFace: boolean;        // default false — too false-alarm-prone; see usePeekDetection.ts DEFAULTS
  peekNoFaceSustainMs: number;       // ms, default 2500 — how long the frame must be empty before "owner not there" counts
  peekStaticStrangerTimeoutMs: number; // ms, default 6000 (0 = disable spoof-timeout escalation)
  peekDebugMode: boolean;            // default false — live signal HUD, see PeekGuard.tsx
  /** Face-ID-style "Require Attention": owner-verify dismiss additionally
   *  requires eyes-open + roughly-facing-camera in that single frame, not
   *  just a matching embedding. Default true — see isAttentive() in
   *  lib/faceRecognition.ts. */
  peekRequireAttention: boolean;
  /** Auto-unlock: while locked, clear the lock the instant the owner alone
   *  is confidently recognized back in frame — no tap, no OS biometric
   *  prompt. Default true. See usePeekDetection.ts. */
  peekAutoUnlockOnOwner: boolean;
  /** Consecutive confident-owner frames required before auto-unlock fires.
   *  Default 1 — mirrors peekConsistencyFrames, just for the reverse. */
  peekAutoUnlockConsistencyFrames: number;
  /** ms delay after a confirmed owner streak before actually clearing the
   *  lock. Default 15 — mirrors peekLockDelay. */
  peekAutoUnlockDelay: number;
  anniversaryDate: string | null;
  moodDetection: boolean; // Fix #Bug11: explicit opt-in, defaults off
  // Separate opt-in from moodDetection above: moodDetection controls the
  // once-a-day POPUP card; this controls a silent periodic capture with no
  // UI at all (see hooks/useBackgroundMoodDetection.ts). Deliberately its
  // own flag rather than folded into moodDetection — someone can want the
  // occasional deliberate check-in without also agreeing to the camera
  // waking up unannounced on a timer, so turning one on never implies the
  // other. Defaults off either way.
  moodBackgroundDetection: boolean;
}

interface ThemeContextType {
  theme: ThemeColor;
  setTheme: (theme: ThemeColor) => void;
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  toggleColorMode: () => void;
  // Adaptive theming: the user's actual preference. "light"/"dark" are
  // explicit manual choices; "auto" mirrors the OS/browser color-scheme
  // live; "schedule" flips at the configured scheduleDarkStart/End times;
  // "dynamic" continuously blends every token through the day (see
  // themeEngine.ts). `colorMode` above always reflects the binary
  // light/dark classification, even while "dynamic" is active.
  themeMode: ThemeModePreference;
  setThemeMode: (mode: ThemeModePreference) => void;
  scheduleDarkStart: string;
  scheduleDarkEnd: string;
  setScheduleTimes: (start: string, end: string) => void;
  chatWallpaper: string | null;
  setChatWallpaper: (wp: string | null) => void;
  appIcon: string | null;
  setAppIcon: (icon: string | null) => void;
  appName: string;
  setAppName: (name: string) => void;
  appSettings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  isAppLocked: boolean;
  setIsAppLocked: (locked: boolean) => void;
}

const defaultSettings: AppSettings = {
  biometricLock: false,
  appLockTimeout: 0,
  notifications: true,
  hapticFeedback: true,
  privacyMode: false,
  peekGuard: false,
  peekFaceThreshold: 2,
  peekDetectionDelay: 1500,
  peekCheckInterval: 300,
  peekMatchThreshold: 0.62,
  peekConsistencyFrames: 1,
  peekLockDelay: 30,
  peekMinFaceArea: 0.015,
  peekAlertOnStranger: true,
  peekAlertOnMultipleFaces: true,
  peekAlertOnNoFace: false,
  peekNoFaceSustainMs: 2500,
  peekStaticStrangerTimeoutMs: 6000,
  peekDebugMode: false,
  peekRequireAttention: true,
  peekAutoUnlockOnOwner: true,
  peekAutoUnlockConsistencyFrames: 1,
  peekAutoUnlockDelay: 15,
  anniversaryDate: null,
  moodDetection: false,
  moodBackgroundDetection: false,
};

const ThemeContext = createContext<ThemeContextType>({
  theme: "midnight",
  setTheme: () => {},
  colorMode: "dark",
  setColorMode: () => {},
  toggleColorMode: () => {},
  themeMode: "dark",
  setThemeMode: () => {},
  scheduleDarkStart: "19:00",
  scheduleDarkEnd: "07:00",
  setScheduleTimes: () => {},
  chatWallpaper: null,
  setChatWallpaper: () => {},
  appIcon: null,
  setAppIcon: () => {},
  appName: "DuoSpace",
  setAppName: () => {},
  appSettings: defaultSettings,
  updateSetting: () => {},
  isAppLocked: false,
  setIsAppLocked: () => {},
});

export const useTheme = () => useContext(ThemeContext);

// Each preset is just an "identity" — a primary + accent hue/saturation.
// The full ~17-variable palette (card, border, secondary, muted, and their
// *-foreground pairs) is always derived from this via deriveTokens(), for
// BOTH light and dark mode. This is what fixes presets silently leaving
// half the palette untouched — there's now no way to define a preset
// without getting a complete, contrast-checked result in either mode.
export const THEME_IDENTITIES: Record<ThemeColor, ThemeIdentity> = {
  midnight:       { primary: { h: 224, s: 45, l: 58 }, accent: { h: 210, s: 40, l: 55 } },
  graphite:       { primary: { h: 220, s: 10, l: 55 }, accent: { h: 220, s: 8,  l: 50 } },
  ocean:          { primary: { h: 195, s: 60, l: 48 }, accent: { h: 190, s: 50, l: 50 } },
  forest:         { primary: { h: 155, s: 40, l: 42 }, accent: { h: 110, s: 30, l: 45 } },
  arctic:         { primary: { h: 205, s: 60, l: 45 }, accent: { h: 200, s: 40, l: 55 } },
  amber:          { primary: { h: 36,  s: 75, l: 52 }, accent: { h: 30,  s: 60, l: 55 } },
  rose:           { primary: { h: 348, s: 55, l: 60 }, accent: { h: 340, s: 45, l: 62 } },
  "minimal-light":{ primary: { h: 0,   s: 0,  l: 18 }, accent: { h: 0,   s: 0,  l: 55 } },
  "minimal-dark": { primary: { h: 0,   s: 0,  l: 80 }, accent: { h: 0,   s: 0,  l: 60 } },
  monochrome:     { primary: { h: 0,   s: 0,  l: 45 }, accent: { h: 0,   s: 0,  l: 45 } },
  lavender:       { primary: { h: 270, s: 45, l: 62 }, accent: { h: 285, s: 40, l: 65 } },
  mint:           { primary: { h: 160, s: 45, l: 46 }, accent: { h: 145, s: 40, l: 50 } },
  plum:           { primary: { h: 300, s: 35, l: 55 }, accent: { h: 290, s: 30, l: 50 } },
  coral:          { primary: { h: 10,  s: 70, l: 60 }, accent: { h: 22,  s: 65, l: 60 } },
  slate:          { primary: { h: 215, s: 15, l: 55 }, accent: { h: 210, s: 12, l: 50 } },
  blush:          { primary: { h: 330, s: 50, l: 72 }, accent: { h: 320, s: 42, l: 68 } },
  cocoa:          { primary: { h: 25,  s: 30, l: 45 }, accent: { h: 20,  s: 25, l: 42 } },
  lagoon:         { primary: { h: 185, s: 55, l: 48 }, accent: { h: 175, s: 45, l: 50 } },
  // ── Added for a wider preset range ──────────────────────────────────────
  wine:           { primary: { h: 350, s: 58, l: 34 }, accent: { h: 355, s: 45, l: 40 } },
  sunset:         { primary: { h: 18,  s: 82, l: 58 }, accent: { h: 340, s: 65, l: 62 } },
  emerald:        { primary: { h: 152, s: 55, l: 38 }, accent: { h: 165, s: 45, l: 42 } },
  sapphire:       { primary: { h: 215, s: 65, l: 45 }, accent: { h: 225, s: 55, l: 50 } },
  indigo:         { primary: { h: 245, s: 55, l: 56 }, accent: { h: 255, s: 45, l: 60 } },
  gold:           { primary: { h: 45,  s: 75, l: 50 }, accent: { h: 38,  s: 60, l: 55 } },
  cherry:         { primary: { h: 355, s: 68, l: 52 }, accent: { h: 5,   s: 55, l: 58 } },
  olive:          { primary: { h: 75,  s: 32, l: 38 }, accent: { h: 60,  s: 25, l: 42 } },
  steel:          { primary: { h: 205, s: 20, l: 46 }, accent: { h: 200, s: 15, l: 50 } },
  sand:           { primary: { h: 35,  s: 38, l: 65 }, accent: { h: 28,  s: 32, l: 60 } },
  // ── Round 2 additions: fill the Romantic / Cool / Nature / Neutral gaps ──
  peony:          { primary: { h: 335, s: 62, l: 58 }, accent: { h: 15,  s: 60, l: 68 } },
  mulberry:       { primary: { h: 328, s: 50, l: 42 }, accent: { h: 345, s: 42, l: 52 } },
  aurora:         { primary: { h: 170, s: 58, l: 42 }, accent: { h: 265, s: 55, l: 64 } },
  meadow:         { primary: { h: 105, s: 42, l: 38 }, accent: { h: 62,  s: 52, l: 52 } },
  noir:           { primary: { h: 42,  s: 32, l: 62 }, accent: { h: 30,  s: 18, l: 50 } },
};

// Each preset's INTENDED default mode (its "home" appearance) — the mode
// toggle can still flip any of them, this just decides what a fresh
// selection shows first, and what the Settings swatch preview renders.
const THEME_DEFAULT_MODE: Record<ThemeColor, ColorMode> = {
  midnight: "dark", graphite: "dark", ocean: "light", forest: "light",
  arctic: "light", amber: "light", rose: "light",
  "minimal-light": "light", "minimal-dark": "dark", monochrome: "dark",
  lavender: "light", mint: "light", plum: "dark", coral: "light",
  slate: "dark", blush: "light", cocoa: "dark", lagoon: "dark",
  wine: "dark", sunset: "light", emerald: "dark", sapphire: "dark",
  indigo: "dark", gold: "light", cherry: "light", olive: "dark",
  steel: "dark", sand: "light",
  peony: "light", mulberry: "dark", aurora: "dark", meadow: "light", noir: "dark",
};

const swatchPreview = (id: ThemeColor): string => {
  const tokens = deriveTokens(THEME_IDENTITIES[id], THEME_DEFAULT_MODE[id]);
  return `hsl(${tokens["--background"]})`;
};
const swatchAccent = (id: ThemeColor): string => {
  const tokens = deriveTokens(THEME_IDENTITIES[id], THEME_DEFAULT_MODE[id]);
  return `hsl(${tokens["--primary"]})`;
};

// Picker grouping. Every theme belongs to exactly one category so the
// selector can filter without duplicates — "Romantic" is first-class here
// because this is a couples app.
export type ThemeCategory = "Cool" | "Romantic" | "Warm" | "Nature" | "Neutral";
export const THEME_CATEGORIES: ReadonlyArray<{ id: ThemeCategory; emoji: string }> = [
  { id: "Cool",     emoji: "🧊" },
  { id: "Romantic", emoji: "💞" },
  { id: "Warm",     emoji: "🔥" },
  { id: "Nature",   emoji: "🌿" },
  { id: "Neutral",  emoji: "◐"  },
];

// Display metadata, listed in picker order (grouped by category, Midnight —
// the app default — first). preview/accent/dark are derived below so they can
// never drift from THEME_IDENTITIES / THEME_DEFAULT_MODE.
const THEME_META: ReadonlyArray<{ id: ThemeColor; name: string; emoji: string; category: ThemeCategory }> = [
  { id: "midnight",      name: "Midnight",      emoji: "🌙", category: "Cool" },
  { id: "ocean",         name: "Ocean",         emoji: "🌊", category: "Cool" },
  { id: "arctic",        name: "Arctic",        emoji: "❄️", category: "Cool" },
  { id: "lagoon",        name: "Lagoon",        emoji: "🌴", category: "Cool" },
  { id: "sapphire",      name: "Sapphire",      emoji: "💎", category: "Cool" },
  { id: "indigo",        name: "Indigo",        emoji: "🔮", category: "Cool" },
  { id: "aurora",        name: "Aurora",        emoji: "🌌", category: "Cool" },
  { id: "rose",          name: "Rose",          emoji: "🌸", category: "Romantic" },
  { id: "blush",         name: "Blush",         emoji: "🌷", category: "Romantic" },
  { id: "peony",         name: "Peony",         emoji: "🌺", category: "Romantic" },
  { id: "lavender",      name: "Lavender",      emoji: "💜", category: "Romantic" },
  { id: "cherry",        name: "Cherry",        emoji: "🍒", category: "Romantic" },
  { id: "wine",          name: "Wine Red",      emoji: "🍷", category: "Romantic" },
  { id: "plum",          name: "Plum",          emoji: "🍇", category: "Romantic" },
  { id: "mulberry",      name: "Mulberry",      emoji: "🫐", category: "Romantic" },
  { id: "amber",         name: "Amber",         emoji: "🌅", category: "Warm" },
  { id: "sunset",        name: "Sunset",        emoji: "🌇", category: "Warm" },
  { id: "coral",         name: "Coral",         emoji: "🪸", category: "Warm" },
  { id: "gold",          name: "Gold",          emoji: "🌟", category: "Warm" },
  { id: "sand",          name: "Sand",          emoji: "🏖️", category: "Warm" },
  { id: "cocoa",         name: "Cocoa",         emoji: "🍫", category: "Warm" },
  { id: "forest",        name: "Forest",        emoji: "🌿", category: "Nature" },
  { id: "mint",          name: "Mint",          emoji: "🍃", category: "Nature" },
  { id: "emerald",       name: "Emerald",       emoji: "💚", category: "Nature" },
  { id: "meadow",        name: "Meadow",        emoji: "🌾", category: "Nature" },
  { id: "olive",         name: "Olive",         emoji: "🫒", category: "Nature" },
  { id: "graphite",      name: "Graphite",      emoji: "⚙️", category: "Neutral" },
  { id: "slate",         name: "Slate",         emoji: "🪨", category: "Neutral" },
  { id: "steel",         name: "Steel",         emoji: "🔩", category: "Neutral" },
  { id: "noir",          name: "Noir",          emoji: "🖤", category: "Neutral" },
  { id: "minimal-light", name: "Minimal Light", emoji: "⚪", category: "Neutral" },
  { id: "minimal-dark",  name: "Minimal Dark",  emoji: "⚫", category: "Neutral" },
  { id: "monochrome",    name: "Monochrome",    emoji: "◐",  category: "Neutral" },
];

export const THEMES: Array<{
  id: ThemeColor;
  name: string;
  emoji: string;
  category: ThemeCategory;
  preview: string;
  accent: string;
  dark: boolean;
}> = THEME_META.map(m => ({
  ...m,
  preview: swatchPreview(m.id),
  accent: swatchAccent(m.id),
  dark: THEME_DEFAULT_MODE[m.id] === "dark",
}));

// ─── IndexedDB icon store ────────────────────────────────────────────────────
// ICON-02 FIX: App icon images must NOT be stored in localStorage.
// localStorage is shared across all keys with a hard 5MB cap. A typical user
// photo as base64 is 2–5MB — one image can exhaust the entire budget, silently
// corrupting all other stored data (settings, pins, E2E keys) with no error shown.
// IndexedDB has no practical size limit and is the correct store for binary blobs.
// (idbGet/idbSet/idbDelete now live in src/lib/idbStore.ts, shared with the
// per-app icon config store used by Icon Studio.)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Couple-theme share, offline-safe ────────────────────────────────────────
const PENDING_COUPLE_THEME_KEY = "duo-couple-theme-pending";

/** Tell the partner about the chosen theme; remember it for later if we can't right now. */
async function pushCoupleTheme(theme: string): Promise<void> {
  const uid = readPersistedSession()?.user.id;
  if (!uid) return;
  if (!isOnlineNow()) { storage.set(PENDING_COUPLE_THEME_KEY, theme); return; }
  try {
    const { supabase } = await import("@/integrations/supabase/appClient");
    const { error } = await supabase.from("profiles").update({ couple_theme: theme } as any).eq("user_id", uid);
    if (error) storage.set(PENDING_COUPLE_THEME_KEY, theme);
    else storage.remove(PENDING_COUPLE_THEME_KEY);
  } catch {
    storage.set(PENDING_COUPLE_THEME_KEY, theme);
  }
}

function flushPendingCoupleTheme(): void {
  const pending = storage.get(PENDING_COUPLE_THEME_KEY);
  if (pending) void pushCoupleTheme(pending);
}

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const isNativePlatform = Capacitor.isNativePlatform();

  const [theme, setThemeState] = useState<ThemeColor>(() =>
    resolveThemeId(storage.get("duo-theme"))
  );
  // The manual light/dark fallback — used directly when themeMode is
  // "light"/"dark", and as a fallback if "auto" can't resolve.
  const manualColorMode = (): ColorMode => {
    const saved = storage.get("duo-color-mode");
    if (saved === "light" || saved === "dark") return saved;
    return THEME_DEFAULT_MODE[resolveThemeId(storage.get("duo-theme"))];
  };

  const [themeMode, setThemeModeState] = useState<ThemeModePreference>(() => {
    const saved = storage.get("duo-theme-mode");
    if (saved === "light" || saved === "dark" || saved === "auto" || saved === "schedule" || saved === "dynamic") return saved;
    // No explicit preference saved yet. If this person already has a manual
    // duo-color-mode from before adaptive theming existed, respect it as-is
    // so nothing changes underneath an existing user. Brand-new installs
    // default to "auto" (follow system light/dark), matching what most
    // people expect out of the box.
    return storage.get("duo-color-mode") ? manualColorMode() : "auto";
  });
  const [scheduleDarkStart, setScheduleDarkStart] = useState<string>(() => storage.get("duo-schedule-start") || "19:00");
  const [scheduleDarkEnd, setScheduleDarkEnd] = useState<string>(() => storage.get("duo-schedule-end") || "07:00");

  const [colorMode, setColorModeState] = useState<ColorMode>(() =>
    resolveColorMode(themeMode, { manualFallback: manualColorMode(), scheduleDarkStart, scheduleDarkEnd })
  );

  // Drives periodic recomputation for "schedule" (binary flip check) and
  // "dynamic" (continuous token re-blend) modes — both need to notice time
  // passing even with no other state change to naturally trigger it.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (themeMode !== "schedule" && themeMode !== "dynamic") return;
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [themeMode]);
  const [chatWallpaper, setChatWallpaperState] = useState<string | null>(() =>
    storage.get("duo-wallpaper") || null
  );
  // ICON-02 FIX: appIcon is loaded async from IndexedDB on mount.
  // It starts null (no flash), then resolves once idbGet returns.
  // Any old value in localStorage "duo-app-icon" is migrated on first load and removed.
  const [appIcon, setAppIconState] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      // Migrate old localStorage value if present
      const legacy = storage.get("duo-app-icon");
      if (legacy) {
        await idbSet("duo-app-icon", legacy);
        storage.remove("duo-app-icon");
        setAppIconState(legacy);
        return;
      }
      const saved = await idbGet("duo-app-icon");
      if (saved) setAppIconState(saved);
    })();
  }, []);
  const [appName, setAppNameState] = useState<string>(() =>
    storage.get("duo-app-name") || "DuoSpace"
  );
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    const saved = storage.get("duo-settings");
    const settings = saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    // FIX BUG-12: On cold start, sync "mood-detection-enabled" from "duo-settings" so
    // MoodDetector (which reads the standalone key) stays in agreement with ThemeContext.
    // Previously, if "duo-settings" had moodDetection:true but "mood-detection-enabled"
    // was absent (partial storage clear), MoodDetector silently skipped itself while
    // Settings showed the toggle as ON.
    storage.set("mood-detection-enabled", settings.moodDetection ? "true" : "false");
    return settings;
  });
  const [isAppLocked, setIsAppLocked] = useState(false);

  // Apply theme CSS variables via the derivation engine (always a complete
  // palette, for whichever colorMode is active). Re-apply any active custom
  // theme override on top afterward so it persists across reloads/switches.
  // Skip the view-transition crossfade on the very first apply (app boot) —
  // there's nothing to fade *from* yet, so it would just be a pointless
  // flash. Only subsequent theme/mode switches get the animated crossfade.
  const hasAppliedOnce = useRef(false);
  useEffect(() => {
    const identity = THEME_IDENTITIES[theme] ?? THEME_IDENTITIES.midnight;
    const apply = () => {
      if (themeMode === "dynamic") {
        applyTokens(deriveDynamicTokens(identity, new Date()));
      } else {
        applyTokens(deriveTokens(identity, colorMode));
      }
      document.documentElement.classList.toggle("dark", colorMode === "dark");
      // Lazy-import to avoid a circular dep at module load.
      // Pass the already-resolved colorMode through explicitly — see the
      // BUG FIX comment in customThemes.ts's applyCustomTheme for why this
      // matters for schedule/auto/dynamic modes.
      import("@/lib/customThemes").then(({ restoreActiveCustomTheme }) => {
        restoreActiveCustomTheme(colorMode);
      });
    };
    // View Transitions API: smooth crossfade between the old and new palette
    // instead of every CSS custom property snapping instantly. Feature-
    // detected — iOS WebView and older Android WebViews don't support it,
    // so they just get the same instant swap as before, not a broken one.
    const supportsViewTransition = hasAppliedOnce.current
      && typeof document !== "undefined"
      && "startViewTransition" in document
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (supportsViewTransition) {
      (document as any).startViewTransition(apply);
    } else {
      apply();
    }
    hasAppliedOnce.current = true;
  }, [theme, colorMode, themeMode, tick]);

  // Keep the binary colorMode classification (used for the dark class,
  // wallpaper light/dark pairs, etc) in sync with themeMode — live for
  // "auto" via a matchMedia listener, and on each `tick` for "schedule" and
  // "dynamic".
  useEffect(() => {
    setColorModeState(resolveColorMode(themeMode, {
      manualFallback: manualColorMode(), scheduleDarkStart, scheduleDarkEnd,
    }));
  }, [themeMode, scheduleDarkStart, scheduleDarkEnd, tick]);

  useEffect(() => {
    if (themeMode !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setColorModeState(resolveColorMode(themeMode, {
      manualFallback: manualColorMode(), scheduleDarkStart, scheduleDarkEnd,
    }));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeMode, scheduleDarkStart, scheduleDarkEnd]);

  const setTheme = (t: ThemeColor) => {
    setThemeState(t);
    storage.set("duo-theme", t);
    // BUG FIX ("themes not working properly"): the apply-effect below always
    // calls restoreActiveCustomTheme() after deriving a preset's tokens, so
    // it persists across reloads. But if the person had ever applied a
    // custom theme (ThemeStudio), that "active custom theme" flag stayed
    // set in storage forever — nothing ever cleared it. Picking a different
    // *built-in* preset here would apply its tokens for a frame, then get
    // immediately overwritten right back to the old custom theme by that
    // same effect, so switching presets silently appeared to do nothing.
    // Selecting a built-in preset is an explicit move off any custom
    // theme, so clear the override here.
    import("@/lib/customThemes").then(({ getActiveCustomThemeId, clearCustomThemeOverride }) => {
      if (getActiveCustomThemeId()) clearCustomThemeOverride();
    });
    // OFFLINE-FIRST: the theme itself is already applied and saved locally
    // above. Sharing it with the partner needs the server, so if that can't
    // happen right now the choice is remembered and sent on reconnect. (It used
    // to ask the network who the user was first — getUser() — and silently
    // dropped the share whenever that failed.)
    pushCoupleTheme(t);
  };

  const setColorMode = (mode: ColorMode) => {
    setColorModeState(mode);
    storage.set("duo-color-mode", mode);
    setThemeModeState(mode);
    storage.set("duo-theme-mode", mode);
  };
  // Manual toggle breaks out of auto/schedule/dynamic into an explicit
  // choice — the same behavior most OSes use when you flip dark mode by hand.
  const toggleColorMode = () => setColorMode(colorMode === "dark" ? "light" : "dark");

  const setThemeMode = (mode: ThemeModePreference) => {
    setThemeModeState(mode);
    storage.set("duo-theme-mode", mode);
    if (mode === "light" || mode === "dark") storage.set("duo-color-mode", mode);
    // Picking Dynamic links the wallpaper to it too — the whole point is
    // that chrome *and* wallpaper drift through the day together, not just
    // one or the other. Only auto-select it if nothing else is already
    // chosen, so it doesn't silently override a wallpaper the person picked
    // on purpose.
    if (mode === "dynamic" && !storage.get("duo-wallpaper")) {
      setChatWallpaperState("w-dynamic-sky");
      storage.set("duo-wallpaper", "w-dynamic-sky");
    }
  };

  const setScheduleTimes = (start: string, end: string) => {
    setScheduleDarkStart(start);
    setScheduleDarkEnd(end);
    storage.set("duo-schedule-start", start);
    storage.set("duo-schedule-end", end);
  };

  // Partner theme sync via Supabase realtime
  // Fix #Bug2: use a ref to capture the channel so the React cleanup function
  // can actually call removeChannel (the previous Promise-chain return was ignored by React).
  const themeChannelRef = useRef<any>(null);
  useEffect(() => {
    let cancelled = false;

    let settingUp = false;
    const runSetup = async () => {
      if (themeChannelRef.current || !isOnlineNow()) return; // already listening / will retry on reconnect
      const { supabase } = await import("@/integrations/supabase/appClient");
      // Identity from the local session (no network round trip); the profile
      // query below is what actually needs the server.
      const uid = readPersistedSession()?.user.id;
      if (cancelled || !uid) return;

      const { data: profile } = await supabase
        .from("profiles").select("couple_theme, partner_id")
        .eq("user_id", uid).single();
      if (cancelled || themeChannelRef.current || !profile?.partner_id) return;

      const channel = supabase
        .channel(`couple-theme-${uid}`)
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: "profiles",
          filter: `user_id=eq.${profile.partner_id}`,
        }, (payload: { new: Record<string, unknown> }) => {
          const partnerTheme = payload.new?.couple_theme as ThemeColor | null;
          if (partnerTheme && partnerTheme !== storage.get("duo-theme")) {
            setThemeState(partnerTheme);
            storage.set("duo-theme", partnerTheme);
          }
        })
        .subscribe();

      if (cancelled) {
        supabase.removeChannel(channel);
        return;
      }
      themeChannelRef.current = { channel, supabase };
    };

    // Guard against two overlapping runs (launch + an immediate reconnect)
    // both passing the "not listening yet" check and subscribing twice.
    const setup = async () => {
      if (settingUp) return;
      settingUp = true;
      try { await runSetup(); } finally { settingUp = false; }
    };
    void setup();
    flushPendingCoupleTheme();
    // Back online: send a theme choice made offline, and start listening for
    // the partner's if setup couldn't run at launch.
    const unsubscribe = subscribeConnectivity((online) => {
      if (!online) return;
      flushPendingCoupleTheme();
      void setup();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (themeChannelRef.current) {
        const { channel, supabase } = themeChannelRef.current;
        supabase.removeChannel(channel);
        themeChannelRef.current = null;
      }
    };
  }, []);

  const setChatWallpaper = (wp: string | null) => {
    setChatWallpaperState(wp);
    if (wp) storage.set("duo-wallpaper", wp);
    else storage.remove("duo-wallpaper");
  };

  const setAppIcon = (icon: string | null) => {
    setAppIconState(icon);
    // ICON-02 FIX: persist to IndexedDB, not localStorage
    if (icon) idbSet("duo-app-icon", icon);
    else idbDelete("duo-app-icon");
    // ICON-03 FIX: update the browser tab/PWA favicon at runtime.
    // The static <link rel="icon"> in index.html is frozen at build time.
    // Patching it here is the only way to reflect a user-chosen icon in the tab.
    const link =
      document.querySelector<HTMLLinkElement>("link[rel~='icon']") ||
      (() => {
        const el = document.createElement("link");
        el.rel = "icon";
        document.head.appendChild(el);
        return el;
      })();
    link.href = icon ?? "/favicon.ico";
    link.type = icon ? "image/png" : "image/x-icon";
  };

  const setAppName = (name: string) => {
    const trimmed = name.trim();
    // NAME-02 FIX: Enforce the validation the UI description promises.
    // Previously any characters (spaces, emoji, symbols) passed through and
    // the only guard was an empty-string fallback to "DuoSpace".
    const valid = /^[a-zA-Z0-9._]{3,32}$/.test(trimmed);
    const finalName = valid ? trimmed : "DuoSpace";
    setAppNameState(finalName);
    storage.set("duo-app-name", finalName);
    document.title = finalName;
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setAppSettings((prev) => {
      const next = { ...prev, [key]: value };
      // PRIVACY (Phase 1.6): clear the dependent background-camera opt-in
      // BEFORE persisting. It used to be cleared after storage.set(), so the
      // saved JSON kept moodBackgroundDetection:true and turning Daily Mood
      // back on silently re-armed unattended camera capture.
      if (key === "moodDetection" && !value) next.moodBackgroundDetection = false;
      storage.set("duo-settings", JSON.stringify(next));
      // FIX BUG-12: Keep the standalone "mood-detection-enabled" key that MoodDetector
      // reads in sync with the canonical "duo-settings" JSON on every write.
      // Settings.tsx also writes this key on toggle, but ThemeContext is the
      // authoritative source — syncing here means they can never diverge.
      if (key === "moodDetection") {
        storage.set("mood-detection-enabled", value ? "true" : "false");
      }
      return next;
    });
  };

  // Privacy mode — blur on background
  // FIX BUG-01: capture visibilitychange handler in a named const so cleanup can remove it.
  // Previously an anonymous arrow was passed to addEventListener — impossible to removeEventListener.
  // Every privacyMode toggle ON added a new handler that was never removed.
  useEffect(() => {
    if (!appSettings.privacyMode) return;
    const blur = () => { document.body.style.filter = "blur(20px)"; document.body.style.transition = "filter 0.15s ease"; };
    const unblur = () => { document.body.style.filter = ""; };
    const onVisibility = () => {
      if (document.hidden) blur();
      else unblur();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", unblur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", unblur);
      document.removeEventListener("visibilitychange", onVisibility);
      document.body.style.filter = "";
    };
  }, [appSettings.privacyMode]);

  // App lock on hide — respects appSettings.appLockTimeout (minutes the app
  // can sit backgrounded before it re-locks; 0 = lock instantly, the old
  // behavior). See lib/appLockTimer.ts: the timestamp is written on hide and
  // only checked on resume (a backgrounded tab/webview can be fully
  // suspended, so a live countdown timer isn't reliable) and it's kept in
  // localStorage so the check still works even if the OS killed the app
  // entirely while it was away.
  useEffect(() => {
    if (!appSettings.biometricLock || !isNativePlatform) { setIsAppLocked(false); clearAppBackgroundedMark(); return; }
    const handle = () => {
      if (document.hidden) {
        markAppBackgrounded();
      } else {
        if (shouldLockOnResume(appSettings.appLockTimeout)) setIsAppLocked(true);
        clearAppBackgroundedMark();
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [appSettings.biometricLock, appSettings.appLockTimeout, isNativePlatform]);

  // Cold-start check: if the app was killed while backgrounded past the
  // threshold, the visibilitychange handler above never gets a "hide" event
  // to react to on this fresh mount — check once against whatever mark
  // survived in localStorage from the previous session.
  useEffect(() => {
    if (!appSettings.biometricLock || !isNativePlatform) return;
    if (hasBackgroundedMark() && shouldLockOnResume(appSettings.appLockTimeout)) {
      setIsAppLocked(true);
    }
    clearAppBackgroundedMark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync page title to appName
  useEffect(() => { document.title = appName; }, [appName]);

  // ICON-03 FIX: Keep favicon in sync whenever appIcon state resolves (e.g. after
  // async idbGet on mount) so the tab icon is correct after a page reload.
  useEffect(() => {
    if (!appIcon) return;
    const link =
      document.querySelector<HTMLLinkElement>("link[rel~='icon']") ||
      (() => { const el = document.createElement("link"); el.rel = "icon"; document.head.appendChild(el); return el; })();
    link.href = appIcon;
    link.type = "image/png";
  }, [appIcon]);

  const value = useMemo(() => ({
    theme, setTheme,
    colorMode, setColorMode, toggleColorMode,
    themeMode, setThemeMode,
    scheduleDarkStart, scheduleDarkEnd, setScheduleTimes,
    chatWallpaper, setChatWallpaper,
    appIcon, setAppIcon,
    appName, setAppName,
    appSettings, updateSetting,
    isAppLocked, setIsAppLocked,
  }), [
    theme, setTheme,
    colorMode, setColorMode, toggleColorMode,
    themeMode, setThemeMode,
    scheduleDarkStart, scheduleDarkEnd, setScheduleTimes,
    chatWallpaper, setChatWallpaper,
    appIcon, setAppIcon,
    appName, setAppName,
    appSettings, updateSetting,
    isAppLocked, setIsAppLocked,
  ]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
