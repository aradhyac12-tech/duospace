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
import en_ui from "@/lib/uiCatalogs/en";
import hi_ui from "@/lib/uiCatalogs/hi";
import mr_ui from "@/lib/uiCatalogs/mr";
import as_ui from "@/lib/uiCatalogs/as";
import bn_ui from "@/lib/uiCatalogs/bn";
import te_ui from "@/lib/uiCatalogs/te";
import ta_ui from "@/lib/uiCatalogs/ta";
import kn_ui from "@/lib/uiCatalogs/kn";
import ml_ui from "@/lib/uiCatalogs/ml";
import gu_ui from "@/lib/uiCatalogs/gu";
import pa_ui from "@/lib/uiCatalogs/pa";
import or_ui from "@/lib/uiCatalogs/or";
import mrl_ui from "@/lib/uiCatalogs/mrl";
import hil_ui from "@/lib/uiCatalogs/hil";

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
 * The stored value may also be "system" (default): follow the device language,
 * re-evaluated live on `languagechange`.
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
  { code: "mrl", label: "Marathi (English letters)", short: "MRL", tagline: "Tumha doghansathi ek khasagi jaaga" },
  { code: "hil", label: "Hindi (English letters)", short: "HIL", tagline: "Aap dono ke liye ek private jagah" },
];

const LANG_KEY = "duo-language";
/** Stored value meaning "follow the device language" (also the default when nothing is stored). */
export const SYSTEM_LANGUAGE = "system";
const listeners = new Set<() => void>();

const isSupported = (code: string | null | undefined): code is string =>
  !!code && SPLASH_LANGUAGES.some((l) => l.code === code);

/** First supported language in the device's preference list, else null. Checks the
 *  whole `navigator.languages` list (not just the first entry) so a phone set to
 *  [ru, hi] still gets Hindi rather than English. */
export const detectDeviceLanguage = (): string | null => {
  if (typeof navigator === "undefined") return null;
  const list = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const l of list) {
    const base = l.split(/[-_]/)[0].toLowerCase();
    if (isSupported(base)) return base;
  }
  return null;
};

/** What the user chose: a language code, or "system" (default). */
export const getLanguagePreference = (): string => {
  const saved = storage.get(LANG_KEY);
  return isSupported(saved) ? saved : SYSTEM_LANGUAGE;
};

/** The language actually in effect. A saved explicit choice always wins;
 *  otherwise the device language; otherwise English. */
export const getLanguageCode = (): string => {
  const pref = getLanguagePreference();
  if (pref !== SYSTEM_LANGUAGE) return pref;
  return detectDeviceLanguage() ?? "en";
};

export const getSplashLanguage = (code: string): SplashLanguage =>
  SPLASH_LANGUAGES.find((l) => l.code === code) ?? SPLASH_LANGUAGES[0];

const applyDocumentLanguage = () => {
  if (typeof document !== "undefined") { const c = getLanguageCode(); document.documentElement.lang = c === "mrl" ? "mr-Latn" : c === "hil" ? "hi-Latn" : c; }
};

const notify = () => {
  applyDocumentLanguage();
  listeners.forEach((fn) => fn());
};

/** Pass a language code, or SYSTEM_LANGUAGE to follow the device again. */
export const setLanguageCode = (code: string) => {
  if (code === SYSTEM_LANGUAGE) storage.set(LANG_KEY, SYSTEM_LANGUAGE);
  else if (isSupported(code)) storage.set(LANG_KEY, code);
  else return;
  notify();
};

/** Lets any mounted component stay in sync without a context provider. */
export const subscribeLanguage = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Device language changed while the app is open (Android/iOS settings, browser
// preference): re-resolve only when the user is following the system.
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (getLanguagePreference() === SYSTEM_LANGUAGE) notify();
  });
  applyDocumentLanguage();
}

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
  "p1.today.empty": "Nothing needs your attention today.",
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
  "p1.understand.cloud.ask": "Look closer (uses an AI service)",
  "p1.understand.cloud.failed": "Couldn't look closer right now. The summary above still applies.",
  "p1.understand.cloud.label": "AI service reading — a possible interpretation, not a fact",
  "p1.understand.cloud.unsure": "This message may not say enough to be sure.",
  "p1.reply.preparing": "Preparing a reply",
  "p1.reply.consentBody": "DuoSpace suggests replies on your phone by default. The message isn't sent anywhere unless you choose to allow an AI service, and nothing is saved.",
  "p1.reply.error": "Couldn't suggest a reply right now.",
  "p1.reply.use": "Use this reply",
  "p1.reply.footer": "Based only on their words above — DuoSpace can't know what they feel. You can edit it before sending.",
  "p1.composer.cancelEdit": "Cancel edit",
  "p1.composer.cancelVoice": "Cancel voice recording",
  "p1.composer.sendVoice": "Send voice recording",
  "p1.composer.attachments": "Attachments",
  "p1.composer.modes": "Message modes",
  "p1.composer.message": "Message",
  "p1.composer.saveEdit": "Save edit",
  "p1.composer.send": "Send message",
  "p1.composer.holdRecord": "Hold to record voice message",
  "p1.reply.cancel": "Cancel",
  "p1.reply.retry": "Try again",
  "p1.reply.badge.ai": "Written by an AI service",
  "p1.reply.badge.device": "Suggested on your phone",
  "p1.reply.notice.quota": "You've used today's AI replies. This one is from your phone.",
  "p1.reply.notice.unavailable": "The AI service isn't available right now. This one is from your phone.",
  "p1.reply.cloud.title": "Get a more natural reply?",
  "p1.reply.cloud.body": "This sends their message and a few messages before it to an AI service to write the reply. Nothing else is sent. It isn't end-to-end encrypted while it's processed. You can turn this off anytime in Privacy settings.",
  "p1.reply.cloud.allow": "Allow AI service",
  "p1.reply.cloud.decline": "Not now",
  "p1.reply.askDirect": "Asking them directly might be best here.",
  "p1.rel.chatHint": "In Chat, long-press your partner's message → “Help me reply” or “Understand”.",
  "p1.rel.moreTools": "More tools",
  "p1.rel.hide": "Hide",
  "p1.rel.moreToolsList": "Compare · Repair · Memory",
  "p1.intent.askMean": "Ask what they mean",
  "p1.intent.ackApology": "Acknowledge the apology",
  "p1.intent.ack": "Acknowledge",
  "p1.intent.respondAsk": "Respond to their ask",
  "p1.intent.replyQ": "Reply to the question",
  "p1.intent.respect": "Respect the limit",
  "p1.intent.explain": "Explain your side",
  "p1.intent.askFirst": "Ask first",
  "p1.rel.err.save": "Couldn't save",
  "p1.rel.err.reflect": "Couldn't reflect on this yet",
  "p1.rel.shared": "Shared",
  "p1.rel.err.share": "Couldn't share",
  "p1.rel.err.update": "Couldn't update",
  "p1.rel.err.delete": "Couldn't delete",
  "p1.rel.err.process": "Couldn't process this",
  "p1.rel.err.feedback": "Couldn't save your feedback",
  "p1.rel.sharingStopped": "Sharing stopped",
  "p1.rel.err.withdraw": "Couldn't withdraw it",
  "p1.rel.notApplicable": "This doesn't apply to my relationship",
  "p1.rel.exp.addTitle": "Add something you'd like to name",
  "p1.rel.exp.placeholder": "Describe it in your own words…",
  "p1.rel.notRelevant": "Not relevant anymore",
  "p1.rel.exp.empty": "Nothing added yet.",
  "p1.rel.exp.boundaryTitle": "Mark this as a boundary?",
  "p1.rel.exp.boundaryBody": "A boundary is something you consider necessary — not just a preference. Only you can decide this.",
  "p1.rel.cancel": "Cancel",
  "p1.rel.exp.boundaryYes": "Yes, this is a boundary",
  "p1.rel.reflect.placeholder": "Write as much or as little as you'd like…",
  "p1.rel.reflect.keep": "Keep what I wrote on this device",
  "p1.rel.rate": "Rate this",
  "p1.rel.sharedWithPartner": "Shared with your partner",
  "p1.rel.withdraw": "Withdraw",
  "p1.rel.acc.title": "How accurate was this?",
  "p1.rel.acc.body": "This only records your own feedback — nothing is retrained.",
  "p1.rel.acc.correct": "Accurate",
  "p1.rel.acc.partly": "Partly accurate",
  "p1.rel.acc.not": "Not accurate",
  "p1.rel.shareDlg.title": "Share with your partner?",
  "p1.rel.shareDlg.body": "This is exactly what they'll see — nothing more.",
  "p1.rel.shareThis": "Share this",
  "p1.rel.share": "Share",
  "p1.rel.notSure": "Not sure",
  "p1.rel.preferNot": "Prefer not to answer",
  "p1.rel.val.reflect": "Reflect on my answers",
  "p1.rel.exp.reflect": "Reflect on these",
  "p1.rel.reflect.reflect": "Reflect on this",
  "p1.rel.reflect.note": "This only analyzes what you write here. Your partner is never analyzed, and nothing about what \"really\" happened between you is asserted — only what you reported.",
  "p1.rel.insights.empty": "Nothing yet. Answer some questions in Values or Expectations, or write a reflection, then tap \"Reflect\".",
  "p1.rel.err.generic": "Something went wrong. Nothing was saved or sent.",
  "p1.menu.reply": "Reply",
  "p1.menu.react": "React",
  "p1.menu.copy": "Copy",
  "p1.menu.edit": "Edit",
  "p1.menu.pin": "Pin",
  "p1.menu.unpin": "Unpin",
  "p1.menu.delete": "Delete",
  "p1.reply.chip.another": "Another",
  "p1.reply.chip.shorter": "Shorter",
  "p1.reply.chip.askFirst": "Ask first",
  "p1.reply.chip.moreCasual": "More casual",
  "p1.rel.title": "Relationship Reflection",
  "p1.rel.subtitle": "Private — only you can see this unless you choose to share",
  "p1.rel.tab.values": "Values",
  "p1.rel.tab.expectations": "Expectations",
  "p1.rel.tab.reflect": "Reflect",
  "p1.checkin.title": "How's today between you?",
  "p1.checkin.sub": "One tap. Stays on your phone.",
  "p1.checkin.mood.good": "Good",
  "p1.checkin.mood.okay": "Okay",
  "p1.checkin.mood.off": "A bit off",
  "p1.checkin.mood.hard": "Hard",
  "p1.checkin.help": "What would help? (optional)",
  "p1.checkin.need.time": "Time together",
  "p1.checkin.need.space": "Some space",
  "p1.checkin.need.kind_word": "A kind word",
  "p1.checkin.need.help": "A hand with something",
  "p1.checkin.need.listen": "Someone to listen",
  "p1.checkin.need.talk": "To sort something out",
  "p1.checkin.send": "Send in chat",
  "p1.checkin.words": "Help me put it into words",
  "p1.adaptive.title": "Get to know your preferences",
  "p1.adaptive.sub": "A few short questions, one at a time. You can skip any of them.",
  "p1.adaptive.start": "Start",
  "p1.adaptive.wait": "One moment…",
  "p1.adaptive.done": "That's enough for now — thank you. You can answer more any time.",
  "p1.compat.title": "Overview by area",
  "p1.compat.onePartner": "Based on what you've shared so far. ",
  "p1.compat.noScore": "No score — a difference never means incompatible.",
  "p1.compat.state.ALIGNED": "Aligned",
  "p1.compat.state.DIFFERENT": "Different — worth talking about",
  "p1.compat.state.DISCOVERING": "Still discovering",
  "p1.compat.state.INSUFFICIENT_DATA": "Not enough information yet",
  "p1.compat.explain": "Explain this in words",
  "p1.compat.working": "Working…",
  "p1.compat.basedOnShared": "Based on what you've shared: {text}",
  "p1.cantTell.full": "I can't reliably tell what they mean from this message alone.",
  "p1.cantTell.short": "I can't reliably tell from this message alone.",
  "p1.fact.request": "They asked: “{q}”",
  "p1.fact.question": "They asked you a question: “{q}”",
  "p1.fact.feeling": "They said: “{q}”",
  "p1.fact.apology": "They apologised: “{q}”",
  "p1.fact.boundary": "They set a limit: “{q}”",
  "p1.fact.uncertainty": "They said they're unsure: “{q}”",
  "p1.fact.event": "They described what happened: “{q}”",
  "p1.fact.accusation": "They blamed you for something: “{q}”. You can reply with care without accepting blame.",
  "p1.fact.control": "They're asking for access to something private: “{q}”. You can be kind and still keep your privacy.",
  "p1.fact.pastExpectation": "They mentioned something that didn't happen: “{q}”",
  "p1.fact.acknowledgement": "They acknowledged you: “{q}”",
  "p1.fact.defensive": "They explained their side: “{q}”",
  "p1.today.request": "They asked you: “{q}”",
  "p1.today.question": "They asked a question today: “{q}”",
  "p1.today.feeling": "They told you today: “{q}”",
  "p1.today.uncertainty": "They said they weren't sure: “{q}”",
  "p1.today.apology": "They apologised today: “{q}”",
});

// App-shell UI catalogs (nav, Settings, language picker). Plain data files so
// there is no import cycle. Non-English entries are machine-authored and need
// native-speaker review; missing keys fall back to English via fallbackChain().
registerCatalog("en", en_ui);
registerCatalog("hi", hi_ui);
registerCatalog("mr", mr_ui);
registerCatalog("as", as_ui);
registerCatalog("bn", bn_ui);
registerCatalog("te", te_ui);
registerCatalog("ta", ta_ui);
registerCatalog("kn", kn_ui);
registerCatalog("ml", ml_ui);
registerCatalog("gu", gu_ui);
registerCatalog("pa", pa_ui);
registerCatalog("or", or_ui);
registerCatalog("mrl", mrl_ui);
registerCatalog("hil", hil_ui);

// Hindi / Marathi — relationship-help surfaces (natural phrasing, not word-for-word; needs native review).
registerCatalog("hi", {
  "p1.today.empty": "आज ध्यान देने लायक कुछ नहीं है।",
  "p1.ai.helpReply": "जवाब देने में मदद",
  "p1.understand.title": "समझें",
  "p1.menu.reply": "जवाब दें", "p1.menu.react": "प्रतिक्रिया", "p1.menu.copy": "कॉपी", "p1.menu.edit": "बदलें",
  "p1.menu.pin": "पिन करें", "p1.menu.unpin": "पिन हटाएँ", "p1.menu.delete": "हटाएँ",
  "p1.intent.askMean": "पूछें कि उनका क्या मतलब है", "p1.intent.ackApology": "माफ़ी को स्वीकार करें", "p1.intent.ack": "बात को स्वीकार करें",
  "p1.intent.respondAsk": "उनकी बात का जवाब दें", "p1.intent.replyQ": "सवाल का जवाब दें", "p1.intent.respect": "उनकी सीमा का सम्मान करें",
  "p1.intent.explain": "अपनी बात समझाएँ", "p1.intent.askFirst": "पहले पूछें",
  "p1.reply.chip.another": "दूसरा", "p1.reply.chip.shorter": "छोटा", "p1.reply.chip.moreCasual": "थोड़ा सहज",
});
registerCatalog("mr", {
  "p1.today.empty": "आज लक्ष देण्यासारखे काही नाही.",
  "p1.ai.helpReply": "उत्तर देण्यास मदत",
  "p1.understand.title": "समजून घ्या",
  "p1.menu.reply": "उत्तर द्या", "p1.menu.react": "प्रतिक्रिया", "p1.menu.copy": "कॉपी", "p1.menu.edit": "बदला",
  "p1.menu.pin": "पिन करा", "p1.menu.unpin": "पिन काढा", "p1.menu.delete": "हटवा",
  "p1.intent.askMean": "त्यांना काय म्हणायचे ते विचारा", "p1.intent.ackApology": "माफी स्वीकारा", "p1.intent.ack": "म्हणणे मान्य करा",
  "p1.intent.respondAsk": "त्यांच्या विनंतीला उत्तर द्या", "p1.intent.replyQ": "प्रश्नाचे उत्तर द्या", "p1.intent.respect": "त्यांच्या मर्यादेचा आदर करा",
  "p1.intent.explain": "तुमची बाजू सांगा", "p1.intent.askFirst": "आधी विचारा",
  "p1.reply.chip.another": "दुसरे", "p1.reply.chip.shorter": "लहान", "p1.reply.chip.moreCasual": "थोडे सहज",
});

// Hindi / Marathi — remaining reachable RI strings (templates for Understand/Today live in contextual/present.ts via p1.fact.* / p1.today.*).
registerCatalog("hi", {
  "p1.checkin.title": "आज आप दोनों के बीच कैसा रहा?",
  "p1.checkin.sub": "बस एक टैप। आपके फ़ोन पर ही रहता है।",
  "p1.checkin.mood.good": "अच्छा",
  "p1.checkin.mood.okay": "ठीक-ठाक",
  "p1.checkin.mood.off": "थोड़ा अजीब",
  "p1.checkin.mood.hard": "मुश्किल",
  "p1.checkin.help": "क्या मदद करेगा? (वैकल्पिक)",
  "p1.checkin.need.time": "साथ में समय",
  "p1.checkin.need.space": "थोड़ी जगह",
  "p1.checkin.need.kind_word": "एक प्यार भरी बात",
  "p1.checkin.need.help": "किसी काम में हाथ",
  "p1.checkin.need.listen": "कोई सुनने वाला",
  "p1.checkin.need.talk": "कुछ सुलझाने के लिए",
  "p1.checkin.send": "चैट में भेजें",
  "p1.checkin.words": "शब्दों में कहने में मदद करें",
  "p1.adaptive.title": "अपनी पसंद को जानें",
  "p1.adaptive.sub": "कुछ छोटे सवाल, एक-एक करके। आप किसी को भी छोड़ सकते हैं।",
  "p1.adaptive.start": "शुरू करें",
  "p1.adaptive.wait": "एक पल…",
  "p1.adaptive.done": "अभी के लिए इतना काफ़ी है — शुक्रिया। आप जब चाहें और जवाब दे सकते हैं।",
  "p1.compat.title": "क्षेत्र के अनुसार झलक",
  "p1.compat.onePartner": "अब तक आपने जो साझा किया है उस पर आधारित। ",
  "p1.compat.noScore": "कोई स्कोर नहीं — अंतर का मतलब कभी असंगति नहीं होता।",
  "p1.compat.state.ALIGNED": "मेल खाता है",
  "p1.compat.state.DIFFERENT": "अलग — बात करने लायक",
  "p1.compat.state.DISCOVERING": "अभी जान रहे हैं",
  "p1.compat.state.INSUFFICIENT_DATA": "अभी पर्याप्त जानकारी नहीं",
  "p1.compat.explain": "इसे शब्दों में समझाएँ",
  "p1.compat.working": "हो रहा है…",
  "p1.compat.basedOnShared": "आपने जो साझा किया उस पर आधारित: {text}",
  "p1.rel.title": "रिश्ते पर विचार",
  "p1.rel.subtitle": "निजी — जब तक आप साझा न करें, सिर्फ़ आप इसे देख सकते हैं",
  "p1.rel.tab.values": "मूल्य",
  "p1.rel.tab.expectations": "अपेक्षाएँ",
  "p1.rel.tab.reflect": "विचार",
  "p1.cantTell.full": "सिर्फ़ इस संदेश से भरोसे के साथ नहीं कहा जा सकता कि उनका क्या मतलब है।",
  "p1.cantTell.short": "सिर्फ़ इस संदेश से भरोसे के साथ कुछ नहीं कहा जा सकता।",
  "p1.fact.request": "उन्होंने आपसे कुछ माँगा: “{q}”",
  "p1.fact.question": "उन्होंने आपसे एक सवाल पूछा: “{q}”",
  "p1.fact.feeling": "उन्होंने कहा: “{q}”",
  "p1.fact.apology": "उन्होंने माफ़ी माँगी: “{q}”",
  "p1.fact.boundary": "उन्होंने अपनी एक सीमा बताई: “{q}”",
  "p1.fact.uncertainty": "उन्होंने कहा कि उन्हें पक्का नहीं पता: “{q}”",
  "p1.fact.event": "उन्होंने बताया कि क्या हुआ: “{q}”",
  "p1.fact.accusation": "उन्होंने आपको किसी बात का दोषी ठहराया: “{q}”। दोष माने बिना भी आप परवाह के साथ जवाब दे सकते हैं।",
  "p1.fact.control": "वे आपकी किसी निजी चीज़ तक पहुँच माँग रहे हैं: “{q}”। आप प्यार से जवाब देते हुए भी अपनी निजता रख सकते हैं।",
  "p1.fact.pastExpectation": "उन्होंने किसी ऐसी बात का ज़िक्र किया जो नहीं हुई: “{q}”",
  "p1.fact.acknowledgement": "उन्होंने आपकी बात को स्वीकार किया: “{q}”",
  "p1.fact.defensive": "उन्होंने अपनी तरफ़ से सफ़ाई दी: “{q}”",
  "p1.today.request": "उन्होंने आपसे कहा: “{q}”",
  "p1.today.question": "उन्होंने आज एक सवाल पूछा: “{q}”",
  "p1.today.feeling": "उन्होंने आज आपसे कहा: “{q}”",
  "p1.today.uncertainty": "उन्होंने कहा कि उन्हें पक्का नहीं पता: “{q}”",
  "p1.today.apology": "उन्होंने आज माफ़ी माँगी: “{q}”",
  "p1.today.title": "आज",
  "p1.today.notice": "ध्यान देने लायक एक छोटी बात",
  "p1.ai.why": "क्यों?",
  "p1.ai.hide": "छिपाएँ",
  "p1.ai.askThem": "उनसे पूछें",
  "p1.ai.basedOn": "सिर्फ़ उसी पर आधारित जो उन्होंने साफ़ शब्दों में कहा।",
  "p1.ai.allowOnDevice": "फ़ोन पर मदद की अनुमति दें",
  "p1.today.consentBody": "DuoSpace आज के संदेशों में से ध्यान देने लायक एक बात बता सकता है — सिर्फ़ आपके फ़ोन पर।",
  "p1.today.dismiss": "हटाएँ",
  "p1.understand.consentBody": "DuoSpace आपके फ़ोन पर ही बता सकता है कि इस संदेश में क्या कहा गया है। कुछ भेजा या सहेजा नहीं जाता।",
  "p1.understand.repairPrompt": "इसे सुलझाने में मदद चाहिए?",
  "p1.understand.repair.own": "अपना हिस्सा मानें",
  "p1.understand.repair.explain": "समझाएँ",
  "p1.understand.repair.boundary": "सीमा बताएँ",
  "p1.understand.repair.walk": "क़दम-दर-क़दम बताएँ",
  "p1.understand.footer": "सिर्फ़ वही जो संदेश में लिखा है — DuoSpace नहीं जान सकता कि उन्हें कैसा लग रहा है।",
  "p1.understand.cloud.ask": "और ध्यान से देखें (AI सेवा का उपयोग)",
  "p1.understand.cloud.failed": "अभी और गहराई से नहीं देख पाए। ऊपर का सारांश अब भी लागू है।",
  "p1.understand.cloud.label": "AI सेवा की व्याख्या — एक संभावित अर्थ, तथ्य नहीं",
  "p1.understand.cloud.unsure": "हो सकता है इस संदेश से पक्का पता न चले।",
  "p1.reply.preparing": "जवाब तैयार हो रहा है",
  "p1.reply.consentBody": "DuoSpace डिफ़ॉल्ट रूप से आपके फ़ोन पर ही जवाब सुझाता है। जब तक आप AI सेवा की अनुमति नहीं देते, संदेश कहीं भेजा नहीं जाता और कुछ सेव नहीं होता।",
  "p1.reply.error": "अभी जवाब नहीं सुझा पाए।",
  "p1.reply.use": "यह जवाब इस्तेमाल करें",
  "p1.reply.footer": "सिर्फ़ ऊपर लिखे उनके शब्दों पर आधारित — DuoSpace नहीं जान सकता कि उन्हें कैसा लग रहा है। भेजने से पहले आप इसे बदल सकते हैं।",
  "p1.composer.cancelEdit": "संपादन रद्द करें",
  "p1.composer.cancelVoice": "वॉइस रिकॉर्डिंग रद्द करें",
  "p1.composer.sendVoice": "वॉइस रिकॉर्डिंग भेजें",
  "p1.composer.attachments": "अटैचमेंट",
  "p1.composer.modes": "संदेश मोड",
  "p1.composer.message": "संदेश",
  "p1.composer.saveEdit": "संपादन सहेजें",
  "p1.composer.send": "संदेश भेजें",
  "p1.composer.holdRecord": "वॉइस संदेश रिकॉर्ड करने के लिए दबाकर रखें",
  "p1.reply.cancel": "रद्द करें",
  "p1.reply.retry": "फिर कोशिश करें",
  "p1.reply.badge.ai": "AI सेवा ने लिखा",
  "p1.reply.badge.device": "आपके फ़ोन पर सुझाया गया",
  "p1.reply.notice.quota": "आज के AI जवाब पूरे हो गए। यह जवाब आपके फ़ोन से है।",
  "p1.reply.notice.unavailable": "AI सेवा अभी उपलब्ध नहीं है। यह जवाब आपके फ़ोन से है।",
  "p1.reply.cloud.title": "ज़्यादा स्वाभाविक जवाब चाहिए?",
  "p1.reply.cloud.body": "इससे उनका संदेश और उससे पहले के कुछ संदेश जवाब लिखने के लिए एक AI सेवा को भेजे जाते हैं। और कुछ नहीं भेजा जाता। प्रोसेस होते समय यह एंड-टू-एंड एन्क्रिप्टेड नहीं रहता। आप इसे कभी भी प्राइवेसी सेटिंग्स में बंद कर सकते हैं।",
  "p1.reply.cloud.allow": "AI सेवा की अनुमति दें",
  "p1.reply.cloud.decline": "अभी नहीं",
  "p1.reply.askDirect": "यहाँ सीधे उनसे पूछ लेना शायद सबसे अच्छा रहेगा।",
  "p1.reply.chip.askFirst": "पहले पूछें",
  "p1.rel.chatHint": "चैट में अपने पार्टनर के संदेश को देर तक दबाएँ → “जवाब देने में मदद” या “समझें”।",
  "p1.rel.moreTools": "और टूल",
  "p1.rel.hide": "छिपाएँ",
  "p1.rel.moreToolsList": "तुलना · सुलह · मेमोरी",
  "p1.rel.err.save": "सहेज नहीं पाए",
  "p1.rel.err.reflect": "अभी इस पर विचार नहीं कर पाए",
  "p1.rel.shared": "साझा किया गया",
  "p1.rel.err.share": "साझा नहीं कर पाए",
  "p1.rel.err.update": "अपडेट नहीं कर पाए",
  "p1.rel.err.delete": "हटा नहीं पाए",
  "p1.rel.err.process": "इसे प्रोसेस नहीं कर पाए",
  "p1.rel.err.feedback": "आपकी राय सहेज नहीं पाए",
  "p1.rel.sharingStopped": "साझा करना बंद किया गया",
  "p1.rel.err.withdraw": "वापस नहीं ले पाए",
  "p1.rel.notApplicable": "यह मेरे रिश्ते पर लागू नहीं होता",
  "p1.rel.exp.addTitle": "कोई बात जिसे आप नाम देना चाहते हैं, जोड़ें",
  "p1.rel.exp.placeholder": "अपने शब्दों में लिखें…",
  "p1.rel.notRelevant": "अब ज़रूरी नहीं",
  "p1.rel.exp.empty": "अभी कुछ जोड़ा नहीं गया।",
  "p1.rel.exp.boundaryTitle": "इसे सीमा के रूप में चिह्नित करें?",
  "p1.rel.exp.boundaryBody": "सीमा वह है जिसे आप ज़रूरी मानते हैं — सिर्फ़ पसंद नहीं। यह सिर्फ़ आप तय कर सकते हैं।",
  "p1.rel.cancel": "रद्द करें",
  "p1.rel.exp.boundaryYes": "हाँ, यह मेरी सीमा है",
  "p1.rel.reflect.placeholder": "जितना चाहें उतना लिखें…",
  "p1.rel.reflect.keep": "जो लिखा है उसे इसी डिवाइस पर रखें",
  "p1.rel.rate": "इसे आँकें",
  "p1.rel.sharedWithPartner": "पार्टनर के साथ साझा किया गया",
  "p1.rel.withdraw": "वापस लें",
  "p1.rel.acc.title": "यह कितना सही था?",
  "p1.rel.acc.body": "यह सिर्फ़ आपकी अपनी राय दर्ज करता है — इससे कुछ दोबारा ट्रेन नहीं होता।",
  "p1.rel.acc.correct": "सही",
  "p1.rel.acc.partly": "कुछ हद तक सही",
  "p1.rel.acc.not": "सही नहीं",
  "p1.rel.shareDlg.title": "पार्टनर के साथ साझा करें?",
  "p1.rel.shareDlg.body": "वे ठीक यही देखेंगे — इससे ज़्यादा कुछ नहीं।",
  "p1.rel.shareThis": "यह साझा करें",
  "p1.rel.share": "साझा करें",
  "p1.rel.notSure": "पक्का नहीं",
  "p1.rel.preferNot": "जवाब नहीं देना",
  "p1.rel.val.reflect": "मेरे जवाबों पर विचार करें",
  "p1.rel.exp.reflect": "इन पर विचार करें",
  "p1.rel.reflect.reflect": "इस पर विचार करें",
  "p1.rel.reflect.note": "यह सिर्फ़ वही देखता है जो आप यहाँ लिखते हैं। आपके पार्टनर का कभी विश्लेषण नहीं होता, और आपके बीच सचमुच क्या हुआ, इसका कोई दावा नहीं किया जाता — सिर्फ़ वही जो आपने बताया।",
  "p1.rel.insights.empty": "अभी कुछ नहीं। मूल्यों या अपेक्षाओं में कुछ सवालों के जवाब दें, या कुछ लिखें, फिर “विचार करें” दबाएँ।",
  "p1.rel.err.generic": "कुछ गड़बड़ हो गई। कुछ भी सहेजा या भेजा नहीं गया।",
});
registerCatalog("mr", {
  "p1.checkin.title": "आज तुमच्या दोघांमध्ये कसे वाटतेय?",
  "p1.checkin.sub": "फक्त एक टॅप. तुमच्या फोनवरच राहते.",
  "p1.checkin.mood.good": "छान",
  "p1.checkin.mood.okay": "ठीक",
  "p1.checkin.mood.off": "थोडे बिघडलेले",
  "p1.checkin.mood.hard": "कठीण",
  "p1.checkin.help": "काय मदत करेल? (ऐच्छिक)",
  "p1.checkin.need.time": "एकत्र वेळ",
  "p1.checkin.need.space": "थोडी मोकळीक",
  "p1.checkin.need.kind_word": "एक प्रेमळ शब्द",
  "p1.checkin.need.help": "एखाद्या कामात मदत",
  "p1.checkin.need.listen": "ऐकणारे कोणीतरी",
  "p1.checkin.need.talk": "काहीतरी सोडवण्यासाठी",
  "p1.checkin.send": "चॅटमध्ये पाठवा",
  "p1.checkin.words": "शब्दांत मांडण्यास मदत करा",
  "p1.adaptive.title": "तुमच्या आवडीनिवडी जाणून घ्या",
  "p1.adaptive.sub": "काही छोटे प्रश्न, एकेक करून. तुम्ही कोणताही वगळू शकता.",
  "p1.adaptive.start": "सुरू करा",
  "p1.adaptive.wait": "एक क्षण…",
  "p1.adaptive.done": "आत्तापुरते इतके पुरे — धन्यवाद. तुम्ही केव्हाही आणखी उत्तरे देऊ शकता.",
  "p1.compat.title": "क्षेत्रानुसार आढावा",
  "p1.compat.onePartner": "आतापर्यंत तुम्ही जे शेअर केले त्यावर आधारित. ",
  "p1.compat.noScore": "कोणताही स्कोअर नाही — फरक म्हणजे कधीच विसंगती नाही.",
  "p1.compat.state.ALIGNED": "जुळते",
  "p1.compat.state.DIFFERENT": "वेगळे — बोलण्यासारखे",
  "p1.compat.state.DISCOVERING": "अजून जाणून घेत आहोत",
  "p1.compat.state.INSUFFICIENT_DATA": "अजून पुरेशी माहिती नाही",
  "p1.compat.explain": "हे शब्दांत समजावून सांगा",
  "p1.compat.working": "सुरू आहे…",
  "p1.compat.basedOnShared": "तुम्ही जे शेअर केले त्यावर आधारित: {text}",
  "p1.rel.title": "नात्यावर विचार",
  "p1.rel.subtitle": "खाजगी — तुम्ही शेअर करेपर्यंत फक्त तुम्हीच हे पाहू शकता",
  "p1.rel.tab.values": "मूल्ये",
  "p1.rel.tab.expectations": "अपेक्षा",
  "p1.rel.tab.reflect": "विचार",
  "p1.cantTell.full": "फक्त या संदेशावरून त्यांना काय म्हणायचे आहे ते खात्रीने सांगता येत नाही.",
  "p1.cantTell.short": "फक्त या संदेशावरून खात्रीने काही सांगता येत नाही.",
  "p1.fact.request": "त्यांनी तुम्हाला काही मागितले: “{q}”",
  "p1.fact.question": "त्यांनी तुम्हाला एक प्रश्न विचारला: “{q}”",
  "p1.fact.feeling": "ते म्हणाले: “{q}”",
  "p1.fact.apology": "त्यांनी माफी मागितली: “{q}”",
  "p1.fact.boundary": "त्यांनी स्वतःची एक मर्यादा सांगितली: “{q}”",
  "p1.fact.uncertainty": "त्यांनी सांगितले की त्यांना खात्री नाही: “{q}”",
  "p1.fact.event": "काय झाले ते त्यांनी सांगितले: “{q}”",
  "p1.fact.accusation": "त्यांनी तुम्हाला एखाद्या गोष्टीसाठी दोष दिला: “{q}”. दोष न स्वीकारताही तुम्ही काळजीने उत्तर देऊ शकता.",
  "p1.fact.control": "ते तुमच्या एखाद्या खाजगी गोष्टीपर्यंत पोहोचू पाहत आहेत: “{q}”. प्रेमाने उत्तर देतानाही तुम्ही तुमची खाजगी जागा जपू शकता.",
  "p1.fact.pastExpectation": "जे घडले नाही अशा एका गोष्टीचा त्यांनी उल्लेख केला: “{q}”",
  "p1.fact.acknowledgement": "त्यांनी तुमचे म्हणणे मान्य केले: “{q}”",
  "p1.fact.defensive": "त्यांनी स्वतःची बाजू मांडली: “{q}”",
  "p1.today.request": "त्यांनी तुम्हाला सांगितले: “{q}”",
  "p1.today.question": "त्यांनी आज एक प्रश्न विचारला: “{q}”",
  "p1.today.feeling": "त्यांनी आज तुम्हाला सांगितले: “{q}”",
  "p1.today.uncertainty": "त्यांनी सांगितले की त्यांना खात्री नाही: “{q}”",
  "p1.today.apology": "त्यांनी आज माफी मागितली: “{q}”",
  "p1.today.title": "आज",
  "p1.today.notice": "लक्ष देण्यासारखी एक छोटी गोष्ट",
  "p1.ai.why": "का?",
  "p1.ai.hide": "लपवा",
  "p1.ai.askThem": "त्यांना विचारा",
  "p1.ai.basedOn": "फक्त त्यांनी स्पष्टपणे जे सांगितले त्यावर आधारित.",
  "p1.ai.allowOnDevice": "फोनवर मदतीची परवानगी द्या",
  "p1.today.consentBody": "DuoSpace आजच्या संदेशांमधून लक्ष देण्यासारखी एक गोष्ट सांगू शकते — फक्त तुमच्या फोनवर.",
  "p1.today.dismiss": "काढून टाका",
  "p1.understand.consentBody": "या संदेशात काय म्हटले आहे ते DuoSpace तुमच्या फोनवरच सांगू शकते. काहीही पाठवले किंवा साठवले जात नाही.",
  "p1.understand.repairPrompt": "हे सुरळीत करण्यासाठी मदत हवी आहे का?",
  "p1.understand.repair.own": "माझा वाटा मान्य करा",
  "p1.understand.repair.explain": "समजावून सांगा",
  "p1.understand.repair.boundary": "मर्यादा सांगा",
  "p1.understand.repair.walk": "टप्प्याटप्प्याने सांगा",
  "p1.understand.footer": "फक्त संदेशात जे लिहिले आहे तेच — त्यांना काय वाटत आहे ते DuoSpace ला कळू शकत नाही.",
  "p1.understand.cloud.ask": "अधिक बारकाईने पहा (AI सेवा वापरते)",
  "p1.understand.cloud.failed": "आत्ता अधिक बारकाईने पाहता आले नाही. वरील सारांश अजूनही लागू आहे.",
  "p1.understand.cloud.label": "AI सेवेचे वाचन — एक संभाव्य अर्थ, वस्तुस्थिती नाही",
  "p1.understand.cloud.unsure": "या संदेशातून खात्री करता येईल इतके स्पष्ट नसू शकते.",
  "p1.reply.preparing": "उत्तर तयार होत आहे",
  "p1.reply.consentBody": "DuoSpace सुरुवातीला तुमच्या फोनवरच उत्तर सुचवते. तुम्ही AI सेवेला परवानगी देत नाही तोपर्यंत संदेश कुठेही पाठवला जात नाही आणि काहीही सेव्ह होत नाही.",
  "p1.reply.error": "सध्या उत्तर सुचवता आले नाही.",
  "p1.reply.use": "हे उत्तर वापरा",
  "p1.reply.footer": "फक्त वर लिहिलेल्या त्यांच्या शब्दांवर आधारित — त्यांना काय वाटत आहे ते DuoSpace ला कळू शकत नाही. पाठवण्यापूर्वी तुम्ही यात बदल करू शकता.",
  "p1.composer.cancelEdit": "संपादन रद्द करा",
  "p1.composer.cancelVoice": "व्हॉइस रेकॉर्डिंग रद्द करा",
  "p1.composer.sendVoice": "व्हॉइस रेकॉर्डिंग पाठवा",
  "p1.composer.attachments": "अटॅचमेंट",
  "p1.composer.modes": "संदेश मोड",
  "p1.composer.message": "संदेश",
  "p1.composer.saveEdit": "संपादन जतन करा",
  "p1.composer.send": "संदेश पाठवा",
  "p1.composer.holdRecord": "व्हॉइस संदेश रेकॉर्ड करण्यासाठी दाबून ठेवा",
  "p1.reply.cancel": "रद्द करा",
  "p1.reply.retry": "पुन्हा प्रयत्न करा",
  "p1.reply.badge.ai": "AI सेवेने लिहिलेले",
  "p1.reply.badge.device": "तुमच्या फोनवर सुचवलेले",
  "p1.reply.notice.quota": "आजची AI उत्तरे संपली. हे उत्तर तुमच्या फोनवरून आहे.",
  "p1.reply.notice.unavailable": "AI सेवा सध्या उपलब्ध नाही. हे उत्तर तुमच्या फोनवरून आहे.",
  "p1.reply.cloud.title": "अधिक नैसर्गिक उत्तर हवे?",
  "p1.reply.cloud.body": "यात त्यांचा संदेश आणि त्याआधीचे काही संदेश उत्तर लिहिण्यासाठी AI सेवेला पाठवले जातात. इतर काहीही पाठवले जात नाही. प्रक्रिया होत असताना ते एंड-टू-एंड एन्क्रिप्टेड नसते. तुम्ही हे केव्हाही प्रायव्हसी सेटिंग्जमध्ये बंद करू शकता.",
  "p1.reply.cloud.allow": "AI सेवेला परवानगी द्या",
  "p1.reply.cloud.decline": "आत्ता नाही",
  "p1.reply.askDirect": "इथे त्यांना थेट विचारणे कदाचित सर्वात चांगले ठरेल.",
  "p1.reply.chip.askFirst": "आधी विचारा",
  "p1.rel.chatHint": "चॅटमध्ये तुमच्या पार्टनरचा संदेश दाबून धरा → “उत्तर देण्यास मदत” किंवा “समजून घ्या”.",
  "p1.rel.moreTools": "आणखी साधने",
  "p1.rel.hide": "लपवा",
  "p1.rel.moreToolsList": "तुलना · समेट · मेमरी",
  "p1.rel.err.save": "जतन करता आले नाही",
  "p1.rel.err.reflect": "सध्या यावर विचार करता आला नाही",
  "p1.rel.shared": "शेअर केले",
  "p1.rel.err.share": "शेअर करता आले नाही",
  "p1.rel.err.update": "अपडेट करता आले नाही",
  "p1.rel.err.delete": "हटवता आले नाही",
  "p1.rel.err.process": "हे प्रोसेस करता आले नाही",
  "p1.rel.err.feedback": "तुमचा अभिप्राय जतन करता आला नाही",
  "p1.rel.sharingStopped": "शेअरिंग थांबवले",
  "p1.rel.err.withdraw": "मागे घेता आले नाही",
  "p1.rel.notApplicable": "हे माझ्या नात्याला लागू होत नाही",
  "p1.rel.exp.addTitle": "तुम्हाला नाव द्यायची असलेली एखादी गोष्ट जोडा",
  "p1.rel.exp.placeholder": "तुमच्या शब्दांत लिहा…",
  "p1.rel.notRelevant": "आता गरजेचे नाही",
  "p1.rel.exp.empty": "अजून काहीही जोडलेले नाही.",
  "p1.rel.exp.boundaryTitle": "हे मर्यादा म्हणून नोंदवायचे का?",
  "p1.rel.exp.boundaryBody": "मर्यादा म्हणजे तुम्हाला आवश्यक वाटणारी गोष्ट — फक्त आवड नव्हे. हे फक्त तुम्हीच ठरवू शकता.",
  "p1.rel.cancel": "रद्द करा",
  "p1.rel.exp.boundaryYes": "हो, ही माझी मर्यादा आहे",
  "p1.rel.reflect.placeholder": "हवे तितके लिहा…",
  "p1.rel.reflect.keep": "मी लिहिलेले याच डिव्हाइसवर ठेवा",
  "p1.rel.rate": "याला रेटिंग द्या",
  "p1.rel.sharedWithPartner": "पार्टनरसोबत शेअर केले",
  "p1.rel.withdraw": "मागे घ्या",
  "p1.rel.acc.title": "हे किती अचूक होते?",
  "p1.rel.acc.body": "हे फक्त तुमचा स्वतःचा अभिप्राय नोंदवते — यातून काहीही पुन्हा ट्रेन होत नाही.",
  "p1.rel.acc.correct": "अचूक",
  "p1.rel.acc.partly": "काही प्रमाणात अचूक",
  "p1.rel.acc.not": "अचूक नाही",
  "p1.rel.shareDlg.title": "पार्टनरसोबत शेअर करायचे?",
  "p1.rel.shareDlg.body": "त्यांना नेमके हेच दिसेल — त्यापेक्षा जास्त काही नाही.",
  "p1.rel.shareThis": "हे शेअर करा",
  "p1.rel.share": "शेअर करा",
  "p1.rel.notSure": "खात्री नाही",
  "p1.rel.preferNot": "उत्तर द्यायचे नाही",
  "p1.rel.val.reflect": "माझ्या उत्तरांवर विचार करा",
  "p1.rel.exp.reflect": "यावर विचार करा",
  "p1.rel.reflect.reflect": "यावर विचार करा",
  "p1.rel.reflect.note": "हे फक्त तुम्ही इथे लिहिलेल्या गोष्टींचे विश्लेषण करते. तुमच्या पार्टनरचे कधीही विश्लेषण होत नाही, आणि तुमच्यात खरोखर काय घडले याबद्दल कोणताही दावा केला जात नाही — फक्त तुम्ही जे सांगितले तेच.",
  "p1.rel.insights.empty": "अजून काही नाही. मूल्ये किंवा अपेक्षांमधील काही प्रश्नांची उत्तरे द्या, किंवा काही लिहा, मग “विचार करा” दाबा.",
  "p1.rel.err.generic": "काहीतरी चुकले. काहीही जतन किंवा पाठवले गेले नाही.",
});
