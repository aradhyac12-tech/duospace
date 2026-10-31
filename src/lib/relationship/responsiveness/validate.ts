/**
 * Phase 3B — validation for response support. Runs on every result
 * (rule or model) before the user sees it. Checks are per COMPONENT so a
 * problem in the user's own supplied wording can be surfaced without
 * discarding the whole reply, while a problem in DuoSpace-authored text
 * rejects the result.
 */
import { findProhibitedContent } from "../../ai/outputValidator";
import { checkGrounding } from "../../ai/groundingValidator";
import type { ResponseComponent, ResponseSupport, ResponseSupportInput } from "./types";

export interface SupportIssue { check: "MANIPULATION" | "COERCION" | "MIND_READING" | "EMOTION_INFERENCE" | "GROUNDING" | "BOUNDARY" | "SAFETY" | "DEPENDENCY" | "STRUCTURE"; where: string; message: string }

/** Guilt, threats, jealousy induction, punishment, loyalty tests, scorekeeping, sarcasm. */
export const MANIPULATIVE_TEXT = /\bafter (all|everything) i'?ve done\b|\bif you (really )?(loved|cared about) me\b|\byou made me\b|\bi guess i just don'?t matter\b|\bdon'?t (bother|worry about me)\b.*\banyway\b|\b(or|otherwise) (i'?ll|i will|we'?re|we are) (leave|leaving|done|over|break)\b|\bwe'?re done if\b|\bi'?ll leave (you )?if\b|\bsomeone else would\b|\bother (people|guys|girls) would\b|\bdon'?t expect (me|anything)\b|\bsee how you like it\b|\bnow you know how it feels\b|\bprove (that )?you (love|care)\b|\byeah,? right\b|\bwhatever you say\b|\bthanks a lot\b|\bnice of you\b|\blast time you\b|\bthis is the (second|third|\w+th) time\b/i;
/** Wording that turns an accusation back or keeps score. */
const SCOREKEEPING = /\byou (always|never)\b|\byou'?re (always|never)\b/i;
/** Asserting the partner's inner state as fact. */
const MIND_READING = /\byou('?re| are) (just )?(being )?(feeling|angry|upset|mad|jealous|hurt|sad|annoyed|insecure|needy|clingy|overreacting|dramatic)\b|\byou (must|probably) (feel|be)\b|\bi know (how|what) you (really )?(feel|mean|think)\b|\byou (really|secretly) (want|mean|feel)\b/i;
/** Compliance with monitoring when the user set a boundary. */
const MONITORING_COMPLIANCE = /\b(i'?ll|i will|you can)\s+(always\s+)?(share my (live )?location|check my phone|read my messages|have my password|give you my password)\b/i;
/** Dependency / AI-authority language. */
const DEPENDENCY = /\bcome back to duospace\b|\blet duospace decide\b|\bonly duospace\b|\bduospace (knows|understands) (your|this) relationship\b|\btrust (me|the ai)\b/i;
const EMOTIONS = ["angry", "anger", "upset", "mad", "sad", "hurt", "jealous", "anxious", "resentful", "resentment", "annoyed", "irritated", "frustrated", "disappointed", "neglected", "abandoned", "rejected", "lonely", "needy", "insecure", "withdrawn", "cold", "distant", "passive aggressive", "sulking", "avoiding"];

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ")} `;
const stripQuotes = (s: string) => s.replace(/“[^”]*”/g, " ");

function sourcesText(i: ResponseSupportInput): string {
  return [i.partnerMessage, i.whatIHeard, i.myExperience, i.myOwnAction, i.myRequest, i.myBoundary].filter(Boolean).join(" ");
}

/** Emotion words DuoSpace wrote that nobody supplied. */
function inferredEmotions(text: string, src: string): string[] {
  const t = norm(stripQuotes(text)), s = norm(src);
  return EMOTIONS.filter((e) => t.includes(` ${e} `) && !s.includes(` ${e} `));
}

export function validateComponent(c: ResponseComponent, input: ResponseSupportInput): SupportIssue[] {
  const issues: SupportIssue[] = [];
  const where = `component:${c.kind}`;
  const src = sourcesText(input);
  if (MANIPULATIVE_TEXT.test(c.text)) issues.push({ check: "MANIPULATION", where, message: "Guilt, threat, jealousy, punishment, loyalty-testing, sarcasm or scorekeeping." });
  if (SCOREKEEPING.test(c.text)) issues.push({ check: "MANIPULATION", where, message: "\"You always / never\" turns a moment into a verdict." });
  if (MIND_READING.test(c.text)) issues.push({ check: "MIND_READING", where, message: "States what the partner feels or means." });
  for (const e of inferredEmotions(c.text, src)) issues.push({ check: "EMOTION_INFERENCE", where, message: `Mentions an emotion (“${e}”) nobody stated.` });
  for (const g of checkGrounding({ [where]: c.text }, src)) issues.push({ check: "GROUNDING", where, message: g.message });
  if (input.myBoundary && MONITORING_COMPLIANCE.test(c.text)) issues.push({ check: "BOUNDARY", where, message: "Agrees to monitoring despite the boundary you set." });
  if (DEPENDENCY.test(c.text)) issues.push({ check: "DEPENDENCY", where, message: "Encourages reliance on DuoSpace." });
  return issues;
}

/** Validates DuoSpace-authored analysis text (never the partner's quoted words). */
export function validateAnalysis(r: ResponseSupport, input: ResponseSupportInput): SupportIssue[] {
  const issues: SupportIssue[] = [];
  const src = sourcesText(input);
  const own: [string, string][] = [
    ...r.whatSeemsToMatter.map((m, i) => [`whatSeemsToMatter[${i}]`, m.text] as [string, string]),
    ...r.whatIsUnknown.map((u, i) => [`whatIsUnknown[${i}]`, u] as [string, string]),
    ...r.notes.map((n, i) => [`notes[${i}]`, n] as [string, string]),
    ["clarifyingQuestion", r.clarifyingQuestion],
  ];
  for (const [where, text] of own) {
    const t = stripQuotes(text);
    for (const p of findProhibitedContent(t)) issues.push({ check: "SAFETY", where, message: `Prohibited content (${p.slice(0, 50)}…)` });
    for (const e of inferredEmotions(t, src)) issues.push({ check: "EMOTION_INFERENCE", where, message: `Mentions an emotion (“${e}”) nobody stated.` });
    if (DEPENDENCY.test(t)) issues.push({ check: "DEPENDENCY", where, message: "Encourages reliance on DuoSpace." });
  }
  // Grounding of EXPLICIT claims: quoted text must occur in the partner's message.
  for (const m of r.whatSeemsToMatter) {
    for (const q of m.text.matchAll(/“([^”]*)”/g)) if (!input.partnerMessage.includes(q[1])) issues.push({ check: "GROUNDING", where: "whatSeemsToMatter", message: `Quotes words not in the message: “${q[1]}”.` });
    if (m.sources.length === 0) issues.push({ check: "GROUNDING", where: "whatSeemsToMatter", message: "Claim without a source." });
    if (m.kind === "TENTATIVE" && !/interpretation|possibly|may|might/i.test(m.text)) issues.push({ check: "STRUCTURE", where: "whatSeemsToMatter", message: "Interpretation not labelled as tentative." });
  }
  if (r.whatPartnerExplicitlySaid.text !== input.partnerMessage.replace(/\s+/g, " ").trim().slice(0, 400)) issues.push({ check: "GROUNDING", where: "whatPartnerExplicitlySaid", message: "Must be the partner's words verbatim." });
  if (!r.insufficientInformation && !r.refusal && r.whatIsUnknown.length === 0) issues.push({ check: "STRUCTURE", where: "whatIsUnknown", message: "Unknowns are mandatory." });
  if (!r.clarifyingQuestion.trim().endsWith("?")) issues.push({ check: "STRUCTURE", where: "clarifyingQuestion", message: "Must be a question." });
  return issues;
}

export function validateSupport(r: ResponseSupport, input: ResponseSupportInput): SupportIssue[] {
  return [...validateAnalysis(r, input), ...r.components.flatMap((c) => validateComponent(c, input))];
}
