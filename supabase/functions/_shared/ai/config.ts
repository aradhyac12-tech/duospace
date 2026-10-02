/**
 * AI_MODEL_CONFIG — the ONE place model ids, limits and fallbacks live.
 *
 * Model ids are NEVER hardcoded: they come from server env (Supabase secrets).
 * A tier whose model id is unset is "unconfigured" and is skipped by the router
 * (fail closed — no silent default to some other model).
 * Secrets (API keys) are read by the provider factory in the Deno entrypoint,
 * never by this pure module and never from a VITE_* variable.
 */
import type { ModelTier } from "./tasks.ts";

export type ProviderId = "openai" | "gemini" | "sarvam";
export const PROVIDER_IDS: readonly ProviderId[] = ["openai", "gemini", "sarvam"];
export type ReasoningLevel = "minimal" | "low" | "medium" | "high";

export interface RetryPolicy { maxAttempts: number; backoffMs: number }

export interface ModelConfigEntry {
  tier: ModelTier;
  provider: ProviderId;
  model: string;
  reasoning: ReasoningLevel;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Omitted when a reasoning model does not accept it. */
  temperature: number | null;
  timeoutMs: number;
  retry: RetryPolicy;
  /** Same-tier fallback. Used only if the privacy policy permits (router.ts). */
  fallback: { provider: ProviderId; model: string } | null;
  featureTier: "FREE" | "PLUS" | "PRO";
  quotaClass: "AI_STANDARD" | "AI_DEEP";
}

export type AiModelConfig = Readonly<Partial<Record<ModelTier, ModelConfigEntry>>>;
type Env = Readonly<Record<string, string | undefined>>;

const num = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d;
};
const isProvider = (v: string | undefined): v is ProviderId => !!v && (PROVIDER_IDS as readonly string[]).includes(v);

interface TierSpec {
  tier: ModelTier; envPrefix: string; reasoning: ReasoningLevel; maxIn: number; maxOut: number;
  timeoutMs: number; featureTier: "FREE" | "PLUS" | "PRO"; quotaClass: "AI_STANDARD" | "AI_DEEP";
}

const TIERS: readonly TierSpec[] = [
  { tier: "STANDARD_HIGH_VOLUME", envPrefix: "AI_STD_FAST", reasoning: "minimal", maxIn: 3000, maxOut: 500, timeoutMs: 12_000, featureTier: "FREE", quotaClass: "AI_STANDARD" },
  { tier: "STANDARD_REASONING", envPrefix: "AI_STD_REASON", reasoning: "low", maxIn: 4000, maxOut: 800, timeoutMs: 20_000, featureTier: "FREE", quotaClass: "AI_STANDARD" },
  { tier: "DEEP_RELATIONSHIP", envPrefix: "AI_DEEP", reasoning: "high", maxIn: 10_000, maxOut: 2000, timeoutMs: 60_000, featureTier: "PRO", quotaClass: "AI_DEEP" },
  { tier: "INDIC_SPECIALIST", envPrefix: "AI_INDIC", reasoning: "low", maxIn: 4000, maxOut: 800, timeoutMs: 20_000, featureTier: "PLUS", quotaClass: "AI_STANDARD" },
  { tier: "SECONDARY_REASONING", envPrefix: "AI_SECONDARY", reasoning: "medium", maxIn: 4000, maxOut: 800, timeoutMs: 25_000, featureTier: "PLUS", quotaClass: "AI_STANDARD" },
];

/**
 * Env contract, per tier (prefix from TIERS):
 *   <PREFIX>_PROVIDER   openai | gemini | sarvam      (required)
 *   <PREFIX>_MODEL      provider model id             (required)
 *   <PREFIX>_FALLBACK_PROVIDER / <PREFIX>_FALLBACK_MODEL   (optional, both or none)
 *   <PREFIX>_MAX_OUT, <PREFIX>_TIMEOUT_MS, <PREFIX>_TEMPERATURE   (optional)
 */
export function resolveModelConfig(env: Env): AiModelConfig {
  const out: Partial<Record<ModelTier, ModelConfigEntry>> = {};
  for (const t of TIERS) {
    const provider = env[`${t.envPrefix}_PROVIDER`]?.trim().toLowerCase();
    const model = env[`${t.envPrefix}_MODEL`]?.trim();
    if (!isProvider(provider) || !model) continue; // unconfigured → router skips
    const fp = env[`${t.envPrefix}_FALLBACK_PROVIDER`]?.trim().toLowerCase();
    const fm = env[`${t.envPrefix}_FALLBACK_MODEL`]?.trim();
    const temp = env[`${t.envPrefix}_TEMPERATURE`];
    out[t.tier] = Object.freeze({
      tier: t.tier, provider, model, reasoning: t.reasoning,
      maxInputTokens: t.maxIn,
      maxOutputTokens: num(env[`${t.envPrefix}_MAX_OUT`], t.maxOut, 64, 8000),
      temperature: temp !== undefined && temp !== "" && Number.isFinite(Number(temp)) ? Math.min(1, Math.max(0, Number(temp))) : null,
      timeoutMs: num(env[`${t.envPrefix}_TIMEOUT_MS`], t.timeoutMs, 1000, 120_000),
      retry: { maxAttempts: 2, backoffMs: 250 },
      fallback: isProvider(fp) && fm ? { provider: fp, model: fm } : null,
      featureTier: t.featureTier, quotaClass: t.quotaClass,
    });
  }
  return Object.freeze(out);
}

/** Endpoints are configurable so staging can point at a proxy; defaults are the public APIs. */
export interface ProviderEndpoints { openai: string; gemini: string; sarvam: string }
export function resolveEndpoints(env: Env): ProviderEndpoints {
  return {
    openai: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    gemini: env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta",
    sarvam: env.SARVAM_BASE_URL?.trim() || "https://api.sarvam.ai/v1",
  };
}
