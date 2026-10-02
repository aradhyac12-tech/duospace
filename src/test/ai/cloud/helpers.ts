import { resolveModelConfig } from "../../../../supabase/functions/_shared/ai/config";
import { EMPTY_CONTEXT } from "../../../lib/ai/cloud/gatewayClient";
import type { GatewayContext } from "../../../../supabase/functions/_shared/ai/minimize";
import { ProviderError, type ProviderAdapter, type StructuredCall } from "../../../../supabase/functions/_shared/ai/providers/types";
import type { GatewayDeps, TelemetryEvent } from "../../../../supabase/functions/_shared/ai/gateway";
import type { ProviderId } from "../../../../supabase/functions/_shared/ai/config";

export const ENV = {
  AI_STD_FAST_PROVIDER: "openai", AI_STD_FAST_MODEL: "fast-model-x", AI_STD_FAST_FALLBACK_PROVIDER: "gemini", AI_STD_FAST_FALLBACK_MODEL: "fast-model-y",
  AI_STD_REASON_PROVIDER: "openai", AI_STD_REASON_MODEL: "reason-model-x", AI_STD_REASON_FALLBACK_PROVIDER: "gemini", AI_STD_REASON_FALLBACK_MODEL: "reason-model-y",
  AI_DEEP_PROVIDER: "openai", AI_DEEP_MODEL: "deep-model-x",
  AI_INDIC_PROVIDER: "sarvam", AI_INDIC_MODEL: "indic-model-x",
  AI_SECONDARY_PROVIDER: "gemini", AI_SECONDARY_MODEL: "secondary-model-x",
};
export const CONFIG = resolveModelConfig(ENV);
export const ctx = (over: Partial<GatewayContext> = {}): GatewayContext => ({ ...EMPTY_CONTEXT, ...over });

export interface Script { json?: unknown; error?: ProviderError; tokensIn?: number; tokensOut?: number }
/** Adapter that replays scripted outcomes and records calls. */
export function fakeAdapter(id: ProviderId, script: Script[]) {
  const calls: StructuredCall[] = [];
  const adapter: ProviderAdapter = {
    id,
    async generateStructured(call) {
      calls.push(call);
      const s = script[Math.min(calls.length - 1, script.length - 1)];
      if (s.error) throw s.error;
      return { json: s.json, tokensIn: s.tokensIn ?? 10, tokensOut: s.tokensOut ?? 5 };
    },
  };
  return { adapter, calls };
}

export function makeDeps(over: Partial<GatewayDeps> = {}) {
  const events: TelemetryEvent[] = [];
  const quota = { consumed: 0, refunded: 0 };
  const deps: GatewayDeps = {
    config: CONFIG, adapters: {}, aiEnv: "production", indicRouting: "off",
    hasConsent: async () => true,
    consumeQuota: async () => { quota.consumed++; return { allowed: true, remaining: 4, reason: "ok" }; },
    refundQuota: async () => { quota.refunded++; },
    telemetry: (e) => events.push(e), now: () => 1000, sleep: async () => {},
    ...over,
  };
  return { deps, events, quota };
}

export const UNDERSTAND_OK = {
  language: { code: "en", script: "latin", codeMixed: false },
  summary: "They're asking to talk tomorrow instead.", intent: "REQUEST",
  evidence: ["talk tomorrow"], why: null, offerReply: true, cannotTell: false, confidence: "HIGH",
};
export const body = (task: string, context: Partial<GatewayContext>, extra: Record<string, unknown> = {}) =>
  ({ task, language: null, allowProviderFallback: false, context: ctx(context), debugForceProvider: null, ...extra });
