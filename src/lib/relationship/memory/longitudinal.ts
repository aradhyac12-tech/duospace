/**
 * Phase 3D — longitudinal engine (descriptive, deterministic, grounded).
 *
 * Every sentence a summary produces is built from a template over explicit
 * records and carries the ids of those records. Counts in a sentence must
 * equal the number of cited sources. No score, rank, rate or prediction.
 */
import { findProhibitedContent } from "../../ai/outputValidator";
import { currency } from "./model";
import type { Agreement, AgreementStatus, MemoryConsents, MemoryRecord, MemoryState, RepairHistoryEntry, Topic } from "./types";
import { MEMORY_RULE_VERSION } from "./types";

const TOPIC_LABEL: Record<Topic, string> = {
  planning: "Planning changes", time_together: "Time together", communication: "Communication", privacy: "Privacy", boundaries: "Boundaries",
  money: "Money", social: "Social plans", household: "Household responsibilities", conflict_repair: "Repairing after disagreements",
  affection: "Affection", future_planning: "Future planning", other: "Other",
};
export const topicLabel = (t: Topic) => TOPIC_LABEL[t];

// ── agreements ────────────────────────────────────────────────────────────

/** Status is derived only from explicit confirmations by each participant. */
export function agreementStatus(a: Agreement, nowMs: number): AgreementStatus {
  if (a.status === "CHANGED" || a.status === "COMPLETED") return a.status;
  const votes = Object.values(a.confirmations);
  if (votes.includes("DECLINED")) return "DECLINED";
  const [p1, p2] = a.participants;
  const acc = [p1, p2].filter((p) => p && a.confirmations[p] === "ACCEPTED").length;
  if (acc === 2) return a.reviewDate && Date.parse(a.reviewDate) < nowMs - 30 * 86_400_000 ? "EXPIRED" : "ACCEPTED_BY_BOTH";
  if (acc === 1) return "ACCEPTED_BY_ONE";
  return "PROPOSED";
}
export const needsReview = (a: Agreement, nowMs: number) => agreementStatus(a, nowMs) === "ACCEPTED_BY_BOTH" && !!a.reviewDate && Date.parse(a.reviewDate) <= nowMs;
export const REVIEW_QUESTION = "Does this still work for both of you?";

// ── context budget (spec §28) ──────────────────────────────────────────────

/**
 * Selects the minimum memory for a request: current + consented + visible to
 * the caller, filtered to the topic when given, ranked by evidence level
 * (1 best, 5 last) then most recently confirmed, capped. Historical,
 * withdrawn and expired records are never selected; AI interpretations
 * (level 5) are only included when nothing better exists for the topic.
 */
export function selectContext(memories: MemoryRecord[], o: { topic?: Topic; consents: MemoryConsents; nowMs: number; max?: number }): MemoryRecord[] {
  if (!o.consents.useInAI) return [];
  const eligible = memories.filter((m) => (o.topic ? m.topic === o.topic : true) && m.status !== "DELETED" && ["CURRENT", "MAY_BE_OUTDATED"].includes(currency(m, o.nowMs)));
  const hasExplicit = eligible.some((m) => m.evidenceLevel < 5);
  return eligible.filter((m) => !(hasExplicit && m.evidenceLevel === 5))
    .sort((a, b) => a.evidenceLevel - b.evidenceLevel || b.lastConfirmedAt.localeCompare(a.lastConfirmedAt))
    .slice(0, o.max ?? 12);
}

// ── partner asymmetry / longitudinal comparison ────────────────────────────

export type LongStatus = "ALIGNED" | "DIFFERENT" | "UNKNOWN" | "NOT_YET_DISCUSSED";
export interface TopicComparison {
  topic: Topic; positionKey: string | null;
  mine: MemoryRecord[]; theirs: MemoryRecord[];
  sharedAgreement: Agreement | null;
  status: LongStatus; negotiable: boolean;
  unknowns: string[]; lastConfirmed: string | null;
  conversationPrompt: string;
  sourceIds: string[];
}

const PROMPTS: Partial<Record<Topic, string>> = {
  planning: "What amount of notice feels realistic when plans change?",
  communication: "What amount of contact feels right to each of you on an ordinary day?",
  time_together: "What does good time together look like for each of you right now?",
  privacy: "What does privacy mean to each of you, and what would you each like the other to respect?",
  household: "What would a fair split of household tasks look like to each of you?",
  money: "How would each of you like money decisions to be made?",
};

/** Partner memories must be explicitly shared (SHARED status, partner-owned). */
export function compareTopics(mine: MemoryRecord[], partnerShared: MemoryRecord[], agreements: Agreement[], me: string, partner: string | null, nowMs: number): TopicComparison[] {
  const cur = (m: MemoryRecord) => ["CURRENT", "MAY_BE_OUTDATED"].includes(currency(m, nowMs));
  const my = mine.filter((m) => m.ownerUserId === me && cur(m));
  const th = partner ? partnerShared.filter((m) => m.ownerUserId === partner && m.visibility === "SHARED" && cur(m)) : [];
  const topics = new Set<Topic>([...my, ...th].map((m) => m.topic));
  const out: TopicComparison[] = [];
  for (const topic of topics) {
    const a = my.filter((m) => m.topic === topic), b = th.filter((m) => m.topic === topic);
    const ag = agreements.find((x) => x.topic === topic && agreementStatus(x, nowMs) === "ACCEPTED_BY_BOTH") ?? null;
    const ka = new Set(a.map((m) => m.position?.key).filter(Boolean)), kb = new Set(b.map((m) => m.position?.key).filter(Boolean));
    const key = [...ka].find((k) => kb.has(k)) ?? null;
    let status: LongStatus; let negotiable = false;
    const unknowns: string[] = [];
    if (!a.length || !b.length) { status = "NOT_YET_DISCUSSED"; unknowns.push(!b.length ? "Only you have recorded something about this; your partner hasn't shared a view." : "Only your partner has shared a view; you haven't recorded one."); }
    else if (key) {
      const va = a.find((m) => m.position?.key === key)!.position!.value, vb = b.find((m) => m.position?.key === key)!.position!.value;
      if (va === "not_sure" || vb === "not_sure") { status = "UNKNOWN"; unknowns.push("At least one of you isn't sure yet."); }
      else if (va === vb) status = "ALIGNED";
      else { status = "DIFFERENT"; negotiable = va === "sometimes" || vb === "sometimes"; }
    } else { status = "UNKNOWN"; unknowns.push("Your views are written in your own words, so DuoSpace doesn't compare them automatically."); }
    if (!ag) unknowns.push("There is no recorded shared agreement.");
    const all = [...a, ...b];
    if (all.some((m) => currency(m, nowMs) === "MAY_BE_OUTDATED")) unknowns.push("Some of this is older and may no longer be true.");
    const lastConfirmed = all.map((m) => m.lastConfirmedAt).sort().pop() ?? null;
    out.push({
      topic, positionKey: key, mine: a, theirs: b, sharedAgreement: ag, status, negotiable, unknowns, lastConfirmed,
      conversationPrompt: negotiable ? "What would a workable middle ground look like for both of you?" : PROMPTS[topic] ?? `What does ${topicLabel(topic).toLowerCase()} look like for each of you right now?`,
      sourceIds: [...all.map((m) => m.memoryId), ...(ag ? [ag.agreementId] : [])],
    });
  }
  return out;
}

// ── recurring topics + summary ─────────────────────────────────────────────

export interface SummarySentence { text: string; sourceIds: string[]; kind: "OBSERVED" | "REPORTED" | "UNKNOWN" | "AGREEMENT" }
export interface LongitudinalSummary {
  windowDays: number; sentences: SummarySentence[]; uncertainty: string[];
  modelVersion: string; processingLocation: "ON_DEVICE"; createdAt: string; insufficientInformation: boolean;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const nWord = (n: number) => (n <= 10 ? WORDS[n] : String(n));

/**
 * Recurring topics come ONLY from structured records the user created:
 * memories (by created date), repair-history entries and agreements. A
 * repeated topic is described as having "come up", never as a problem or a fight.
 */
export function summarize(state: MemoryState, partnerShared: MemoryRecord[], o: { me: string; partner: string | null; consents: MemoryConsents; nowMs: number; windowDays?: number; topic?: Topic }): LongitudinalSummary {
  const windowDays = o.windowDays ?? 30;
  const base = { windowDays, modelVersion: MEMORY_RULE_VERSION, processingLocation: "ON_DEVICE" as const, createdAt: new Date(o.nowMs).toISOString() };
  if (!o.consents.longitudinal) return { ...base, sentences: [], uncertainty: ["Summaries are off. You can turn them on in the memory settings."], insufficientInformation: true };
  const since = o.nowMs - windowDays * 86_400_000;
  const inWin = (iso: string) => Date.parse(iso) >= since;
  const sentences: SummarySentence[] = [];
  const uncertainty: string[] = [];
  const byTopic = new Map<Topic, string[]>();
  const push = (t: Topic, id: string) => byTopic.set(t, [...(byTopic.get(t) ?? []), id]);
  for (const m of state.memories) if (m.ownerUserId === o.me && inWin(m.createdAt) && !m.supersededBy && (!o.topic || m.topic === o.topic)) push(m.topic, m.memoryId);
  for (const r of state.repairs) if (inWin(r.date) && (!o.topic || r.topic === o.topic)) push(r.topic, r.repairId);
  for (const a of state.agreements) if (inWin(a.createdAt) && (!o.topic || a.topic === o.topic)) push(a.topic, a.agreementId);

  for (const [topic, ids] of [...byTopic.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const label = topicLabel(topic);
    if (ids.length >= 2) sentences.push({ kind: "OBSERVED", sourceIds: ids, text: `${label} came up in ${nWord(ids.length)} separate records you made in the last ${windowDays} days. The records don't establish why it keeps coming up.` });
    else sentences.push({ kind: "OBSERVED", sourceIds: ids, text: `${label} came up in one record you made in the last ${windowDays} days.` });
  }
  const comps = compareTopics(state.memories, partnerShared, state.agreements, o.me, o.partner, o.nowMs).filter((c) => !o.topic || c.topic === o.topic);
  for (const c of comps) {
    const label = topicLabel(c.topic);
    if (c.status === "DIFFERENT") sentences.push({ kind: "REPORTED", sourceIds: c.sourceIds, text: `On ${label.toLowerCase()}, you currently have different views${c.negotiable ? ", and at least one of you described it as \"sometimes\", which may leave room to agree on something" : ""}.` });
    if (c.status === "ALIGNED") sentences.push({ kind: "REPORTED", sourceIds: c.sourceIds, text: `On ${label.toLowerCase()}, you both recorded the same view.` });
    if (c.status === "NOT_YET_DISCUSSED") sentences.push({ kind: "UNKNOWN", sourceIds: c.sourceIds, text: `${label}: ${c.unknowns[0]}` });
    if (c.sharedAgreement) sentences.push({ kind: "AGREEMENT", sourceIds: [c.sharedAgreement.agreementId], text: `You both confirmed an agreement about ${label.toLowerCase()}.` });
    else if (c.status !== "NOT_YET_DISCUSSED") sentences.push({ kind: "UNKNOWN", sourceIds: c.sourceIds, text: `There is no recorded shared agreement about ${label.toLowerCase()}.` });
  }
  const open = state.repairs.filter((r) => inWin(r.date) && r.issueOpen === true && (!o.topic || r.topic === o.topic));
  if (open.length) sentences.push({ kind: "REPORTED", sourceIds: open.map((r) => r.repairId), text: `You marked ${nWord(open.length)} repair ${open.length === 1 ? "conversation" : "conversations"} as still open.` });
  const stale = state.memories.filter((m) => m.ownerUserId === o.me && currency(m, o.nowMs) === "MAY_BE_OUTDATED" && (!o.topic || m.topic === o.topic));
  if (stale.length) sentences.push({ kind: "UNKNOWN", sourceIds: stale.map((m) => m.memoryId), text: `${cap(nWord(stale.length))} of your saved ${stale.length === 1 ? "memory is" : "memories are"} older and may be outdated. Are they still true?` });
  if (!sentences.length) uncertainty.push("There isn't enough recorded information for a summary yet.");
  uncertainty.push("This only reflects what you chose to record and what your partner chose to share. It isn't a judgement about either of you or about the relationship.");
  return { ...base, sentences, uncertainty, insufficientInformation: sentences.length === 0 };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── validation ─────────────────────────────────────────────────────────────

export interface LongIssue { check: "GROUNDING" | "SAFETY" | "NO_SCORE" | "PREDICTION" | "PROFILING" | "PATHOLOGY"; where: string; message: string }
const SCORE = /\b\d{1,3}\s*%|\b(score|rating|rank\w*|grade|index|temperature|success rate|health|compatib\w*|stability|risk)\b/i;
const PREDICTION = /\b(will|going to|likely to|bound to)\s+(break ?up|divorce|split|cheat|leave|last|work out|fail)\b|\bbreak ?up\b|\bdivorc\w*|\bwon'?t last\b|\bstay together\b/i;
const PROFILING = /\b(avoidant|anxious|clingy|emotionally unavailable|controlling|narcissis\w*|defensive person|poor communicator|high[- ]conflict|manipulative|toxic)\b/i;
const PATHOLOGY = /\b(fight|fights|fighting|argue|arguing|problem|problems|unhealthy|dysfunctional|red flag)\b/i;

const countIn = (text: string): number | null => {
  const m = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) (separate records|repair conversations?|of your saved)\b/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return /^\d+$/.test(w) ? +w : WORDS.indexOf(w);
};

export function validateSummary(s: LongitudinalSummary, knownIds: Set<string>): LongIssue[] {
  const issues: LongIssue[] = [];
  s.sentences.forEach((x, i) => {
    const where = `sentence[${i}]`;
    if (!x.sourceIds.length) issues.push({ check: "GROUNDING", where, message: "Sentence without sources." });
    for (const id of x.sourceIds) if (!knownIds.has(id)) issues.push({ check: "GROUNDING", where, message: `Unknown source ${id}.` });
    const n = countIn(x.text);
    if (n !== null && n !== x.sourceIds.length) issues.push({ check: "GROUNDING", where, message: `Count ${n} doesn't match ${x.sourceIds.length} sources.` });
    const t = x.text.replace(/“[^”]*”/g, " ");
    for (const p of findProhibitedContent(t)) issues.push({ check: "SAFETY", where, message: p.slice(0, 50) });
    if (SCORE.test(t)) issues.push({ check: "NO_SCORE", where, message: "Score-like wording." });
    if (PREDICTION.test(t)) issues.push({ check: "PREDICTION", where, message: "Predicts an outcome." });
    if (PROFILING.test(t)) issues.push({ check: "PROFILING", where, message: "Labels a person." });
    if (PATHOLOGY.test(t)) issues.push({ check: "PATHOLOGY", where, message: "Treats repetition as a problem/fight." });
  });
  return issues;
}

/** Requests the longitudinal engine refuses outright (spec §32). */
export const LONGITUDINAL_REFUSAL = /\b(really|actually|secretly) loves?\b|\bwho (cares|loves) more\b|\bwhich partner (cares|loves)\b|\bmore toxic\b|\bwho'?s (more )?toxic\b|\bpredict\b|\bbreak ?up\b|\bprove (he|she|they)\b|\b(is|are) (lying|cheating)\b|\bcheating\b|\bpsychological profile\b|\bprofile of my partner\b|\bmanipulative\b|\bresponse time\b|\bwho causes\b|\bcompare our moods\b|\bwithout (them|him|her) knowing\b|\btrack (their|his|her)\b|\banaly[sz]e all our chats\b/i;
export const REFUSAL_TEXT = "DuoSpace doesn't judge, rank, predict, profile or monitor either of you, and it doesn't read feelings, moods or response times to decide anything. It can show what each of you has chosen to record, where your views differ, and what isn't known yet.";
