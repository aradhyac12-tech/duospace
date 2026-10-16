/**
 * Presentation of grounded facts — Understand card, reply intents, Today insight.
 * Every statement is a fixed template around the sender's EXACT words; each
 * result carries a provenance object. If nothing is reliably grounded, the
 * answer is "I can't reliably tell…" — never a guess.
 */
import { tr } from "../../i18n";
import { findProhibitedContent } from "../../ai/outputValidator";
import { extractCached, topFact, EXTRACTOR_VERSION, type Extraction, type Fact, type FactKind } from "./extract";

export interface Provenance {
  sourceMessageIds: string[];
  phrases: string[];
  spans: [number, number][];
  rule: string;
  extractorVersion: string;
  createdAt: string;
  confidence: Extraction["confidence"];
  basis: "EXPLICIT" | "UNKNOWN";
}

/** English canonical text (kept for callers/tests); display paths use tr("p1.cantTell.full"). */
export const CANT_TELL = "I can't reliably tell what they mean from this message alone.";

/** Internal fact kind → i18n key. Classifier names never reach the UI; the exact quote is passed as {q}. */
const FACT_KEY: Record<FactKind, string> = {
  REQUEST: "p1.fact.request", QUESTION: "p1.fact.question", FEELING: "p1.fact.feeling", APOLOGY: "p1.fact.apology",
  BOUNDARY: "p1.fact.boundary", UNCERTAINTY: "p1.fact.uncertainty", EVENT: "p1.fact.event", ACCUSATION: "p1.fact.accusation",
  CONTROL: "p1.fact.control", PAST_EXPECTATION: "p1.fact.pastExpectation", ACKNOWLEDGEMENT: "p1.fact.acknowledgement", DEFENSIVE: "p1.fact.defensive",
};
const TEMPLATE = (k: FactKind) => (q: string) => tr(FACT_KEY[k], { q });
const cantTellShort = () => tr("p1.cantTell.short");
const UNDERSTAND_ORDER: FactKind[] = ["REQUEST", "QUESTION", "FEELING", "APOLOGY", "BOUNDARY", "UNCERTAINTY", "CONTROL", "PAST_EXPECTATION", "ACCUSATION", "EVENT", "ACKNOWLEDGEMENT", "DEFENSIVE"];

const prov = (e: Extraction, facts: Fact[], nowMs: number): Provenance => ({
  sourceMessageIds: [...new Set(facts.map((f) => f.sourceMessageId))].concat(facts.length ? [] : [e.sourceMessageId]),
  phrases: facts.map((f) => f.phrase), spans: facts.map((f) => f.span),
  rule: facts.map((f) => f.rule).join("+") || "none", extractorVersion: EXTRACTOR_VERSION,
  createdAt: new Date(nowMs).toISOString(), confidence: e.confidence, basis: facts.length ? "EXPLICIT" : "UNKNOWN",
});

/** DuoSpace's own words (outside the quote) must pass the shared safety rules. */
const safeTemplate = (s: string) => findProhibitedContent(s.replace(/“[^”]*”/g, " ")).length === 0;

export interface Understanding { statement: string; why: string[]; safety: boolean; provenance: Provenance }

export function understand(msg: { id: string; text: string | null | undefined }, nowMs = Date.now()): Understanding {
  const e = extractCached(msg);
  if (e.safetySignals.length) return { statement: "", why: [], safety: true, provenance: prov(e, [], nowMs) };
  const f = UNDERSTAND_ORDER.map((k) => e.facts.find((x) => x.kind === k)).find(Boolean) ?? null;
  if (!f) return { statement: cantTellShort(), why: [], safety: false, provenance: prov(e, [], nowMs) };
  const statement = TEMPLATE(f.kind)(f.phrase);
  if (!safeTemplate(statement)) return { statement: cantTellShort(), why: [], safety: false, provenance: prov(e, [], nowMs) };
  return { statement, why: [f.phrase], safety: false, provenance: prov(e, [f], nowMs) };
}

/** Reply intents derived from what was explicitly said (max 3). The engine option each maps to. */
export interface ReplyIntent { id: "ACK" | "RESPOND" | "EXPLAIN" | "ASK_FIRST" | "RESPECT"; label: string }
export function replyIntents(e: Extraction): { intents: ReplyIntent[]; fallback: string | null } {
  if (e.confidence === "NONE") return { intents: [{ id: "ASK_FIRST", label: tr("p1.intent.askMean") }], fallback: tr("p1.cantTell.full") };
  const out: ReplyIntent[] = [];
  const has = (k: FactKind) => e.facts.some((f) => f.kind === k);
  if (has("FEELING") || has("APOLOGY")) out.push({ id: "ACK", label: has("APOLOGY") ? tr("p1.intent.ackApology") : tr("p1.intent.ack") });
  if (has("REQUEST") || has("QUESTION")) out.push({ id: "RESPOND", label: has("REQUEST") ? tr("p1.intent.respondAsk") : tr("p1.intent.replyQ") });
  if (has("BOUNDARY")) out.push({ id: "RESPECT", label: tr("p1.intent.respect") });
  if (has("ACCUSATION") || has("EVENT")) out.push({ id: "EXPLAIN", label: tr("p1.intent.explain") });
  out.push({ id: "ASK_FIRST", label: tr("p1.intent.askFirst") });
  if (!out.some((i) => i.id === "ACK" || i.id === "RESPOND")) out.unshift({ id: "ACK", label: tr("p1.intent.ack") });
  return { intents: out.slice(0, 3), fallback: e.confidence === "LOW" ? tr("p1.cantTell.full") : null };
}
export const offersRepair = (e: Extraction) => e.facts.some((f) => f.kind === "ACCUSATION" || f.kind === "EVENT");

// ── Today: one insight from today's local messages, or nothing ────────────
export interface LocalMsg { id: string; sender_id: string; created_at: string; message_type?: string | null; decryptedContent?: string | null }
export interface TodayInsight { statement: string; messageId: string; phrase: string; provenance: Provenance }

const TODAY_KEY: Partial<Record<FactKind, string>> = {
  REQUEST: "p1.today.request", QUESTION: "p1.today.question", FEELING: "p1.today.feeling", UNCERTAINTY: "p1.today.uncertainty", APOLOGY: "p1.today.apology",
};

/**
 * Conservative: only the partner's text messages from the local calendar day,
 * at most the 200 most recent; only HIGH-confidence explicit facts of the
 * ranked kinds; never ranks on timing, length, punctuation or counts; a
 * message with any safety signal is never turned into an insight.
 */
export function selectTodayInsight(messages: LocalMsg[], opts: { me: string; partner: string; nowMs: number; dismissed?: ReadonlySet<string> }): TodayInsight | null {
  const start = new Date(opts.nowMs); start.setHours(0, 0, 0, 0);
  const todays = messages
    .filter((m) => m.sender_id === opts.partner && (m.message_type ?? "text") === "text" && m.decryptedContent && Date.parse(m.created_at) >= start.getTime() && Date.parse(m.created_at) <= opts.nowMs)
    .slice(-200);
  let best: { rank: number; at: number; m: LocalMsg; f: Fact; e: Extraction } | null = null;
  for (const m of todays) {
    if (opts.dismissed?.has(m.id)) continue;
    const e = extractCached({ id: m.id, text: m.decryptedContent });
    if (e.confidence !== "HIGH" || e.safetySignals.length) continue;
    const f = topFact(e);
    if (!f || !TODAY_KEY[f.kind] || f.phrase.split(/\s+/).length < 3) continue;
    const rank = ["REQUEST", "QUESTION", "FEELING", "UNCERTAINTY", "APOLOGY"].indexOf(f.kind);
    const at = Date.parse(m.created_at);
    if (!best || rank < best.rank || (rank === best.rank && at > best.at)) best = { rank, at, m, f, e };
  }
  if (!best) return null;
  const statement = tr(TODAY_KEY[best.f.kind]!, { q: best.f.phrase });
  if (!safeTemplate(statement)) return null;
  return { statement, messageId: best.m.id, phrase: best.f.phrase, provenance: prov(best.e, [best.f], opts.nowMs) };
}
