import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildGatewayRequest, callAiGateway, CLOUD_AI_DISCLOSURE } from "../../../lib/ai/cloud/gatewayClient";
import { MODE_LABEL, AIExecutionMode, decideExecutionMode } from "../../../lib/relationship/executionMode";
import { UNDERSTAND_OK } from "./helpers";

const inv = (data: unknown, error: unknown = null) => ({ invoke: async () => ({ data, error }) });

describe("gateway client", () => {
  it("trims over-long input to the server caps instead of failing", () => {
    const r = buildGatewayRequest("UNDERSTAND", { currentText: "x".repeat(5000), recentMessages: Array.from({ length: 20 }, () => ({ from: "USER" as const, text: "y".repeat(900) })) });
    expect(r.context.currentText!.length).toBe(2000);
    expect(r.context.recentMessages).toHaveLength(8);
    expect(r.context.recentMessages[0].text.length).toBe(500);
  });
  it("never sends a user id, a provider override, or fallback by default", () => {
    const r = buildGatewayRequest("TODAY", {});
    expect(Object.keys(r).sort()).toEqual(["allowProviderFallback", "context", "debugForceProvider", "language", "task"]);
    expect(r.debugForceProvider).toBeNull(); expect(r.allowProviderFallback).toBe(false);
  });
  it("re-validates the server result with the canonical schema", async () => {
    const good = await callAiGateway("UNDERSTAND", { currentText: "hi" }, { invoker: inv({ ok: true, result: UNDERSTAND_OK, meta: { provider: "openai", fallbackUsed: false, remaining: 3 } }) });
    expect(good).toMatchObject({ ok: true, provider: "openai", remaining: 3 });
    const bad = await callAiGateway("UNDERSTAND", { currentText: "hi" }, { invoker: inv({ ok: true, result: { ...UNDERSTAND_OK, score: 9 }, meta: {} }) });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_OUTPUT", message: "Couldn't analyze that right now." });
  });
  it("honest failures; compatibility never falls back to an invented result", async () => {
    expect(await callAiGateway("UNDERSTAND", { currentText: "hi" }, { invoker: inv(null, new Error("net")) })).toMatchObject({ ok: false, fallback: "DETERMINISTIC" });
    const dims = [{ dimension: "pace", state: "DIFFERENT", userEvidence: null, partnerEvidence: null, alignmentReason: null, differenceReason: null, confidence: "MEDIUM", uncertainty: null, importance: "UNKNOWN", lastUpdated: null, nextBestQuestion: null }];
    const c = await callAiGateway("COMPATIBILITY_EXPLAIN", { basis: "BOTH_PARTNERS", dimensions: dims as never }, { invoker: inv(null, new Error("net")) });
    expect(c).toMatchObject({ ok: false, message: "Not enough information right now.", fallback: "NONE" });
  });
  it("surfaces the gateway's own error body (quota, consent)", async () => {
    const r = await callAiGateway("UNDERSTAND", { currentText: "hi" }, { invoker: inv(null, { context: { body: { ok: false, code: "QUOTA_EXCEEDED", message: "Couldn't analyze that right now.", fallback: "DETERMINISTIC" } } }) });
    expect(r).toMatchObject({ ok: false, code: "QUOTA_EXCEEDED" });
  });
});

describe("CLOUD_AI is not E2E_CLOUD", () => {
  it("has its own mode and honest wording; E2E wording stays out of it", () => {
    expect(AIExecutionMode.CLOUD_AI).toBe("CLOUD_AI");
    expect(MODE_LABEL.CLOUD_AI).toBe(CLOUD_AI_DISCLOSURE.replace(/\.$/, ""));
    expect(MODE_LABEL.CLOUD_AI).not.toMatch(/end-to-end|e2e|encrypted/i);
  });
  it("routing policy is unchanged: CLOUD_AI is never auto-selected by decideExecutionMode", () => {
    const dev = { capable: false, localModelReady: false, runtime: "none", memoryClass: "low", confidence: "measured", reason: "x" } as const;
    expect(decideExecutionMode(dev as never, { available: true, userConsented: true, reason: "" }, true).mode).not.toBe("CLOUD_AI");
  });
});

describe("no provider call or secret can live in client code", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
  it("provider hostnames appear only under supabase/functions", () => {
    for (const f of walk("src")) { if (f.includes("/test/")) continue; expect(readFileSync(f, "utf8")).not.toMatch(/api\.openai\.com|generativelanguage\.googleapis\.com|api\.sarvam\.ai/); }
  });
  it("no VITE_ provider secret variable is referenced", () => {
    for (const f of walk("src")) { if (f.includes("/test/")) continue; expect(readFileSync(f, "utf8")).not.toMatch(/VITE_[A-Z_]*(OPENAI|GEMINI|SARVAM)/); }
  });
  it("the gateway never logs request text", () => {
    const src = readFileSync("supabase/functions/ai-gateway/index.ts", "utf8");
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*(body|context|currentText)/);
  });
});
