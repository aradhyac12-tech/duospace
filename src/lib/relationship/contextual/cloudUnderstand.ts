/**
 * Optional, user-initiated "look closer" for Understand (v3.23).
 * Deterministic Understand stays the default and never calls this. This runs ONLY when the
 * user taps, both cloud consents are already granted, and it goes through the existing
 * gateway (UNDERSTAND task). Quota is charged once, server-side, by the gateway.
 * The result keeps explicit evidence separate from interpretation and never shows raw
 * intent labels; `cannotTell` is surfaced as uncertainty instead of forcing an answer.
 */
import { callAiGateway, type GatewayInvoker } from "@/lib/ai/cloud/gatewayClient";
import type { ContextMessage } from "./cloudReply";
import { createDedupe, hashKey } from "./inflight";

export type CloudUnderstandOutcome =
  | { ok: true; source: "CLOUD_MODEL"; summary: string; evidence: string[]; why: string | null; cannotTell: boolean; lowConfidence: boolean }
  | { ok: false; reason: "NO_CONSENT" | "QUOTA" | "UNAVAILABLE"; };

const HIDDEN_STATE = /(secretly|deep down|manipulat|toxic|gaslight|wants to leave|doesn'?t love you|definitely)/i;

const dedupe = createDedupe<CloudUnderstandOutcome>();
const REFUSED: CloudUnderstandOutcome = { ok: false, reason: "UNAVAILABLE" };

export function requestCloudUnderstand(
  input: { text: string; recent?: readonly ContextMessage[]; language?: string | null },
  deps: { userId: string; hasConsent: (u: string, f: string) => Promise<boolean>; invoker?: GatewayInvoker },
): Promise<CloudUnderstandOutcome> {
  // Key = user + exact request. A different message or user can never receive this result.
  const key = hashKey([deps.userId, input.text, (input.recent ?? []).slice(-4), input.language ?? null]);
  return dedupe.run(key, () => run(input, deps), REFUSED);
}

async function run(input: { text: string; recent?: readonly ContextMessage[]; language?: string | null }, deps: { userId: string; hasConsent: (u: string, f: string) => Promise<boolean>; invoker?: GatewayInvoker }): Promise<CloudUnderstandOutcome> {
  const [a, b] = await Promise.all(["CLOUD_AI_PROCESSING", "RELATIONSHIP_INSIGHTS"].map((f) => deps.hasConsent(deps.userId, f).catch(() => false)));
  if (!a || !b || !input.text.trim()) return { ok: false, reason: "NO_CONSENT" };
  const out = await callAiGateway("UNDERSTAND", { currentText: input.text, recentMessages: (input.recent ?? []).slice(-4).map((m) => ({ from: m.from, text: m.text })) }, { language: input.language ?? null, invoker: deps.invoker, allowProviderFallback: false });
  if (!out.ok) return { ok: false, reason: out.code === "QUOTA_EXCEEDED" || out.code === "NOT_IN_PLAN" ? "QUOTA" : out.code === "CONSENT_REQUIRED" ? "NO_CONSENT" : "UNAVAILABLE" };
  const r = out.result;
  // Client defence in depth: hidden-motive claims or evidence not literally in the message are rejected.
  const t = input.text.toLowerCase();
  const evidence = r.evidence.filter((e) => e.trim() && t.includes(e.trim().toLowerCase()));
  if (HIDDEN_STATE.test(r.summary) || (r.why && HIDDEN_STATE.test(r.why)) || !r.summary.trim()) return { ok: false, reason: "UNAVAILABLE" };
  return { ok: true, source: "CLOUD_MODEL", summary: r.summary.trim(), evidence, why: r.why, cannotTell: r.cannotTell || evidence.length === 0, lowConfidence: r.confidence === "LOW" };
}

export function _resetCloudUnderstandInflight() { dedupe.clear(); }
