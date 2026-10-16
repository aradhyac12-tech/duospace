import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestCloudReply, acceptableReply, modeFor, buildReplyContext, _resetCloudReplyInflight, MAX_CONTEXT_MESSAGES } from "@/lib/relationship/contextual/cloudReply";

const ok = (suggestions: unknown[], insufficientContext = false) => ({ data: { ok: true, task: "QUICK_REPLY", result: { suggestions, insufficientContext }, meta: { provider: "openai", fallbackUsed: false, remaining: 7 } }, error: null });
const fail = (code: string) => ({ data: { ok: false, code, message: "x", fallback: "DETERMINISTIC" }, error: null });
const consent = (cloud: boolean, insights = true) => async (_u: string, f: string) => (f === "CLOUD_AI_PROCESSING" ? cloud : insights);
const mk = (res: unknown) => { const invoke = vi.fn(async () => res as never); return { invoke, invoker: { invoke } }; };
const input = { partnerText: "Tum kal bhi late the, I'm tired of this", intent: "ACK" as const };

beforeEach(() => _resetCloudReplyInflight());

describe("requestCloudReply", () => {
  it("makes NO gateway request without cloud consent", async () => {
    const g = mk(ok([]));
    const r = await requestCloudReply(input, { userId: "u", hasConsent: consent(false), invoker: g.invoker });
    expect(g.invoke).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, reason: "NO_CONSENT", canUseDeviceFallback: true });
  });
  it("makes NO gateway request without relationship-insights consent", async () => {
    const g = mk(ok([]));
    await requestCloudReply(input, { userId: "u", hasConsent: consent(true, false), invoker: g.invoker });
    expect(g.invoke).not.toHaveBeenCalled();
  });
  it("returns a CLOUD_MODEL result and sends only minimal context to QUICK_REPLY", async () => {
    const g = mk(ok([{ text: "Sorry I was late. I hear you.", mode: "normal", respondsTo: "late" }]));
    const recent = Array.from({ length: 7 }, (_, i) => ({ from: "PARTNER" as const, text: `m${i}` }));
    const r = await requestCloudReply({ ...input, recent }, { userId: "u", hasConsent: consent(true), invoker: g.invoker });
    expect(r).toMatchObject({ ok: true, source: "CLOUD_MODEL", text: "Sorry I was late. I hear you.", remaining: 7 });
    const body = (g.invoke.mock.calls[0] as unknown as [string, { body: { task: string; context: { recentMessages: unknown[]; currentText: string }; allowProviderFallback: boolean } }])[1].body;
    expect(body.task).toBe("QUICK_REPLY");
    expect(body.context.recentMessages.length).toBe(MAX_CONTEXT_MESSAGES);
    expect(body.allowProviderFallback).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/token|password|apikey|user_id/i);
  });
  it("maps provider/quota/invalid failures to honest fallbacks (never a fake model result)", async () => {
    for (const [code, reason] of [["QUOTA_EXCEEDED", "QUOTA"], ["NOT_IN_PLAN", "NOT_IN_PLAN"], ["INVALID_OUTPUT", "INVALID_OUTPUT"], ["PROVIDER_FAILED", "UNAVAILABLE"], ["NOT_CONFIGURED", "UNAVAILABLE"]] as const) {
      _resetCloudReplyInflight();
      const r = await requestCloudReply(input, { userId: "u", hasConsent: consent(true), invoker: mk(fail(code)).invoker });
      expect(r).toMatchObject({ ok: false, reason });
    }
  });
  it("treats insufficientContext as uncertainty, not a reply", async () => {
    const r = await requestCloudReply(input, { userId: "u", hasConsent: consent(true), invoker: mk(ok([], true)).invoker });
    expect(r).toMatchObject({ ok: false, reason: "INSUFFICIENT_CONTEXT" });
  });
  it("rejects leaky / empty / parroted output on the client and does NOT retry (no double charge)", async () => {
    const g = mk(ok([{ text: "As an AI language model, here is JSON", mode: "normal", respondsTo: "x" }]));
    const r = await requestCloudReply(input, { userId: "u", hasConsent: consent(true), invoker: g.invoker });
    expect(r).toMatchObject({ ok: false, reason: "INVALID_OUTPUT" });
    expect(g.invoke).toHaveBeenCalledTimes(1);
  });
  it("schema-invalid payloads never reach the UI", async () => {
    const r = await requestCloudReply(input, { userId: "u", hasConsent: consent(true), invoker: mk({ data: { ok: true, result: { nope: 1 } }, error: null }).invoker });
    expect(r.ok).toBe(false);
  });
  it("identical concurrent requests share ONE gateway call; different intent/message/user never share a result", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (_n: string, o: { body: { context: { currentText: string }; } }) => {
      calls.push(o.body.context.currentText);
      await new Promise((r) => setTimeout(r, 5));
      return ok([{ text: `reply to ${o.body.context.currentText}`, mode: "normal", respondsTo: "x" }]);
    });
    const deps = { userId: "u", hasConsent: consent(true), invoker: { invoke } as never };
    const [a1, a2] = await Promise.all([requestCloudReply({ partnerText: "msg A", intent: "ACK" }, deps), requestCloudReply({ partnerText: "msg A", intent: "ACK" }, deps)]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(a1).toEqual(a2);
    invoke.mockClear();
    const [b, c, d] = await Promise.all([
      requestCloudReply({ partnerText: "msg B", intent: "ACK" }, deps),
      requestCloudReply({ partnerText: "msg C", intent: "ACK" }, deps),
      requestCloudReply({ partnerText: "msg B", intent: "ACK" }, { ...deps, userId: "other-user" }),
    ]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(b).toMatchObject({ ok: true, text: "reply to msg B" });
    expect(c).toMatchObject({ ok: true, text: "reply to msg C" });
    expect(d).toMatchObject({ ok: true, text: "reply to msg B" });
  });
  it("cleans up in-flight state after failure so a retry makes a fresh call", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ok([{ text: "Okay, I hear you.", mode: "normal", respondsTo: "x" }]));
    const deps = { userId: "u", hasConsent: consent(true), invoker: { invoke } as never };
    const r1 = await requestCloudReply(input, deps);
    expect(r1.ok).toBe(false);
    const r2 = await requestCloudReply(input, deps);
    expect(r2.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("helpers", () => {
  it("modeFor uses existing gateway modes only", () => {
    expect(modeFor("ASK_FIRST")).toBe("ask_first");
    expect(modeFor("ACK", ["MAKE_CLEARER"])).toBe("shorter");
    expect(modeFor("ACK", ["TOO_FORMAL"])).toBe("casual");
    expect(modeFor("EXPLAIN")).toBe("normal");
  });
  it("acceptableReply", () => {
    expect(acceptableReply("", "hi")).toBe(false);
    expect(acceptableReply("x".repeat(400), "hi")).toBe(false);
    expect(acceptableReply("hi", "Hi")).toBe(false);
    expect(acceptableReply("Thanks for telling me.", "hi")).toBe(true);
  });
  it("buildReplyContext returns only messages before the selected one, labelled by sender", () => {
    const m = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `${i}`, sender_id: i % 2 ? "me" : "p", decryptedContent: `t${i}` }));
    const c = buildReplyContext(m, "6", "me");
    expect(c.map((x) => x.text)).toEqual(["t2", "t3", "t4", "t5"]);
    expect(c[0].from).toBe("PARTNER");
    expect(buildReplyContext(m, "1", "me")).toEqual([]);
  });
});
