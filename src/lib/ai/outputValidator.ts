/**
 * Safety validator for AI-generated relationship insight text. See
 * .ai/AI_SAFETY_SPEC.md and .ai/DO_NOT_BUILD.md.
 *
 * Two layers, per the brief's own instruction not to rely solely on
 * string matching:
 *   1. Typed-contract validation — does this NewAIInsight actually have
 *      the required structure (possibleExplanations plural, uncertainty
 *      present, confidence not overstated relative to its source)? This
 *      is the primary defense: a well-formed insight object structurally
 *      cannot express bare certainty, because there's no field for it.
 *   2. A string-pattern check on the free-text fields (observation,
 *      context, suggestedAction) as a second, independent net — catches
 *      a badly-behaved generator that fills the right fields with the
 *      wrong kind of sentence.
 *
 * Nothing in this codebase currently generates insight text to validate
 * (feature freeze) — this exists so the first real feature that does has
 * a required checkpoint to call before anything gets stored or shown.
 */

import type { NewAIInsight } from "./types";
import { InsightSource, InsightConfidence } from "./types";

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Phrases that assert a fact this whole project's own research (see
 * .ai/SCIENTIFIC_FOUNDATION.md) found no evidentiary basis for. Matched
 * case-insensitively as substrings, not whole-message equality — a
 * generator working around this by rephrasing is exactly the failure
 * mode layer 1 (structural validation) is meant to catch instead.
 */
const PROHIBITED_PATTERNS: RegExp[] = [
  /cheat(ing)?/i,
  /\blying\b|\blied\b|\bliar\b/i,
  /definitely (angry|upset|sad|happy|lying|cheating)/i,
  /doesn'?t love you/i,
  /relationship will fail/i,
  /you should break up/i,
  /\btoxic\b/i,
  /trust this (person|partner) 100%/i,
  /definitely hiding something/i,
  /proves? (deception|lying|dishonesty)/i,
  // Phase 1.6 additions — each maps to a conclusion the spec says a model
  // may never assert as fact (see .ai/AI_SAFETY_SPEC.md):
  /\b(deceiv\w*|deceit\w*|deception|dishonest\w*|gaslight\w*|manipulat\w*)\b/i, // deception
  /hidden (intentions?|agenda|motives?)|(secretly|is|are) hiding/i, // hidden intentions
  /\b(definitely|certainly|clearly|obviously|undoubtedly|surely)\s+(angry|furious|upset|mad|resentful|lying|cheating|hiding|deceiving)\b/i, // definite anger
  /\b(no longer|stopped|doesn'?t|does not|don'?t|do not|didn'?t|did not|never|won'?t)\s+(really\s+|even\s+|actually\s+)?(love[sd]?|care[sd]?)\b/i, // lack of love (incl. plural "they don't care")
  /(relationship|marriage|partnership)\s+(is|was|will be|has)\s+(doomed|over|failing|failed|a failure|not going to (last|work))/i, // relationship failure
  /\b(should|need to|must|have to)\b[^.]{0,40}\b(break ?up|leave (him|her|them|your partner)|end (it|the relationship))\b/i, // breakup necessity
  /\b(abusive|narcissist\w*|sociopath\w*|psychopath\w*)\b/i, // toxic-partner labels
  /guarantee[sd]?\b|100\s*%\s*(trust|honest|loyal|faithful|sure|certain)|completely (trustworthy|honest|faithful)/i, // guaranteed trustworthiness

  // Phase 2A (relationship reflection) additions. Each maps to a claim the
  // Phase 2A brief (§8) says the AI may never infer or assert. Patterns are
  // deliberately about the CLAIM, not one wording of it, and they are a second
  // net: the structural rules in checkRelationshipRules() below are the first.
  /\battract(ed|ion)\s+to\s+(someone|somebody|another|other|a\s+(different|new)|her|him|them)\b|\b(has|have|had)\s+(a\s+)?crush\s+on\b|\b(interested|into)\s+(in\s+)?(someone|somebody|another\s+(person|woman|man))\b/i, // attraction to another person
  /\b(emotional(ly)?|verbal(ly)?|psychological(ly)?|physical(ly)?|financial(ly)?)\s+abus\w*|\babus(e|es|ed|er|ers|ive|ing)\b|coercive\s+control|controlling\s+behaviou?r/i, // abuse
  /\bnarcissis\w*|\bnpd\b|personality\s+disorder|\bborderline\b|\bbipolar\b|\bmental(ly)?\s+(ill|illness|unwell)|\bdiagnos(is|es|ed|e|ing)\b|\bcodepend\w*|\b(anxious|avoidant|disorgani[sz]ed)\s+attachment|emotionally\s+(unavailable|immature|stunted)/i, // personality disorder / diagnosis / psychological labels
  /\btoxic\w*/i, // toxicity in any form (the older pattern above only caught the bare word)
  /(relationship|marriage|partnership)\s+(won'?t|will\s+not|isn'?t\s+going\s+to|is\s+not\s+going\s+to)\s+(last|work|survive)|\bno\s+future\b|not\s+meant\s+to\s+be|\bincompatib\w*|\bdoomed\b|beyond\s+repair/i, // relationship failure
  /\b(consider|think\s+about|time\s+to)\s+(leaving|ending\s+(it|the\s+relationship)|breaking\s+up|moving\s+on|walking\s+away)\b|\bwalk\s+away\b|\bbetter\s+off\s+(without|alone)\b|\bcut\s+(them|him|her)\s+off\b/i, // breakup necessity (softer phrasings)
  /\b(your\s+partner|he|she|they)\s+(is|are|was|were)\s+(guilty|to\s+blame|at\s+fault|responsible\s+for\s+(this|the\s+problem))\b|\b(it'?s|it\s+is)\s+(their|his|her)\s+fault\b|\bblame\s+(your\s+partner|them|him|her)\b/i, // partner guilt
  /\b(your\s+partner|he|she|they)\s+(is|are|was|were)\s+(feeling|angry|upset|jealous|anxious|depressed|insecure|resentful|bored|scared|afraid|ashamed|lying|hiding)\b|\b(your\s+partner|he|she|they)\s+(feels|felt|thinks|thought|wants|wanted|intends?|intended|meant|knows|knew|believes?|resents?|hates?|fears?|loves?|craves?|needs)\b/i, // partner mental state stated as fact
  /\bnot\s+(being\s+)?(honest|truthful|faithful|loyal)\b|\bisn'?t\s+(being\s+)?(honest|truthful|faithful|loyal)\b|\buntruthful\b|\b(being\s+)?(sneaky|secretive)\b|\bcovering\s+up\b|\bwithholding\s+the\s+truth\b/i, // deception, other wordings
  /\b(your\s+partner|he|she|they)\s+(is|are|was|were)\s+(ignoring|avoiding|punishing|testing|neglecting|rejecting|betraying|disrespecting|dismissing)\s+you\b|\b(your\s+partner|he|she|they)\s+(does\s*n'?t|do\s*n'?t|did\s*n'?t|does\s+not|do\s+not|did\s+not|never)\s+(respect|value|listen|appreciate|prioriti[sz]e|want)\b/i, // verdicts about a partner's regard for the user
  // No relationship score of any kind (brief §9). Digits are fine ("3 items");
  // percentages, ratios, "out of", and score/rank vocabulary are not.
  // ── Phase 2B: euphemistic / hedged forms. A hedge ("may", "might",
  // "probably") does not make a claim about the partner's mind, fidelity or
  // honesty acceptable — the input cannot support it either way.
  /\b(your\s+partner|he|she|they)(\s+(may|might|could|must|probably|likely|clearly|really|definitely))?\s+(not\s+)?(feel|feels|felt|think|thinks|thought|know|knows|knew|want|wants|wanted|believe|believes|intend|intends|intended|resent|resents|hate|hates|fear|fears|regret|regrets|blame|blames)\b/i, // partner mind/feeling, incl. plural + hedged
  /\b(your\s+partner|he|she|they)(\s+(may|might|could|must|probably|likely))?\s+(is|are|was|were|be|seem(s|ed)?|look(s|ed)?|sound(s|ed)?)\s+((probably|likely|clearly|really|very|so|quite|a\s+bit)\s+)*(angry|upset|mad|jealous|hurt|annoyed|irritated|disappointed|resentful|neglected|bored|distant|cold|frustrated|sad|unhappy|insecure|anxious|depressed|ashamed|guilty)\b/i, // partner emotional state
  /\binfidel\w*|\bunfaithful\b|\baffair\b|\b(seeing|dating|texting|talking\s+to|sleeping\s+with|with)\s+(someone|somebody)\s+(else|new)\b|\b(the\s+)?other\s+(woman|man)\b/i, // cheating euphemisms
  /\bnot\s+(be(ing)?\s+)?(telling|saying)\s+(you\s+)?the\s+(whole\s+)?truth|\bkeep(s|ing)?\s+(secrets|things)\s+from\b|\b(may|might|could|must|probably|likely)\s+be\s+hiding\b|\bhiding\s+(something|things|the\s+truth|stuff)\b/i, // lying / concealment euphemisms
  /\bred\s+flags?\b|\bwarning\s+signs?\b/i, // verdict idioms
  /\bon\s+purpose\b|\bdeliberately\b|\bintentionally\b|\bto\s+hurt\s+you\b|\bsecretly\s+\w+/i, // imputed intent
  /\blost\s+(interest|feelings)\b|\bfeelings\s+(for\s+you\s+)?(have\s+|had\s+)?(faded|died|changed|gone|disappeared)\b|\bfall(en|ing)?\s+out\s+of\s+love\b|\bno\s+longer\s+(interested|attracted|in\s+love)\b/i, // loss of love
  /\btime\s+to\s+(leave|go|move\s+on|let\s+(go|them\s+go)|end\s+(it|things))\b|\bshould\s+(leave|end|walk)\b/i, // breakup necessity
  /\b(depress\w*|anxiety\s+disorder|\bptsd\b|\badhd\b|\bocd\b|\bautis\w*|\bmental\s+health\s+(issue|problem|condition))\b/i, // diagnosis
  // ── Phase 2C: subtler unsupported inferences ─────────────────────────
  /\bif\s+(they|he|she|your\s+partner)\s+(really\s+|truly\s+|actually\s+)?(cared|loved|respected|wanted)\b|\bsomeone\s+who\s+(really\s+|truly\s+)?(loves|cares\s+about|respects)\s+you\b/i, // conditional love tests
  /\bmost\s+(people|partners|men|women|couples)\s+who\b|\btypical\s+of\s+(a|an)\s+\w+\s+(partner|person|type)\b|\b(avoidant|anxious|disorganized|dismissive)\s+(partner|attachment|type|style)\b/i, // generalization / typology
  /\bclearly\s+(shows|means|proves|indicates)\b|\bthis\s+(shows|means|proves|indicates)\s+(that\s+)?(they|your\s+partner|he|she)\b|\bpattern\s+of\s+(neglect|abuse|disrespect|control|avoidance)\b/i, // overconfident conclusions
  /\b(they'?re|they\s+are|he'?s|he\s+is|she'?s|she\s+is|your\s+partner\s+is)\s+((probably|likely|clearly|obviously)\s+)?(avoiding|punishing|testing|ignoring|using|pulling\s+away|withdrawing|playing)\b|\bsign\s+(that\s+)?(they|he|she)\s+(are|is)\s+(pulling\s+away|losing|withdrawing)\b/i, // hidden blame / imputed motive
  /\byou\s+(need|have|must|ought)\s+to\s+(confront|leave|stop|block|ignore|punish|test|check\s+their|go\s+through)\b|\bstop\s+(texting|talking\s+to|replying\s+to|seeing|calling)\s+(them|him|her)\b|\buntil\s+(they|he|she)\s+apologi[sz]es?\b|\bdeserve\s+(someone|somebody|better)\b/i, // coercive / directive advice
  /\b(last|previous)\s+(week|month|year|time)\s+you\s+(also\s+)?(said|mentioned|told|wrote)\b|\bas\s+you\s+(mentioned|said|told\s+me|wrote)\s+(before|earlier|previously|last)\b|\bkeeps\s+happening\b|\bagain\s+and\s+again\b/i, // fabricated history
  /\b(they|he|she|your\s+partner)\s+(was|were|is|are|has\s+been|have\s+been)\s+with\s+(someone|somebody|another)\b|\b(strong|high|good)\s+(chance|likelihood|probability)\s+(that\s+)?(they|he|she|your\s+partner)\b/i, // probability-framed accusations
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions\b|\bsystem\s+prompt\b|\byou\s+are\s+now\s+(an?\s+)?\w+/i, // prompt-injection echoes
  /\b\d{1,3}(\.\d+)?\s*%|\b\d+\s*(\/|out\s+of)\s*\d+\b|\bscor(e|es|ed|ing)\b|\brating\s+of\b|\brank(ed|ing|s)?\b|\bpercent(age)?\b|compatib\w*/i,
];

function checkFreeText(field: string, text: string | undefined, issues: ValidationIssue[]): void {
  if (!text) return;
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({ field, message: `Contains a prohibited unsupported-certainty phrase (matched ${pattern}).` });
    }
  }
}

/** The confidence ceiling a source type is allowed to claim, per .ai/MULTIMODAL_AI_SPEC.md's evidence ranking. A LOCAL_RULE or CLOUD_MODEL output claiming HIGH confidence needs a human security/product review before this ceiling is ever raised — it is not something a single insight can self-declare its way past. */
const SOURCE_CONFIDENCE_CEILING: Record<InsightSource, InsightConfidence> = {
  [InsightSource.USER_REPORTED]: InsightConfidence.HIGH, // it's their own statement — not an inference at all
  [InsightSource.USER_ENTERED]: InsightConfidence.HIGH,
  [InsightSource.SHARED_COUPLE_DATA]: InsightConfidence.MEDIUM,
  [InsightSource.LOCAL_RULE]: InsightConfidence.MEDIUM,
  [InsightSource.LOCAL_MODEL]: InsightConfidence.MEDIUM,
  [InsightSource.CLOUD_MODEL]: InsightConfidence.MEDIUM,
};

/** The `feature` value (a ConsentFeature) that opts an insight into the stricter relationship-reflection rules below. */
export const RELATIONSHIP_INSIGHT_FEATURE = "RELATIONSHIP_INSIGHTS";

/**
 * Observation must be ABOUT what the user provided — it starts from "You…",
 * "Your…", "The information you…", "In your…". This is the structural half of
 * "separate OBSERVATION from INTERPRETATION": an observation cannot begin by
 * asserting something about the partner or about the world.
 */
// "Your …" is user-attributed ONLY if it is not "Your partner/spouse/…":
// "Your partner ignored your requests" starts with "Your" but is a claim
// about the partner, and used to pass this check.
const USER_ATTRIBUTED_OBSERVATION = /^\s*(you\b|your\b(?!\s+(partner|spouse|husband|wife|boyfriend|girlfriend|fianc[eé]e?|significant\s+other|other\s+half)\b)|the\s+(information|details|answers|notes|reflection|items)\s+you\b|in\s+your\b|from\s+your\b|based\s+on\s+(what\s+)?you\b)/i;

/** A possible explanation must be phrased as a possibility, never as established fact. */
const HEDGED = /\b(may|might|could|can\s+be|possibly|perhaps|one\s+possibility|it\s+is\s+possible|sometimes|often|can\s+(mean|reflect|feel))\b/i;

const IMPERATIVE_TO_USER = /\byou\s+(must|need\s+to|have\s+to|should|ought\s+to)\b/i;

const RELATIONSHIP_ANALYSIS_KINDS: readonly string[] = ["VALUES", "EXPECTATIONS", "COMMUNICATION_REFLECTION"];

function checkRelationshipRules(draft: NewAIInsight, issues: ValidationIssue[]): void {
  if (draft.observation && !USER_ATTRIBUTED_OBSERVATION.test(draft.observation)) {
    issues.push({ field: "observation", message: "A relationship observation must be attributed to what the user provided (start with \"You…\", \"Your…\", or \"The information you…\")." });
  }
  if ((draft.observation ?? "").length > 400) {
    issues.push({ field: "observation", message: "observation is too long (max 400 characters) — keep it specific." });
  }
  for (const e of draft.possibleExplanations ?? []) {
    if (!HEDGED.test(e)) {
      issues.push({ field: "possibleExplanations", message: "Each possible explanation must be phrased as a possibility (may / might / could …), never as fact." });
    }
    if (e.length > 300) issues.push({ field: "possibleExplanations", message: "A possible explanation is too long (max 300 characters)." });
  }
  if ((draft.possibleExplanations ?? []).length > 6) {
    issues.push({ field: "possibleExplanations", message: "At most six possible explanations." });
  }
  const evidence = draft.evidence ?? [];
  if (evidence.length === 0 || evidence.some((e) => !e || !e.trim())) {
    issues.push({ field: "evidence", message: "At least one evidence reference (which of the user's own inputs led here) is required." });
  }
  if (evidence.length > 6) issues.push({ field: "evidence", message: "At most six evidence references." });
  if (!draft.analysisKind || !RELATIONSHIP_ANALYSIS_KINDS.includes(draft.analysisKind)) {
    issues.push({ field: "analysisKind", message: "A relationship insight must declare its analysisKind." });
  }
  if (draft.suggestedAction && IMPERATIVE_TO_USER.test(draft.suggestedAction)) {
    issues.push({ field: "suggestedAction", message: "A suggested action is an invitation (\"You could…\"), not a command." });
  }
}

export function validateInsight(draft: NewAIInsight): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Structural checks.
  if (!draft.observation?.trim()) {
    issues.push({ field: "observation", message: "observation is required and must be specific." });
  }
  if (!draft.uncertainty?.trim()) {
    issues.push({ field: "uncertainty", message: "uncertainty is required — an insight with no stated uncertainty is exactly the false-precision this contract exists to prevent." });
  }
  if (!draft.possibleExplanations || draft.possibleExplanations.length < 2) {
    issues.push({ field: "possibleExplanations", message: "At least two possible explanations are required, including a mundane/non-relationship one." });
  }
  if ((draft.source === InsightSource.LOCAL_MODEL || draft.source === InsightSource.CLOUD_MODEL) && !draft.modelVersion) {
    issues.push({ field: "modelVersion", message: "modelVersion is required when source is a model, for provenance/calibration." });
  }
  if (!draft.consentReference) {
    issues.push({ field: "consentReference", message: "consentReference is required — an insight must be traceable to the consent that authorized it." });
  }

  // Confidence-ceiling check.
  const ceiling = SOURCE_CONFIDENCE_CEILING[draft.source];
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  if (rank[draft.confidence] > rank[ceiling]) {
    issues.push({
      field: "confidence",
      message: `Source "${draft.source}" may not claim confidence above ${ceiling}; got ${draft.confidence}.`,
    });
  }

  // Free-text pattern checks.
  checkFreeText("observation", draft.observation, issues);
  // Phase 2A: `uncertainty` and `evidence` are user-facing free text too — the
  // Phase 1 validator did not scan them, which left a place to put a claim.
  checkFreeText("uncertainty", draft.uncertainty, issues);
  checkFreeText("context", draft.context, issues);
  checkFreeText("suggestedAction", draft.suggestedAction, issues);
  for (const explanation of draft.possibleExplanations ?? []) {
    checkFreeText("possibleExplanations", explanation, issues);
  }
  for (const ref of draft.evidence ?? []) {
    checkFreeText("evidence", ref, issues);
  }

  if (draft.feature === RELATIONSHIP_INSIGHT_FEATURE) {
    checkRelationshipRules(draft, issues);
  }

  // suggestedAction must not be directed at the partner.
  if (draft.suggestedAction && /\byour partner should\b|\bthey should\b|\btell (them|your partner) to\b/i.test(draft.suggestedAction)) {
    issues.push({ field: "suggestedAction", message: "Suggested actions must be for the user themselves, never instructions directed at their partner." });
  }

  return { valid: issues.length === 0, issues };
}

/** Throws with a readable message if invalid — for call sites that want fail-fast. */
export function assertValidInsight(draft: NewAIInsight): void {
  const result = validateInsight(draft);
  if (!result.valid) {
    throw new Error(
      `Insight failed safety validation: ${result.issues.map((i) => `[${i.field}] ${i.message}`).join("; ")}`,
    );
  }
}
