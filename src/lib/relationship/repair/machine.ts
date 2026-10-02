/**
 * Phase 3C — safety/coercion gate and repair state machine.
 *
 * The gate is conservative and FAILS CLOSED: any match, or any error while
 * checking, puts the session in SAFETY_HOLD, where no message is generated,
 * nothing can be shared, and reconciliation/apology/confrontation are never
 * suggested. It is not an abuse assessment and says so.
 */
import type { RepairAnswers, RepairField, RepairSession, RepairStage, SafetyCategory, SafetyState } from "./types";
import { STAGE_ORDER } from "./types";
import { multilingualSafetyCategories, type RelLang } from "../i18n/lang";
import { t, SAFETY_KEYS, INDIA_EMERGENCY_KEY } from "../i18n/strings";

const P: [SafetyCategory, RegExp][] = [
  ["THREAT_OR_VIOLENCE", /\b(hit|hits|hitting|slapped|slaps|punched|punches|kicked|choked|chokes|strangled|shoved|pushed me|grabbed me|beat me|beats me|hurt me|hurts me|threw (something|things|it) at me)\b|\bthreaten(ed|s|ing)? (to )?(hurt|kill|hit)\b|\b(kill|hurt) (me|you)\b|\b(gun|knife|weapon)\b|\bafraid (of|for) (him|her|them|my (life|safety))\b|\bscared (of|that) (he|she|they) (will|might|would)\b/i],
  ["STALKING_OR_MONITORING", /\b(follows|followed|following) me\b|\btrack(s|ed|ing)? my (phone|location|car)\b|\b(installed|put) (an? )?(app|tracker|spyware)\b|\b(reads|checks|goes through|went through) my (phone|messages|texts|email)\b|\bshows up (at|outside) my\b/i],
  ["COERCION_OR_CONTROL", /\b(won'?t|doesn'?t|does not|will not) let me\b|\bnot allowed to\b|\bmakes? me ask permission\b|\bforc(es|ed|ing) me to\b|\bor else\b/i],
  ["SEXUAL_COERCION", /\b(forced|pressured|made) me (to )?(have sex|do sexual|sleep with)\b|\bdidn'?t stop when i said no\b|\bwithout my consent\b/i],
  ["SELF_HARM_THREAT_AS_CONTROL", /\b(kill|hurt|harm) (him|her|them)sel(f|ves) if (i|you)\b|\bsaid (he|she|they)('d| would) (kill|hurt) (him|her|them)sel(f|ves)\b|\bthreaten(ed|s)? (suicide|to kill (him|her|them)self)\b/i],
  ["THREAT_TO_CHILDREN_OR_PETS", /\b(hurt|harm|take) (the|my|our) (kids?|children|child|baby|dog|cat|pet)\b|\bthreaten(ed|s)? (the|my|our) (kids?|children|pet)\b/i],
  ["ISOLATION", /\b(won'?t let me|stops me from|not allowed to) (see|talk to|visit|call) (my )?(friends|family|parents|mum|mom|dad)\b|\bcut me off from\b/i],
  ["FINANCIAL_COERCION", /\b(took|takes|controls|keeps) (all )?(my|the) (money|salary|card|cards|bank|wages)\b|\bwon'?t let me (work|have money|access (my|the) (account|money))\b/i],
  ["BLACKMAIL", /\bblackmail\w*\b|\bthreaten(ed|s)? to (post|share|leak|send) (my )?(photos|pictures|videos|nudes|messages)\b/i],
  // "right now" alone is NOT danger ("I need space right now") — audit fix 2026-09-25.
  ["IMMEDIATE_DANGER", /\b(outside my (door|house|home|room)|at my door|in danger|unsafe (right now|at home)|locked me in|won'?t let me leave|(he|she|they)('s| is| are) (here|coming|on (his|her|their) way) right now)\b/i],
];

const FIELDS: RepairField[] = ["whatHappened", "concreteEvent", "myExperience", "whatMatteredToMe", "whatMatteredToPartnerGuess", "uncertainAbout", "myResponsibility", "stillNeedToExplain", "wishPartnerUnderstood", "wantToUnderstand", "boundary", "repairLooksLike", "specificChange", "willingToDo", "partnerSaid"];

export function checkSafety(answers: RepairAnswers): SafetyState {
  try {
    const categories = new Set<SafetyCategory>();
    const matchedFields = new Set<RepairField>();
    for (const f of FIELDS) {
      const text = answers[f];
      if (text == null) continue;
      if (typeof text !== "string") throw new Error("non-text answer");
      for (const [cat, re] of P) if (re.test(text)) { categories.add(cat); matchedFields.add(f); }
      // Indian-language lexicon (all languages, always). Only ever adds.
      for (const cat of multilingualSafetyCategories(text)) { categories.add(cat); matchedFields.add(f); }
    }
    return categories.size ? { status: "CONCERN", categories: [...categories], matchedFields: [...matchedFields] } : { status: "CLEAR", categories: [], matchedFields: [] };
  } catch {
    return { status: "CONCERN", categories: ["CHECK_FAILED"], matchedFields: [] }; // fail closed
  }
}

/** Shown on SAFETY_HOLD. No reconciliation, no apology, no confrontation, no sharing. */
export const SAFETY_GUIDANCE = {
  title: "This situation may involve a safety concern",
  body: [
    "DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else.",
    "Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now.",
    "If you are in immediate danger, contact your local emergency number.",
    "Talking to someone you trust, or a local domestic-violence or crisis support service, may help you think through what's safe for you.",
    "You can close this at any time. Nothing you wrote here is saved or shared.",
  ],
} as const;

/** Localized safety guidance (fixed strings; see i18n/strings.ts). */
/**
 * Localized safety guidance. The emergency number is only named when the
 * DEVICE REGION is confidently India (region "IN"); otherwise the wording
 * stays neutral ("your local emergency number"). App language alone is
 * never used to guess the country.
 */
export const safetyGuidance = (lang: RelLang, region: string | null = null) => {
  const body = SAFETY_KEYS.map((k) => t(lang, k));
  if (region === "IN") body.splice(3, 0, t(lang, INDIA_EMERGENCY_KEY));
  return { title: t(lang, "safetyTitle"), body };
};

// ── state machine ─────────────────────────────────────────────────────────

export type RepairEvent =
  | { type: "NEXT" } | { type: "BACK" } | { type: "EXIT" }
  | { type: "ANSWER"; answers: Partial<RepairAnswers> }
  | { type: "CONFIRM_SHARE_READY" }   // REVIEW → SHARE, only with a validated message
  | { type: "SHARED"; shareId: string }
  | { type: "WITHDRAWN" }
  | { type: "DONE" };

export interface TransitionResult { session: RepairSession; refused: string | null }

const minimalFacts = (a: RepairAnswers) => !!(a.concreteEvent?.trim() || a.whatHappened?.trim());

export function transition(s: RepairSession, e: RepairEvent, ctx: { messageValid?: boolean; shareBlocked?: boolean } = {}): TransitionResult {
  const ok = (session: RepairSession): TransitionResult => ({ session, refused: null });
  const no = (why: string): TransitionResult => ({ session: s, refused: why });
  if (e.type === "EXIT") return ok({ ...s, stage: "EXITED" });
  if (s.stage === "EXITED" || s.stage === "COMPLETE") return no("Session is closed.");

  if (e.type === "ANSWER") {
    const answers = { ...s.answers, ...e.answers };
    const safetyState = checkSafety(answers);
    // Once CONCERN, it stays CONCERN for this session (fail closed; no un-flagging by editing).
    const sticky = s.safetyState.status === "CONCERN" ? { ...s.safetyState, categories: [...new Set([...s.safetyState.categories, ...safetyState.categories])] } : safetyState;
    return ok({ ...s, answers, safetyState: sticky, stage: sticky.status === "CONCERN" ? "SAFETY_HOLD" : s.stage });
  }
  if (s.stage === "SAFETY_HOLD" || s.safetyState.status === "CONCERN") return no("Safety hold: only exit is available.");

  const i = STAGE_ORDER.indexOf(s.stage);
  if (e.type === "BACK") return i > 0 && s.stage !== "SHARE" ? ok({ ...s, stage: STAGE_ORDER[i - 1] }) : no("Can't go back from here.");
  if (e.type === "NEXT") {
    const next = STAGE_ORDER[i + 1] as RepairStage | undefined;
    if (!next || next === "SHARE" || next === "COMPLETE") return no("Use review/share actions.");
    // No jumping from a charged input straight to a message: facts are required before review.
    if (next === "IMPACT" && !minimalFacts(s.answers)) return no("Describe what concretely happened first.");
    return ok({ ...s, stage: next });
  }
  if (e.type === "CONFIRM_SHARE_READY") {
    if (s.stage !== "REVIEW") return no("Review the message first.");
    if (!ctx.messageValid) return no("The message didn't pass validation.");
    if (ctx.shareBlocked) return no("You chose not to share this.");
    return ok({ ...s, stage: "SHARE", shareState: "READY_TO_SHARE" });
  }
  if (e.type === "SHARED") return s.stage === "SHARE" && s.shareState === "READY_TO_SHARE" ? ok({ ...s, shareState: "SHARED", shareId: e.shareId }) : no("Not ready to share.");
  if (e.type === "WITHDRAWN") return s.shareState === "SHARED" || s.shareState === "READY_TO_SHARE" ? ok({ ...s, shareState: "WITHDRAWN" }) : no("Nothing to withdraw.");
  if (e.type === "DONE") return s.stage === "REVIEW" || s.stage === "SHARE" ? ok({ ...s, stage: "COMPLETE" }) : no("Not finished.");
  return no("Unknown event.");
}

export function newSession(p: { id: string; conflictId: string; userId: string; relationshipId: string | null; nowMs: number }): RepairSession {
  return {
    repairSessionId: p.id, conflictId: p.conflictId, userId: p.userId, relationshipId: p.relationshipId,
    stage: "PAUSE", answers: {}, safetyState: { status: "CLEAR", categories: [], matchedFields: [] },
    shareState: "PRIVATE", shareId: null,
    createdAt: new Date(p.nowMs).toISOString(), expiresAt: new Date(p.nowMs + 24 * 3600_000).toISOString(),
  };
}
