/**
 * ai-gateway — the ONLY place DuoSpace talks to OpenAI / Gemini / Sarvam.
 *
 * NOT RUNTIME-VERIFIED: no Supabase project, network or provider keys exist in
 * the authoring sandbox. Verify with scripts/ai-live-staging.mjs.
 *
 * Security boundaries:
 *   - Provider keys (OPENAI_API_KEY / GEMINI_API_KEY / SARVAM_API_KEY) are read
 *     from Deno.env only; never returned, never logged, never in a VITE_* var.
 *   - Identity = the verified JWT (auth.getUser). The body cannot name a user.
 *   - Consent, quota and refund run through service-role-only SQL functions
 *     (20261001100000_ai_gateway_quota.sql), keyed on the verified user id.
 *   - Logs contain task/provider/model/latency/status only — never text.
 * All policy lives in _shared/ai/gateway.ts (unit-tested).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { resolveEndpoints, resolveModelConfig, type ProviderId } from "../_shared/ai/config.ts";
import { handleGateway, type GatewayDeps } from "../_shared/ai/gateway.ts";
import { createGeminiAdapter } from "../_shared/ai/providers/gemini.ts";
import { createOpenAIAdapter } from "../_shared/ai/providers/openai.ts";
import { createSarvamAdapter } from "../_shared/ai/providers/sarvam.ts";
import type { AdapterOptions, FetchLike, ProviderAdapter } from "../_shared/ai/providers/types.ts";

const env = Deno.env.toObject();
const SUPABASE_URL = env.SUPABASE_URL!;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = env.SUPABASE_ANON_KEY!;

const config = resolveModelConfig(env);
const endpoints = resolveEndpoints(env);
const fetchImpl: FetchLike = (url, init) => fetch(url, init);

const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
const opt = (apiKey: string | undefined, baseUrl: string): AdapterOptions | null => (apiKey ? { apiKey, baseUrl, fetch: fetchImpl, openaiSendReasoning: env.OPENAI_SEND_REASONING === "1" } : null);
{
  const o = opt(env.OPENAI_API_KEY, endpoints.openai); if (o) adapters.openai = createOpenAIAdapter(o);
  const g = opt(env.GEMINI_API_KEY, endpoints.gemini); if (g) adapters.gemini = createGeminiAdapter(g);
  const s = opt(env.SARVAM_API_KEY, endpoints.sarvam); if (s) adapters.sarvam = createSarvamAdapter(s);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const deps: GatewayDeps = {
  config, adapters,
  aiEnv: env.AI_ENV ?? "production",
  indicRouting: env.AI_INDIC_ROUTING === "specialist" ? "specialist" : "off",
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async hasConsent(userId, features) {
    const { data, error } = await admin.rpc("gateway_has_consents", { _user_id: userId, _features: [...features] });
    if (error) throw error;
    return data === true;
  },
  async consumeQuota(userId, bucket, cost) {
    const { data, error } = await admin.rpc("gateway_consume_ai_quota", { _user_id: userId, _bucket: bucket, _cost: cost });
    if (error || !data) throw error ?? new Error("empty");
    const d = data as { allowed: boolean; remaining: number | null; reason: string; level?: string };
    return { allowed: d.allowed === true, remaining: d.remaining ?? null, reason: d.reason, level: d.level };
  },
  async refundQuota(userId, bucket, cost) {
    await admin.rpc("gateway_refund_ai_quota", { _user_id: userId, _bucket: bucket, _cost: cost });
  },
  // Metadata only — the TelemetryEvent type has no text field.
  telemetry: (e) => console.log(JSON.stringify({ evt: "ai_gateway", ...e })),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
  if (req.method !== "POST") return json(405, { ok: false, code: "BAD_REQUEST", message: "POST only", fallback: "NONE" });

  let userId: string | null = null;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data } = await userClient.auth.getUser(auth.slice(7));
    userId = data.user?.id ?? null;
  }
  let body: unknown = null;
  try { body = await req.json(); } catch { /* handled as BAD_REQUEST */ }
  const res = await handleGateway(userId, body, deps);
  return json(res.status, res.body);
});
