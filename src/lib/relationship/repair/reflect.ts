/**
 * Phase 3C — deterministic organisation of the user's OWN answers.
 *
 * - A charged sentence like "You cancelled dinner again, so clearly I'm not
 *   important to you" is split at its conclusion marker: the event becomes
 *   a FACT (frequency/globalising words removed), the conclusion becomes an
 *   INTERPRETATION quoted in the user's words, and the reason is UNKNOWN.
 * - Globalising language ("always", "you never listen") is not blocked; the
 *   user is offered a specific-observation form built from their own facts.
 * - Message components are included only when the user supplied the
 *   information for them. Apology only on explicit request.
 */
import type { MessageComponent, MessageComponentKind, RepairAnswers, RepairEdit, RepairField, RepairSource, RepairStatement } from "./types";

const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
const stripEnd = (s: string) => s.replace(/[.!?…\s]+$/, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => (/^I\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

export const src = (field: RepairField, a: RepairAnswers): RepairSource => ({
  sourceType: field === "partnerSaid" ? "PARTNER_MESSAGE" : "USER_REFLECTION", sourceField: field,
  sourcePartner: field === "partnerSaid" ? "PARTNER" : "SELF",
  sourceMessageId: field === "partnerSaid" ? a.partnerSaidMessageId ?? null : null,
  sourceTimestamp: field === "partnerSaid" ? a.partnerSaidAt ?? null : null,
});
const RULE: RepairSource = { sourceType: "RULE_TEMPLATE", sourceField: null, sourcePartner: null, sourceMessageId: null, sourceTimestamp: null };

/** Where a factual clause turns into a conclusion. */
const CONCLUSION = /\s*(?:,\s*)?\b(so clearly|so obviously|so|which means|which shows|that means|that shows|this proves|that proves|because clearly|clearly|obviously)\b\s*/i;
export const GLOBALIZING = /\b(always|never|every (single )?time|all the time|constantly|you don'?t care|you obviously|you never listen|you only think about yourself|again)\b/gi;

export interface SplitResult { fact: string | null; interpretation: string | null; hadGlobalizing: boolean }

export function splitFactFromInterpretation(text: string): SplitResult {
  const t = clean(text);
  if (!t) return { fact: null, interpretation: null, hadGlobalizing: false };
  const m = t.match(CONCLUSION);
  const left = m ? t.slice(0, m.index) : t;
  const right = m ? t.slice((m.index ?? 0) + m[0].length) : null;
  const hadGlobalizing = new RegExp(GLOBALIZING.source, "i").test(t);
  const fact = stripEnd(left.replace(new RegExp(GLOBALIZING.source, "gi"), "").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim());
  return { fact: fact ? `${cap(fact)}.` : null, interpretation: right ? stripEnd(right) : null, hadGlobalizing };
}

export interface Organized {
  facts: RepairStatement[]; userExperience: RepairStatement[]; userNeeds: RepairStatement[]; partnerUnderstanding: RepairStatement[];
  unknowns: RepairStatement[]; possibilities: RepairStatement[]; responsibility: RepairStatement[]; explanation: RepairStatement[];
  boundary: RepairStatement[]; repairGoal: RepairStatement[]; concreteRequest: RepairStatement[]; nextTimePlan: RepairStatement[];
  repairQuestions: RepairStatement[]; communicationNotes: RepairStatement[];
}

export function organize(a: RepairAnswers): Organized {
  const o: Organized = { facts: [], userExperience: [], userNeeds: [], partnerUnderstanding: [], unknowns: [], possibilities: [], responsibility: [], explanation: [], boundary: [], repairGoal: [], concreteRequest: [], nextTimePlan: [], repairQuestions: [], communicationNotes: [] };
  const st = (kind: RepairStatement["kind"], text: string, fields: (RepairField | null)[]): RepairStatement => ({ kind, text, sources: fields.map((f) => (f ? src(f, a) : RULE)) });

  for (const f of ["concreteEvent", "whatHappened"] as const) {
    const raw = clean(a[f]);
    if (!raw) continue;
    const sp = splitFactFromInterpretation(raw);
    if (sp.fact && !o.facts.some((x) => x.text === sp.fact)) o.facts.push(st("FACT", sp.fact, [f]));
    if (sp.interpretation) {
      o.partnerUnderstanding.push(st("INTERPRETATION", `It may feel to you as though this means: “${sp.interpretation}”. That is your reading, not an established fact.`, [f]));
      o.unknowns.push(st("UNKNOWN", `The reason behind it is unknown${sp.fact ? `: ${low(stripEnd(sp.fact))}` : ""}.`, [f]));
      o.possibilities.push(st("POSSIBILITY", "There may have been another reason that hasn't been said yet.", [null]));
    }
    if (sp.hadGlobalizing) {
      o.communicationNotes.push(st("SUGGESTION", "This wording includes generalising words (like \"always\", \"never\" or \"again\"). Describing the specific moment usually makes it easier to talk about.", [f]));
      if (sp.fact && clean(a.myExperience)) o.communicationNotes.push(st("SUGGESTION", `A more specific version could be: “${stripEnd(sp.fact)}, and I felt ${low(stripEnd(clean(a.myExperience)).replace(/^i (felt|feel)\s+/i, ""))}.”`, [f, "myExperience"]));
      else o.communicationNotes.push(st("SUGGESTION", "Which specific moment are you thinking of?", [f]));
    }
  }
  if (clean(a.myExperience)) o.userExperience.push(st("EXPERIENCE", cap(stripEnd(clean(a.myExperience))) + ".", ["myExperience"]));
  if (clean(a.whatMatteredToMe)) o.userNeeds.push(st("EXPERIENCE", cap(stripEnd(clean(a.whatMatteredToMe))) + ".", ["whatMatteredToMe"]));
  if (clean(a.whatMatteredToPartnerGuess)) o.partnerUnderstanding.push(st("INTERPRETATION", `Your guess about what mattered to them: “${stripEnd(clean(a.whatMatteredToPartnerGuess))}”. Only they can confirm this.`, ["whatMatteredToPartnerGuess"]));
  if (clean(a.partnerSaid)) o.partnerUnderstanding.push(st("FACT", `They said: “${clean(a.partnerSaid)}”`, ["partnerSaid"]));
  if (clean(a.uncertainAbout)) o.unknowns.push(st("UNKNOWN", cap(stripEnd(clean(a.uncertainAbout))) + ".", ["uncertainAbout"]));
  if (!clean(a.partnerSaid)) o.unknowns.push(st("UNKNOWN", "What your partner experienced: they haven't said it here.", [null]));
  else o.unknowns.push(st("UNKNOWN", "Anything beyond these exact words: only your partner can explain it.", ["partnerSaid"]));
  if (clean(a.myResponsibility)) o.responsibility.push(st("FACT", cap(stripEnd(clean(a.myResponsibility))) + ".", ["myResponsibility"]));
  if (clean(a.stillNeedToExplain)) o.explanation.push(st("EXPERIENCE", cap(stripEnd(clean(a.stillNeedToExplain))) + ".", ["stillNeedToExplain"]));
  if (clean(a.boundary)) o.boundary.push(st("FACT", cap(stripEnd(clean(a.boundary))) + ".", ["boundary"]));
  if (clean(a.repairLooksLike)) o.repairGoal.push(st("EXPERIENCE", cap(stripEnd(clean(a.repairLooksLike))) + ".", ["repairLooksLike"]));
  if (clean(a.specificChange)) o.concreteRequest.push(st("SUGGESTION", cap(stripEnd(clean(a.specificChange))) + ".", ["specificChange"]));
  if (clean(a.willingToDo)) o.nextTimePlan.push(st("SUGGESTION", cap(stripEnd(clean(a.willingToDo))) + ".", ["willingToDo"]));

  if (clean(a.wantToUnderstand)) o.repairQuestions.push(st("SUGGESTION", questionize(clean(a.wantToUnderstand)), ["wantToUnderstand"]));
  const fact = o.facts[0];
  if (fact && o.partnerUnderstanding.some((p) => p.kind === "INTERPRETATION")) {
    const inner = stripEnd(fact.text);
    const q = /^you\b/i.test(inner) ? `What was happening for you when ${low(inner)}?` : "What was happening for you at that moment?";
    o.repairQuestions.push(st("SUGGESTION", q, [fact.sources[0].sourceField]));
  }
  if (o.repairQuestions.length === 0) o.repairQuestions.push(st("SUGGESTION", "What part of what happened mattered most to you?", [null]));
  return o;
}

function questionize(s: string): string {
  const t = stripEnd(s);
  if (/\?$/.test(s)) return s;
  if (/^(why|what|how|when|whether|if)\b/i.test(t)) {
    const body = t.replace(/^whether\s+|^if\s+/i, "");
    return /^(why|what|how|when)\b/i.test(t) ? `Can you help me understand ${low(t)}?` : `Can you help me understand whether ${low(body)}?`;
  }
  return `Can you help me understand ${low(t)}?`;
}

// ── message ────────────────────────────────────────────────────────────────

export function buildMessage(a: RepairAnswers, o: Organized, edits: RepairEdit[]): MessageComponent[] {
  const E = new Set(edits);
  const c: MessageComponent[] = [];
  const add = (kind: MessageComponentKind, text: string, fields: (RepairField | null)[]) => c.push({ kind, text, sources: fields.map((f) => (f ? src(f, a) : RULE)) });
  const formal = !E.has("TOO_FORMAL");

  const partner = clean(a.partnerSaid);
  if (partner) add("ACKNOWLEDGE", `${formal ? "I understand that you said" : "I hear that you said"}: “${stripEnd(partner)}”.`, ["partnerSaid"]);
  else if (o.facts[0]) add("ACKNOWLEDGE", `${formal ? "I'd like to talk about" : "Can we talk about"} what happened: ${low(stripEnd(o.facts[0].text))}${formal ? "." : "?"}`, [o.facts[0].sources[0].sourceField]);

  const own = clean(a.myResponsibility);
  if (own) {
    const apology = a.apologize && !E.has("TOO_APOLOGETIC") ? "I'm sorry. " : "";
    add("OWN", `${apology}I take responsibility for this part: ${low(stripEnd(own))}.`, ["myResponsibility"]);
  }

  if (!E.has("TOO_DEFENSIVE") && !E.has("NOT_WHAT_I_MEANT")) {
    // "why this hurt" only when THEY said it hurt — otherwise it would assert a feeling nobody stated.
    const saidHurt = /\b(hurt|hurts)\b/i.test(partner);
    if (a.rememberDifferently) add("EXPLAIN", saidHurt ? "I understand why this hurt, but I remember it differently." : partner ? "I understand this mattered to you, but I remember it differently." : "I remember some of it differently.", [partner ? "partnerSaid" : null]);
    if (a.disagreeWithInterpretation) add("EXPLAIN", own ? "I take responsibility for what I did, but I don't agree with every interpretation of it." : "I don't agree with every interpretation of what happened.", [own ? "myResponsibility" : null]);
    const exp = clean(a.stillNeedToExplain);
    if (exp) add("EXPLAIN", `${formal ? "What I meant was" : "From my side,"} ${low(stripEnd(exp))}.`, ["stillNeedToExplain"]);
  }

  const q = o.repairQuestions[0];
  if (q) add("CLARIFY", E.has("ASK_INSTEAD_OF_ASSUME") || E.has("NOT_WHAT_I_MEANT") ? `I don't want to assume. ${q.text}` : q.text, [q.sources[0].sourceField]);

  const will = clean(a.willingToDo);
  if (will) add("NEXT_TIME", `Next time, I can ${low(stripEnd(will)).replace(/^i (will|can|could)\s+/i, "")}.`, ["willingToDo"]);
  const req = clean(a.specificChange);
  if (req) add("REQUEST", `What would help me is: ${low(stripEnd(req))}.`, ["specificChange"]);

  const b = clean(a.boundary);
  if (b || E.has("KEEP_MY_BOUNDARY")) {
    if (b) add("BOUNDARY", a.cannotAgreeToRequest ? `I understand your request, but I can't agree to it, because ${low(stripEnd(b))}.` : `${cap(stripEnd(b))}.`, ["boundary"]);
  } else if (a.cannotAgreeToRequest) {
    add("BOUNDARY", "I understand your request, but I can't agree to it as it stands.", [null]);
  }

  if (E.has("MAKE_SHORTER")) {
    const keep: MessageComponentKind[] = ["OWN", "CLARIFY", "REQUEST", "BOUNDARY"];
    const short = c.filter((x) => keep.includes(x.kind));
    return short.length ? short : c.slice(0, 2);
  }
  return c;
}
