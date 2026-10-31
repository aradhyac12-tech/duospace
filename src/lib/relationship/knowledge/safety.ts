/**
 * Safety override layer (spec §16).
 *
 * Priority: this runs BEFORE ordinary reasoning. Any state other than "none"
 * suppresses ordinary relationship advice (see engine.ts) and forbids joint
 * confrontation suggestions.
 *
 * What this is NOT: a diagnosis or a screening instrument. The state names
 * describe how strongly a concern has been *reported*, never a finding that
 * abuse is occurring. Thresholds below are PRODUCT POLICY chosen to err on the
 * side of showing support options; they are not research-derived and require
 * review by a domestic-violence advocate/clinician before launch.
 *
 * Privacy: a safety assessment belongs to the person who reported it. It is
 * never shared with the partner (`shareWithPartner` is always false) because
 * the partner may be the source of the danger.
 */
import { SAFETY_RANK, type Observation, type SafetyState } from "./types";

export type SafetyIndicator =
  // strong: unambiguous behaviours
  | "physical_violence" | "sexual_coercion" | "threat_of_harm" | "stalking" | "weapon_threat" | "threat_to_children_or_pets"
  // weaker / coercive-control patterns
  | "monitoring_phone" | "anger_at_friend_contact" | "isolation" | "financial_control" | "repeated_intimidation"
  | "psychological_aggression" | "blackmail"
  // fear and immediacy
  | "fear_for_safety" | "imminent_danger";

const STRONG: ReadonlySet<SafetyIndicator> = new Set(["physical_violence", "sexual_coercion", "threat_of_harm", "stalking", "weapon_threat", "threat_to_children_or_pets"]);
const URGENT: ReadonlySet<SafetyIndicator> = new Set(["imminent_danger"]);
const WEAK: ReadonlySet<SafetyIndicator> = new Set(["monitoring_phone", "anger_at_friend_contact", "isolation", "financial_control", "repeated_intimidation", "psychological_aggression", "blackmail"]);

export const SAFETY_CONSTRUCTS = new Set(["safety", "intimate_partner_violence", "psychological_aggression", "stalking", "coercive_control"]);
export const isSafetyIndicator = (k: string): k is SafetyIndicator => STRONG.has(k as SafetyIndicator) || WEAK.has(k as SafetyIndicator) || URGENT.has(k as SafetyIndicator) || k === "fear_for_safety";

export interface SafetySignal {
  indicator: SafetyIndicator;
  /** The reporter describes this happening to THEM, in their own words/choice. */
  firstPerson: boolean;
  /** The reporter confirmed it when asked (e.g. on the support screen). */
  confirmedByReporter: boolean;
  /** Came from language analysis rather than an explicit structured answer. */
  fromText: boolean;
  observationId?: string;
}

export interface SafetyAssessment {
  state: SafetyState;
  indicators: SafetyIndicator[];
  evidenceIds: string[];
  rationale: string;
  /** Ordinary relationship tips/insights must be withheld. */
  suppressOrdinaryAdvice: boolean;
  /** Never suggest talking it through with, or confronting, the partner together. */
  jointConfrontationAllowed: false;
  /** Always false: the partner may be the source of the danger. */
  shareWithPartner: false;
  needsReconfirmation: boolean;
  responseKey: "safety.none" | "safety.review" | "safety.urgent";
}

/** Structured safety observations → signals. Stale safety evidence is still counted (never auto-cleared). */
export function signalsFromObservations(obs: readonly Observation[]): SafetySignal[] {
  const out: SafetySignal[] = [];
  for (const o of obs) {
    if (!SAFETY_CONSTRUCTS.has(o.constructId) || !isSafetyIndicator(o.attributeKey)) continue;
    if (o.value !== true && o.value !== "true") continue;
    if (o.confirmationStatus === "withdrawn") continue; // the reporter themself withdrew it
    out.push({
      indicator: o.attributeKey, firstPerson: o.sourceType === "self_report",
      confirmedByReporter: o.sourceType === "self_report" && o.confirmationStatus === "confirmed",
      fromText: o.sourceType === "inferred", observationId: o.observationId,
    });
  }
  return out;
}

export function assessSafety(signals: readonly SafetySignal[], now: Date = new Date(), lastEvidenceAt?: string | null): SafetyAssessment {
  const mk = (state: SafetyState, rationale: string, ids: string[], inds: SafetyIndicator[]): SafetyAssessment => ({
    state, indicators: [...new Set(inds)], evidenceIds: ids, rationale,
    suppressOrdinaryAdvice: state !== "none", jointConfrontationAllowed: false, shareWithPartner: false,
    needsReconfirmation: state !== "none" && !!lastEvidenceAt && now.getTime() - Date.parse(lastEvidenceAt) > 180 * 86_400_000,
    responseKey: state === "none" ? "safety.none" : state === "urgent_safety_concern" ? "safety.urgent" : "safety.review",
  });
  if (signals.length === 0) return mk("none", "no safety indicators", [], []);

  const ids = signals.map((s) => s.observationId).filter((x): x is string => !!x);
  const inds = signals.map((s) => s.indicator);
  const distinctWeak = new Set(signals.filter((s) => WEAK.has(s.indicator)).map((s) => s.indicator));
  const strong = signals.filter((s) => STRONG.has(s.indicator));
  const fear = signals.some((s) => s.indicator === "fear_for_safety" && s.firstPerson);

  // urgent: an explicit statement of imminent danger. Text-derived is enough — a
  // false positive costs a support screen; a false negative can cost far more.
  if (signals.some((s) => URGENT.has(s.indicator) && s.firstPerson)) return mk("urgent_safety_concern", "imminent danger reported", ids, inds);

  const strongFirst = strong.some((s) => s.firstPerson);
  const reportedLevel = strongFirst || distinctWeak.size >= 2 || (distinctWeak.size >= 1 && fear);
  if (reportedLevel) {
    // "confirmed" = the reporter confirmed it themselves when asked; not external verification.
    const confirmed = signals.some((s) => s.firstPerson && s.confirmedByReporter);
    return mk(confirmed ? "confirmed_safety_concern" : "reported_safety_concern", confirmed ? "reported and confirmed by the reporter" : "first-person report of strong or multiple concerning behaviours", ids, inds);
  }
  // A single weaker indicator, or anything not first-person (a partner's/third-party report, inference).
  return mk("possible_safety_concern", "a single or indirect indicator; ambiguous alone", ids, inds);
}

export const maxSafety = (a: SafetyState, b: SafetyState): SafetyState => (SAFETY_RANK[a] >= SAFETY_RANK[b] ? a : b);

// ── localised support copy ──────────────────────────────────────────────────
// Reuse the app's existing, reviewed safety copy and region rule (repair/machine.ts
// + i18n/strings.ts): the emergency number is only named when the DEVICE REGION is
// confidently India; otherwise wording stays neutral. No second number table is
// kept here — extra helpline numbers were deliberately NOT added because they
// could not be verified offline. Add them to i18n/strings.ts after verification.
export { safetyGuidance as localizedSafetyGuidance } from "../repair/machine";

export const SAFETY_AVOID_PHRASES = ["talk it through together", "confront", "sit down with your partner", "work on your communication"] as const;
