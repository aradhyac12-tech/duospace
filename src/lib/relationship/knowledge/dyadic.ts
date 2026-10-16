/**
 * Dyadic model (spec §12). Treats the pair as two actors plus the dyad and
 * NEVER assumes symmetry or that one partner's report about the other is true.
 * Conceptual reference: Actor–Partner Interdependence Model. This module does
 * not estimate APIM parameters; no statistical analysis is performed.
 *
 *   A→A  A's own statement        B→B  B's own statement
 *   A→B  what A says about B      B→A  what B says about A
 *   A+B  the dyad itself
 */
import { resolveFact } from "./evidence";
import type { AttrValue, Dyad, EffectiveFact, Observation } from "./types";

export interface DyadicView {
  A_to_A: EffectiveFact; B_to_B: EffectiveFact;
  /** What A reports about B / B about A — reports, not B's/A's own state. */
  A_to_B: AttrValue | undefined; B_to_A: AttrValue | undefined;
  dyad: EffectiveFact;
  /** A's report about B differs from B's own statement (or vice versa). Surfaced, never resolved by us. */
  discrepancies: { subject: "A" | "B"; ownValue: AttrValue; reportedByPartner: AttrValue }[];
}

export function dyadicView(obs: readonly Observation[], d: Dyad, constructId: string, key: string, now: Date): DyadicView {
  const A = resolveFact(obs, "A", d, constructId, key, now);
  const B = resolveFact(obs, "B", d, constructId, key, now);
  const dyad = resolveFact(obs, "DYAD", d, constructId, key, now);
  const reportAbout = (subjectId: string, observerId: string): AttrValue | undefined =>
    [...obs].filter((o) => o.relationshipId === d.relationshipId && o.constructId === constructId && o.attributeKey === key
      && o.sourceType === "partner_report" && o.subjectUserId === subjectId && o.observerUserId === observerId && o.confirmationStatus !== "withdrawn")
      .sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt))[0]?.value;
  const A_to_B = reportAbout(d.userB, d.userA), B_to_A = reportAbout(d.userA, d.userB);
  const discrepancies: DyadicView["discrepancies"] = [];
  if (B.value !== undefined && A_to_B !== undefined && String(B.value) !== String(A_to_B)) discrepancies.push({ subject: "B", ownValue: B.value, reportedByPartner: A_to_B });
  if (A.value !== undefined && B_to_A !== undefined && String(A.value) !== String(B_to_A)) discrepancies.push({ subject: "A", ownValue: A.value, reportedByPartner: B_to_A });
  return { A_to_A: A, B_to_B: B, A_to_B, B_to_A, dyad, discrepancies };
}

export const partyOf = (userId: string, d: Dyad): "A" | "B" | null => (userId === d.userA ? "A" : userId === d.userB ? "B" : null);
/** Canonical A/B assignment: lexicographic, matching rk_relationship_key(). */
export const makeDyad = (u1: string, u2: string): Dyad => {
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  return { relationshipId: `${a}:${b}`, userA: a, userB: b };
};
