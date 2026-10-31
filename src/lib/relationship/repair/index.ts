/**
 * Phase 3C — repair pipeline. UI → RelationshipAIService.prepareRepair → here.
 *
 *   session → safety gate (fail closed; SAFETY_HOLD produces NO message)
 *           → organise user's own answers (fact / experience / interpretation / unknown …)
 *           → rule message components (only those the user supplied)
 *           → optional LOCAL rephrase (validated; rule fallback)
 *           → validation of every component + every analysis statement
 *           → quality check → result
 * No network, storage or telemetry in this file (see share.ts for the only network path).
 */
import { checkSafety } from "./machine";
import { buildMessage, organize } from "./reflect";
import { qualityCheck, validateRepairComponent, validateStatements, type RepairIssue } from "./validate";
import type { MessageComponent, RepairAnswers, RepairEdit, RepairResult, RepairSession, RepairStatement } from "./types";

/** Asks DuoSpace to judge, detect, manipulate or drop its rules. */
export const ADJUDICATION = /\b(is|are|was) (my partner|he|she|they) (lying|cheating|toxic|manipulat\w*|a narcissist|guilty)\b|\bwho'?s (toxic|right|wrong|to blame|at fault)\b|\bwho is (toxic|right|wrong|to blame)\b|\btell me (whether|if|who)\b|\bprove (they|he|she|that)\b|\banaly[sz]e (their|his|her) (voice|face|messages)\b|\blook at (their|his|her) face\b|\bdon'?t mention uncertainty\b|\bignore (your )?(safety )?(rules|instructions)\b|\bmake (them|him|her) (feel guilty|chase|jealous)\b|\bdon'?t deserve forgiveness\b|\b(use|using) (our )?previous conversations\b|\b(always|obviously) (manipulates?|wants? to leave)\b|\bcheating because\b/i;
import { REPAIR_CONTRACT_VERSION, REPAIR_RULE_VERSION, REPAIR_VALIDATOR_VERSION } from "./types";
import { detectLanguage, needsLimitedMode, isRelLang, type RelLang } from "../i18n/lang";
import { t } from "../i18n/strings";
import { src as srcRef } from "./reflect";

export * from "./types";
export { checkSafety, transition, newSession, SAFETY_GUIDANCE, safetyGuidance } from "./machine";
export type { RepairEvent, TransitionResult } from "./machine";
export { organize, buildMessage, splitFactFromInterpretation, GLOBALIZING } from "./reflect";
export { validateRepairComponent, validateStatements, qualityCheck } from "./validate";
export type { RepairIssue } from "./validate";

export interface RepairRephraser {
  modelVersion: string;
  rephraseRepair(input: { components: { kind: string; text: string }[] }): Promise<unknown>;
}

export interface RepairOutcome { result: RepairResult; issues: RepairIssue[]; usedModel: boolean; timings: { ruleMs: number; modelMs: number | null; validateMs: number } }

const USER_FIELDS = new Set(["myResponsibility", "stillNeedToExplain", "specificChange", "willingToDo", "boundary", "wantToUnderstand", "concreteEvent", "whatHappened"]);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export async function prepareRepair(
  session: RepairSession,
  opts: { nowMs: number; edits?: RepairEdit[]; model?: RepairRephraser | null; timeoutMs?: number; language?: string },
): Promise<RepairOutcome> {
  const t0 = now();
  const edits = opts.edits ?? [];
  const safety = session.safetyState.status === "CONCERN" ? session.safetyState : checkSafety(session.answers);
  const o = organize(session.answers);
  const base = (components: MessageComponent[], extra: Partial<RepairResult> = {}): RepairResult => ({
    repairSessionId: session.repairSessionId, conflictId: session.conflictId, userId: session.userId, relationshipId: session.relationshipId,
    stage: safety.status === "CONCERN" ? "SAFETY_HOLD" : session.stage,
    ...o, components, proposedMessage: components.map((c) => c.text).join(" ").trim(),
    quality: qualityCheck(components, session.answers, []), safetyState: safety,
    confidence: components.length >= 2 ? "SUPPORTED" : components.length === 1 ? "PARTIAL" : "INSUFFICIENT_INFORMATION",
    processingLocation: "ON_DEVICE", source: "user_reflection", executionMode: "RULE_BASED", modelVersion: REPAIR_RULE_VERSION,
    validatorVersion: REPAIR_VALIDATOR_VERSION, contractVersion: REPAIR_CONTRACT_VERSION, appliedEdits: edits, language: "en", limitedMode: false,
    shareable: !edits.includes("DONT_SHARE") && safety.status === "CLEAR",
    createdAt: new Date(opts.nowMs).toISOString(), expiresAt: new Date(opts.nowMs + 24 * 3600_000).toISOString(),
    ...extra,
  });

  // Safety hold: no message, no sharing, no reconciliation suggestions.
  if (safety.status === "CONCERN") {
    const held = base([], { proposedMessage: "", confidence: "INSUFFICIENT_INFORMATION", shareable: false, repairQuestions: [], communicationNotes: [] });
    return { result: held, issues: [], usedModel: false, timings: { ruleMs: now() - t0, modelMs: null, validateMs: 0 } };
  }

  // Non-English text: the English pattern engine can't read it, so nothing is
  // interpreted. Words are shown verbatim inside fixed, localized templates.
  const a = session.answers;
  const texts = [a.whatHappened, a.concreteEvent, a.myExperience, a.partnerSaid, a.myResponsibility, a.stillNeedToExplain, a.specificChange, a.willingToDo, a.boundary, a.wantToUnderstand];
  if (needsLimitedMode(texts)) {
    const lang: RelLang = isRelLang(opts.language) && opts.language !== "en" ? opts.language : detectLanguage(texts.filter(Boolean).join(" ")).lang;
    const lim = limitedRepair(session, lang, edits);
    const r = base(lim.components, { ...lim.org, communicationNotes: [{ kind: "SUGGESTION", text: t(lang, "limitedNotice"), sources: [RULE_SRC] }], language: lang, limitedMode: true,
      quality: qualityCheck(lim.components, {}, []) });
    return { result: lim.components.some((c) => c.sources.some((x) => x.sourceType !== "RULE_TEMPLATE")) ? r : { ...r, proposedMessage: "INSUFFICIENT_INFORMATION", confidence: "INSUFFICIENT_INFORMATION", shareable: false }, issues: [], usedModel: false, timings: { ruleMs: now() - t0, modelMs: null, validateMs: 0 } };
  }

  // Requests for adjudication / detection / manipulation / rule-bypass are
  // never turned into a message; the user is told plainly what DuoSpace won't do.
  const cleaned: RepairAnswers = { ...session.answers };
  const refusals: RepairStatement[] = [];
  for (const [k, v] of Object.entries(session.answers)) {
    if (typeof v === "string" && ADJUDICATION.test(v)) {
      delete (cleaned as Record<string, unknown>)[k];
      refusals.push({ kind: "SUGGESTION", text: "DuoSpace can't tell who is right, whether someone is lying, cheating or \"toxic\", or read feelings from voice or faces, and it won't help make someone feel guilty or chase you. That part was left out. You could ask your partner directly about what you want to understand.", sources: [{ sourceType: "USER_REFLECTION", sourceField: k as RepairStatement["sources"][number]["sourceField"], sourcePartner: "SELF", sourceMessageId: null, sourceTimestamp: null }] });
    }
  }
  const oc = refusals.length ? organize(cleaned) : o;
  let comps = buildMessage(cleaned, oc, edits);
  const ruleMs = now() - t0;
  const t1 = now();
  const issues: RepairIssue[] = [];
  const notes: RepairStatement[] = [...oc.communicationNotes, ...refusals.slice(0, 1)];
  const kept: MessageComponent[] = [];
  for (const c of comps) {
    const ci = validateRepairComponent(c, cleaned);
    if (ci.length === 0) { kept.push(c); continue; }
    issues.push(...ci);
    if (c.sources.every((s) => s.sourceField && USER_FIELDS.has(s.sourceField))) {
      notes.push({ kind: "SUGGESTION", text: `Part of your wording was left out of the message (${c.kind.toLowerCase()}): ${ci[0].message} You can rephrase it in your own words.`, sources: c.sources });
    } else {
      comps = []; break; // DuoSpace-authored text failed → fall back to nothing rather than something unsafe
    }
  }
  comps = comps.length ? kept : [];
  // A message made only of templates says nothing the user actually told us.
  if (!comps.some((c) => c.sources.some((x) => x.sourceType !== "RULE_TEMPLATE"))) comps = [];
  const statementIssues = validateStatements([...oc.partnerUnderstanding, ...oc.unknowns, ...oc.possibilities, ...oc.repairQuestions, ...notes], session.answers);
  issues.push(...statementIssues);
  if (statementIssues.length) comps = [];
  const validateMs = now() - t1;

  let result = base(comps, { ...oc, communicationNotes: notes, quality: qualityCheck(comps, session.answers, issues) });
  if (!comps.length) result = { ...result, proposedMessage: "INSUFFICIENT_INFORMATION", confidence: "INSUFFICIENT_INFORMATION", shareable: false };

  let modelMs: number | null = null;
  if (opts.model && comps.length) {
    const t2 = now();
    try {
      const raw = await Promise.race([
        opts.model.rephraseRepair({ components: comps.map((c) => ({ kind: c.kind, text: c.text })) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), opts.timeoutMs ?? 8000)),
      ]);
      const text = raw && typeof raw === "object" && typeof (raw as { proposedMessage?: unknown }).proposedMessage === "string" ? (raw as { proposedMessage: string }).proposedMessage.trim() : "";
      if (text && text.length <= 2000) {
        const mi = validateRepairComponent({ kind: "OWN", text, sources: [] }, session.answers);
        // A model may not drop the user's boundary or disagreement.
        if (session.answers.boundary && !comps.some((c) => c.kind === "BOUNDARY" && text.includes(c.text.replace(/\.$/, "")))) mi.push({ check: "BOUNDARY", where: "model", message: "Dropped the user's boundary." });
        if (mi.length === 0) {
          modelMs = now() - t2;
          return { result: { ...result, proposedMessage: text, executionMode: "LOCAL", modelVersion: opts.model.modelVersion }, issues, usedModel: true, timings: { ruleMs, modelMs, validateMs } };
        }
        issues.push(...mi.map((x) => ({ ...x, where: "model" })));
      }
    } catch { /* timeout / failure → rule text; no cloud */ }
    modelMs = now() - t2;
  }
  return { result, issues, usedModel: false, timings: { ruleMs, modelMs, validateMs } };
}

const RULE_SRC = { sourceType: "RULE_TEMPLATE" as const, sourceField: null, sourcePartner: null, sourceMessageId: null, sourceTimestamp: null };

/** Limited (non-English) mode: verbatim user words in fixed localized templates. No interpretation, no model. */
function limitedRepair(session: RepairSession, lang: RelLang, edits: RepairEdit[]) {
  const a = session.answers; const E = new Set(edits);
  const v = (x?: string) => (x ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const comps: MessageComponent[] = [];
  const add = (kind: MessageComponent["kind"], text: string, field: Parameters<typeof srcRef>[0] | null) => comps.push({ kind, text, sources: [field ? srcRef(field, a) : RULE_SRC] });
  if (v(a.partnerSaid)) add("ACKNOWLEDGE", t(lang, "partnerSaid", v(a.partnerSaid)), "partnerSaid");
  if (v(a.myResponsibility)) add("OWN", `${a.apologize && !E.has("TOO_APOLOGETIC") ? t(lang, "apology") + " " : ""}${t(lang, "own", v(a.myResponsibility))}`, "myResponsibility");
  if (!E.has("TOO_DEFENSIVE") && !E.has("NOT_WHAT_I_MEANT")) {
    if (a.rememberDifferently) add("EXPLAIN", t(lang, "rememberDifferently"), null);
    if (a.disagreeWithInterpretation) add("EXPLAIN", t(lang, "disagreeInterp"), null);
    if (v(a.stillNeedToExplain)) add("EXPLAIN", t(lang, "explain", v(a.stillNeedToExplain)), "stillNeedToExplain");
  }
  add("CLARIFY", t(lang, "repairQuestion"), null);
  if (v(a.willingToDo)) add("NEXT_TIME", t(lang, "nextTime", v(a.willingToDo)), "willingToDo");
  if (v(a.specificChange)) add("REQUEST", t(lang, "request", v(a.specificChange)), "specificChange");
  if (v(a.boundary)) add("BOUNDARY", a.cannotAgreeToRequest ? t(lang, "boundaryCannot", v(a.boundary)) : v(a.boundary), "boundary");
  const components = E.has("MAKE_SHORTER") ? comps.filter((c) => ["OWN", "CLARIFY", "REQUEST", "BOUNDARY"].includes(c.kind)) : comps;
  const st = (kind: RepairStatement["kind"], text: string, field: Parameters<typeof srcRef>[0] | null): RepairStatement => ({ kind, text, sources: [field ? srcRef(field, a) : RULE_SRC] });
  const org = {
    facts: v(a.concreteEvent) ? [st("FACT", v(a.concreteEvent), "concreteEvent")] : [],
    userExperience: [v(a.whatHappened) && st("EXPERIENCE", v(a.whatHappened), "whatHappened"), v(a.myExperience) && st("EXPERIENCE", v(a.myExperience), "myExperience")].filter(Boolean) as RepairStatement[],
    partnerUnderstanding: v(a.partnerSaid) ? [st("FACT", `“${v(a.partnerSaid)}”`, "partnerSaid")] : [],
    unknowns: [st("UNKNOWN", t(lang, "unknownMeaning"), null), st("UNKNOWN", t(lang, "unknownFeelings"), null)],
    possibilities: [] as RepairStatement[],
    repairQuestions: [st("SUGGESTION", t(lang, "repairQuestion"), null)],
  };
  return { components, org };
}
