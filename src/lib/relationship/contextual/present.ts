/**
 * Presentation of grounded facts — Understand card, reply intents, Today insight.
 * Every statement is a fixed template around the sender's EXACT words; each
 * result carries a provenance object. If nothing is reliably grounded, the
 * answer is "I can't reliably tell…" — never a guess.
 */
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

export const CANT_TELL = "I can't reliably tell what they mean from this message alone.";

const TEMPLATE: Record<FactKind, (q: string) => string> = {
  REQUEST: (q) => `They asked: “${q}”`,
  QUESTION: (q) => `They asked you a question: “${q}”`,
  FEELING: (q) => `They said: “${q}”`,
  APOLOGY: (q) => `They apologised: “${q}”`,
  BOUNDARY: (q) => `They set a limit: “${q}”`,
  UNCERTAINTY: (q) => `They said they're unsure: “${q}”`,
  EVENT: (q) => `They described what happened: “${q}”`,
  ACCUSATION: (q) => `This message includes a blaming phrase: “${q}”. You don't have to accept blame to reply with care.`,
  CONTROL: (q) => `This message asks for access to your private things: “${q}”. You can respond kindly and still keep your privacy.`,
  PAST_EXPECTATION: (q) => `They mentioned something that didn't happen: “${q}”`,
  ACKNOWLEDGEMENT: (q) => `They acknowledged you: “${q}”`,
  DEFENSIVE: (q) => `They explained their side: “${q}”`,
};
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
  if (!f) return { statement: CANT_TELL.replace("what they mean ", ""), why: [], safety: false, provenance: prov(e, [], nowMs) };
  const statement = TEMPLATE[f.kind](f.phrase);
  if (!safeTemplate(statement)) return { statement: CANT_TELL.replace("what they mean ", ""), why: [], safety: false, provenance: prov(e, [], nowMs) };
  return { statement, why: [f.phrase], safety: false, provenance: prov(e, [f], nowMs) };
}

/** Reply intents derived from what was explicitly said (max 3). The engine option each maps to. */
export interface ReplyIntent { id: "ACK" | "RESPOND" | "EXPLAIN" | "ASK_FIRST" | "RESPECT"; label: string }
export function replyIntents(e: Extraction): { intents: ReplyIntent[]; fallback: string | null } {
  if (e.confidence === "NONE") return { intents: [{ id: "ASK_FIRST", label: "Ask what they mean" }], fallback: CANT_TELL };
  const out: ReplyIntent[] = [];
  const has = (k: FactKind) => e.facts.some((f) => f.kind === k);
  if (has("FEELING") || has("APOLOGY")) out.push({ id: "ACK", label: has("APOLOGY") ? "Acknowledge the apology" : "Acknowledge" });
  if (has("REQUEST") || has("QUESTION")) out.push({ id: "RESPOND", label: has("REQUEST") ? "Respond to their ask" : "Reply to the question" });
  if (has("BOUNDARY")) out.push({ id: "RESPECT", label: "Respect the limit" });
  if (has("ACCUSATION") || has("EVENT")) out.push({ id: "EXPLAIN", label: "Explain your side" });
  out.push({ id: "ASK_FIRST", label: "Ask first" });
  if (!out.some((i) => i.id === "ACK" || i.id === "RESPOND")) out.unshift({ id: "ACK", label: "Acknowledge" });
  return { intents: out.slice(0, 3), fallback: e.confidence === "LOW" ? CANT_TELL : null };
}
export const offersRepair = (e: Extraction) => e.facts.some((f) => f.kind === "ACCUSATION" || f.kind === "EVENT");

// ── Today: one insight from today's local messages, or nothing ────────────
export interface LocalMsg { id: string; sender_id: string; created_at: string; message_type?: string | null; decryptedContent?: string | null }
export interface TodayInsight { statement: string; messageId: string; phrase: string; provenance: Provenance }

const TODAY_TEMPLATE: Partial<Record<FactKind, (q: string) => string>> = {
  REQUEST: (q) => `They asked you: “${q}”`,
  QUESTION: (q) => `They asked a question today: “${q}”`,
  FEELING: (q) => `They told you today: “${q}”`,
  UNCERTAINTY: (q) => `They said they weren't sure: “${q}”`,
  APOLOGY: (q) => `They apologised today: “${q}”`,
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
    if (!f || !TODAY_TEMPLATE[f.kind] || f.phrase.split(/\s+/).length < 3) continue;
    const rank = ["REQUEST", "QUESTION", "FEELING", "UNCERTAINTY", "APOLOGY"].indexOf(f.kind);
    const at = Date.parse(m.created_at);
    if (!best || rank < best.rank || (rank === best.rank && at > best.at)) best = { rank, at, m, f, e };
  }
  if (!best) return null;
  const statement = TODAY_TEMPLATE[best.f.kind]!(best.f.phrase);
  if (!safeTemplate(statement)) return null;
  return { statement, messageId: best.m.id, phrase: best.f.phrase, provenance: prov(best.e, [best.f], opts.nowMs) };
}
