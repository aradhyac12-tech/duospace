/**
 * Cloud-generated "Help me reply" (v3.23).
 *
 * This is the ONLY place the Chat reply sheet reaches a generative model, and it
 * does so exclusively through the existing gateway client (callAiGateway →
 * `ai-gateway` edge function). It adds NO new gateway, provider, or quota counter:
 *
 *  - Quota is charged ONCE, server-side, by the gateway (reserve-before-call,
 *    refund-on-failure). This module never calls consumeAiQuota.
 *  - Cloud processing requires BOTH CLOUD_AI_PROCESSING and RELATIONSHIP_INSIGHTS.
 *    Without them, NO request is made (the gateway is never invoked).
 *  - Only the selected message + at most MAX_CONTEXT recent messages are sent.
 *  - Every outcome carries `source` so callers never present a fallback as model-written.
 *
 * Never auto-sends: this returns text; the UI inserts it into the composer on tap.
 */
import { callAiGateway, type GatewayInvoker } from "@/lib/ai/cloud/gatewayClient";
import type { ReplyIntent } from "./present";
import { createDedupe, hashKey } from "./inflight";
import type { SupportCorrection } from "../responsiveness";

export type ReplySource = "CLOUD_MODEL" | "ON_DEVICE_RULES";
export const MAX_CONTEXT_MESSAGES = 4;
export const MAX_REPLY_CHARS = 320;

export type CloudReplyFailure = "NO_CONSENT" | "QUOTA" | "NOT_IN_PLAN" | "INSUFFICIENT_CONTEXT" | "INVALID_OUTPUT" | "UNAVAILABLE";
export type CloudReplyOutcome =
  | { ok: true; source: "CLOUD_MODEL"; text: string; mode: string; remaining: number | null }
  | { ok: false; reason: CloudReplyFailure; /** true → caller may show the on-device reply, labelled as on-device. */ canUseDeviceFallback: boolean };

export interface ContextMessage { from: "USER" | "PARTNER"; text: string }
export interface CloudReplyInput {
  partnerText: string;
  recent?: readonly ContextMessage[];
  intent: ReplyIntent["id"];
  corrections?: readonly SupportCorrection[];
  language?: string | null;
}
export interface CloudReplyDeps {
  userId: string;
  hasConsent: (userId: string, feature: string) => Promise<boolean>;
  invoker?: GatewayInvoker;
}

type Mode = "normal" | "softer" | "casual" | "shorter" | "ask_first";

/** Intent/corrections → existing gateway reply mode. No new schema values. */
export function modeFor(intent: ReplyIntent["id"], corrections: readonly SupportCorrection[] = []): Mode {
  const last = corrections[corrections.length - 1];
  if (last === "MAKE_CLEARER") return "shorter";
  if (last === "TOO_FORMAL") return "casual";
  if (intent === "ASK_FIRST") return "ask_first";
  return "normal";
}

const LEAK = /(system prompt|developer message|as an ai language model|\bjson\b|<\/?[a-z]+>|```)/i;

/** Client-side defence in depth on top of the server guard + Zod schema. */
export function acceptableReply(text: string, partnerText: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_REPLY_CHARS) return false;
  if (LEAK.test(t)) return false;
  if (t.toLowerCase() === partnerText.trim().toLowerCase()) return false; // parrots the message back
  return true;
}

const dedupe = createDedupe<CloudReplyOutcome>();
const REFUSED: CloudReplyOutcome = { ok: false, reason: "UNAVAILABLE", canUseDeviceFallback: true };

export function requestCloudReply(input: CloudReplyInput, deps: CloudReplyDeps): Promise<CloudReplyOutcome> {
  // Identical request (same user + message + intent + corrections + context) shares ONE call/charge.
  // A different message/user/intent gets its own call and never another request's result.
  const key = hashKey([deps.userId, input.partnerText, input.intent, input.corrections ?? [], (input.recent ?? []).slice(-MAX_CONTEXT_MESSAGES), input.language ?? null]);
  return dedupe.run(key, () => run(input, deps), REFUSED);
}

async function run(input: CloudReplyInput, deps: CloudReplyDeps): Promise<CloudReplyOutcome> {
  // 1. Consent is checked BEFORE anything is built, so a denied user can never produce a request.
  const [cloud, insights] = await Promise.all([
    deps.hasConsent(deps.userId, "CLOUD_AI_PROCESSING").catch(() => false),
    deps.hasConsent(deps.userId, "RELATIONSHIP_INSIGHTS").catch(() => false),
  ]);
  if (!cloud || !insights) return { ok: false, reason: "NO_CONSENT", canUseDeviceFallback: true };
  if (!input.partnerText.trim()) return { ok: false, reason: "INSUFFICIENT_CONTEXT", canUseDeviceFallback: true };

  const mode = modeFor(input.intent, input.corrections);
  const recent = (input.recent ?? []).slice(-MAX_CONTEXT_MESSAGES).filter((m) => m.text.trim());

  // 2. Existing gateway: auth, server consent, quota, schema, grounding guard, refund.
  const out = await callAiGateway("QUICK_REPLY", {
    currentText: input.partnerText,
    recentMessages: recent.map((m) => ({ from: m.from, text: m.text })),
    replyMode: mode,
  }, { language: input.language ?? null, invoker: deps.invoker, allowProviderFallback: false });

  if (!out.ok) {
    if (out.code === "QUOTA_EXCEEDED") return { ok: false, reason: "QUOTA", canUseDeviceFallback: true };
    if (out.code === "NOT_IN_PLAN") return { ok: false, reason: "NOT_IN_PLAN", canUseDeviceFallback: true };
    if (out.code === "CONSENT_REQUIRED") return { ok: false, reason: "NO_CONSENT", canUseDeviceFallback: true };
    if (out.code === "INVALID_OUTPUT") return { ok: false, reason: "INVALID_OUTPUT", canUseDeviceFallback: true };
    return { ok: false, reason: "UNAVAILABLE", canUseDeviceFallback: true };
  }

  const r = out.result;
  if (r.insufficientContext) return { ok: false, reason: "INSUFFICIENT_CONTEXT", canUseDeviceFallback: true };
  const pick = r.suggestions.find((s) => s.mode === mode && acceptableReply(s.text, input.partnerText))
    ?? r.suggestions.find((s) => acceptableReply(s.text, input.partnerText));
  // No bounded retry here: the gateway already retries within its own policy; a second client call would double-charge.
  if (!pick) return { ok: false, reason: "INVALID_OUTPUT", canUseDeviceFallback: true };
  return { ok: true, source: "CLOUD_MODEL", text: pick.text.trim(), mode: pick.mode, remaining: out.remaining };
}

/** Test seam. */
export function _resetCloudReplyInflight() { dedupe.clear(); }

/** The minimum surrounding conversation: up to MAX_CONTEXT_MESSAGES text messages BEFORE the selected one. */
export function buildReplyContext(
  messages: readonly { id: string; sender_id: string; decryptedContent: string | null }[],
  selectedId: string, myUserId: string,
): ContextMessage[] {
  const i = messages.findIndex((m) => m.id === selectedId);
  if (i <= 0) return [];
  return messages.slice(Math.max(0, i - MAX_CONTEXT_MESSAGES), i)
    .filter((m) => (m.decryptedContent ?? "").trim())
    .map((m) => ({ from: m.sender_id === myUserId ? "USER" as const : "PARTNER" as const, text: (m.decryptedContent as string).slice(0, 500) }));
}
