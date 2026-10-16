import { approveAllForTesting, makeDyad, runEngine, type Dimension, type EngineOutput, type Observation, type RelationshipStage, type SafetyAssessment } from "../../lib/relationship/knowledge/index";

export const NOW = new Date("2026-10-04T00:00:00Z");
export const UA = "00000000-0000-0000-0000-00000000000a";
export const UB = "00000000-0000-0000-0000-00000000000b";
export const DYAD = makeDyad(UA, UB);
export const SNAP = approveAllForTesting();

export type Kind = "self" | "partner" | "partner_confirmed" | "observed" | "inferred";
export interface O { by: "A" | "B"; about: "A" | "B" | "DYAD"; c: string; k: string; v: string | boolean | number; kind?: Kind; age?: number; conf?: number; reconfirmedAge?: number; id?: string }
let n = 0;
const uid = (p: "A" | "B") => (p === "A" ? UA : UB);
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

export function obs(o: O): Observation {
  const kind: Kind = o.kind ?? (o.by === o.about || o.about === "DYAD" ? "self" : "partner");
  const subject = o.about === "DYAD" ? null : uid(o.about);
  const sourceType = kind === "self" ? "self_report" : kind === "observed" ? "observed_pattern" : kind === "inferred" ? "inferred" : "partner_report";
  const tier = kind === "self" ? "explicit_self_report" : kind === "observed" ? "observed_pattern" : kind === "inferred" ? "inferred" : kind === "partner_confirmed" ? "confirmed_partner_report" : "unconfirmed_partner_report";
  const t = iso(o.age ?? 1);
  return {
    observationId: o.id ?? `obs-${++n}`, relationshipId: DYAD.relationshipId, observerUserId: uid(o.by), subjectUserId: subject,
    targetUserId: o.about === "DYAD" ? null : uid(o.about === "A" ? "B" : "A"), constructId: o.c, attributeKey: o.k, value: o.v,
    sourceType, evidenceTier: tier, confidence: o.conf ?? 0.8, explicitness: kind === "inferred" ? "implicit" : "explicit", temporalScope: "current",
    perspective: o.about === "DYAD" ? "dyad" : `${o.by}_to_${o.about}`, confirmationStatus: kind === "partner_confirmed" ? "confirmed" : "unconfirmed",
    validFrom: t, observedAt: t, lastConfirmedAt: o.reconfirmedAge !== undefined ? iso(o.reconfirmedAge) : null,
  } as Observation;
}

export function run(list: Observation[], opts: { stage?: RelationshipStage; safety?: SafetyAssessment; snapshot?: typeof SNAP } = {}): EngineOutput {
  return runEngine({ observations: list, dyad: DYAD, stage: opts.stage ?? "committed", now: NOW, snapshot: opts.snapshot ?? SNAP, safety: opts.safety });
}
export const dim = (o: EngineOutput, d: Dimension) => o.dimensions[d];
export const RHYTHM = (by: "A" | "B", v: string, extra: Partial<O> = {}) => obs({ by, about: by, c: "communication_preferences", k: "rhythm", v, ...extra });
