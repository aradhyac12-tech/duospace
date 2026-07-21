import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
// FIX #9: Use the shared storage wrapper (src/lib/storage.ts) instead of an
// inline duplicate. All localStorage access goes through one safe try/catch
// boundary, consistent with the rest of the app.
import storage from "@/lib/storage";
import { deriveTokens, applyTokens, ColorMode, ThemeIdentity } from "@/lib/themeEngine";

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
  | "monochrome";

// Backward-compat: old preset ids (before the preset system was rebuilt)
// map onto the closest new identity so a saved `duo-theme` value from an
// older session never crashes or silently falls through to a default.
const LEGACY_THEME_ALIASES: Record<string, ThemeColor> = {
  "soft-neutral": "minimal-light",
  "wine-red": "rose",
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

interface AppSettings {
  biometricLock: boolean;
  notifications: boolean;
  hapticFeedback: boolean;
  privacyMode: boolean;
  peekGuard: boolean;
  // Legacy (kept for backwards compat with PeekGuard component reads)
  peekFaceThreshold: number;
  peekDetectionDelay: number;
  peekCheckInterval: number;
  // New owner-recognition pipeline knobs
  peekMatchThreshold: number;        // 0..1 cosine similarity (default 0.7)
  peekConsistencyFrames: number;     // 1..10 (default 4)
  peekLockDelay: number;             // ms (default 1500)
  peekMinFaceArea: number;           // 0..0.2 normalized area (default 0.015)
  peekAlertOnStranger: boolean;      // default true
  peekAlertOnMultipleFaces: boolean; // default true
  peekAlertOnNoFace: boolean;        // default false
  anniversaryDate: string | null;
  moodDetection: boolean; // Fix #Bug11: explicit opt-in, defaults off
}

interface ThemeContextType {
  theme: ThemeColor;
  setTheme: (theme: ThemeColor) => void;
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  toggleColorMode: () => void;
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
  notifications: true,
  hapticFeedback: true,
  privacyMode: false,
  peekGuard: false,
  peekFaceThreshold: 2,
  peekDetectionDelay: 1500,
  peekCheckInterval: 600,
  peekMatchThreshold: 0.7,
  peekConsistencyFrames: 4,
  peekLockDelay: 1500,
  peekMinFaceArea: 0.015,
  peekAlertOnStranger: true,
  peekAlertOnMultipleFaces: true,
  peekAlertOnNoFace: false,
  anniversaryDate: null,
  moodDetection: false,
};

const ThemeContext = createContext<ThemeContextType>({
  theme: "midnight",
  setTheme: () => {},
  colorMode: "dark",
  setColorMode: () => {},
  toggleColorMode: () => {},
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
};

// Each preset's INTENDED default mode (its "home" appearance) — the mode
// toggle can still flip any of them, this just decides what a fresh
// selection shows first, and what the Settings swatch preview renders.
const THEME_DEFAULT_MODE: Record<ThemeColor, ColorMode> = {
  midnight: "dark", graphite: "dark", ocean: "light", forest: "light",
  arctic: "light", amber: "light", rose: "light",
  "minimal-light": "light", "minimal-dark": "dark", monochrome: "dark",
};

const swatchPreview = (id: ThemeColor): string => {
  const tokens = deriveTokens(THEME_IDENTITIES[id], THEME_DEFAULT_MODE[id]);
  return `hsl(${tokens["--background"]})`;
};
const swatchAccent = (id: ThemeColor): string => {
  const tokens = deriveTokens(THEME_IDENTITIES[id], THEME_DEFAULT_MODE[id]);
  return `hsl(${tokens["--primary"]})`;
};

export const THEMES: Array<{
  id: ThemeColor;
  name: string;
  emoji: string;
  preview: string;
  accent: string;
  dark: boolean;
}> = [
  { id: "midnight",        name: "Midnight",      emoji: "🌙", preview: swatchPreview("midnight"),        accent: swatchAccent("midnight"),        dark: THEME_DEFAULT_MODE.midnight === "dark" },
  { id: "graphite",        name: "Graphite",      emoji: "⚙️", preview: swatchPreview("graphite"),        accent: swatchAccent("graphite"),        dark: THEME_DEFAULT_MODE.graphite === "dark" },
  { id: "ocean",           name: "Ocean",         emoji: "🌊", preview: swatchPreview("ocean"),           accent: swatchAccent("ocean"),           dark: THEME_DEFAULT_MODE.ocean === "dark" },
  { id: "forest",          name: "Forest",        emoji: "🌿", preview: swatchPreview("forest"),          accent: swatchAccent("forest"),          dark: THEME_DEFAULT_MODE.forest === "dark" },
  { id: "arctic",          name: "Arctic",        emoji: "❄️", preview: swatchPreview("arctic"),          accent: swatchAccent("arctic"),          dark: THEME_DEFAULT_MODE.arctic === "dark" },
  { id: "amber",           name: "Amber",         emoji: "🌅", preview: swatchPreview("amber"),           accent: swatchAccent("amber"),           dark: THEME_DEFAULT_MODE.amber === "dark" },
  { id: "rose",            name: "Rose",          emoji: "🌸", preview: swatchPreview("rose"),            accent: swatchAccent("rose"),            dark: THEME_DEFAULT_MODE.rose === "dark" },
  { id: "minimal-light",   name: "Minimal Light", emoji: "⚪", preview: swatchPreview("minimal-light"),   accent: swatchAccent("minimal-light"),   dark: false },
  { id: "minimal-dark",    name: "Minimal Dark",  emoji: "⚫", preview: swatchPreview("minimal-dark"),    accent: swatchAccent("minimal-dark"),    dark: true  },
  { id: "monochrome",      name: "Monochrome",    emoji: "◐",  preview: swatchPreview("monochrome"),      accent: swatchAccent("monochrome"),      dark: THEME_DEFAULT_MODE.monochrome === "dark" },
];

// ─── IndexedDB icon store ────────────────────────────────────────────────────
// ICON-02 FIX: App icon images must NOT be stored in localStorage.
// localStorage is shared across all keys with a hard 5MB cap. A typical user
// photo as base64 is 2–5MB — one image can exhaust the entire budget, silently
// corrupting all other stored data (settings, pins, E2E keys) with no error shown.
// IndexedDB has no practical size limit and is the correct store for binary blobs.
const IDB_DB   = "duo-assets";
const IDB_STORE = "blobs";

const idbOpen = (): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });

const idbGet = async (key: string): Promise<string | null> => {
  try {
    const db  = await idbOpen();
    const tx  = db.transaction(IDB_STORE, "readonly");
    return await new Promise((res) => {
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
};

const idbSet = async (key: string, value: string): Promise<void> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
  } catch { /* noop — idb unavailable in some private modes */ }
};

const idbDelete = async (key: string): Promise<void> => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
  } catch { /* noop */ }
};
// ─────────────────────────────────────────────────────────────────────────────

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const isNativePlatform = Capacitor.isNativePlatform();

  const [theme, setThemeState] = useState<ThemeColor>(() =>
    resolveThemeId(storage.get("duo-theme"))
  );
  const [colorMode, setColorModeState] = useState<ColorMode>(() => {
    const saved = storage.get("duo-color-mode");
    if (saved === "light" || saved === "dark") return saved;
    return THEME_DEFAULT_MODE[resolveThemeId(storage.get("duo-theme"))];
  });
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
  useEffect(() => {
    const identity = THEME_IDENTITIES[theme] ?? THEME_IDENTITIES.midnight;
    applyTokens(deriveTokens(identity, colorMode));
    document.documentElement.classList.toggle("dark", colorMode === "dark");
    // Lazy-import to avoid a circular dep at module load.
    import("@/lib/customThemes").then(({ restoreActiveCustomTheme }) => {
      restoreActiveCustomTheme();
    });
  }, [theme, colorMode]);

  const setTheme = (t: ThemeColor) => {
    setThemeState(t);
    storage.set("duo-theme", t);
    import("@/integrations/supabase/client").then(({ supabase }) => {
      supabase.auth.getUser().then(({ data }) => {
        if (data.user)
          supabase.from("profiles").update({ couple_theme: t } as any).eq("user_id", data.user.id);
      });
    });
  };

  const setColorMode = (mode: ColorMode) => {
    setColorModeState(mode);
    storage.set("duo-color-mode", mode);
  };
  const toggleColorMode = () => setColorMode(colorMode === "dark" ? "light" : "dark");

  // Partner theme sync via Supabase realtime
  // Fix #Bug2: use a ref to capture the channel so the React cleanup function
  // can actually call removeChannel (the previous Promise-chain return was ignored by React).
  const themeChannelRef = useRef<any>(null);
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;

      const { data: profile } = await supabase
        .from("profiles").select("couple_theme, partner_id")
        .eq("user_id", data.user.id).single();
      if (cancelled || !profile?.partner_id) return;

      const channel = supabase
        .channel(`couple-theme-${data.user.id}`)
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

    setup();

    return () => {
      cancelled = true;
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

  // App lock on hide
  useEffect(() => {
    if (!appSettings.biometricLock || !isNativePlatform) { setIsAppLocked(false); return; }
    const handle = () => { if (document.hidden) setIsAppLocked(true); };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [appSettings.biometricLock, isNativePlatform]);

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

  return (
    <ThemeContext.Provider value={{
      theme, setTheme,
      colorMode, setColorMode, toggleColorMode,
      chatWallpaper, setChatWallpaper,
      appIcon, setAppIcon,
      appName, setAppName,
      appSettings, updateSetting,
      isAppLocked, setIsAppLocked,
    }}>
      {children}
    </ThemeContext.Provider>
  );
};
