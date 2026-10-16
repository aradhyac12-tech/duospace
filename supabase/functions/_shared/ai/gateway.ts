/**
 * Gateway core. Pure orchestration with every side effect injected, so the
 * whole policy (auth → minimise → consent → route → quota → call → validate →
 * guard → fallback → refund) is unit-testable without Deno, Supabase or a
 * network. index.ts wires the real dependencies.
 *
 * Invariants (each has a test):
 *  - no verified user → nothing runs
 *  - consent is checked server-side, fail closed
 *  - quota is reserved BEFORE the provider call, fail closed, refunded if the user gets no result
 *  - a different provider is used only if allowProviderFallback
 *  - invalid / unsafe output is never returned
 *  - telemetry carries no relationship text
 */
import type { AiModelConfig, ProviderId } from "./config.ts";
import { guardOutput, type GuardFailure } from "./guard.ts";
import { estimateTokens, GatewayRequestSchema, looksLikeInjection, groundingCorpus } from "./minimize.ts";
import { runStructuredTask, type TaskFailure } from "./cloudProvider.ts";
import { looksIndicOrMixed, planRoute } from "./router.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { TASK_BUCKET, type AiTask, type QuotaBucket } from "./tasks.ts";

export interface QuotaResult { allowed: boolean; remaining: number | null; reason: string; level?: string }
export interface TelemetryEvent {
  task: AiTask; provider: ProviderId | null; model: string | null; ok: boolean; failure: TaskFailure | GuardFailure | null;
  latencyMs: number; tokensIn: number | null; tokensOut: number | null; bucket: QuotaBucket; fallbackUsed: boolean;
  injectionSuspected: boolean; droppedFacts: number;
}
export interface GatewayDeps {
  config: AiModelConfig;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  hasConsent(userId: string, features: readonly string[]): Promise<boolean>;
  consumeQuota(userId: string, bucket: QuotaBucket, cost: number): Promise<QuotaResult>;
  refundQuota(userId: string, bucket: QuotaBucket, cost: number): Promise<void>;
  telemetry(e: TelemetryEvent): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  aiEnv: string;
  indicRouting: "off" | "specialist";
}

export type GatewayCode =
  | "UNAUTHENTICATED" | "BAD_REQUEST" | "CONTEXT_TOO_LARGE" | "CONSENT_REQUIRED" | "CONSENT_UNAVAILABLE"
  | "QUOTA_EXCEEDED" | "NOT_IN_PLAN" | "QUOTA_UNAVAILABLE" | "NOT_CONFIGURED" | "PROVIDER_FAILED" | "INVALID_OUTPUT";
export type GatewayResponse =
  | { status: 200; body: { ok: true; task: AiTask; result: unknown; meta: { provider: ProviderId; model: string; fallbackUsed: boolean; latencyMs: number; bucket: QuotaBucket; remaining: number | null; droppedFacts: number } } }
  | { status: number; body: { ok: false; code: GatewayCode; message: string; fallback: "DETERMINISTIC" | "NONE"; quota?: { reason: string; remaining: number | null } } };

export const REQUIRED_CONSENTS = ["CLOUD_AI_PROCESSING", "RELATIONSHIP_INSIGHTS"] as const;

const HONEST: Record<"general" | "compat", string> = { general: "Couldn't analyze that right now.", compat: "Not enough information right now." };
const isCompat = (t: AiTask) => t === "COMPATIBILITY_EXPLAIN" || t === "COMPATIBILITY_DEEP" || t === "LONGITUDINAL_ANALYSIS";

function fail(status: number, code: GatewayCode, task: AiTask | null, extra: Partial<{ quota: { reason: string; remaining: number | null }; message: string }> = {}): GatewayResponse {
  const compat = task ? isCompat(task) : false;
  return { status, body: { ok: false, code, message: extra.message ?? HONEST[compat ? "compat" : "general"], // compatibility is NEVER fabricated
    fallback: compat ? "NONE" : "DETERMINISTIC", ...(extra.quota ? { quota: extra.quota } : {}) } };
}

export async function handleGateway(userId: string | null, raw: unknown, d: GatewayDeps): Promise<GatewayResponse> {
  if (!userId) return fail(401, "UNAUTHENTICATED", null, { message: "Please sign in again." });

  const parsed = GatewayRequestSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "BAD_REQUEST", null, { message: "Invalid request." });
  const req = parsed.data;
  const task = req.task;
  const bucket = TASK_BUCKET[task];
  const ctx = req.context;

  const available = new Set(Object.keys(d.adapters) as ProviderId[]);
  const plan = planRoute({
    task, isIndicOrMixed: looksIndicOrMixed(groundingCorpus(ctx), req.language), allowFallback: req.allowProviderFallback,
    forceProvider: req.debugForceProvider, stagingOverridesAllowed: d.aiEnv === "staging", indicRouting: d.indicRouting, availableProviders: available,
  }, d.config);
  if (plan.length === 0) return fail(503, "NOT_CONFIGURED", task);
  if (estimateTokens(ctx) > plan[0].entry.maxInputTokens) return fail(400, "CONTEXT_TOO_LARGE", task);

  try {
    if (!(await d.hasConsent(userId, REQUIRED_CONSENTS))) return fail(403, "CONSENT_REQUIRED", task, { message: "Turn on cloud AI in Privacy settings to use this." });
  } catch { return fail(503, "CONSENT_UNAVAILABLE", task); }

  let q: QuotaResult;
  try { q = await d.consumeQuota(userId, bucket, 1); } catch { return fail(503, "QUOTA_UNAVAILABLE", task); } // fail CLOSED
  if (!q.allowed) {
    const code: GatewayCode = q.reason === "not_in_plan" ? "NOT_IN_PLAN" : q.reason === "quota_exceeded" ? "QUOTA_EXCEEDED" : "QUOTA_UNAVAILABLE";
    return fail(code === "QUOTA_UNAVAILABLE" ? 503 : code === "NOT_IN_PLAN" ? 403 : 429, code, task, { quota: { reason: q.reason, remaining: q.remaining } });
  }

  const injection = looksLikeInjection(ctx);
  let lastFailure: TaskFailure | GuardFailure = "PROVIDER_HTTP";
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const adapter = d.adapters[a.provider]!;
    const t0 = d.now();
    const run = await runStructuredTask(adapter, task, ctx, { model: a.model, entry: a.entry, languageHint: req.language, sleep: d.sleep });
    let failure: TaskFailure | GuardFailure | null = run.ok ? null : run.failure;
    let guarded: ReturnType<typeof guardOutput> | null = null;
    if (run.ok) {
      guarded = guardOutput(task, run.value, ctx);
      if (!guarded.ok) failure = guarded.category;
    }
    const latencyMs = d.now() - t0;
    d.telemetry({
      task, provider: a.provider, model: a.model, ok: failure === null, failure, latencyMs, bucket, fallbackUsed: i > 0, injectionSuspected: injection,
      tokensIn: run.ok ? run.tokensIn : null, tokensOut: run.ok ? run.tokensOut : null, droppedFacts: guarded && guarded.ok ? guarded.dropped : 0,
    });
    if (failure === null && guarded && guarded.ok) {
      return { status: 200, body: { ok: true, task, result: guarded.value, meta: { provider: a.provider, model: a.model, fallbackUsed: i > 0, latencyMs, bucket, remaining: q.remaining, droppedFacts: guarded.dropped } } };
    }
    lastFailure = failure!;
  }

  // The user got nothing: give the reservation back.
  try { await d.refundQuota(userId, bucket, 1); } catch { /* best effort; never blocks the honest failure */ }
  const invalid = lastFailure === "SCHEMA_INVALID" || ["BANNED_CLAIM", "UNGROUNDED_EVIDENCE", "UNSUPPORTED_NUMBER", "SEMANTIC_MISMATCH", "UNSAFE_REPLY", "LEAK"].includes(lastFailure);
  return fail(502, invalid ? "INVALID_OUTPUT" : "PROVIDER_FAILED", task);
}
