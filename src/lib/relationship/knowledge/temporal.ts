/**
 * Temporal model (spec §11). Pure functions; `now` is always injected.
 * History is never rewritten: staleness changes how evidence is *used*, not
 * whether it exists. Thresholds/half-lives are engineering parameters.
 */
import { stalenessDaysFor } from "./taxonomy";
import type { Observation } from "./types";

const DAY_MS = 86_400_000;
export const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
};

/** Reference moment for freshness: last reconfirmation if any, else when observed. */
export function referenceTimeMs(o: Observation): number {
  return Math.max(toMs(o.lastConfirmedAt) ?? 0, toMs(o.observedAt) ?? 0);
}

export function ageDays(o: Observation, now: Date): number {
  return Math.max(0, (now.getTime() - referenceTimeMs(o)) / DAY_MS);
}

export function stalenessThreshold(o: Observation): number {
  return o.stalenessThresholdDays ?? stalenessDaysFor(o.constructId);
}

/** Why (if at all) an observation must not be treated as a current fact. */
export function staleReason(o: Observation, now: Date): string | null {
  const t = now.getTime();
  const until = toMs(o.validUntil), exp = toMs(o.expiresAt), from = toMs(o.validFrom);
  if (until !== null && until < t) return "validity window ended";
  if (exp !== null && exp < t) return "expired";
  if (from !== null && from > t) return "not yet valid";
  if (o.temporalScope === "historical") return "described as past";
  const age = ageDays(o, now), limit = stalenessThreshold(o);
  if (age > limit) return `not reconfirmed for ${Math.floor(age)} days (limit ${limit})`;
  return null;
}
export const isStale = (o: Observation, now: Date): boolean => staleReason(o, now) !== null;

/** Exponential decay; half-life defaults to the staleness threshold. */
export function decayedConfidence(o: Observation, now: Date): number {
  const half = o.confidenceHalfLifeDays ?? stalenessThreshold(o);
  if (!(half > 0)) return o.confidence;
  return o.confidence * Math.pow(0.5, ageDays(o, now) / half);
}
