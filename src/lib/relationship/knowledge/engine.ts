/**
 * Deterministic reasoning engine (spec §14). Pure: same inputs → same outputs.
 * No AI, no randomness, no I/O, no clock reads (`now` is injected).
 *
 * Order of authority:
 *   1. Safety assessment (overrides everything else)
 *   2. Approved, stage-applicable rules over resolved evidence
 *   3. Honest fall-through: contradictory / insufficient_evidence / unknown
 */
import { resolveFact } from "./evidence";
import { assessSafety, signalsFromObservations, type SafetyAssessment } from "./safety";
import { provenanceFor, ruleExecutable, type KnowledgeSnapshot } from "./snapshot";
import {
  DIMENSIONS, TIER_RANK, type ConfidenceLabel, type Condition, type Dimension, type DimensionResult, type DimensionState,
  type Dyad, type EffectiveFact, type EvidenceTier, type FactParty, type FactRef, type InferenceTrace, type Observation,
  type Party, type RelationshipStage, type Rule,
} from "./types";

export interface EngineInput {
  observations: readonly Observation[];
  dyad: Dyad;
  stage: RelationshipStage;
  contexts?: readonly string[];
  now: Date;
  snapshot: KnowledgeSnapshot;
  /** Precomputed assessment (e.g. including text-derived signals); defaults to structured observations only. */
  safety?: SafetyAssessment;
}

export interface EngineOutput { dimensions: Record<Dimension, DimensionResult>; safety: SafetyAssessment }

const CONF_ORDER: ConfidenceLabel[] = ["unknown", "low", "moderate", "high"];
const minConf = (a: ConfidenceLabel, b: ConfidenceLabel) => (CONF_ORDER.indexOf(a) <= CONF_ORDER.indexOf(b) ? a : b);

/** Engineering mapping from effective numeric confidence to a label (NOT research-derived). */
export function labelFromNumber(n: number): ConfidenceLabel {
  if (!(n > 0)) return "unknown";
  return n < 0.4 ? "low" : n < 0.7 ? "moderate" : "high";
}

/** Tier ceilings: weaker evidence can never yield higher confidence than its authority allows. */
const TIER_CAP: Record<EvidenceTier, ConfidenceLabel> = {
  mutually_confirmed: "high", explicit_self_report: "high", confirmed_partner_report: "moderate",
  observed_pattern: "moderate", unconfirmed_partner_report: "low", inferred: "low",
};

const partyFor = (p: FactParty, x: Party, y: Party): Party => (p === "X" ? x : p === "Y" ? y : p);

function evalCondition(c: Condition, rule: Rule, x: Party, y: Party, get: (p: Party, ref: FactRef) => EffectiveFact): { ok: boolean; facts: EffectiveFact[] } {
  const f = get(partyFor(c.fact.party, x, y), c.fact);
  const facts = [f];
  const policy = rule.confidencePolicy;
  const tierOk = (fact: EffectiveFact): boolean => {
    if (!fact.tier) return false;
    if (fact.tier === "inferred" && !policy.allowInferred) return false;
    return TIER_RANK[fact.tier] >= TIER_RANK[policy.minTier];
  };
  const usable = (fact: EffectiveFact) => fact.state !== "unknown" && fact.state !== "stale" && fact.state !== "contradictory" && tierOk(fact);

  if (c.op === "missing") return { ok: f.state === "unknown", facts };
  if (c.op === "exists") return { ok: usable(f), facts };
  if (!usable(f)) return { ok: false, facts };
  if (c.other) {
    const o = get(partyFor(c.other.party, x, y), c.other);
    facts.push(o);
    if (!usable(o)) return { ok: false, facts };
    const same = String(f.value) === String(o.value);
    return { ok: c.op === "eq" ? same : c.op === "ne" ? !same : false, facts };
  }
  const v = f.value;
  if (c.op === "eq") return { ok: String(v) === String(c.value), facts };
  if (c.op === "ne") return { ok: String(v) !== String(c.value), facts };
  if (c.op === "in") return { ok: Array.isArray(c.value) && c.value.map(String).includes(String(v)), facts };
  return { ok: false, facts };
}

interface Match { rule: Rule; facts: EffectiveFact[]; key: string }

function combine(states: DimensionState[]): DimensionState {
  const u = [...new Set(states)];
  return u.length === 1 ? u[0] : "mixed";
}

function perspectiveOf(facts: EffectiveFact[], dyad: Dyad): { perspective: string; sourceType: string } {
  const tiers = new Set(facts.filter((f) => f.tier).map((f) => f.tier as EvidenceTier));
  const parties = new Set(facts.filter((f) => f.tier).map((f) => f.party));
  const bothSelf = parties.has("A") && parties.has("B") && [...tiers].every((t) => t === "explicit_self_report" || t === "mutually_confirmed");
  const perspective = bothSelf ? "both_partner_reports" : parties.size >= 2 ? "both_parties_mixed_sources"
    : tiers.has("unconfirmed_partner_report") ? "one_partner_report_about_other" : tiers.has("inferred") ? "inferred_from_language" : "one_partner_report";
  const sourceType = [...tiers].sort().join("+") || "none";
  void dyad;
  return { perspective, sourceType };
}

export function runEngine(input: EngineInput): EngineOutput {
  const { observations, dyad, stage, now, snapshot } = input;
  const safety = input.safety ?? assessSafety(signalsFromObservations(observations.filter((o) => o.relationshipId === dyad.relationshipId)), now,
    observations.filter((o) => o.relationshipId === dyad.relationshipId).map((o) => o.observedAt).sort().pop());

  const cache = new Map<string, EffectiveFact>();
  const get = (p: Party, ref: FactRef): EffectiveFact => {
    const k = `${p}|${ref.construct}|${ref.key}`;
    let f = cache.get(k);
    if (!f) { f = resolveFact(observations, p, dyad, ref.construct, ref.key, now); cache.set(k, f); }
    return f;
  };

  const out = {} as Record<Dimension, DimensionResult>;
  for (const dim of DIMENSIONS) {
    out[dim] = { dimension: dim, state: "unknown", confidence: "unknown", evidenceSourceType: "none", perspective: "none", limitations: [], traces: [], statementKeys: [] };
  }

  // 1. SAFETY OVERRIDE — ordinary reasoning is withheld, not merely outranked.
  if (safety.state !== "none") {
    for (const dim of DIMENSIONS) if (dim !== "safety") out[dim] = { ...out[dim], suppressedBecause: "safety_override" };
    out.safety = {
      dimension: "safety", state: "mixed", confidence: safety.state === "possible_safety_concern" ? "low" : "moderate",
      evidenceSourceType: "reported_safety_indicators", perspective: "reporter_only",
      limitations: ["This is not an assessment of anyone's safety.", "Only the person who reported it sees this."],
      traces: [], statementKeys: [safety.responseKey === "safety.urgent" ? "safety.review" : "safety.review"],
    };
    return { dimensions: out, safety };
  }

  // 2. RULES
  const eligible = snapshot.rules
    .filter((r) => ruleExecutable(r, snapshot.claims, snapshot.sources))
    .filter((r) => r.applicableStages.length === 0 || r.applicableStages.includes(stage))
    .filter((r) => r.applicableContexts.length === 0 || r.applicableContexts.some((c) => input.contexts?.includes(c)))
    .sort((a, b) => b.safetyPriority - a.safetyPriority || a.ruleKey.localeCompare(b.ruleKey));

  const matchesByDim = new Map<Dimension, Match[]>();
  const relevantFacts = new Map<Dimension, EffectiveFact[]>();

  for (const rule of eligible) {
    const pairs: [Party, Party][] = [["A", "B"], ["B", "A"]];
    const seen = new Set<string>();
    for (const [x, y] of pairs) {
      const evals = rule.conditions.map((c) => evalCondition(c, rule, x, y, get));
      const facts = evals.flatMap((e) => e.facts);
      const list = relevantFacts.get(rule.dimension) ?? [];
      list.push(...facts); relevantFacts.set(rule.dimension, list);
      if (!evals.every((e) => e.ok)) continue;
      if (facts.some((f) => rule.excludedEvidence.states?.includes(f.state))) continue;
      const needParties = rule.requiredEvidence.distinctParties ?? 1;
      if (new Set(facts.filter((f) => f.tier).map((f) => f.party)).size < needParties) continue;
      const key = `${rule.ruleKey}|${[...new Set(facts.flatMap((f) => f.observationIds))].sort().join(",")}`;
      if (seen.has(key)) continue; // symmetric rule matched under both X/Y assignments
      seen.add(key);
      const arr = matchesByDim.get(rule.dimension) ?? [];
      arr.push({ rule, facts, key });
      matchesByDim.set(rule.dimension, arr);
    }
  }

  for (const dim of DIMENSIONS) {
    if (dim === "safety") continue;
    const ms = matchesByDim.get(dim) ?? [];
    const facts = relevantFacts.get(dim) ?? [];
    if (ms.length === 0) {
      const contradictory = facts.some((f) => f.state === "contradictory");
      const stale = facts.some((f) => f.state === "stale");
      const anyKnown = facts.some((f) => f.tier && f.state !== "stale" && f.state !== "contradictory");
      out[dim] = {
        ...out[dim],
        state: contradictory ? "contradictory" : anyKnown || stale ? "insufficient_evidence" : "unknown",
        statementKeys: [contradictory ? "contradictory.generic" : "unknown.generic"],
        limitations: stale ? ["Some earlier answers are out of date and were not used as current."] : [],
      };
      continue;
    }
    const states = ms.map((m) => m.rule.outputState);
    const state = combine(states);
    let conf: ConfidenceLabel = "high";
    const traces: InferenceTrace[] = [];
    const allFacts: EffectiveFact[] = [];
    for (const m of ms) {
      let c: ConfidenceLabel = m.rule.confidencePolicy.cap;
      const used = m.facts.filter((f) => f.tier);
      for (const f of used) { c = minConf(c, TIER_CAP[f.tier as EvidenceTier]); c = minConf(c, labelFromNumber(f.confidence)); }
      conf = minConf(conf, c);
      allFacts.push(...used);
      const prov = provenanceFor(m.rule, snapshot);
      traces.push({
        ruleKey: m.rule.ruleKey, ruleVersion: m.rule.version, knowledgeVersion: snapshot.knowledgeVersion, taxonomyVersion: snapshot.taxonomyVersion,
        observationIds: [...new Set(m.facts.flatMap((f) => f.observationIds))], claimKeys: prov.claimKeys, sourceKeys: prov.sourceKeys,
        inputState: Object.fromEntries(m.facts.map((f) => [`${f.party}:${f.constructId}.${f.attributeKey}`, `${f.state}:${String(f.value)}`])),
      });
    }
    const { perspective, sourceType } = perspectiveOf(allFacts, dyad);
    out[dim] = {
      dimension: dim, state, confidence: conf, evidenceSourceType: sourceType, perspective,
      limitations: [...new Set(ms.flatMap((m) => m.rule.limitations))], traces,
      statementKeys: state === "mixed" && new Set(states).size > 1 ? ["mixed.generic", ...ms.map((m) => m.rule.statementKey)] : [...new Set(ms.map((m) => m.rule.statementKey))],
    };
  }
  return { dimensions: out, safety };
}
