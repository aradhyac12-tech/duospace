/**
 * Privacy-safe operational telemetry for Relationship Reflection.
 *
 * WHAT MAY BE RECORDED (brief §25): which operation ran, whether it worked,
 * how long it took, which KIND of provider ran it, a non-sensitive error
 * category, and a bare count. That is the entire schema.
 *
 * WHAT MAY NEVER BE RECORDED: reflection text, values answers, expectations,
 * AI output, partner information, prompts, raw model responses.
 *
 * Enforcement is structural, not "be careful": `sanitizeEvent` rebuilds the
 * event from closed enumerations and finite numbers only. No free-form string
 * can pass through it, so a caller cannot leak text even by mistake.
 */
import { logInfo } from "@/lib/telemetry";
import { RELATIONSHIP_ERROR_CODES, type RelationshipErrorCode } from "./errors";

export const RELATIONSHIP_OPS = [
  "values_analysis", "expectations_analysis", "reflection_analysis",
  "share", "revoke", "correction", "reconcile",
] as const;
export type RelationshipOp = (typeof RELATIONSHIP_OPS)[number];

export const PROVIDER_TYPES = ["LOCAL_RULE", "LOCAL_MODEL", "CLOUD_MODEL", "MOCK"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface RelationshipEvent {
  op: RelationshipOp;
  outcome: "success" | "failure" | "denied";
  latencyMs?: number;
  providerType?: ProviderType;
  errorCategory?: RelationshipErrorCode;
  count?: number;
}

export type RelationshipTelemetrySink = (event: RelationshipEvent) => void;

const OUTCOMES = ["success", "failure", "denied"] as const;

export function sanitizeEvent(e: RelationshipEvent): RelationshipEvent {
  const out: RelationshipEvent = {
    op: (RELATIONSHIP_OPS as readonly string[]).includes(e.op) ? e.op : "reconcile",
    outcome: (OUTCOMES as readonly string[]).includes(e.outcome) ? e.outcome : "failure",
  };
  if (typeof e.latencyMs === "number" && Number.isFinite(e.latencyMs)) out.latencyMs = Math.max(0, Math.round(e.latencyMs));
  if (e.providerType && (PROVIDER_TYPES as readonly string[]).includes(e.providerType)) out.providerType = e.providerType;
  if (e.errorCategory && RELATIONSHIP_ERROR_CODES.includes(e.errorCategory)) out.errorCategory = e.errorCategory;
  if (typeof e.count === "number" && Number.isFinite(e.count)) out.count = Math.max(0, Math.min(1000, Math.round(e.count)));
  return out;
}

/** Default sink: the app's local ring buffer via logInfo (which also redacts). Message is built only from whitelisted enums. */
export const defaultTelemetrySink: RelationshipTelemetrySink = (event) => {
  const clean = sanitizeEvent(event);
  try {
    logInfo("relationship", `${clean.op}:${clean.outcome}`, clean);
  } catch {
    /* telemetry must never throw into the feature */
  }
};

/** Records through a sink but re-sanitises first, so even a custom sink only ever sees the whitelisted shape. */
export function recordRelationshipEvent(sink: RelationshipTelemetrySink, event: RelationshipEvent): void {
  try {
    sink(sanitizeEvent(event));
  } catch {
    /* never throw from telemetry */
  }
}
