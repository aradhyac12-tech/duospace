import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
// FIX #9: Use the shared storage wrapper (src/lib/storage.ts) instead of an
// inline duplicate. All localStorage access goes through one safe try/catch
// boundary, consistent with the rest of the app.
import storage from "@/lib/storage";

export type ThemeColor =
  | "soft-neutral"
  | "midnight"
  | "ocean"
  | "rose"
  | "forest"
  | "lavender"
  | "wine-red"
  | "golden-hour"
  | "slate-dark"
  | "cherry-blossom"
  | "deep-space"
  | "terracotta";

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
  theme: "soft-neutral",
  setTheme: () => {},
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

export const THEMES: Array<{
  id: ThemeColor;
  name: string;
  emoji: string;
  preview: string;
  accent: string;
  dark: boolean;
}> = [
  { id: "soft-neutral", name: "Warm Sand",     emoji: "🏖️", preview: "hsl(30,25%,96%)",   accent: "hsl(28,15%,72%)",  dark: false },
  { id: "rose",         name: "Rosé",           emoji: "🌸", preview: "hsl(350,30%,96%)",  accent: "hsl(350,45%,65%)", dark: false },
  { id: "wine-red",     name: "Wine Red",       emoji: "🍷", preview: "hsl(345,35%,12%)",  accent: "hsl(348,60%,52%)", dark: true  },
  { id: "cherry-blossom",name:"Cherry Blossom", emoji: "🌺", preview: "hsl(340,40%,94%)",  accent: "hsl(340,55%,62%)", dark: false },
  { id: "golden-hour",  name: "Golden Hour",    emoji: "🌅", preview: "hsl(38,50%,94%)",   accent: "hsl(36,70%,55%)",  dark: false },
  { id: "terracotta",   name: "Terracotta",     emoji: "🪴", preview: "hsl(18,30%,93%)",   accent: "hsl(18,55%,52%)",  dark: false },
  { id: "ocean",        name: "Ocean",          emoji: "🌊", preview: "hsl(195,30%,95%)",  accent: "hsl(195,50%,55%)", dark: false },
  { id: "forest",       name: "Forest",         emoji: "🌿", preview: "hsl(150,20%,95%)",  accent: "hsl(155,35%,50%)", dark: false },
  { id: "lavender",     name: "Lavender",       emoji: "💜", preview: "hsl(270,25%,96%)",  accent: "hsl(270,40%,65%)", dark: false },
  { id: "midnight",     name: "Midnight",       emoji: "🌙", preview: "hsl(230,20%,10%)",  accent: "hsl(220,40%,55%)", dark: true  },
  { id: "slate-dark",   name: "Slate",          emoji: "🪨", preview: "hsl(215,25%,11%)",  accent: "hsl(210,35%,50%)", dark: true  },
  { id: "deep-space",   name: "Deep Space",     emoji: "🔭", preview: "hsl(240,30%,8%)",   accent: "hsl(260,50%,65%)", dark: true  },
];

const themeStyles: Record<ThemeColor, Record<string, string>> = {
  "soft-neutral": {
    "--background": "30 25% 96%", "--foreground": "0 0% 17%",
    "--card": "30 20% 98%", "--card-foreground": "0 0% 17%",
    "--primary": "28 15% 72%", "--primary-foreground": "0 0% 17%",
    "--secondary": "30 12% 90%", "--secondary-foreground": "0 0% 17%",
    "--muted": "30 10% 92%", "--muted-foreground": "0 0% 45%",
    "--accent": "28 18% 82%", "--accent-foreground": "0 0% 17%",
    "--border": "28 12% 88%", "--input": "28 12% 88%", "--ring": "28 15% 72%",
    "--warm": "30 25% 96%", "--taupe": "28 15% 72%", "--sand": "30 20% 85%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  rose: {
    "--background": "350 30% 96%", "--foreground": "350 15% 15%",
    "--card": "350 25% 98%", "--card-foreground": "350 15% 15%",
    "--primary": "350 45% 65%", "--primary-foreground": "350 15% 15%",
    "--secondary": "350 18% 91%", "--secondary-foreground": "350 15% 15%",
    "--muted": "350 12% 92%", "--muted-foreground": "350 8% 45%",
    "--accent": "350 25% 85%", "--accent-foreground": "350 15% 15%",
    "--border": "350 15% 88%", "--input": "350 15% 88%", "--ring": "350 45% 65%",
    "--warm": "350 30% 96%", "--taupe": "350 15% 68%", "--sand": "350 18% 86%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  "wine-red": {
    "--background": "345 35% 12%", "--foreground": "348 15% 90%",
    "--card": "345 30% 15%", "--card-foreground": "348 15% 90%",
    "--primary": "348 60% 52%", "--primary-foreground": "348 15% 97%",
    "--secondary": "345 25% 20%", "--secondary-foreground": "348 15% 85%",
    "--muted": "345 20% 18%", "--muted-foreground": "348 10% 55%",
    "--accent": "348 45% 28%", "--accent-foreground": "348 15% 90%",
    "--border": "345 22% 22%", "--input": "345 22% 22%", "--ring": "348 60% 52%",
    "--warm": "345 35% 14%", "--taupe": "348 20% 45%", "--sand": "345 25% 20%",
    "--destructive": "0 70% 55%", "--destructive-foreground": "0 0% 98%",
  },
  "cherry-blossom": {
    "--background": "340 40% 94%", "--foreground": "340 20% 15%",
    "--card": "340 35% 97%", "--card-foreground": "340 20% 15%",
    "--primary": "340 55% 62%", "--primary-foreground": "340 20% 15%",
    "--secondary": "340 25% 89%", "--secondary-foreground": "340 20% 15%",
    "--muted": "340 18% 90%", "--muted-foreground": "340 10% 45%",
    "--accent": "340 32% 83%", "--accent-foreground": "340 20% 15%",
    "--border": "340 20% 86%", "--input": "340 20% 86%", "--ring": "340 55% 62%",
    "--warm": "340 40% 94%", "--taupe": "340 18% 65%", "--sand": "340 25% 84%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  "golden-hour": {
    "--background": "38 50% 94%", "--foreground": "36 25% 15%",
    "--card": "38 45% 97%", "--card-foreground": "36 25% 15%",
    "--primary": "36 70% 55%", "--primary-foreground": "36 25% 15%",
    "--secondary": "38 30% 88%", "--secondary-foreground": "36 25% 15%",
    "--muted": "38 22% 90%", "--muted-foreground": "36 12% 45%",
    "--accent": "38 40% 82%", "--accent-foreground": "36 25% 15%",
    "--border": "38 25% 86%", "--input": "38 25% 86%", "--ring": "36 70% 55%",
    "--warm": "38 50% 94%", "--taupe": "36 22% 62%", "--sand": "38 32% 84%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  terracotta: {
    "--background": "18 30% 93%", "--foreground": "18 25% 14%",
    "--card": "18 25% 96%", "--card-foreground": "18 25% 14%",
    "--primary": "18 55% 52%", "--primary-foreground": "18 25% 14%",
    "--secondary": "18 20% 87%", "--secondary-foreground": "18 25% 14%",
    "--muted": "18 14% 89%", "--muted-foreground": "18 10% 44%",
    "--accent": "18 28% 80%", "--accent-foreground": "18 25% 14%",
    "--border": "18 18% 85%", "--input": "18 18% 85%", "--ring": "18 55% 52%",
    "--warm": "18 30% 93%", "--taupe": "18 18% 60%", "--sand": "18 22% 82%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  ocean: {
    "--background": "195 30% 95%", "--foreground": "200 25% 15%",
    "--card": "195 25% 97%", "--card-foreground": "200 25% 15%",
    "--primary": "195 50% 55%", "--primary-foreground": "200 25% 15%",
    "--secondary": "195 20% 90%", "--secondary-foreground": "200 25% 15%",
    "--muted": "195 15% 91%", "--muted-foreground": "200 10% 45%",
    "--accent": "195 30% 82%", "--accent-foreground": "200 25% 15%",
    "--border": "195 18% 87%", "--input": "195 18% 87%", "--ring": "195 50% 55%",
    "--warm": "195 30% 95%", "--taupe": "195 20% 65%", "--sand": "195 20% 85%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  forest: {
    "--background": "150 20% 95%", "--foreground": "150 20% 12%",
    "--card": "150 18% 97%", "--card-foreground": "150 20% 12%",
    "--primary": "155 35% 50%", "--primary-foreground": "150 20% 12%",
    "--secondary": "150 15% 90%", "--secondary-foreground": "150 20% 12%",
    "--muted": "150 10% 91%", "--muted-foreground": "150 8% 42%",
    "--accent": "150 22% 82%", "--accent-foreground": "150 20% 12%",
    "--border": "150 12% 87%", "--input": "150 12% 87%", "--ring": "155 35% 50%",
    "--warm": "150 20% 95%", "--taupe": "150 12% 62%", "--sand": "150 15% 85%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  lavender: {
    "--background": "270 25% 96%", "--foreground": "270 15% 15%",
    "--card": "270 20% 98%", "--card-foreground": "270 15% 15%",
    "--primary": "270 40% 65%", "--primary-foreground": "270 15% 15%",
    "--secondary": "270 15% 91%", "--secondary-foreground": "270 15% 15%",
    "--muted": "270 10% 92%", "--muted-foreground": "270 8% 45%",
    "--accent": "270 22% 84%", "--accent-foreground": "270 15% 15%",
    "--border": "270 12% 88%", "--input": "270 12% 88%", "--ring": "270 40% 65%",
    "--warm": "270 25% 96%", "--taupe": "270 12% 65%", "--sand": "270 15% 86%",
    "--destructive": "0 84% 60%", "--destructive-foreground": "0 0% 98%",
  },
  midnight: {
    "--background": "230 20% 10%", "--foreground": "220 15% 90%",
    "--card": "230 18% 13%", "--card-foreground": "220 15% 90%",
    "--primary": "220 40% 55%", "--primary-foreground": "220 15% 95%",
    "--secondary": "230 15% 18%", "--secondary-foreground": "220 15% 90%",
    "--muted": "230 12% 16%", "--muted-foreground": "220 10% 50%",
    "--accent": "220 30% 25%", "--accent-foreground": "220 15% 90%",
    "--border": "230 12% 18%", "--input": "230 12% 18%", "--ring": "220 40% 55%",
    "--warm": "230 20% 12%", "--taupe": "220 15% 45%", "--sand": "230 12% 20%",
    "--destructive": "0 70% 55%", "--destructive-foreground": "0 0% 98%",
  },
  "slate-dark": {
    "--background": "215 25% 11%", "--foreground": "210 15% 88%",
    "--card": "215 22% 14%", "--card-foreground": "210 15% 88%",
    "--primary": "210 35% 50%", "--primary-foreground": "210 15% 95%",
    "--secondary": "215 18% 19%", "--secondary-foreground": "210 12% 85%",
    "--muted": "215 14% 17%", "--muted-foreground": "210 8% 52%",
    "--accent": "210 25% 24%", "--accent-foreground": "210 15% 88%",
    "--border": "215 15% 19%", "--input": "215 15% 19%", "--ring": "210 35% 50%",
    "--warm": "215 25% 13%", "--taupe": "210 12% 42%", "--sand": "215 16% 21%",
    "--destructive": "0 70% 55%", "--destructive-foreground": "0 0% 98%",
  },
  "deep-space": {
    "--background": "240 30% 8%", "--foreground": "260 15% 88%",
    "--card": "240 28% 11%", "--card-foreground": "260 15% 88%",
    "--primary": "260 50% 65%", "--primary-foreground": "260 15% 97%",
    "--secondary": "240 22% 17%", "--secondary-foreground": "260 12% 82%",
    "--muted": "240 18% 14%", "--muted-foreground": "260 8% 50%",
    "--accent": "255 35% 24%", "--accent-foreground": "260 15% 88%",
    "--border": "240 18% 17%", "--input": "240 18% 17%", "--ring": "260 50% 65%",
    "--warm": "240 30% 10%", "--taupe": "255 14% 42%", "--sand": "240 20% 18%",
    "--destructive": "0 70% 55%", "--destructive-foreground": "0 0% 98%",
  },
};

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
    (storage.get("duo-theme") as ThemeColor) || "soft-neutral"
  );
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

  // Apply theme CSS variables. After applying preset, re-apply any active
  // custom theme override on top so the user's last custom selection persists
  // across reloads and preset switches.
  useEffect(() => {
    const root = document.documentElement;
    const styles = themeStyles[theme];
    Object.entries(styles).forEach(([key, value]) => root.style.setProperty(key, value));
    // Lazy-import to avoid a circular dep at module load.
    import("@/lib/customThemes").then(({ restoreActiveCustomTheme }) => {
      restoreActiveCustomTheme();
    });
  }, [theme]);

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
