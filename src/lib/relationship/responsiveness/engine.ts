/**
 * Phase 3B — deterministic (RULE_BASED) response support.
 *
 * Reads ONLY the text the user pasted/selected. Recognises what is EXPLICIT
 * (requests, stated feelings) with simple patterns; labels anything else as
 * TENTATIVE; never infers emotion from punctuation, length, capitals or
 * timing; prefers a clarifying question whenever more than one reading is
 * plausible. Builds a reply from optional components the user controls.
 */
import { extractFacts } from "../contextual/extract";
import type { Domain } from "../contextual/patterns";
import type {
  ComponentKind, GroundedText, ResponseComponent, ResponseSupport, ResponseSupportInput, SourceField, SourceRef,
  SupportCorrection, TextCharacteristic,
} from "./types";

export const RULE_VERSION = "responsiveness-rule-v1";
const TTL_MS = 24 * 3600_000;

// ── pronoun swap (partner's "I wanted you to…" → reply's "You wanted me to…") ──
const SUBJECT_NEXT = /^(were|are|was|am|have|had|will|would|can|could|did|do|should|need|want|wanted|said|asked|felt|feel|think|know)$/i;
const BE_SWAP: Record<string, string> = { was: "were", am: "are", were: "was", are: "am" };
export function swapPerson(s: string): string {
  const t = s.split(/(\s+)/);
  const words = t.map((x, i) => (i % 2 === 0 ? x : null));
  const next = (i: number) => (words[i + 2] ?? "").replace(/[^\w']/g, "");
  const out = t.map((tok, i) => {
    if (i % 2 === 1) return tok;
    const m = tok.match(/^([\w']+)(.*)$/);
    if (!m) return tok;
    const [, w, rest] = m; const k = w.toLowerCase();
    const prev = (words[i - 2] ?? "").toLowerCase();
    let r: string | null = null;
    if (k === "i") r = "you";
    else if (k === "me" || k === "myself") r = k === "me" ? "you" : "yourself";
    else if (k === "my") r = "your"; else if (k === "mine") r = "yours";
    else if (k === "i'm") r = "you're"; else if (k === "i'd") r = "you'd"; else if (k === "i've") r = "you've"; else if (k === "i'll") r = "you'll";
    else if (k === "you") r = SUBJECT_NEXT.test(next(i)) ? "I" : "me";
    else if (k === "your") r = "my"; else if (k === "yours") r = "mine"; else if (k === "yourself") r = "myself";
    else if (k === "you're") r = "I'm"; else if (k === "you'd") r = "I'd"; else if (k === "you've") r = "I've"; else if (k === "you'll") r = "I'll";
    else if (BE_SWAP[k] && (prev === "i" || prev === "you")) r = prev === "i" ? (k === "was" ? "were" : k === "am" ? "are" : k) : (k === "were" ? "was" : k === "are" ? "am" : k);
    return r === null ? tok : r + rest;
  });
  return out.join("");
}
/** "they/them/their" in the user's own reading → "you/your" when spoken to the partner. */
const thirdToSecond = (s: string) => s.replace(/\bthey're\b/gi, "you're").replace(/\bthey\b/gi, "you").replace(/\bthem\b/gi, "you").replace(/\btheirs\b/gi, "yours").replace(/\btheir\b/gi, "your").replace(/\bthemselves\b/gi, "yourself").replace(/\bhe\b|\bshe\b/gi, "you").replace(/\bhim\b/gi, "you").replace(/\bhis\b/gi, "your");
const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
const stripEnd = (s: string) => s.replace(/[.!?…\s]+$/, "");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => (/^I\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

// ── explicit patterns ──────────────────────────────────────────────────────


const DOMAINS: { id: Domain; matter: string; question: string; unknown: string }[] = [
  { id: "CONTACT", matter: "contact or acknowledgement", question: "Would a call, a message, or just letting you know my plans work best for you?", unknown: "Whether a call, a message, or simply an explanation was hoped for." },
  { id: "WORK_STRESS", matter: "having their day noticed and being checked in on", question: "Would you have preferred me to listen, check in, or help with something?", unknown: "Whether being listened to, checked in on, or helped with something was what mattered." },
  { id: "PLANS", matter: "the plan and time together", question: "What would have helped when the plan changed?", unknown: "What the plan meant, and what would help if plans change." },
  { id: "CHORES", matter: "how things are shared between you", question: "What would a fair way of handling this look like to you?", unknown: "What arrangement would seem fair to them." },
  { id: "SPACE", matter: "time or space for themselves", question: "What would giving you space look like, and when would you like to reconnect?", unknown: "How much space is wanted, and when to reconnect." },
  { id: "LISTENING", matter: "being listened to", question: "What would help you feel listened to right now?", unknown: "What listening would look like in this situation." },
  { id: "FAMILY_FRIENDS", matter: "how family or friends fit into your plans", question: "What would you like us to agree on about this?", unknown: "Which part of this matters most to them." },
];
const GENERIC_Q = "What would have felt helpful in that situation?";
const AMBIGUOUS_Q = "Do you want to talk about it, or would you rather have some space for now?";

/** Manipulation / coercion intent in what the USER asks DuoSpace to help with. */
export const MANIPULATIVE_GOAL = /\b(make|makes|making|get|gets)\s+(them|him|her|my partner)\s+(feel\s+)?(guilty|jealous|bad|sorry|worried|insecure|scared)\b|\bguilt[- ]?trip\b|\b(punish|get back at|revenge|payback)\b|\b(test|check)\s+(their|his|her)\s+(loyalty|love|feelings)\b|\bignore\s+(them|him|her)\s+until\b|\bsilent treatment\b|\bthreaten\b|\bmake\s+(them|him|her)\s+(comply|obey|do what i want)\b|\bso\s+(they|he|she)('?ll| will)\s+(never|stop)\b|\bemotional(ly)?\s+blackmail\b/i;

const ref = (field: SourceField, i: ResponseSupportInput): SourceRef => ({
  sourceField: field, sourcePartner: field === "partnerMessage" ? "PARTNER" : "SELF",
  sourceMessageId: field === "partnerMessage" ? i.partnerMessageId ?? null : null,
  sourceTimestamp: field === "partnerMessage" ? i.partnerMessageAt ?? null : null,
});

export interface Analysis {
  explicitRequest: string | null;      // partner's words, as said
  requestKind: "PAST_WISH" | "PAST_MISS" | "FUTURE" | "FUTURE_WE" | null;
  statedFeeling: string | null;
  ambiguous: boolean;
  control: boolean;
  characteristics: TextCharacteristic[];
  domain: (typeof DOMAINS)[number] | null;
}

export function analyzeMessage(message: string): Analysis {
  const m = clean(message);
  // ONE semantic authority: the canonical extraction (contextual/extract.ts).
  // English rules are forced here to keep this engine's long-standing behaviour
  // (it has always run them on any script; limited mode is decided upstream).
  const ex = extractFacts({ id: "analyze", text: m }, { englishRules: true });
  const byRule = (rule: string) => ex.facts.find((f) => f.rule === rule) ?? null;
  const wish = byRule("past-wish"), futWe = byRule("future-we"), futAny = futWe ?? byRule("future-request"), miss = byRule("past-miss");
  const fut = futAny;
  const explicitRequest = wish?.detail ?? fut?.detail ?? miss?.detail ?? null;
  const requestKind = wish ? "PAST_WISH" : fut ? (futWe ? "FUTURE_WE" : "FUTURE") : miss ? "PAST_MISS" : null;
  const feel = byRule("stated-feeling");
  const statedFeeling = feel ? feel.phrase : null;
  // Short/one-word replies are ambiguous. Punctuation, capitals, length and timing NEVER imply an emotion.
  const ambiguous = ex.ambiguous;
  const control = !!byRule("control");
  const ch: TextCharacteristic[] = [];
  if (ambiguous) ch.push("AMBIGUOUS");
  if (byRule("accusation")) ch.push("ACCUSATION");
  if (control) ch.push("CONTROL_OR_MONITORING_REQUEST");
  if (requestKind === "FUTURE" || requestKind === "FUTURE_WE") ch.push("SPECIFIC_REQUEST");
  else if (requestKind === "PAST_WISH") ch.push("SPECIFIC_REQUEST");
  else if (requestKind === "PAST_MISS") ch.push("UNCLEAR_EXPECTATION");
  else if (!ambiguous && /\b(you|we)\b/i.test(m) && !statedFeeling) ch.push("VAGUE_REQUEST");
  if (statedFeeling) ch.push("STATED_FEELING");
  if (byRule("acknowledgement")) ch.push("ACKNOWLEDGMENT");
  if (/\?\s*$/.test(m) && !fut) ch.push("CLARIFICATION");
  if (byRule("defensive")) ch.push("DEFENSIVE_EXPLANATION");
  const domain = DOMAINS.find((d) => d.id === ex.domain) ?? null;
  return { explicitRequest: explicitRequest ? stripEnd(explicitRequest).slice(0, 200) : null, requestKind, statedFeeling, ambiguous, control, characteristics: [...new Set(ch)], domain };
}

// ── variants (regenerate / tone) ───────────────────────────────────────────
const ACK_V = [["I hear you.", "Thank you for telling me.", "I'm glad you told me."], ["Got it, thanks for telling me.", "Okay, I hear you.", "Thanks for saying it."]];
const pick = (arr: string[], v: number) => arr[((v % arr.length) + arr.length) % arr.length];

export function buildSupport(
  input: ResponseSupportInput, opts: { nowMs: number; corrections?: SupportCorrection[]; variant?: number },
): ResponseSupport {
  const corr = new Set(opts.corrections ?? []);
  const variant = (opts.variant ?? 0) + (opts.corrections ?? []).filter((c) => c === "REGENERATE").length;
  const msg = clean(input.partnerMessage);
  const base = {
    source: "user_supplied_text" as const, processingLocation: "ON_DEVICE" as const, modelVersion: RULE_VERSION,
    createdAt: new Date(opts.nowMs).toISOString(), expiresAt: new Date(opts.nowMs + TTL_MS).toISOString(),
    shareable: !corr.has("DONT_SHARE"), appliedCorrections: [...corr], variant,
  };
  const P = ref("partnerMessage", input);
  const explicit: GroundedText = { text: msg, kind: "EXPLICIT", sources: [P] };

  if (msg.length < 1) {
    return { ...base, whatPartnerExplicitlySaid: explicit, whatSeemsToMatter: [], whatIsUnknown: ["Nothing was entered."], textCharacteristics: [], clarificationFirst: true, clarifyingQuestion: GENERIC_Q, understandingCheck: null, components: [], possibleResponse: "INSUFFICIENT_INFORMATION", userPerspective: null, notes: [], uncertainty: "There is no message to work from.", insufficientInformation: true, refusal: null };
  }

  // Manipulation intent → refuse and offer a direct alternative.
  if (MANIPULATIVE_GOAL.test(`${input.myGoal ?? ""} ${input.myRequest ?? ""}`)) {
    return {
      ...base, whatPartnerExplicitlySaid: explicit, whatSeemsToMatter: [], whatIsUnknown: [], textCharacteristics: analyzeMessage(msg).characteristics,
      clarificationFirst: false, clarifyingQuestion: GENERIC_Q, understandingCheck: null, components: [],
      possibleResponse: "I've been upset about this and I'd like to talk about it directly. Can we find a time today?",
      userPerspective: null, notes: ["Saying directly what you feel and what you'd like usually works better than trying to make someone feel something."],
      uncertainty: "", insufficientInformation: false,
      refusal: "DuoSpace won't help write messages meant to make someone feel guilty, jealous, afraid or punished, or to test them. Here is a direct way to say it instead.",
    };
  }

  const a = analyzeMessage(msg);
  const matter: GroundedText[] = [];
  if (a.explicitRequest) matter.push({ text: `In their words: “${a.explicitRequest}”`, kind: "EXPLICIT", sources: [P] });
  if (a.statedFeeling) matter.push({ text: `In their words: “${a.statedFeeling}”`, kind: "EXPLICIT", sources: [P] });
  if (a.domain && !a.ambiguous) matter.push({ text: `Possibly about ${a.domain.matter} (an interpretation, not something they said).`, kind: "TENTATIVE", sources: [P] });

  const unknown: string[] = [];
  if (a.ambiguous) unknown.push("What this message means. Short replies can mean many different things, and DuoSpace doesn't read feelings from wording, punctuation or timing.");
  if (a.domain && !a.ambiguous) unknown.push(a.domain.unknown);
  if (!a.statedFeeling) unknown.push("Their feelings about it: none were stated in the message.");
  if (!a.explicitRequest && !a.ambiguous) unknown.push("What specifically would help: no specific request was stated.");
  unknown.push("Anything that happened outside this message.");

  const clarificationFirst = a.ambiguous || corr.has("NOT_WHAT_I_MEANT") || (!a.explicitRequest && !a.statedFeeling);
  const clarifyingQuestion = a.ambiguous ? AMBIGUOUS_Q : a.domain?.question ?? GENERIC_Q;

  const heard = clean(input.whatIHeard);
  const understandingCheck = heard ? `It sounds like ${lowerFirst(stripEnd(thirdToSecond(heard)))}. Did I understand that correctly?` : null;

  const casual = corr.has("TOO_FORMAL") ? 1 : 0;
  const comps: ResponseComponent[] = [];
  const add = (kind: ComponentKind, text: string, fields: SourceField[]) => comps.push({ kind, text, sources: fields.map((f) => ref(f, input)) });

  add("ACKNOWLEDGE", pick(ACK_V[casual], variant), ["partnerMessage"]);
  if (!corr.has("NOT_WHAT_I_MEANT")) {
    if (understandingCheck) add("REFLECT", understandingCheck, ["whatIHeard"]);
    else if (a.explicitRequest && a.requestKind === "PAST_WISH") add("REFLECT", `You wanted me to ${swapPerson(a.explicitRequest)}.`, ["partnerMessage"]);
    else if (a.explicitRequest && a.requestKind === "FUTURE_WE") add("REFLECT", `You'd like us to ${a.explicitRequest}.`, ["partnerMessage"]);
    else if (a.explicitRequest && a.requestKind === "FUTURE") add("REFLECT", `You'd like me to ${swapPerson(a.explicitRequest)}.`, ["partnerMessage"]);
    else if (a.explicitRequest && a.requestKind === "PAST_MISS") add("REFLECT", `You noticed I didn't ${swapPerson(a.explicitRequest)}.`, ["partnerMessage"]);
  }
  if (clarificationFirst || !understandingCheck) add("CLARIFY", clarifyingQuestion, ["partnerMessage"]);

  const own = clean(input.myOwnAction);
  if (!corr.has("TOO_APOLOGETIC") && (own || input.apologize)) {
    const sorry = input.apologize ? "I'm sorry. " : "";
    add("OWN", `${sorry}${own ? `${stripEnd(own)}.` : ""}`.trim(), own ? ["myOwnAction"] : ["partnerMessage"]);
  }

  const exp = clean(input.myExperience);
  // The disagreement stance is its own (DuoSpace-authored) component, so it
  // survives even if the user's own wording of their experience is filtered.
  if (input.seeItDifferently) {
    add("EXPLAIN", exp ? "I understand this mattered to you, but I experienced it differently." : "I understand this mattered to you. I see some of it differently, and I'd like to tell you how it was for me.", ["partnerMessage"]);
  }
  if (exp) {
    const lead = input.seeItDifferently ? "" : corr.has("TOO_DEFENSIVE") ? "For context, " : "From my side, ";
    add("EXPLAIN", lead ? `${lead}${lowerFirst(stripEnd(exp))}.` : `${capitalize(stripEnd(exp))}.`, ["myExperience"]);
  }

  const req = clean(input.myRequest);
  if (req) add("REQUEST", `Next time, ${lowerFirst(stripEnd(req))}${/\?$/.test(req) ? "" : "?"}`.replace(/\?\?$/, "?"), ["myRequest"]);

  const boundary = clean(input.myBoundary);
  const notes: string[] = [];
  if (boundary || corr.has("KEEP_MY_BOUNDARY") || a.control) {
    if (boundary) add("BOUNDARY", `${stripEnd(boundary)}.`, ["myBoundary"]);
    if (a.control) notes.push("You don't have to agree to this to be responsive. You can acknowledge why it matters to them and still keep your privacy.");
    if (a.control && !boundary) add("BOUNDARY", "I'm not comfortable with that. Could we find another way that works for both of us?", ["partnerMessage"]);
  }
  if (a.characteristics.includes("ACCUSATION")) notes.push("This message contains an accusation and doesn't state a specific request. Asking what they'd like to happen can help. You don't have to accept blame to respond with care.");
  if (a.ambiguous) notes.push("This message is ambiguous. Asking is more reliable than guessing.");

  let finalComps = comps;
  if (corr.has("MAKE_CLEARER")) finalComps = comps.filter((c) => c.kind !== "ACKNOWLEDGE" || comps.length <= 2);
  if (corr.has("KEEP_MY_BOUNDARY")) finalComps = finalComps.filter((c) => c.kind !== "OWN" || !/\bI'?ll\s+(always|share|let you check)/i.test(c.text));
  const possibleResponse = finalComps.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();

  const userPerspective: GroundedText | null = exp ? { text: exp, kind: "EXPLICIT", sources: [ref("myExperience", input)] } : null;

  return {
    ...base, whatPartnerExplicitlySaid: explicit, whatSeemsToMatter: matter, whatIsUnknown: unknown, textCharacteristics: a.characteristics,
    clarificationFirst, clarifyingQuestion, understandingCheck, components: finalComps, possibleResponse, userPerspective, notes,
    uncertainty: "Based only on the text you entered. DuoSpace can't know what your partner feels or meant beyond their words; asking them is the reliable way to find out.",
    insufficientInformation: false, refusal: null,
  };
}
