/**
 * Phase 3B — response support entry point. UI → RelationshipAIService.supportResponse → here.
 *
 *   input → manipulation check → deterministic analysis + components (RULE)
 *         → optional LOCAL rephrase of the reply text only
 *         → validation (analysis + every component)
 *         → user-supplied wording that fails is left out with a note;
 *           DuoSpace-authored text that fails → INSUFFICIENT_INFORMATION.
 * Nothing is persisted, logged or sent anywhere.
 */
import { buildSupport, RULE_VERSION } from "./engine";
import { validateAnalysis, validateComponent, type SupportIssue } from "./validate";
import type { ResponseComponent, ResponseSupport, ResponseSupportInput, SourceField, SupportCorrection } from "./types";
import { detectLanguage, isRelLang, needsLimitedMode, type RelLang } from "../i18n/lang";
import { t } from "../i18n/strings";
import { checkSafety, safetyGuidance } from "../repair/machine";

export * from "./types";
export { analyzeMessage, buildSupport, swapPerson, MANIPULATIVE_GOAL, RULE_VERSION } from "./engine";
export { validateSupport, validateComponent, validateAnalysis, MANIPULATIVE_TEXT } from "./validate";
export type { SupportIssue } from "./validate";

/** What a model may contribute: a rephrasing of the reply. Nothing else. */
export interface ResponseRephraser {
  modelVersion: string;
  rephraseResponse(input: { components: { kind: string; text: string }[]; clarificationFirst: boolean }): Promise<unknown>;
}

const USER_FIELDS = new Set(["myOwnAction", "myExperience", "myRequest", "myBoundary", "whatIHeard"]);

export interface SupportOutcome { support: ResponseSupport; usedModel: boolean; issues: SupportIssue[] }

export async function supportResponse(
  input: ResponseSupportInput,
  opts: { nowMs: number; corrections?: SupportCorrection[]; variant?: number; model?: ResponseRephraser | null; timeoutMs?: number; language?: string; region?: string | null },
): Promise<SupportOutcome> {
  let s = buildSupport(input, opts);
  // AUDIT FIX (2026-09-25): the same fail-closed, multilingual safety gate as
  // Conflict Repair. If any text suggests danger or coercion, no reply is
  // drafted (a "responsive" reply to a threat could increase risk); only
  // neutral, localized guidance is returned.
  const gate = checkSafety({ partnerSaid: input.partnerMessage, myExperience: input.myExperience, stillNeedToExplain: input.whatIHeard, myResponsibility: input.myOwnAction, specificChange: input.myRequest, boundary: input.myBoundary });
  if (gate.status === "CONCERN") {
    const all = [input.partnerMessage, input.whatIHeard, input.myExperience].filter(Boolean).join(" ");
    const lang: RelLang = detectLanguage(all).lang !== "en" ? detectLanguage(all).lang : isRelLang(opts.language) ? opts.language : "en";
    const g = safetyGuidance(lang, opts.region ?? null);
    return { support: { ...s, components: [], possibleResponse: "", understandingCheck: null, whatSeemsToMatter: [], safetyHold: true, language: lang, notes: [g.title, ...g.body], refusal: null, insufficientInformation: false }, usedModel: false, issues: [] };
  }
  const texts = [input.partnerMessage, input.whatIHeard, input.myExperience, input.myOwnAction, input.myRequest, input.myBoundary];
  if (!s.refusal && !s.insufficientInformation && needsLimitedMode(texts)) {
    const lang: RelLang = isRelLang(opts.language) && opts.language !== "en" ? opts.language : detectLanguage(texts.filter(Boolean).join(" ")).lang;
    return { support: limitedSupport(s, input, lang, opts.corrections ?? []), usedModel: false, issues: [] };
  }
  if (s.insufficientInformation || s.refusal) return { support: s, usedModel: false, issues: [] };

  // Per-component validation: user-authored wording that fails is dropped with an explanation.
  const kept = []; const notes = [...s.notes]; const issues: SupportIssue[] = [];
  for (const c of s.components) {
    const ci = validateComponent(c, input);
    if (ci.length === 0) { kept.push(c); continue; }
    issues.push(...ci);
    const fromUser = c.sources.every((r) => USER_FIELDS.has(r.sourceField));
    if (fromUser) notes.push(`Left out part of your wording (${c.kind.toLowerCase()}): ${ci[0].message} You can rephrase it in your own words.`);
    else return { support: insufficient(s), usedModel: false, issues };
  }
  s = { ...s, components: kept, notes, possibleResponse: kept.map((c) => c.text).join(" ").trim() };

  const ai = validateAnalysis(s, input);
  if (ai.length) return { support: insufficient(s), usedModel: false, issues: [...issues, ...ai] };
  if (!s.possibleResponse) return { support: insufficient(s), usedModel: false, issues };

  // Optional LOCAL rephrase: validated exactly like a component; any failure keeps the rule text.
  if (opts.model) {
    try {
      const raw = await Promise.race([
        opts.model.rephraseResponse({ components: s.components.map((c) => ({ kind: c.kind, text: c.text })), clarificationFirst: s.clarificationFirst }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), opts.timeoutMs ?? 8000)),
      ]);
      const text = raw && typeof raw === "object" && typeof (raw as { possibleResponse?: unknown }).possibleResponse === "string"
        ? (raw as { possibleResponse: string }).possibleResponse.trim() : "";
      if (text && text.length <= 800) {
        const mi = validateComponent({ kind: "ACKNOWLEDGE", text, sources: [] }, input);
        // A clarification-first reply must still ask.
        if (s.clarificationFirst && !/\?/.test(text)) mi.push({ check: "STRUCTURE", where: "model", message: "Clarification-first reply must ask a question." });
        if (mi.length === 0) return { support: { ...s, possibleResponse: text, modelVersion: opts.model.modelVersion }, usedModel: true, issues };
        issues.push(...mi.map((x) => ({ ...x, where: "model" })));
      }
    } catch { /* timeout / integrity / runtime failure → rule text; no cloud */ }
  }
  return { support: s, usedModel: false, issues };
}

function insufficient(s: ResponseSupport): ResponseSupport {
  return { ...s, components: [], possibleResponse: "INSUFFICIENT_INFORMATION", insufficientInformation: true, modelVersion: RULE_VERSION,
    uncertainty: "DuoSpace couldn't produce a safe, grounded suggestion from this. Asking your partner directly is the best next step." };
}

/** Non-English text: verbatim words in fixed localized templates; clarification first; nothing inferred. */
function limitedSupport(base: ResponseSupport, i: ResponseSupportInput, lang: RelLang, corr: SupportCorrection[]): ResponseSupport {
  const v = (x?: string) => (x ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const ref = (f: SourceField) => ({ sourceField: f, sourcePartner: f === "partnerMessage" ? "PARTNER" as const : "SELF" as const, sourceMessageId: f === "partnerMessage" ? i.partnerMessageId ?? null : null, sourceTimestamp: f === "partnerMessage" ? i.partnerMessageAt ?? null : null });
  const C = new Set(corr);
  const comps: ResponseComponent[] = [];
  const add = (kind: ResponseComponent["kind"], text: string, f: SourceField) => comps.push({ kind, text, sources: [ref(f)] });
  add("ACKNOWLEDGE", t(lang, "ack"), "partnerMessage");
  if (v(i.whatIHeard) && !C.has("NOT_WHAT_I_MEANT")) add("REFLECT", t(lang, "understandCheck", v(i.whatIHeard)), "whatIHeard");
  const short = v(i.partnerMessage).split(/\s+/).length <= 3;
  add("CLARIFY", short ? t(lang, "clarifyAmbiguous") : t(lang, "clarifyGeneric"), "partnerMessage");
  if (v(i.myOwnAction) && !C.has("TOO_APOLOGETIC")) add("OWN", `${i.apologize ? t(lang, "apology") + " " : ""}${t(lang, "own", v(i.myOwnAction))}`, "myOwnAction");
  if (i.seeItDifferently) add("EXPLAIN", t(lang, "rememberDifferently"), "partnerMessage");
  if (v(i.myExperience)) add("EXPLAIN", t(lang, "explain", v(i.myExperience)), "myExperience");
  if (v(i.myRequest)) add("REQUEST", t(lang, "request", v(i.myRequest)), "myRequest");
  if (v(i.myBoundary)) add("BOUNDARY", v(i.myBoundary), "myBoundary");
  return {
    ...base, language: lang, limitedMode: true, modelVersion: RULE_VERSION,
    whatSeemsToMatter: [], textCharacteristics: [],
    whatIsUnknown: [t(lang, "unknownMeaning"), t(lang, "unknownFeelings")],
    clarificationFirst: true, clarifyingQuestion: short ? t(lang, "clarifyAmbiguous") : t(lang, "clarifyGeneric"),
    understandingCheck: v(i.whatIHeard) ? t(lang, "understandCheck", v(i.whatIHeard)) : null,
    components: comps, possibleResponse: comps.map((c) => c.text).join(" "),
    notes: [t(lang, "limitedNotice")], uncertainty: t(lang, "uncertainty"),
  };
}
