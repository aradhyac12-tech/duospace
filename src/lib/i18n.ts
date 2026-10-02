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

/**
 * App languages: English + Indian languages (owner decision, 2026-09-25).
 * Previously also es/fr/de/pt/ja/ar — a saved choice of one of those now
 * falls back to device language / English via getLanguageCode().
 * Non-English taglines are machine-authored and need native-speaker review.
 */
export const SPLASH_LANGUAGES: SplashLanguage[] = [
  { code: "en", label: "English", short: "EN", tagline: "The private space for two of you" },
  { code: "hi", label: "हिन्दी", short: "HI", tagline: "तुम दोनों के लिए एक निजी दुनिया" },
  { code: "mr", label: "मराठी", short: "MR", tagline: "तुम्हा दोघांसाठी एक खाजगी जागा" },
  { code: "as", label: "অসমীয়া", short: "AS", tagline: "আপোনালোক দুয়োৰে বাবে এক ব্যক্তিগত ঠাই" },
  { code: "bn", label: "বাংলা", short: "BN", tagline: "তোমাদের দুজনের জন্য একটি ব্যক্তিগত জায়গা" },
  { code: "te", label: "తెలుగు", short: "TE", tagline: "మీ ఇద్దరి కోసం ఒక ప్రైవేట్ స్థలం" },
  { code: "ta", label: "தமிழ்", short: "TA", tagline: "உங்கள் இருவருக்குமான தனிப்பட்ட இடம்" },
  { code: "kn", label: "ಕನ್ನಡ", short: "KN", tagline: "ನಿಮ್ಮಿಬ್ಬರಿಗಾಗಿ ಒಂದು ಖಾಸಗಿ ಜಾಗ" },
  { code: "ml", label: "മലയാളം", short: "ML", tagline: "നിങ്ങൾ രണ്ടുപേർക്കുമായി ഒരു സ്വകാര്യ ഇടം" },
  { code: "gu", label: "ગુજરાતી", short: "GU", tagline: "તમારા બંને માટે એક ખાનગી જગ્યા" },
  { code: "pa", label: "ਪੰਜਾਬੀ", short: "PA", tagline: "ਤੁਹਾਡੇ ਦੋਵਾਂ ਲਈ ਇੱਕ ਨਿੱਜੀ ਥਾਂ" },
  { code: "or", label: "ଓଡ଼ିଆ", short: "OR", tagline: "ଆପଣ ଦୁହିଁଙ୍କ ପାଇଁ ଏକ ବ୍ୟକ୍ତିଗତ ସ୍ଥାନ" },
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

/**
 * Region for emergency guidance — "IN" only when the DEVICE says so: a
 * browser/OS locale with region IN (e.g. en-IN, hi-IN) or an India time
 * zone. Returns null when unsure; callers then use neutral wording. The app
 * language is deliberately NOT used (a Hindi speaker may live anywhere).
 */
export const detectEmergencyRegion = (): "IN" | null => {
  try {
    const langs = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language].filter(Boolean) : [];
    if (langs.some((l) => /-IN$/i.test(l))) return "IN";
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "IN";
  } catch { /* fall through to neutral */ }
  return null;
};

// ── UI string catalogs (Phase 3E architecture; see docs/I18N_ARCHITECTURE.md) ─
//
// One system, extending this file: catalogs keyed by language code, looked
// up with a deterministic fallback chain. Safety-critical text does NOT use
// this generic fallback — it lives in src/lib/relationship/i18n/strings.ts
// with an explicit, reviewed English fallback per key.

export type Priority = "P0" | "P1" | "P2" | "P3";
export type Catalog = Record<string, string>;
const catalogs = new Map<string, Catalog>();

/** Registers (or extends) a language catalog. English is the source of truth. */
export const registerCatalog = (lang: string, entries: Catalog) => {
  catalogs.set(lang, { ...(catalogs.get(lang) ?? {}), ...entries });
};

/** Selected → regional base (hi-IN → hi) → English. Never returns blank. */
export const fallbackChain = (lang: string): string[] => {
  const base = lang.split(/[-_]/)[0].toLowerCase();
  return [...new Set([lang, base, "en"])];
};

/**
 * Translate a UI key. {name} placeholders are replaced from vars; a
 * `{count}` var selects `key.one` / `key.other` (Intl.PluralRules) when those
 * exist. Missing everywhere → the key itself (visible, never blank, never a crash).
 */
export function tr(key: string, vars: Record<string, string | number> = {}, lang: string = getLanguageCode()): string {
  const chain = fallbackChain(lang);
  let pluralKey: string | null = null;
  if (typeof vars.count === "number") {
    try { pluralKey = `${key}.${new Intl.PluralRules(chain[0]).select(vars.count)}`; } catch { pluralKey = `${key}.other`; }
  }
  let text: string | undefined;
  for (const l of chain) {
    const c = catalogs.get(l);
    text = (pluralKey && (c?.[pluralKey] ?? c?.[`${key}.other`])) || c?.[key];
    if (text) break;
  }
  if (!text) return key;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Supported app languages are all LTR (Urdu excluded). Never mark an Indic script RTL. */
export const isRtl = (_lang: string): boolean => false;

// P0 English source catalog (consent, deletion, sharing, errors, privacy).
// Non-English entries are intentionally NOT added until native review
// (docs/NATIVE_LANGUAGE_REVIEW_PACK.md); the chain falls back to English.
registerCatalog("en", {
  "p0.memory.deleteAllConfirm": "Delete all relationship memory on this device and withdraw anything you shared from it with your partner? Other account data isn't affected.",
  "p0.memory.withdrawFailed": "Couldn't confirm your shared items were withdrawn. Nothing was deleted; try again when online.",
  "p0.share.confirm": "Share exactly this with your partner?",
  "p0.share.turnedOff": "Sharing was turned off, so this was not shared.",
  "p0.error.generic": "Couldn't do that",
  "p0.privacy.nothingSaved": "Nothing you write here is saved or shared.",
  "p0.memory.itemsShared.one": "{count} item is shared with your partner",
  "p0.memory.itemsShared.other": "{count} items are shared with your partner",
});

// Chat-first relationship AI (Phase 3J) — English source; other languages fall back until reviewed.
registerCatalog("en", {
  "p1.today.title": "Today",
  "p1.today.notice": "A small thing worth noticing",
  "p1.today.empty": "Nothing needs decoding today.",
  "p1.ai.why": "Why?",
  "p1.ai.hide": "Hide",
  "p1.ai.helpReply": "Help me reply",
  "p1.ai.askThem": "Ask them",
  "p1.ai.basedOn": "Based only on what they explicitly said.",
  "p1.ai.allowOnDevice": "Allow on-device help",
  "p1.today.consentBody": "DuoSpace can point out one thing worth noticing from today's messages — on your phone only.",
  "p1.today.dismiss": "Dismiss",
  "p1.understand.title": "Understand",
  "p1.understand.consentBody": "DuoSpace can point out what this message says, right here on your phone. Nothing is sent or saved.",
  "p1.understand.repairPrompt": "Need help repairing this?",
  "p1.understand.repair.own": "Own my part",
  "p1.understand.repair.explain": "Explain",
  "p1.understand.repair.boundary": "Set a boundary",
  "p1.understand.repair.walk": "Walk me through it",
  "p1.understand.footer": "Only what the message says — DuoSpace can't know what they feel.",
  "p1.reply.preparing": "Preparing a reply",
  "p1.reply.consentBody": "DuoSpace can suggest a reply right here on your phone. The message isn't sent anywhere, and nothing is saved.",
  "p1.reply.error": "Couldn't suggest a reply right now.",
  "p1.reply.use": "Use this reply",
  "p1.reply.footer": "Based only on their words above — DuoSpace can't know what they feel. You can edit it before sending.",
  "p1.reply.askDirect": "Asking them directly might be best here.",
  "p1.reply.chip.another": "Another",
  "p1.reply.chip.shorter": "Shorter",
  "p1.reply.chip.askFirst": "Ask first",
  "p1.reply.chip.moreCasual": "More casual",
});
