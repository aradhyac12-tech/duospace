/**
 * Multilingual semantic normalization (spec §19).
 *
 * Maps meaning, not words: English, Hinglish, Hindi, Marathi (Devanagari and
 * Romanized) → structured semantic items. Deterministic lexicon matching is
 * the baseline; an AI extractor (aiAdapter.ts) may propose additional items
 * but they pass through the SAME validation and stay `inferred`.
 *
 * Hard rules:
 *  - Output is always `inferred` until the user confirms it (confirmDraft()).
 *  - An explicit negation of X is recorded as "X explicit = false"; it is NEVER
 *    rewritten into a positive claim ("does not want breakup" is not produced
 *    — only `breakup_intent_explicit=false`).
 *  - Never emits mind-reading attributes (see FORBIDDEN_ATTRIBUTE_KEYS).
 *  - `originalText` is returned to the caller for on-device use only; it must
 *    not be persisted, logged or sent to analytics (privacy rule §29).
 *  - Reuses the app's existing detectLanguage + safety lexicons; adds only
 *    Romanized-Marathi detection and semantic patterns.
 */
import { detectLanguage, multilingualSafetyCategories, type RelLang } from "../i18n/lang";
import { checkSafety } from "../repair/machine";
import type { SafetyCategory } from "../repair/types";
import type { SafetyIndicator, SafetySignal } from "./safety";
import type { AttrValue, Observation } from "./types";

export type NormScript = "latin" | "devanagari" | "other_indic" | "none";
export type NormLang = RelLang | "hinglish" | "mr-latn";

export interface SemanticItem {
  constructId: string;
  attributeKey: string;
  value: AttrValue;
  /** Who the statement is about, from the writer's point of view. */
  about: "self" | "partner" | "dyad";
  /** Which lexicon rule produced it (for audit; never the text itself). */
  pattern: string;
}

export interface NormalizedText {
  originalText: string; // caller-local; never persist/log
  detectedLanguage: NormLang;
  script: NormScript;
  semantics: SemanticItem[];
  safetyCategories: SafetyCategory[];
  safetySignals: SafetySignal[];
  confidence: number; // 0..0.6: lexicon extraction is deliberately modest
  /** Always true when semantics exist: nothing here is user-confirmed. */
  needsConfirmation: boolean;
  /** Language outside the lexicon coverage → less reliable. */
  limited: boolean;
}

/** Attribute keys that would be psychological mind-reading. Rejected everywhere. */
export const FORBIDDEN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "love", "lack_of_love", "loves", "does_not_love", "cheating", "infidelity", "emotional_distance", "narcissism", "narcissist",
  "avoidant_attachment", "anxious_attachment", "attachment_style", "manipulation", "manipulative", "loss_of_interest", "losing_interest",
  "breakup_intention", "will_break_up", "diagnosis", "depression", "bpd", "psychological_diagnosis", "gaslighting",
]);
export const isForbiddenAttribute = (k: string): boolean => FORBIDDEN_ATTRIBUTE_KEYS.has(k.toLowerCase());

// ── language ────────────────────────────────────────────────────────────────

const MR_LATN = /\b(mala|tula|tumhi|pahije|paahije|nako|aahe|ahe|aahes|karaycha|karaychay|karaychi|nahi\s+karaycha|kaay|zala|jhala|majha|majhi|mazi|aapan|aamhi|baghto|baghte|thoda\s+vel)\b/gi;
const HI_LATN = /\b(mujhe|mujhko|chahiye|karna|karni|hai|hain|nahi|nahin|thoda|bahut|yaar|tum|tumhe|mera|meri|kyun|kab|kaise)\b/gi;

export function detectNormLanguage(text: string): { lang: NormLang; script: NormScript } {
  const t = text ?? "";
  const d = detectLanguage(t);
  if (d.script === "indic") return { lang: d.lang, script: /[\u0900-\u097F]/.test(t) ? "devanagari" : "other_indic" };
  const mr = (t.match(MR_LATN) ?? []).length;
  const hi = (t.match(HI_LATN) ?? []).length;
  const words = Math.max(1, t.trim().split(/\s+/).length);
  if (mr >= 2 && mr >= hi) return { lang: "mr-latn", script: "latin" };
  if (d.romanizedHindi || (hi >= 2 && hi / words >= 0.2)) return { lang: "hinglish", script: "latin" };
  return { lang: "en", script: t.trim() ? "latin" : "none" };
}

// ── semantic lexicon ────────────────────────────────────────────────────────

interface Pat { id: string; re: RegExp; item: Omit<SemanticItem, "pattern"> }
const P = (id: string, re: RegExp, item: Omit<SemanticItem, "pattern">): Pat => ({ id, re, item });
const U = "iu";

const PATTERNS: Pat[] = [
  // wants space (English · Hinglish · Romanized Marathi · Hindi · Marathi)
  P("space.en.self", new RegExp("\\bi\\s+(need|want)\\s+(some|a bit of|a little)?\\s*space\\b|\\bgive me (some )?space\\b", U), { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "self" }),
  P("space.en.partner", new RegExp("\\b(he|she|they)\\s+(need|needs|want|wants)\\s+(some|a bit of|a little)?\\s*space\\b", U), { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "partner" }),
  P("space.hinglish", new RegExp("\\b(thoda\\s+)?space\\s+(chahiye|chahie|chahiye\\s+mujhe)\\b|\\bmujhe\\s+(thoda\\s+)?space\\b", U), { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "self" }),
  P("space.mr-latn", new RegExp("\\b(thoda\\s+|thodi\\s+)?space\\s+(pahije|paahije|hava)\\b|\\bmala\\s+(thoda\\s+)?space\\b", U), { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "self" }),
  P("space.hi", /(थोड़ा|थोड़ी|थोडा|थोडी)?\s*(स्पेस|जगह)\s*(चाहिए|चाहिये|हवा|पाहिजे)/u, { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "self" }),
  P("space.mr", /(स्पेस|जागा)\s*(पाहिजे|हवी|हवं|हवे|हवा)/u, { constructId: "relationship_direction", attributeKey: "wants_space", value: true, about: "self" }),
  // explicit denial of ending the relationship — recorded as a denial, never as a positive claim
  P("nobreakup.en", new RegExp("\\b(not|n't|no)\\s+(want\\s+to\\s+|going\\s+to\\s+|wanting\\s+to\\s+)?(break\\s?up|breaking\\s?up|breakup)\\b|\\bdon'?t want (to |a )?break\\s?up\\b", U), { constructId: "relationship_direction", attributeKey: "breakup_intent_explicit", value: false, about: "self" }),
  P("nobreakup.latn", new RegExp("\\bbreak\\s?up\\s+(nahi|nahin|nako)\\b", U), { constructId: "relationship_direction", attributeKey: "breakup_intent_explicit", value: false, about: "self" }),
  P("nobreakup.deva", /(ब्रेकअप|ब्रेक अप)\s*(नहीं|नही|नाही|नको)/u, { constructId: "relationship_direction", attributeKey: "breakup_intent_explicit", value: false, about: "self" }),
  P("yesbreakup.en", new RegExp("\\bi\\s+(want|wanna)\\s+to\\s+break\\s?up\\b|\\blet'?s\\s+break\\s?up\\b", U), { constructId: "relationship_direction", attributeKey: "breakup_intent_explicit", value: true, about: "self" }),
  // communication preferences (stated preference, not behaviour)
  P("rhythm.fs.en", new RegExp("\\b(prefer|like|love)s?\\s+(frequent|many|lots of)\\s+(short|quick|small)\\b|\\bprefer\\s+(short|quick)\\s+(and\\s+)?frequent\\b", U), { constructId: "communication_preferences", attributeKey: "rhythm", value: "frequent_short", about: "self" }),
  P("rhythm.il.en", new RegExp("\\b(prefer|like|love)s?\\s+(fewer|less)\\b.{0,25}\\b(longer|long|deeper)\\b|\\bprefer\\s+(long|longer)\\s+(conversations?|calls?|talks?)\\b", U), { constructId: "communication_preferences", attributeKey: "rhythm", value: "infrequent_long", about: "self" }),
  P("rhythm.fs.latn", new RegExp("\\b(chhote|chote|lahan)\\s+(chhote|chote|lahan)?\\s*(messages?|msgs?|chat)\\b.{0,20}\\b(pasand|avadta|avadte|chahiye|pahije)\\b|\\bpasand\\s+hai\\s+(chhote|chote)\\b", U), { constructId: "communication_preferences", attributeKey: "rhythm", value: "frequent_short", about: "self" }),
  P("rhythm.il.latn", new RegExp("\\b(kam|kami|thodi)\\b.{0,15}\\b(lambi|lamba|lambe|motha|mothi)\\s+(baat|baatein|gappa|gappa|calls?)\\b|\\blambi\\s+baat\\s+pasand\\b", U), { constructId: "communication_preferences", attributeKey: "rhythm", value: "infrequent_long", about: "self" }),
  // observed behaviour reported about the partner — recorded as a behaviour, NEVER as a motive
  P("replylate.en", new RegExp("\\b(he|she|they)\\s+(replies|responds|answers)\\s+(late|slowly)\\b|\\b(slow|late)\\s+(to\\s+)?repl(y|ies)\\b", U), { constructId: "digital_communication", attributeKey: "reply_latency", value: "slow", about: "partner" }),
  P("fewtexts.en", new RegExp("\\b(he|she|they)\\s+(doesn'?t|does not|don'?t)\\s+text\\s+(much|a lot|often)\\b", U), { constructId: "digital_communication", attributeKey: "texting_frequency", value: "low", about: "partner" }),
  P("attentive.en", new RegExp("\\b(attentive|caring|present|warm)\\s+in\\s+person\\b|\\bis\\s+(very\\s+)?attentive\\s+in\\s+person\\b", U), { constructId: "partner_responsiveness", attributeKey: "in_person_attentive", value: true, about: "partner" }),
  // feeling understood
  P("understood.pos.en", new RegExp("\\bi\\s+feel\\s+(heard|understood|cared for)\\b", U), { constructId: "partner_responsiveness", attributeKey: "feels_understood", value: true, about: "self" }),
  P("understood.neg.en", new RegExp("\\bi\\s+(don'?t|do not|never)\\s+feel\\s+(heard|understood)\\b|\\bfeel\\s+unheard\\b", U), { constructId: "partner_responsiveness", attributeKey: "feels_understood", value: false, about: "self" }),
];

// ── safety text → indicators (reuses existing multilingual checks) ──────────

const CAT_TO_INDICATOR: Record<SafetyCategory, SafetyIndicator> = {
  THREAT_OR_VIOLENCE: "physical_violence", STALKING_OR_MONITORING: "monitoring_phone", COERCION_OR_CONTROL: "psychological_aggression",
  SEXUAL_COERCION: "sexual_coercion", SELF_HARM_THREAT_AS_CONTROL: "psychological_aggression", THREAT_TO_CHILDREN_OR_PETS: "threat_to_children_or_pets",
  ISOLATION: "isolation", FINANCIAL_COERCION: "financial_control", BLACKMAIL: "blackmail", IMMEDIATE_DANGER: "imminent_danger",
  CHECK_FAILED: "fear_for_safety",
};
// Supplement: "gets angry when I talk to friends" is not covered by the existing English set.
const ANGER_AT_FRIENDS = new RegExp("\\b(gets?|got|becomes?|turns?)\\s+(angry|mad|furious|upset)\\s+(if|when|whenever)\\s+i\\s+(talk|speak|text|meet|hang out)\\w*\\s+(to|with)?\\s*(my\\s+)?(friends?|family|anyone|others?)\\b", U);
const FIRST_PERSON = /\b(me|my|mine|i|i'm|i've|mujhe|mujhko|mera|meri|mere|mala|majha|majhi|mazi)\b|मुझे|मेरा|मेरी|मेरे|मला|माझ|माझी/iu;

export function extractSafetySignals(text: string): { categories: SafetyCategory[]; signals: SafetySignal[] } {
  const categories = new Set<SafetyCategory>();
  for (const c of checkSafety({ whatHappened: text } as never).categories) categories.add(c);
  for (const c of multilingualSafetyCategories(text)) categories.add(c);
  const extra: SafetyIndicator[] = ANGER_AT_FRIENDS.test(text) ? ["anger_at_friend_contact"] : [];
  const firstPerson = FIRST_PERSON.test(text);
  const signals: SafetySignal[] = [
    ...[...categories].map((c) => ({ indicator: CAT_TO_INDICATOR[c], firstPerson: c === "CHECK_FAILED" ? false : firstPerson, confirmedByReporter: false, fromText: true })),
    ...extra.map((indicator) => ({ indicator, firstPerson, confirmedByReporter: false, fromText: true })),
  ];
  return { categories: [...categories], signals };
}

// ── main entry ──────────────────────────────────────────────────────────────

export function normalizeText(text: string): NormalizedText {
  const raw = (text ?? "").normalize("NFC");
  const { lang, script } = detectNormLanguage(raw);
  const semantics: SemanticItem[] = [];
  for (const p of PATTERNS) if (p.re.test(raw) && !semantics.some((s) => s.constructId === p.item.constructId && s.attributeKey === p.item.attributeKey)) {
    if (isForbiddenAttribute(p.item.attributeKey)) continue; // belt and braces
    semantics.push({ ...p.item, pattern: p.id });
  }
  const safety = extractSafetySignals(raw);
  const limited = !(["en", "hinglish", "mr-latn", "hi", "mr"] as string[]).includes(lang);
  return {
    originalText: raw, detectedLanguage: lang, script, semantics, safetyCategories: safety.categories, safetySignals: safety.signals,
    confidence: semantics.length ? (limited ? 0.25 : 0.5) : 0, needsConfirmation: semantics.length > 0, limited,
  };
}

// ── drafts → observations ───────────────────────────────────────────────────

export interface DraftContext {
  relationshipId: string; writerUserId: string; partnerUserId: string; now: Date; idFactory: () => string; sourceReference?: string;
}

/** An INFERRED observation. Never explicit, never self_report — even when the writer said it about themself. */
export function draftToObservation(s: SemanticItem, ctx: DraftContext, conf = 0.5): Observation {
  if (isForbiddenAttribute(s.attributeKey)) throw new Error(`forbidden attribute ${s.attributeKey}`);
  const subject = s.about === "self" ? ctx.writerUserId : s.about === "partner" ? ctx.partnerUserId : null;
  const writerIsA = ctx.writerUserId < ctx.partnerUserId;
  const subj = subject === null ? "dyad" : subject === ctx.writerUserId ? (writerIsA ? "A_to_A" : "B_to_B") : (writerIsA ? "A_to_B" : "B_to_A");
  const iso = ctx.now.toISOString();
  return {
    observationId: ctx.idFactory(), relationshipId: ctx.relationshipId, observerUserId: ctx.writerUserId, subjectUserId: subject,
    targetUserId: s.about === "partner" ? ctx.partnerUserId : null, constructId: s.constructId, attributeKey: s.attributeKey, value: s.value,
    sourceType: "inferred", evidenceTier: "inferred", sourceReference: ctx.sourceReference, confidence: Math.min(conf, 0.5), explicitness: "implicit",
    temporalScope: "current", perspective: subj as Observation["perspective"], confirmationStatus: "unconfirmed", validFrom: iso, observedAt: iso,
  };
}

/**
 * The ONLY way an extracted item becomes explicit evidence: the writer confirms
 * a statement ABOUT THEMSELF. Creates a NEW observation (history is kept).
 * Statements about the partner can only ever become partner reports.
 */
export function confirmDraft(s: SemanticItem, ctx: DraftContext, conf = 0.8): Observation {
  const base = draftToObservation(s, ctx, conf);
  if (s.about === "self") return { ...base, sourceType: "self_report", evidenceTier: "explicit_self_report", explicitness: "explicit", confidence: conf, confirmationStatus: "confirmed", lastConfirmedAt: base.observedAt };
  if (s.about === "partner") return { ...base, sourceType: "partner_report", evidenceTier: "unconfirmed_partner_report", explicitness: "explicit", confidence: Math.min(conf, 0.5), confirmationStatus: "unconfirmed" };
  return { ...base, sourceType: "self_report", evidenceTier: "explicit_self_report", explicitness: "explicit", confidence: conf, confirmationStatus: "confirmed", subjectUserId: null, perspective: "dyad" };
}
