/**
 * Phase 3A — explanation of a deterministic comparison, plus the validators
 * every explanation must pass before a user can see it.
 *
 * Pipeline:  DyadicComparison (source of truth)
 *              → rule explanation (always available, never guesses)
 *              → optional LOCAL model refinement (may only rephrase the
 *                comparison sentence, the hedged possibilities and the prompt)
 *              → safety + grounding + no-score + structure validation
 *              → first candidate that passes; otherwise INSUFFICIENT_INFORMATION.
 *
 * Status, evidence and unknowns are NEVER taken from a model.
 */
import { CATEGORY_LABEL } from "../types";
import { findProhibitedContent } from "../../ai/outputValidator";
import { checkGrounding } from "../../ai/groundingValidator";
import type { DyadicComparison, DyadicResult, UnknownReason } from "./types";

export const RULE_MODEL_VERSION = "dyadic-rule-v1";
const RESULT_TTL_MS = 30 * 86_400_000;

/** Neutral, specific, answerable prompts per area (none ask "why are you…"). */
const AREA_PROMPTS: Record<string, string> = {
  RELATIONSHIP_DIRECTION: "Where would each of you like this relationship to be heading, and how would you like to talk about it?",
  PACE: "What pace of getting closer feels comfortable for each of you, and how would you like to signal if it changes?",
  COMMUNICATION: "What amount and kind of contact feels connecting rather than distracting for each of you?",
  AFFECTION: "What small things make each of you feel cared for on an ordinary day?",
  INDEPENDENCE: "What does time on your own look like for each of you, and how would you like the other to respond to it?",
  TRUST: "What helps each of you feel secure when you are apart?",
  QUALITY_TIME: "What does quality time look like for each of you?",
  CONFLICT: "When you disagree, what helps each of you come back to the conversation?",
  SUPPORT: "When you have a hard day, what kind of response from the other feels most supportive?",
  FINANCES: "What would a comfortable way of making money decisions together look like for each of you?",
  FAMILY: "How would each of you like to balance time and decisions involving family?",
  FUTURE_PLANNING: "Which future plans feel important to talk about now, and which can wait, for each of you?",
  LIFESTYLE: "What does a good ordinary week look like for each of you?",
  BOUNDARIES: "Which boundaries, including needing time or space alone, feel most important to each of you right now, and how would you like them respected?",
  INTIMACY: "What helps each of you feel close, and how would you like to bring it up with each other?",
  PERSONAL_GROWTH: "What are each of you hoping to grow in, and how could the other support that?",
};

const REASON_UNKNOWN: Record<UnknownReason, string> = {
  SELF_NOT_ANSWERED: "You have not answered this yet.",
  PARTNER_NOT_SHARED: "Your partner has not shared an answer to this with you.",
  NOT_SURE: "At least one of you chose \"not sure\".",
  DECLINED: "At least one of you preferred not to answer.",
  AMBIGUOUS_ANSWER: "At least one answer depends on the situation, so it cannot be compared directly.",
  FREE_TEXT_NOT_COMPARABLE: "These are written in your own words, so DuoSpace does not compare them automatically.",
  MARKED_OUTDATED: "You marked this as outdated.",
  MARKED_WRONG: "You said this comparison did not reflect what you meant.",
};

const REASON_PROMPT: Partial<Record<UnknownReason, string>> = {
  SELF_NOT_ANSWERED: "Would you like to answer this question for yourself first?",
  PARTNER_NOT_SHARED: "Would you both like to share your answers to this question with each other?",
  NOT_SURE: "What would help each of you feel clearer about this?",
  DECLINED: "Is this something either of you would like to talk about, now or later?",
  MARKED_OUTDATED: "Is this still how each of you see it today?",
  MARKED_WRONG: "How would you describe what you meant, in your own words?",
};

const quote = (s: string) => `“${s}”`;
const daysAgo = (iso: string | null, nowMs: number) => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 86_400_000)) : null);

export interface ExplainCtx {
  nowMs: number;
  newId: () => string;
  consentReference: string | null;
}

/** Deterministic explanation. Never fabricates: every sentence is a template over the comparison. */
export function ruleExplain(c: DyadicComparison, ctx: ExplainCtx): DyadicResult {
  const area = CATEGORY_LABEL[c.category] ?? "This area";
  const selfEv = c.self?.state === "ANSWERED" ? c.self.statement : null;
  const partnerEv = c.partner?.state === "ANSWERED" ? c.partner.statement : null;
  const base = {
    id: ctx.newId(), comparisonKey: c.key, area, status: c.status,
    selfEvidence: selfEv, partnerEvidence: partnerEv,
    source: "user_self_report" as const, modelVersion: RULE_MODEL_VERSION,
    classification: "RELATIONSHIP_SENSITIVE" as const, processingLocation: "ON_DEVICE" as const,
    consentReference: ctx.consentReference,
    createdAt: new Date(ctx.nowMs).toISOString(), expiresAt: new Date(ctx.nowMs + RESULT_TTL_MS).toISOString(),
  };

  // Answered but no readable statement → cannot explain safely.
  if ((c.self?.state === "ANSWERED" && !selfEv) || (c.partner?.state === "ANSWERED" && !partnerEv)) {
    return insufficient(c, ctx);
  }

  const observed: string[] = [];
  if (c.prompt) observed.push(`Question: ${c.prompt}`);
  observed.push(selfEv ? `You answered ${quote(selfEv)}.` : c.self ? `Your answer: ${c.self.state === "NOT_SURE" ? "not sure" : "prefer not to answer"}.` : "You have not answered.");
  observed.push(partnerEv ? `Your partner's shared answer is ${quote(partnerEv)}.` : c.partner ? "Your partner shared \"not sure\"." : "Your partner has not shared an answer.");
  if (c.self?.context) observed.push(`Context you added: ${quote(c.self.context)}.`);

  const unknowns: string[] = [];
  if (c.status === "UNKNOWN" && c.unknownReason) unknowns.push(REASON_UNKNOWN[c.unknownReason]);
  if (c.status !== "UNKNOWN") unknowns.push("Why each answer matters to each of you was not stated.");
  const sd = daysAgo(c.staleness.selfUpdatedAt, ctx.nowMs);
  const pd = daysAgo(c.staleness.partnerUpdatedAt, ctx.nowMs);
  if (c.staleness.needsClarification && sd !== null && pd !== null) {
    unknowns.push(`Your answer was last updated ${sd} days ago and your partner's ${pd} days ago; either may have changed since.`);
  } else if (c.staleness.needsClarification) {
    unknowns.push("At least one answer is old and may no longer reflect how you see it.");
  }

  let comparison: string;
  let possibleExplanations: string[] = [];
  let conversationPrompt = AREA_PROMPTS[c.category] ?? "What does this area look like for each of you?";
  let suggestedAction: string | null = null;
  if (c.status === "ALIGNED") {
    comparison = "You both chose the same answer to this question. The same answer can still mean slightly different things to each of you.";
    suggestedAction = "You could talk about what this looks like day to day for each of you.";
  } else if (c.status === "DIFFERENT") {
    comparison = "Your answers to this question are different. A difference is not a verdict about the relationship; it is something you can talk about.";
    possibleExplanations = [
      "The answers may reflect different everyday routines rather than different priorities.",
      "Each answer might depend on context, such as a busy week compared with a quiet one.",
      "The same words could mean something slightly different to each of you.",
    ];
    suggestedAction = "You could each describe what your answer looks like in practice, and then compare.";
  } else {
    comparison = "There is not enough explicit information to compare this.";
    if (c.unknownReason && REASON_PROMPT[c.unknownReason]) conversationPrompt = REASON_PROMPT[c.unknownReason]!;
  }
  if (c.staleness.needsClarification && c.status !== "UNKNOWN") {
    comparison += " Because the answers were given at different times, it is worth checking they are both still current.";
    conversationPrompt = "Is this still how each of you see it today?";
  }

  return {
    ...base, observation: observed.join(" "), comparison, possibleExplanations, unknowns, conversationPrompt, suggestedAction,
    confidence: c.status === "UNKNOWN" ? "partial" : "explicit",
    uncertainty: "Based only on the answers shown here. DuoSpace does not know your reasons or feelings beyond them.",
    insufficientInformation: false,
  };
}

export function insufficient(c: DyadicComparison, ctx: ExplainCtx): DyadicResult {
  return {
    id: ctx.newId(), comparisonKey: c.key, area: CATEGORY_LABEL[c.category] ?? "This area", status: "UNKNOWN",
    observation: "INSUFFICIENT_INFORMATION", selfEvidence: null, partnerEvidence: null,
    comparison: "INSUFFICIENT_INFORMATION", possibleExplanations: [],
    unknowns: ["DuoSpace could not explain this safely from the information available."],
    conversationPrompt: "How would each of you describe this in your own words?", suggestedAction: null,
    confidence: "partial", uncertainty: "No explanation is shown because it could not be grounded in what you both said.",
    source: "user_self_report", modelVersion: RULE_MODEL_VERSION, classification: "RELATIONSHIP_SENSITIVE",
    processingLocation: "ON_DEVICE", consentReference: ctx.consentReference,
    createdAt: new Date(ctx.nowMs).toISOString(), expiresAt: new Date(ctx.nowMs + RESULT_TTL_MS).toISOString(),
    insufficientInformation: true,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

export interface DyadicIssue { check: "SAFETY" | "GROUNDING" | "NO_SCORE" | "STRUCTURE" | "STATUS" ; field: string; message: string }

/** Anything that looks like a score/grade/match verdict, in any disguise. */
const SCORE_PATTERN = /\b\d{1,3}(\.\d+)?\s*(%|percent|\/\s*\d+|out of)|\b(compatib\w*|incompatib\w*|match(ed)? (quality|level|score)|good match|bad match|perfect match|alignment (index|score|level)|relationship (health|strength|score|status|grade)|healthy relationship|unhealthy relationship|red flag|green flag|grade [a-f]\b|rank\w*|winner|loser|score\w*)\b/i;
const ACCUSATORY_PROMPT = /\bwhy (are|do|don'?t|doesn'?t|did|didn'?t|is|isn'?t) (you|they|your partner|he|she)\b|losing interest|(doesn'?t|don'?t) (you|they|your partner) care|emotionally distant|what'?s wrong with/i;
/** Outcome prediction: DuoSpace never predicts problems, breakup, divorce or whether a couple lasts. */
const OUTCOME_PREDICTION = /\b(will|going to|bound to|likely to|may|might|could)\s+(cause|lead to|end in|result in|create)\s+(\w+\s+){0,2}(problems?|conflicts?|trouble|issues|fights?)\b|\bbreak ?up\b|\bdivorc\w*|\bsplit up\b|\bwon'?t last\b|\bdoomed\b|\b(stay|last) together\b|\bfuture together is\b/i;
const HEDGED = /\b(may|might|could|perhaps|possibly)\b/i;
const OBEY_AI = /\btrust me\b|listen to (me|duospace|the ai) instead|i know what your partner (really )?means|this proves|the ai (knows|understands) (better|more)/i;

const textFields = (r: Pick<DyadicResult, "observation" | "comparison" | "possibleExplanations" | "unknowns" | "conversationPrompt" | "suggestedAction" | "uncertainty">) => ({
  observation: r.observation, comparison: r.comparison, possibleExplanations: r.possibleExplanations.join(" "),
  unknowns: r.unknowns.join(" "), conversationPrompt: r.conversationPrompt, suggestedAction: r.suggestedAction ?? "", uncertainty: r.uncertainty,
});

/** Removes the users' own quoted words so their content can't trip — or smuggle past — the checks on DuoSpace's words. */
function stripEvidence(text: string, c: DyadicComparison): string {
  let t = text;
  for (const e of [c.self?.statement, c.partner?.statement, c.self?.context, c.prompt]) if (e) t = t.split(`“${e}”`).join(" ").split(e).join(" ");
  return t;
}

export function validateDyadicResult(r: DyadicResult, c: DyadicComparison): DyadicIssue[] {
  const issues: DyadicIssue[] = [];
  if (r.status !== c.status) issues.push({ check: "STATUS", field: "status", message: "Explanation status differs from the deterministic comparison." });
  if (r.insufficientInformation) return issues;

  // Evidence must be exactly what each person stated — no paraphrase, no addition.
  const selfStated = c.self?.state === "ANSWERED" ? c.self.statement : null;
  const partnerStated = c.partner?.state === "ANSWERED" ? c.partner.statement : null;
  if (r.selfEvidence !== selfStated) issues.push({ check: "GROUNDING", field: "selfEvidence", message: "Self evidence is not the user's explicit statement." });
  if (r.partnerEvidence !== partnerStated) issues.push({ check: "GROUNDING", field: "partnerEvidence", message: "Partner evidence is not the partner's explicit shared statement." });
  const allowedQuotes = new Set([selfStated, partnerStated, c.self?.context].filter(Boolean) as string[]);
  for (const [field, text] of Object.entries(textFields(r))) {
    for (const m of text.matchAll(/“([^”]*)”/g)) if (!allowedQuotes.has(m[1])) issues.push({ check: "GROUNDING", field, message: `Quotes text neither person stated: “${m[1]}”.` });
  }

  const own = Object.fromEntries(Object.entries(textFields(r)).map(([k, v]) => [k, stripEvidence(v, c)]));
  // Temporal grounding: the users' own words have been stripped out above,
  // so ANY remaining history/frequency term or number was authored by
  // DuoSpace and is rejected — even if the same word appears inside an
  // answer label ("always" in an option must not license "your partner
  // always…"). Unknowns carry the only computed day counts.
  for (const g of checkGrounding({ ...own, unknowns: "" }, "")) issues.push({ check: "GROUNDING", field: g.field, message: g.message });

  for (const [field, text] of Object.entries(own)) {
    for (const p of findProhibitedContent(text)) issues.push({ check: "SAFETY", field, message: `Prohibited content (${p.slice(0, 60)}…).` });
    if (SCORE_PATTERN.test(text)) issues.push({ check: "NO_SCORE", field, message: "Looks like a score, grade or match verdict." });
    if (OUTCOME_PREDICTION.test(text)) issues.push({ check: "SAFETY", field, message: "Predicts a relationship outcome." });
    if (OBEY_AI.test(text)) issues.push({ check: "SAFETY", field, message: "Claims authority over the users' own understanding." });
  }
  if (!r.conversationPrompt.trim().endsWith("?")) issues.push({ check: "STRUCTURE", field: "conversationPrompt", message: "Conversation prompt must be a question." });
  if (ACCUSATORY_PROMPT.test(r.conversationPrompt)) issues.push({ check: "SAFETY", field: "conversationPrompt", message: "Conversation prompt is accusatory." });
  if (r.unknowns.length === 0) issues.push({ check: "STRUCTURE", field: "unknowns", message: "Every result must state what is unknown." });
  for (const e of r.possibleExplanations) if (!HEDGED.test(e)) issues.push({ check: "STRUCTURE", field: "possibleExplanations", message: "Possible explanations must be hedged." });
  if (r.possibleExplanations.length === 1) issues.push({ check: "STRUCTURE", field: "possibleExplanations", message: "Offer several possibilities or none — never a single explanation." });
  if (c.status !== "DIFFERENT" && r.possibleExplanations.length > 0) issues.push({ check: "STRUCTURE", field: "possibleExplanations", message: "Only a genuine difference gets possible explanations." });
  return issues;
}

// ── optional local-model refinement ───────────────────────────────────────

/** What a model is ALLOWED to contribute. Status, evidence, unknowns are not in here on purpose. */
export interface DyadicModelDraft {
  comparison?: string;
  possibleExplanations?: string[];
  conversationPrompt?: string;
  suggestedAction?: string | null;
}

export interface DyadicExplainer {
  modelVersion: string;
  explainDyadic(input: { area: string; status: string; prompt: string | null; selfStatement: string | null; partnerStatement: string | null }): Promise<unknown>;
}

function parseDraft(raw: unknown): DyadicModelDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 && v.length <= 400 ? v.trim() : undefined);
  const list = Array.isArray(o.possibleExplanations) ? o.possibleExplanations.map(str).filter((x): x is string => !!x).slice(0, 4) : undefined;
  return { comparison: str(o.comparison), possibleExplanations: list, conversationPrompt: str(o.conversationPrompt), suggestedAction: str(o.suggestedAction) ?? null };
}

function validateQuotes(text: string, c: DyadicComparison): boolean {
  const allowed = new Set([c.self?.statement, c.partner?.statement, c.self?.context].filter(Boolean) as string[]);
  return [...text.matchAll(/“([^”]*)”/g)].some((m) => !allowed.has(m[1]));
}

export interface ExplainOutcome { result: DyadicResult; usedModel: boolean; rejectedModelIssues: DyadicIssue[] }

/**
 * Explains one comparison. A model (if given) is tried first but can only
 * rephrase; any timeout / malformed output / safety or grounding rejection
 * falls back to the rule explanation. Nothing unvalidated is ever returned.
 */
export async function explainComparison(c: DyadicComparison, ctx: ExplainCtx, model?: DyadicExplainer | null, timeoutMs = 8000): Promise<ExplainOutcome> {
  const rule = ruleExplain(c, ctx);
  let rejectedModelIssues: DyadicIssue[] = [];
  if (model && !rule.insufficientInformation && c.status !== "UNKNOWN") {
    try {
      const raw = await Promise.race([
        model.explainDyadic({ area: rule.area, status: c.status, prompt: c.prompt, selfStatement: rule.selfEvidence, partnerStatement: rule.partnerEvidence }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("dyadic model timeout")), timeoutMs)),
      ]);
      const d = parseDraft(raw);
      // Any unsafe content ANYWHERE in the draft rejects the model output
      // outright — even in a field the rule layer would have discarded.
      const rawText = d ? [d.comparison, d.conversationPrompt, d.suggestedAction, ...(d.possibleExplanations ?? [])].filter(Boolean).join(" ") : "";
      const draftUnsafe = d !== null && (findProhibitedContent(rawText).length > 0 || OUTCOME_PREDICTION.test(rawText) || SCORE_PATTERN.test(rawText) || OBEY_AI.test(rawText) || /“/.test(rawText) && validateQuotes(rawText, c));
      if (d && draftUnsafe) {
        rejectedModelIssues = [{ check: "SAFETY", field: "model", message: "Model draft contained prohibited content." }];
      } else if (d) {
        const candidate: DyadicResult = {
          ...rule,
          comparison: d.comparison ?? rule.comparison,
          possibleExplanations: c.status === "DIFFERENT" ? (d.possibleExplanations ?? rule.possibleExplanations) : [],
          conversationPrompt: d.conversationPrompt ?? rule.conversationPrompt,
          suggestedAction: d.suggestedAction ?? rule.suggestedAction,
          modelVersion: model.modelVersion,
        };
        const issues = validateDyadicResult(candidate, c);
        if (issues.length === 0) return { result: candidate, usedModel: true, rejectedModelIssues: [] };
        rejectedModelIssues = issues;
      }
    } catch {
      /* timeout / integrity / runtime failure → rule path; no cloud fallback exists */
    }
  }
  if (validateDyadicResult(rule, c).length === 0) return { result: rule, usedModel: false, rejectedModelIssues };
  return { result: insufficient(c, ctx), usedModel: false, rejectedModelIssues };
}
