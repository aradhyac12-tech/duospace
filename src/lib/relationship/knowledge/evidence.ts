/**
 * Evidence model (spec §9, §10, §12): tier derivation, authority ordering and
 * resolution of "what do we currently know about X for party P".
 *
 * Invariants enforced here (and tested):
 *  - A partner's report about B is never B's own statement.
 *  - Inferred evidence never becomes explicit, however it is stored.
 *  - Unknown stays unknown; stale evidence never reads as current.
 *  - Disagreement at equal authority is `contradictory`, not averaged.
 */
import { decayedConfidence, ageDays, referenceTimeMs, staleReason } from "./temporal";
import {
  TIER_RANK, type AttrValue, type Dyad, type EffectiveFact, type EvidenceState, type EvidenceTier,
  type Observation, type Party,
} from "./types";

/** Recompute the tier from source facts; a stored tier can only be *lowered* by this. */
export function deriveTier(o: Observation): EvidenceTier {
  switch (o.sourceType) {
    case "inferred": return "inferred";
    case "observed_pattern": return "observed_pattern";
    case "self_report": return "explicit_self_report";
    case "partner_report": return o.confirmationStatus === "confirmed" ? "confirmed_partner_report" : "unconfirmed_partner_report";
  }
}

export function tierToState(t: EvidenceTier): EvidenceState {
  switch (t) {
    case "explicit_self_report": return "known";
    case "mutually_confirmed":
    case "confirmed_partner_report": return "confirmed";
    case "observed_pattern": return "observed";
    case "unconfirmed_partner_report": return "reported";
    case "inferred": return "inferred";
  }
}

const subjectOf = (party: Party, d: Dyad): string | null => (party === "A" ? d.userA : party === "B" ? d.userB : null);
const otherOf = (party: Party, d: Dyad): string | null => (party === "A" ? d.userB : party === "B" ? d.userA : null);

/** Is `o` a statement that belongs to this party/construct/attribute? */
function isAbout(o: Observation, party: Party, d: Dyad, constructId: string, key: string): boolean {
  if (o.relationshipId !== d.relationshipId || o.constructId !== constructId || o.attributeKey !== key) return false;
  if (o.confirmationStatus === "withdrawn") return false;
  return o.subjectUserId === subjectOf(party, d);
}

export function resolveFact(
  all: readonly Observation[], party: Party, d: Dyad, constructId: string, key: string, now: Date,
): EffectiveFact {
  const base = { party, constructId, attributeKey: key, observationIds: [] as string[] };
  const cands = all.filter((o) => isAbout(o, party, d, constructId, key));
  // A partner report the subject has disputed is not usable as evidence about them.
  const usable = cands.filter((o) => !(o.sourceType === "partner_report" && o.confirmationStatus === "disputed"));
  if (usable.length === 0) {
    const why = cands.length ? "only withdrawn or disputed statements" : "no evidence";
    return { ...base, state: "unknown", confidence: 0, reason: why };
  }

  const fresh = usable.filter((o) => staleReason(o, now) === null);
  if (fresh.length === 0) {
    const newest = [...usable].sort((a, b) => referenceTimeMs(b) - referenceTimeMs(a))[0];
    return {
      ...base, state: "stale", value: newest.value, tier: deriveTier(newest), confidence: 0,
      observationIds: [newest.observationId], ageDays: ageDays(newest, now),
      reason: `${staleReason(newest, now)}; kept as history, not used as current`,
    };
  }

  // Latest statement per (observer, tier): people change their minds; newer replaces older.
  // If two differing statements share the newest timestamp we cannot say which is newer → keep both.
  const latestByKey = new Map<string, Observation[]>();
  for (const o of fresh) {
    const k = `${o.observerUserId}|${deriveTier(o)}`;
    const prev = latestByKey.get(k);
    if (!prev) { latestByKey.set(k, [o]); continue; }
    const pt = referenceTimeMs(prev[0]), ot = referenceTimeMs(o);
    if (ot > pt) latestByKey.set(k, [o]); else if (ot === pt) prev.push(o);
  }
  const current = [...latestByKey.values()].flat();
  const topRank = Math.max(...current.map((o) => TIER_RANK[deriveTier(o)]));
  const top = current.filter((o) => TIER_RANK[deriveTier(o)] === topRank);

  const distinct = new Set(top.map((o) => String(o.value)));
  if (distinct.size > 1) {
    return {
      ...base, state: "contradictory", confidence: 0, observationIds: top.map((o) => o.observationId),
      conflictingValues: top.map((o) => o.value), reason: "equal-authority statements disagree",
    };
  }
  const chosen = [...top].sort((a, b) => referenceTimeMs(b) - referenceTimeMs(a))[0];
  let tier = deriveTier(chosen);
  let discrepant: AttrValue | undefined;
  const other = otherOf(party, d);
  const partnerReports = fresh.filter((o) => o.sourceType === "partner_report" && o.observerUserId === other);
  if (partnerReports.length && party !== "DYAD") {
    const pr = [...partnerReports].sort((a, b) => referenceTimeMs(b) - referenceTimeMs(a))[0];
    if (String(pr.value) === String(chosen.value) && tier === "explicit_self_report" && pr.confirmationStatus === "confirmed") {
      tier = "mutually_confirmed"; // self-report AND a confirmed partner report agree
    } else if (String(pr.value) !== String(chosen.value) && tier !== "inferred") {
      discrepant = pr.value;
    }
  }
  const ids = [chosen.observationId, ...top.filter((o) => o !== chosen).map((o) => o.observationId)];
  return {
    ...base, state: tierToState(tier), value: chosen.value, tier,
    confidence: decayedConfidence(chosen, now), observationIds: ids, ageDays: ageDays(chosen, now),
    reason: `${tier} (${chosen.sourceType})`, ...(discrepant !== undefined ? { discrepantPartnerReport: discrepant } : {}),
  };
}
