/**
 * Phase 3C — repair validation. Reuses the Phase 3B component validator
 * (manipulation, mind-reading, emotion inference, grounding, boundary,
 * dependency) and adds repair-specific rejections. Also computes the
 * pre-display quality check (spec §21).
 */
import { validateComponent, type SupportIssue } from "../responsiveness/validate";
import { findProhibitedContent } from "../../ai/outputValidator";
import type { MessageComponent, QualityCheck, RepairAnswers, RepairStatement } from "./types";

export interface RepairIssue { check: SupportIssue["check"] | "BLAME" | "FORCED_RECONCILIATION" | "UNSAFE_ENGAGEMENT" | "SURVEILLANCE" | "POSITIVITY" | "INVENTED_PARTNER_WORDS"; where: string; message: string }

const BLAME = /\byou caused\b|\b(it'?s|it is|this is) (all )?your fault\b|\byou'?re the problem\b|\byou (always|never)\b|\bthis proves\b|\byou (clearly|obviously) (don'?t|do not)\b/i;
const FORCED_RECONCILIATION = /\byou (need|have) to forgive\b|\bforgive me (now|already)\b|\bwe (have|need) to (make up|move on|get past this) (now|today)\b|\blet'?s (just )?forget (about )?(it|this)\b|\byou should (just )?(get over|move on)\b|\bstay together\b/i;
const UNSAFE_ENGAGEMENT = /\bconfront (them|him|her)( immediately| now)?\b|\bshow up (at|outside)\b|\bdon'?t let (them|him|her) leave\b/i;
const SURVEILLANCE = /\bcheck (their|his|her|your) (phone|messages)\b|\btrack (their|his|her|your) (location|phone)\b|\bread (their|his|her) (messages|texts)\b/i;
const POSITIVITY = /\beverything will be (okay|ok|fine)\b|\bthis will make (us|you) stronger\b|\byour relationship (can|will) grow from this\b/i;
/** Partner inner states / statements asserted without a verbatim quote. */
const REPAIR_MIND_READING = /\bi know (that )?you\b|\byou (feel|felt|think|thought|meant|intended|secretly|only did it|did it to)\b|\byou were trying to\b/i;
const HEDGE = /\b(may|might|could|possibly|unknown|not an established fact|only they can confirm|your guess|your reading)\b/i;

const userText = (a: RepairAnswers) => [a.whatHappened, a.concreteEvent, a.myExperience, a.whatMatteredToMe, a.whatMatteredToPartnerGuess, a.uncertainAbout, a.myResponsibility, a.stillNeedToExplain, a.wishPartnerUnderstood, a.wantToUnderstand, a.boundary, a.repairLooksLike, a.specificChange, a.willingToDo, a.partnerSaid].filter(Boolean).join(" ");

export function validateRepairComponent(c: MessageComponent, a: RepairAnswers): RepairIssue[] {
  const where = `component:${c.kind}`;
  const input = { partnerMessage: userText(a), myBoundary: a.boundary };
  const own = c.text.replace(/“[^”]*”/g, " "); // words quoted verbatim are evidence, not DuoSpace's claim (quotes are checked below)
  const issues: RepairIssue[] = validateComponent({ kind: "EXPLAIN", text: own, sources: [] }, input).map((i) => ({ ...i, where }));
  if (/\byou said\b(?!:?\s*“)/i.test(c.text)) issues.push({ check: "MIND_READING", where, message: "Reports partner words without quoting them verbatim." });
  if (REPAIR_MIND_READING.test(own)) issues.push({ check: "MIND_READING", where, message: "States what the partner feels, meant, said or intended without their words." });
  for (const p of findProhibitedContent(own)) issues.push({ check: "SAFETY", where, message: `Prohibited (${p.slice(0, 40)}…)` });
  if (BLAME.test(own)) issues.push({ check: "BLAME", where, message: "Assigns blame or globalises." });
  if (FORCED_RECONCILIATION.test(own)) issues.push({ check: "FORCED_RECONCILIATION", where, message: "Pushes forgiveness or reconciliation." });
  if (UNSAFE_ENGAGEMENT.test(own)) issues.push({ check: "UNSAFE_ENGAGEMENT", where, message: "Suggests unsafe confrontation." });
  if (SURVEILLANCE.test(own)) issues.push({ check: "SURVEILLANCE", where, message: "Suggests monitoring." });
  if (POSITIVITY.test(own)) issues.push({ check: "POSITIVITY", where, message: "Promises an outcome." });
  for (const q of c.text.matchAll(/“([^”]*)”/g)) if (!userText(a).includes(q[1].replace(/[.!?]$/, ""))) issues.push({ check: "INVENTED_PARTNER_WORDS", where, message: `Quotes words nobody supplied: “${q[1]}”.` });
  return issues;
}

/** DuoSpace-authored analysis statements: interpretations must be hedged; nothing prohibited. */
export function validateStatements(list: RepairStatement[], a: RepairAnswers): RepairIssue[] {
  const issues: RepairIssue[] = [];
  for (const s of list) {
    const own = s.text.replace(/“[^”]*”/g, " ");
    for (const p of findProhibitedContent(own)) issues.push({ check: "SAFETY", where: `statement:${s.kind}`, message: `Prohibited (${p.slice(0, 40)}…)` });
    if ((s.kind === "INTERPRETATION" || s.kind === "POSSIBILITY" || s.kind === "UNKNOWN") && s.sources.some((x) => x.sourceType !== "RULE_TEMPLATE") && !HEDGE.test(own) && s.kind !== "UNKNOWN") issues.push({ check: "STRUCTURE", where: `statement:${s.kind}`, message: "Interpretation not marked as uncertain." });
    if (s.sources.length === 0) issues.push({ check: "GROUNDING", where: `statement:${s.kind}`, message: "No source." });
    for (const q of s.text.matchAll(/“([^”]*)”/g)) if (!userText(a).includes(q[1].replace(/[.!?]$/, "")) && !/, and I felt /.test(q[1])) issues.push({ check: "INVENTED_PARTNER_WORDS", where: `statement:${s.kind}`, message: `Quotes words nobody supplied: “${q[1]}”.` });
  }
  return issues;
}

export function qualityCheck(components: MessageComponent[], a: RepairAnswers, issues: RepairIssue[]): QualityCheck {
  const kinds = new Set(components.map((c) => c.kind));
  const has = (k: RepairIssue["check"]) => issues.some((i) => i.check === k);
  const text = components.map((c) => c.text).join(" ");
  return {
    describesSpecificBehavior: kinds.has("OWN") || kinds.has("ACKNOWLEDGE"),
    separatesFactFromInterpretation: !has("MIND_READING") && !has("EMOTION_INFERENCE"),
    noMindReading: !has("MIND_READING"),
    preservesDisagreement: !(a.rememberDifferently || a.disagreeWithInterpretation) || kinds.has("EXPLAIN"),
    preservesBoundary: !(a.boundary || a.cannotAgreeToRequest) || kinds.has("BOUNDARY"),
    noBlame: !has("BLAME"),
    hasConcreteRepairAction: kinds.has("NEXT_TIME") || kinds.has("OWN") || kinds.has("CLARIFY"),
    hasRequestWhenAppropriate: !a.specificChange || kinds.has("REQUEST"),
    noForcedReconciliation: !has("FORCED_RECONCILIATION"),
    noManipulation: !has("MANIPULATION"),
    reflectsUserPosition: !/\byou'?re right\b|\bit was (all )?my fault\b/i.test(text) || /\bmy fault\b/i.test(userText(a)),
    noInventedPartnerFeelings: !has("EMOTION_INFERENCE") && !has("INVENTED_PARTNER_WORDS"),
    noUnsafeEngagement: !has("UNSAFE_ENGAGEMENT") && !has("SURVEILLANCE"),
  };
}
