/**
 * Phase 3A — responsiveness support.
 *
 * Helps a user check their OWN reply against five questions drawn from the
 * perceived-partner-responsiveness construct (understanding, validation,
 * caring — Reis & Shaver 1988; Laurenceau et al. 1998/2005; see
 * docs/AI_SCIENTIFIC_FOUNDATION.md). Deterministic: it flags features of the
 * user's draft; it never judges who is right and never states what the
 * partner feels. Runs entirely on-device; nothing is stored.
 */
import { findProhibitedContent } from "../../ai/outputValidator";

export interface ResponsivenessCheck {
  id: "UNDERSTOOD" | "ACKNOWLEDGED" | "RESPONDED_TO_REQUEST" | "PROBLEM_SOLVING_FIRST" | "OWN_PERSPECTIVE_RESPECTFUL";
  question: string;
  /** What DuoSpace noticed in YOUR draft — a prompt to reflect, not a grade. */
  note: string;
  flagged: boolean;
}

export interface ResponsivenessSupport {
  checks: ResponsivenessCheck[];
  /** A starting point the user can edit. Quotes only the partner's own words. */
  suggestedOpening: string | null;
  followUpQuestion: string;
  /** Set when the partner's message or the draft contained something DuoSpace will not work with (e.g. a request to judge). */
  refusedReason: string | null;
}

const ACK = /\b(i hear|i understand|i get (it|that)|that sounds|sounds like|it makes sense|thank you for telling me|i see (why|that)|i'?m sorry (you|that))\b/i;
const FIX_FIRST = /^\s*(you should|just\b|why don'?t you|have you tried|try\b|next time\b|the solution|what you need to do)/i;
const DEFENSIVE = /\b(but i|i didn'?t|that'?s not fair|you always|you never|it'?s not my fault|calm down|you'?re overreacting|whatever)\b/i;
const ASKS_NEED = /\b(what would|how can i|what do you need|what can i do|would it help)\b[^?]*\?/i;
const I_STATEMENT = /\bi (feel|felt|would like|need|prefer|was hoping)\b/i;
const JUDGE_REQUEST = /\bwho('?s| is) right\b|\bis (he|she|my partner) (toxic|cheating|lying|a narcissist)\b|\bprove (that )?(he|she|they)\b/i;

const firstSentence = (s: string) => (s.match(/[^.!?\n]+[.!?]?/)?.[0] ?? s).trim().slice(0, 200);

export function buildResponsivenessSupport(partnerMessage: string, myDraft: string): ResponsivenessSupport {
  const followUpQuestion = "What would feel supportive from me right now?";
  if (JUDGE_REQUEST.test(partnerMessage) || JUDGE_REQUEST.test(myDraft)) {
    return { checks: [], suggestedOpening: null, followUpQuestion, refusedReason: "DuoSpace doesn't decide who is right or label either of you. It can help you word your own reply." };
  }
  const draft = myDraft.trim();
  const checks: ResponsivenessCheck[] = [
    {
      id: "UNDERSTOOD", question: "Did I understand what my partner was trying to say?",
      flagged: draft.length > 0 && !ACK.test(draft) && !/\?/.test(draft),
      note: ACK.test(draft) || /\?/.test(draft) ? "Your reply reflects back or checks your understanding." : "You could reflect back what you heard, or ask if you understood it right.",
    },
    {
      id: "ACKNOWLEDGED", question: "Did I acknowledge what mattered to them?",
      flagged: !ACK.test(draft),
      note: ACK.test(draft) ? "Your reply includes an acknowledgement." : "Your reply doesn't yet acknowledge what they said before moving on.",
    },
    {
      id: "RESPONDED_TO_REQUEST", question: "Did I respond to the actual need or request?",
      flagged: !ASKS_NEED.test(draft),
      note: ASKS_NEED.test(draft) ? "You ask what would help." : "If you're unsure what they were asking for, you could ask.",
    },
    {
      id: "PROBLEM_SOLVING_FIRST", question: "Did I jump straight into problem-solving?",
      flagged: FIX_FIRST.test(draft),
      note: FIX_FIRST.test(draft) ? "Your reply opens with advice. They may or may not have been asking for a solution." : "Your reply doesn't open with advice.",
    },
    {
      id: "OWN_PERSPECTIVE_RESPECTFUL", question: "Did I share my own perspective respectfully?",
      flagged: DEFENSIVE.test(draft),
      note: DEFENSIVE.test(draft)
        ? "Some wording may come across as defensive. Your view matters too; an \"I…\" sentence can carry it."
        : I_STATEMENT.test(draft) ? "You describe your own side in \"I…\" terms." : "Your own perspective is welcome too, if you want to add it.",
    },
  ];
  const words = firstSentence(partnerMessage);
  const opening = words
    ? `You said: “${words}” I want to make sure I understood what mattered to you.`
    : null;
  // Belt and braces: never emit DuoSpace-authored text that fails the shared safety rules.
  const safeOpening = opening && findProhibitedContent(opening.replace(`“${words}”`, "")).length === 0 ? opening : null;
  return { checks, suggestedOpening: safeOpening, followUpQuestion, refusedReason: null };
}
