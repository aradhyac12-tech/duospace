/**
 * Contextual communication-fact extraction — the single, deterministic source
 * of truth for "Help me reply", "Understand" and the Today insight.
 *
 * Contract: a fact exists ONLY if a pattern matched text the sender actually
 * wrote. Every fact carries the source message id and the exact phrase +
 * [start, end) span, so anything shown can be traced back. Nothing about
 * hidden feelings, intent, personality, timing or the relationship is ever
 * produced here. Non-English text gets only script-independent facts
 * (a question mark) plus the multilingual safety lexicon; everything else is
 * UNKNOWN ("can't reliably tell").
 *
 * Runs on-device, pure, no I/O. Results can be cached in memory by
 * message id + content hash (see cache below) — never persisted.
 */
import { PATTERNS, DOMAIN_PATTERNS, type Domain } from "./patterns";
import { detectLanguage } from "../i18n/lang";
import { checkSafety } from "../repair/machine";
import type { SafetyCategory } from "../repair/types";

export const EXTRACTOR_VERSION = "contextual-extract-v1";

export type FactKind = "REQUEST" | "QUESTION" | "FEELING" | "APOLOGY" | "BOUNDARY" | "UNCERTAINTY" | "EVENT" | "ACCUSATION" | "CONTROL" | "PAST_EXPECTATION" | "ACKNOWLEDGEMENT" | "DEFENSIVE";

export interface Fact {
  kind: FactKind;
  /** Exact substring of the message. */
  phrase: string;
  span: [number, number];
  sourceMessageId: string;
  rule: string;
  /** The object of a request/expectation (e.g. "ask how I was"), also an exact substring at detailSpan. */
  detail?: string;
  detailSpan?: [number, number];
}

export interface Extraction {
  sourceMessageId: string;
  contentHash: string;
  language: string;
  facts: Fact[];
  safetySignals: SafetyCategory[];
  /** Deterministic: REQUEST > QUESTION > EXPRESSION (stated feeling) > ACKNOWLEDGEMENT > UNKNOWN. Safety is reported separately in safetySignals and always handled first by consumers. */
  primaryIntent: "QUESTION" | "REQUEST" | "EXPRESSION" | "ACKNOWLEDGEMENT" | "UNKNOWN";
  /** Topic of the request object, else of the whole message (first matching domain), else null. */
  domain: Domain | null;
  /** Very short message (≤3 words) with no explicit request or stated feeling. */
  ambiguous: boolean;
  /** HIGH: at least one explicit fact of a primary kind. LOW: only weak/indirect facts. NONE: nothing reliable. */
  confidence: "HIGH" | "LOW" | "NONE";
  extractorVersion: string;
}

export interface SourceMessage { id: string; text: string | null | undefined }

// Patterns that exist only here (not in the responsiveness engine).
const APOLOGY = /\b(i'?m\s+(?:really\s+|so\s+)?sorry|i\s+apologi[sz]e|my\s+bad|i\s+was\s+wrong|forgive\s+me)\b[^.!?]*/i;
const BOUNDARY = /\b(i\s+(?:don'?t|do\s+not)\s+want\s+(?:you\s+)?to|i'?m\s+not\s+(?:comfortable|okay|ok)\s+with|please\s+don'?t|don'?t\s+(?:ever\s+)?(?:call|text|touch|shout|yell|talk\s+to\s+me)|i\s+need\s+(?:some\s+)?(?:space|time\s+alone|time\s+to\s+myself))\b[^.!?]*/i;
const UNCERTAINTY = /\b(i\s+(?:don'?t|do\s+not)\s+(?:know|understand|get\s+it)|i'?m\s+(?:not\s+sure|confused)|what\s+do\s+you\s+mean)\b[^.!?]*/i;
const EVENT = /\b(?:you|i|we)\s+(?:cancelled|canceled|forgot|missed|left|came\s+home|were\s+late|was\s+late|didn'?t\s+(?:call|reply|text|come|show\s+up)|said|told)\b[^.!?]*/i;
const QUESTION_SENTENCE = /[^.!?\n]*\?/g;

/** Small non-cryptographic hash: cache key only (content change ⇒ new key). */
export function contentHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function add(out: Fact[], text: string, m: RegExpMatchArray | null, kind: FactKind, rule: string, id: string) {
  if (!m || m.index === undefined) return;
  const phrase = m[0].trim().replace(/[,;:\s]+$/, "");
  if (phrase.length < 3) return;
  const start = text.indexOf(phrase, m.index);
  if (start < 0) return;
  if (out.some((f) => f.span[0] === start && f.kind === kind)) return;
  const fact: Fact = { kind, phrase, span: [start, start + phrase.length], sourceMessageId: id, rule };
  const group = m.slice(1).find((g) => typeof g === "string" && g.trim());
  if (group) {
    const d = group.trim().replace(/[.!?…\s]+$/, "");
    const ds = text.indexOf(d, start);
    if (d && ds >= 0) { fact.detail = d; fact.detailSpan = [ds, ds + d.length]; }
  }
  out.push(fact);
}

const PRIMARY: FactKind[] = ["REQUEST", "QUESTION", "FEELING", "APOLOGY", "BOUNDARY", "UNCERTAINTY"];

export function extractFacts(msg: SourceMessage, opts: { englishRules?: boolean } = {}): Extraction {
  const text = (msg.text ?? "").normalize("NFC").slice(0, 2000);
  const base: Extraction = { sourceMessageId: msg.id, contentHash: contentHash(text), language: "en", facts: [], safetySignals: [], confidence: "NONE", extractorVersion: EXTRACTOR_VERSION, primaryIntent: "UNKNOWN", domain: null, ambiguous: true };
  if (!text.trim()) return base;
  const lang = detectLanguage(text).lang;
  // The ONE shared safety gate (English patterns + all 12 lexicons; fails closed).
  const gate = checkSafety({ concreteEvent: text });
  const safetySignals = gate.status === "CONCERN" ? gate.categories : [];
  const facts: Fact[] = [];

  // Script-independent: explicit questions (any language).
  for (const q of text.matchAll(QUESTION_SENTENCE)) {
    const raw = q[0];
    const lead = raw.length - raw.trimStart().length;
    const phrase = raw.trim();
    // "?" / "??" / "ok?" carry no reliable content.
    if (phrase.replace(/[?\s]/g, "").length < 4 || phrase.split(/\s+/).length < 2) continue;
    const start = (q.index ?? 0) + lead;
    facts.push({ kind: "QUESTION", phrase, span: [start, start + phrase.length], sourceMessageId: msg.id, rule: "question-mark" });
  }

  if (lang === "en" || opts.englishRules) {
    add(facts, text, text.match(PATTERNS.PAST_WISH), "REQUEST", "past-wish", msg.id);
    const fut = text.match(PATTERNS.FUTURE_REQ);
    add(facts, text, fut, "REQUEST", fut?.[1] ? "future-we" : "future-request", msg.id);
    add(facts, text, text.match(PATTERNS.PAST_MISS), "PAST_EXPECTATION", "past-miss", msg.id);
    add(facts, text, text.match(PATTERNS.ACK), "ACKNOWLEDGEMENT", "acknowledgement", msg.id);
    add(facts, text, text.match(PATTERNS.DEFENSIVE), "DEFENSIVE", "defensive", msg.id);
    add(facts, text, text.match(PATTERNS.STATED_FEELING), "FEELING", "stated-feeling", msg.id);
    add(facts, text, text.match(APOLOGY), "APOLOGY", "apology", msg.id);
    add(facts, text, text.match(BOUNDARY), "BOUNDARY", "boundary", msg.id);
    add(facts, text, text.match(UNCERTAINTY), "UNCERTAINTY", "uncertainty", msg.id);
    add(facts, text, text.match(EVENT), "EVENT", "event", msg.id);
    add(facts, text, text.match(PATTERNS.ACCUSATION), "ACCUSATION", "accusation", msg.id);
    add(facts, text, text.match(PATTERNS.CONTROL), "CONTROL", "control", msg.id);
  }
  // Every fact must be an exact substring at its span (auditable provenance).
  const grounded = facts.filter((f) => text.slice(f.span[0], f.span[1]) === f.phrase);
  const confidence = grounded.some((f) => PRIMARY.includes(f.kind)) ? "HIGH" : grounded.length ? "LOW" : "NONE";
  const byRule = (r: string) => grounded.find((f) => f.rule === r);
  const requestObj = (byRule("past-wish") ?? byRule("future-we") ?? byRule("future-request") ?? byRule("past-miss"))?.detail ?? null;
  const feeling = byRule("stated-feeling");
  const words = text.replace(/\s+/g, " ").trim().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  const ambiguous = words.length <= 3 && !requestObj && !feeling;
  const domain = (requestObj && DOMAIN_PATTERNS.find((d) => d.re.test(requestObj))?.id) || DOMAIN_PATTERNS.find((d) => d.re.test(text))?.id || null;
  const has = (k: FactKind) => grounded.some((f) => f.kind === k);
  const primaryIntent = has("REQUEST") ? "REQUEST" : has("QUESTION") ? "QUESTION" : has("FEELING") ? "EXPRESSION" : has("ACKNOWLEDGEMENT") ? "ACKNOWLEDGEMENT" : "UNKNOWN";
  return { ...base, language: lang, facts: grounded, safetySignals, confidence, primaryIntent, domain, ambiguous };
}

// ── in-memory cache (never persisted; keyed by id + content hash) ──────────
const cache = new Map<string, Extraction>();
export function extractCached(msg: SourceMessage): Extraction {
  const key = `${msg.id}:${contentHash((msg.text ?? "").normalize("NFC").slice(0, 2000))}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = extractFacts(msg);
  if (cache.size > 500) cache.clear();
  cache.set(key, r);
  return r;
}
export const clearExtractionCache = () => cache.clear();

/** Ranking for a single insight: request > question > feeling > uncertainty(clarification) > apology. */
export const RANK: FactKind[] = ["REQUEST", "QUESTION", "FEELING", "UNCERTAINTY", "APOLOGY", "BOUNDARY"];
export const topFact = (e: Extraction): Fact | null => {
  for (const k of RANK) { const f = e.facts.find((x) => x.kind === k); if (f) return f; }
  return null;
};
