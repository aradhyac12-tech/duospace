/**
 * Splash language preference.
 *
 * There is no existing i18n/translation architecture in this project
 * (checked: no i18next, no LanguageContext/provider, no translations/
 * folder, no "useTranslation" anywhere). Per the redesign brief — reuse an
 * existing system if one exists, don't duplicate one that doesn't — this is
 * a single small source of truth rather than a full app-wide i18n
 * framework, following the same pattern haptics.ts already uses for a
 * standalone preference (`duo-haptic-intensity`): storage.ts wrapper, its
 * own key, no second copy of app settings.
 *
 * If a real i18n system is added later, this file is the one place that
 * needs to change — everything else (splash, future Settings > Language)
 * reads/writes through `getLanguageCode` / `setLanguageCode`.
 */
import storage from "@/lib/storage";

export interface SplashLanguage {
  code: string;
  /** Full name, shown in the language sheet. */
  label: string;
  /** Short code shown on the collapsed pill, e.g. "EN". */
  short: string;
  /** Localized splash tagline. */
  tagline: string;
  /** Set for RTL scripts so the tagline paragraph gets dir="rtl". */
  rtl?: boolean;
}

export const SPLASH_LANGUAGES: SplashLanguage[] = [
  { code: "en", label: "English", short: "EN", tagline: "The private space for two of you" },
  { code: "es", label: "Español", short: "ES", tagline: "El espacio privado para ustedes dos" },
  { code: "fr", label: "Français", short: "FR", tagline: "L'espace privé pour vous deux" },
  { code: "de", label: "Deutsch", short: "DE", tagline: "Der private Raum für euch beide" },
  { code: "pt", label: "Português", short: "PT", tagline: "O espaço privado para vocês dois" },
  { code: "hi", label: "हिन्दी", short: "HI", tagline: "तुम दोनों के लिए एक निजी दुनिया" },
  { code: "ja", label: "日本語", short: "JA", tagline: "ふたりだけのプライベートな空間" },
  { code: "ar", label: "العربية", short: "AR", tagline: "المساحة الخاصة بكما", rtl: true },
];

const LANG_KEY = "duo-language";
const listeners = new Set<() => void>();

export const getLanguageCode = (): string => {
  const saved = storage.get(LANG_KEY);
  if (saved && SPLASH_LANGUAGES.some((l) => l.code === saved)) return saved;
  // First run only: best-effort match against the device/browser language.
  // Never overrides an explicit saved choice.
  if (typeof navigator !== "undefined" && navigator.language) {
    const nav = navigator.language.slice(0, 2).toLowerCase();
    if (SPLASH_LANGUAGES.some((l) => l.code === nav)) return nav;
  }
  return "en";
};

export const getSplashLanguage = (code: string): SplashLanguage =>
  SPLASH_LANGUAGES.find((l) => l.code === code) ?? SPLASH_LANGUAGES[0];

export const setLanguageCode = (code: string) => {
  storage.set(LANG_KEY, code);
  listeners.forEach((fn) => fn());
};

/** Lets any mounted component (this splash, and later a Settings > Language
 *  screen) stay in sync without a context provider. */
export const subscribeLanguage = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
