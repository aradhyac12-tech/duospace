/**
 * Client for the DuoSpace AI gateway (Supabase edge function `ai-gateway`).
 *
 * The client NEVER talks to OpenAI / Gemini / Sarvam and holds no provider key;
 * it only sends a minimised context to our own server. This file:
 *  - builds the minimised request (same caps the server enforces)
 *  - re-validates the response with the canonical Zod schema (defence in depth)
 *  - maps every failure to an honest, non-fabricated outcome
 *
 * Stage 1 ships the client; product features adopt it in Stage 3.
 */
import { GatewayRequestSchema, LIMITS, type GatewayContext, type GatewayRequest } from "../../../../supabase/functions/_shared/ai/minimize";
import { TASK_SCHEMA, type TaskOutput } from "../../../../supabase/functions/_shared/ai/schemas";
import type { AiTask } from "../../../../supabase/functions/_shared/ai/tasks";

export type { AiTask, GatewayContext };

export const EMPTY_CONTEXT: GatewayContext = Object.freeze({
  currentText: null, recentMessages: [], facts: [], memories: [], stage: null, durationMonths: null,
  dimensions: [], basis: null, replyMode: null, askedDimensions: [], unknownDimensions: [],
}) as GatewayContext;

/** Shown wherever cloud AI is explained or consented to. Never says "end-to-end encrypted". */
export const CLOUD_AI_DISCLOSURE = "Some AI features send the relevant text you choose to an AI service to process it.";

export type CloudOutcome<T extends AiTask> =
  | { ok: true; result: TaskOutput<T>; provider: string; fallbackUsed: boolean; remaining: number | null }
  | { ok: false; code: string; message: string; /** DETERMINISTIC: caller may use its on-device path. NONE: show the message, do not fabricate. */ fallback: "DETERMINISTIC" | "NONE" };

export interface GatewayInvoker { invoke(name: string, opts: { body: unknown }): Promise<{ data: unknown; error: unknown }> }

export function buildGatewayRequest(task: AiTask, context: Partial<GatewayContext>, o: { language?: string | null; allowProviderFallback?: boolean } = {}): GatewayRequest {
  const c = { ...EMPTY_CONTEXT, ...context } as GatewayContext;
  const req: GatewayRequest = {
    task, language: o.language ?? null, allowProviderFallback: o.allowProviderFallback ?? false,
    // Trim to the same caps the server enforces so an over-long history is cut here, not rejected.
    context: {
      ...c,
      currentText: c.currentText ? c.currentText.slice(0, LIMITS.currentText) : null,
      recentMessages: c.recentMessages.slice(-LIMITS.recentMessages).map((m) => ({ ...m, text: m.text.slice(0, LIMITS.recentMessageText) })),
      facts: c.facts.slice(0, LIMITS.facts),
      memories: c.memories.slice(0, LIMITS.memories),
    },
    debugForceProvider: null,
  };
  return GatewayRequestSchema.parse(req);
}

export async function callAiGateway<T extends AiTask>(task: T, context: Partial<GatewayContext>, o: { language?: string | null; allowProviderFallback?: boolean; invoker?: GatewayInvoker } = {}): Promise<CloudOutcome<T>> {
  const generic = { ok: false as const, code: "UNAVAILABLE", message: "Couldn't analyze that right now.", fallback: "DETERMINISTIC" as const };
  const compat = task === "COMPATIBILITY_EXPLAIN" || task === "COMPATIBILITY_DEEP" || task === "LONGITUDINAL_ANALYSIS";
  const unavailable = compat ? { ...generic, message: "Not enough information right now.", fallback: "NONE" as const } : generic;
  let body: GatewayRequest;
  try { body = buildGatewayRequest(task, context, o); } catch { return { ...unavailable, code: "BAD_REQUEST" }; }
  try {
    // Lazy import keeps this module (and its tests) free of the Supabase client unless really calling the server.
    const invoker = o.invoker ?? ((await import("@/integrations/supabase/appClient")).supabase.functions as unknown as GatewayInvoker);
    const { data, error } = await invoker.invoke("ai-gateway", { body });
    // supabase-js surfaces non-2xx as `error`; the gateway's JSON body (honest message) is in error.context when present.
    const payload = (data ?? (error as { context?: { body?: unknown } } | null)?.context?.body) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return unavailable;
    if (payload.ok === true) {
      const parsed = TASK_SCHEMA[task].safeParse(payload.result);
      if (!parsed.success) return { ...unavailable, code: "INVALID_OUTPUT" };
      const meta = (payload.meta ?? {}) as { provider?: string; fallbackUsed?: boolean; remaining?: number | null };
      return { ok: true, result: parsed.data as TaskOutput<T>, provider: String(meta.provider ?? "unknown"), fallbackUsed: meta.fallbackUsed === true, remaining: meta.remaining ?? null };
    }
    return {
      ok: false, code: typeof payload.code === "string" ? payload.code : "UNAVAILABLE",
      message: typeof payload.message === "string" ? payload.message : unavailable.message,
      fallback: payload.fallback === "NONE" || compat ? "NONE" : "DETERMINISTIC",
    };
  } catch { return unavailable; }
}
