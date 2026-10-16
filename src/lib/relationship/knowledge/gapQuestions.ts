/**
 * Adaptive question engine (spec §18). Questions come from information GAPS in
 * evidence that executable rules could actually use — never from a fixed survey.
 * At most ONE short question is returned, and often none.
 *
 * Scoring parameters are engineering heuristics, not research-derived.
 */
import { resolveFact } from "./evidence";
import { ruleExecutable, type KnowledgeSnapshot } from "./snapshot";
import type { Dyad, EffectiveFact, Observation, Party, RelationshipStage, SafetyState } from "./types";

export interface QuestionDef {
  id: string; constructId: string; attributeKey: string; text: string;
  options: { value: string | boolean; label: string }[];
  importance: 1 | 2 | 3; burden: 1 | 2 | 3; privacy: 1 | 2 | 3;
  stages: RelationshipStage[]; // empty = all
}

export const QUESTION_BANK: readonly QuestionDef[] = [
  { id: "q.comm.rhythm", constructId: "communication_preferences", attributeKey: "rhythm", text: "Do you usually prefer frequent short chats or fewer longer conversations?",
    options: [{ value: "frequent_short", label: "Frequent short chats" }, { value: "infrequent_long", label: "Fewer, longer conversations" }], importance: 2, burden: 1, privacy: 1, stages: [] },
  { id: "q.conf.first_step", constructId: "conflict_resolution", attributeKey: "first_step", text: "After a disagreement, do you usually prefer to talk it through soon or take some space first?",
    options: [{ value: "talk_now", label: "Talk soon" }, { value: "space_first", label: "Space first" }], importance: 2, burden: 1, privacy: 2, stages: ["early_relationship", "committed", "long_term"] },
  { id: "q.resp.understood", constructId: "partner_responsiveness", attributeKey: "feels_understood", text: "Lately, do you feel understood by your partner?",
    options: [{ value: true, label: "Mostly yes" }, { value: false, label: "Not really" }], importance: 3, burden: 1, privacy: 3, stages: ["early_relationship", "committed", "long_term"] },
  { id: "q.supp.good_news", constructId: "capitalization", attributeKey: "partner_response", text: "When you share good news, how does your partner usually respond?",
    options: [{ value: "active_constructive", label: "Warmly, with interest" }, { value: "other", label: "Differently" }], importance: 1, burden: 1, privacy: 2, stages: [] },
];

export interface QuestionContext {
  asker: Party; // the user being asked, always asked about THEMSELF
  observations: readonly Observation[];
  dyad: Dyad; stage: RelationshipStage; now: Date; snapshot: KnowledgeSnapshot;
  recentQuestionIds?: readonly string[];
  questionsToday?: number;
  safetyState?: SafetyState;
  /** Constructs the user has marked as not wanted. */
  declinedConstructs?: readonly string[];
}
export interface QuestionChoice { question: QuestionDef; gap: "missing" | "stale" | "contradictory"; score: number; reason: string }

export interface GapReport { missing: string[]; uncertain: string[]; stale: string[]; contradictory: string[] }
const k = (q: { constructId: string; attributeKey: string }) => `${q.constructId}.${q.attributeKey}`;

export function gapReport(ctx: QuestionContext): GapReport {
  const rep: GapReport = { missing: [], uncertain: [], stale: [], contradictory: [] };
  for (const q of QUESTION_BANK) {
    const f = resolveFact(ctx.observations, ctx.asker, ctx.dyad, q.constructId, q.attributeKey, ctx.now);
    if (f.state === "unknown") rep.missing.push(k(q));
    else if (f.state === "stale") rep.stale.push(k(q));
    else if (f.state === "contradictory") rep.contradictory.push(k(q));
    else if (f.state === "inferred" || f.state === "reported") rep.uncertain.push(k(q));
  }
  return rep;
}

/** How many executable rules would gain from this attribute (2 if the partner's side is already in place). */
function informationGain(q: QuestionDef, ctx: QuestionContext): number {
  const other: Party = ctx.asker === "A" ? "B" : "A";
  let gain = 0;
  for (const r of ctx.snapshot.rules) {
    if (!ruleExecutable(r, ctx.snapshot.claims, ctx.snapshot.sources)) continue;
    if (r.applicableStages.length && !r.applicableStages.includes(ctx.stage)) continue;
    const refs = r.conditions.flatMap((c) => [c.fact, ...(c.other ? [c.other] : [])]);
    if (!refs.some((f) => f.construct === q.constructId && f.key === q.attributeKey)) continue;
    const partnerReady = refs.filter((f) => f.construct === q.constructId && f.key === q.attributeKey)
      .some(() => { const pf: EffectiveFact = resolveFact(ctx.observations, other, ctx.dyad, q.constructId, q.attributeKey, ctx.now); return pf.state === "known" || pf.state === "confirmed"; });
    gain += partnerReady ? 2 : 1;
  }
  return gain;
}

export const MAX_QUESTIONS_PER_DAY = 1;
export const RECENT_BLOCK = 8;

export function nextQuestion(ctx: QuestionContext): QuestionChoice | null {
  // Safety first: never interrupt a person who may be unsafe with relationship-optimisation questions.
  if (ctx.safetyState && ctx.safetyState !== "none") return null;
  if ((ctx.questionsToday ?? 0) >= MAX_QUESTIONS_PER_DAY) return null; // fatigue
  const recent = new Set((ctx.recentQuestionIds ?? []).slice(-RECENT_BLOCK));
  let best: QuestionChoice | null = null;
  for (const q of QUESTION_BANK) {
    if (recent.has(q.id)) continue;
    if (ctx.declinedConstructs?.includes(q.constructId)) continue;
    if (q.stages.length && !q.stages.includes(ctx.stage)) continue;
    const f = resolveFact(ctx.observations, ctx.asker, ctx.dyad, q.constructId, q.attributeKey, ctx.now);
    const gap = f.state === "unknown" ? "missing" : f.state === "stale" ? "stale" : f.state === "contradictory" ? "contradictory" : null;
    if (!gap) continue; // already known/confirmed: do not ask again
    const gain = informationGain(q, ctx);
    if (gain === 0) continue; // nothing would use the answer → not useful → not asked
    const gapWeight = gap === "contradictory" ? 3 : gap === "stale" ? 2 : 2;
    const score = (gain * q.importance * gapWeight) / (q.burden + q.privacy);
    if (!best || score > best.score || (score === best.score && q.id < best.question.id)) {
      best = { question: q, gap, score, reason: `gap=${gap} gain=${gain} importance=${q.importance}` };
    }
  }
  return best;
}
