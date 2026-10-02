/**
 * RelationshipCloudProvider — the provider-independent task interface. All
 * business logic (prompting, schema validation, retry) lives here ONCE; the
 * OpenAI/Gemini/Sarvam adapters only transport. Every provider therefore
 * returns the same canonical, Zod-validated shapes.
 */
import type { z } from "zod";
import type { ModelConfigEntry } from "./config.ts";
import type { GatewayContext } from "./minimize.ts";
import { buildPrompt } from "./prompts.ts";
import { TASK_SCHEMA, type TaskOutput } from "./schemas.ts";
import type { AiTask } from "./tasks.ts";
import { ProviderError, type ProviderAdapter } from "./providers/types.ts";

export type TaskFailure =
  | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMIT" | "PROVIDER_AUTH" | "PROVIDER_HTTP"
  | "PROVIDER_MALFORMED" | "PROVIDER_REFUSED" | "PROVIDER_NETWORK" | "SCHEMA_INVALID";

export type TaskRun<T> =
  | { ok: true; value: T; tokensIn: number | null; tokensOut: number | null; attempts: number }
  | { ok: false; failure: TaskFailure; attempts: number };

export interface RunOptions {
  model: string;
  entry: Pick<ModelConfigEntry, "maxOutputTokens" | "temperature" | "reasoning" | "timeoutMs" | "retry">;
  languageHint: string | null;
  sleep: (ms: number) => Promise<void>;
}

export async function runStructuredTask<T extends AiTask>(adapter: ProviderAdapter, task: T, ctx: GatewayContext, o: RunOptions): Promise<TaskRun<TaskOutput<T>>> {
  const schema = TASK_SCHEMA[task] as z.ZodTypeAny;
  const { system, user } = buildPrompt(task, ctx, o.languageHint);
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const r = await adapter.generateStructured({
        model: o.model, system, user, schemaName: task.toLowerCase(), schema,
        maxOutputTokens: o.entry.maxOutputTokens, temperature: o.entry.temperature, reasoning: o.entry.reasoning, timeoutMs: o.entry.timeoutMs,
      });
      const parsed = schema.safeParse(r.json);
      // Invalid output is REJECTED — never coerced, trimmed or "repaired".
      if (!parsed.success) return { ok: false, failure: "SCHEMA_INVALID", attempts };
      return { ok: true, value: parsed.data as TaskOutput<T>, tokensIn: r.tokensIn, tokensOut: r.tokensOut, attempts };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("NETWORK");
      if (pe.retryable && attempts < o.entry.retry.maxAttempts) { await o.sleep(o.entry.retry.backoffMs * attempts); continue; }
      return { ok: false, failure: `PROVIDER_${pe.kind === "REFUSED" ? "REFUSED" : pe.kind}` as TaskFailure, attempts };
    }
  }
}

/** Named-method facade over the same runner (the interface from the Phase 3M brief). */
export function createRelationshipCloudProvider(adapter: ProviderAdapter, o: RunOptions) {
  const run = <T extends AiTask>(task: T, ctx: GatewayContext) => runStructuredTask(adapter, task, ctx, o);
  return {
    id: adapter.id,
    understandMessage: (c: GatewayContext) => run("UNDERSTAND", c),
    suggestReply: (c: GatewayContext) => run("QUICK_REPLY", c),
    extractRelationshipFacts: (c: GatewayContext) => run("FACT_EXTRACTION", c),
    selectNextQuestion: (c: GatewayContext) => run("ADAPTIVE_QUESTION", c),
    analyzeCompatibility: (c: GatewayContext, deep: boolean) => run(deep ? "COMPATIBILITY_DEEP" : "COMPATIBILITY_EXPLAIN", c),
    generateTodayInsight: (c: GatewayContext) => run("TODAY", c),
    analyzeConflict: (c: GatewayContext) => run("COMPLEX_CONFLICT", c),
    suggestMemory: (c: GatewayContext) => run("MEMORY_SUGGESTION", c),
    analyzeLongitudinal: (c: GatewayContext) => run("LONGITUDINAL_ANALYSIS", c),
    translateOrNormalizeLanguage: (c: GatewayContext) => run("NORMALIZE_LANGUAGE", c),
  };
}
export type RelationshipCloudProvider = ReturnType<typeof createRelationshipCloudProvider>;
