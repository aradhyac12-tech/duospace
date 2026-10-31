import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestCloudUnderstand, _resetCloudUnderstandInflight } from "@/lib/relationship/contextual/cloudUnderstand";

const res = (r: Record<string, unknown>) => ({ data: { ok: true, task: "UNDERSTAND", result: { language: { code: "en", script: "latin", codeMixed: false }, summary: "They say they are tired of waiting.", intent: "FEELING_EXPRESSED", evidence: ["tired of waiting"], why: null, offerReply: true, cannotTell: false, confidence: "MEDIUM", ...r }, meta: { provider: "openai", fallbackUsed: false, remaining: 5 } }, error: null });
const yes = async () => true;
const mk = (v: unknown) => { const invoke = vi.fn(async () => v as never); return { invoke, invoker: { invoke } }; };
const text = "I'm tired of waiting for you";
beforeEach(() => _resetCloudUnderstandInflight());

describe("requestCloudUnderstand", () => {
  it("no gateway call without consent", async () => {
    const g = mk(res({}));
    const r = await requestCloudUnderstand({ text }, { userId: "u", hasConsent: async () => false, invoker: g.invoker });
    expect(g.invoke).not.toHaveBeenCalled(); expect(r).toEqual({ ok: false, reason: "NO_CONSENT" });
  });
  it("returns grounded interpretation; evidence must literally appear in the message", async () => {
    const r = await requestCloudUnderstand({ text }, { userId: "u", hasConsent: yes, invoker: mk(res({ evidence: ["tired of waiting", "invented quote"] })).invoker });
    expect(r).toMatchObject({ ok: true, source: "CLOUD_MODEL", evidence: ["tired of waiting"], cannotTell: false });
  });
  it("no supporting evidence → surfaced as uncertainty", async () => {
    const r = await requestCloudUnderstand({ text }, { userId: "u", hasConsent: yes, invoker: mk(res({ evidence: ["made up"] })).invoker });
    expect(r).toMatchObject({ ok: true, cannotTell: true });
  });
  it("rejects hidden-motive claims", async () => {
    const r = await requestCloudUnderstand({ text }, { userId: "u", hasConsent: yes, invoker: mk(res({ summary: "They secretly want to leave." })).invoker });
    expect(r.ok).toBe(false);
  });
  it("maps quota failures to QUOTA", async () => {
    const q = await requestCloudUnderstand({ text }, { userId: "u", hasConsent: yes, invoker: mk({ data: { ok: false, code: "QUOTA_EXCEEDED", message: "x", fallback: "DETERMINISTIC" }, error: null }).invoker });
    expect(q).toEqual({ ok: false, reason: "QUOTA" });
  });
  it("identical concurrent requests share ONE call", async () => {
    const g = mk(res({})); const d = { userId: "u", hasConsent: yes, invoker: g.invoker };
    const [a, b] = await Promise.all([requestCloudUnderstand({ text }, d), requestCloudUnderstand({ text }, d)]);
    expect(g.invoke).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
  it("REGRESSION: a different message never receives another message's result", async () => {
    const invoke = vi.fn(async (_n: string, o: { body: { context: { currentText: string } } }) => {
      const t = o.body.context.currentText;
      await new Promise((r) => setTimeout(r, 5));
      return res({ summary: `Summary of ${t}`, evidence: [t] });
    });
    const d = { userId: "u", hasConsent: yes, invoker: { invoke } as never };
    const [a, b] = await Promise.all([requestCloudUnderstand({ text: "first message here" }, d), requestCloudUnderstand({ text: "second message there" }, d)]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(a).toMatchObject({ ok: true, summary: "Summary of first message here" });
    expect(b).toMatchObject({ ok: true, summary: "Summary of second message there" });
  });
  it("REGRESSION: different users never share a result", async () => {
    const g = mk(res({}));
    await Promise.all([
      requestCloudUnderstand({ text }, { userId: "u1", hasConsent: yes, invoker: g.invoker }),
      requestCloudUnderstand({ text }, { userId: "u2", hasConsent: yes, invoker: g.invoker }),
    ]);
    expect(g.invoke).toHaveBeenCalledTimes(2);
  });
  it("cleans up after failure/success; later identical request makes a fresh call; concurrency is bounded", async () => {
    const g = mk(res({})); const d = { userId: "u", hasConsent: yes, invoker: g.invoker };
    await requestCloudUnderstand({ text }, d); await requestCloudUnderstand({ text }, d);
    expect(g.invoke).toHaveBeenCalledTimes(2);
    const releases: Array<(v: unknown) => void> = [];
    const slow = { invoke: vi.fn(() => new Promise((r) => { releases.push(r); })) };
    const ps = Array.from({ length: 6 }, (_, i) => requestCloudUnderstand({ text: `m${i}` }, { userId: "u", hasConsent: yes, invoker: slow as never }));
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.invoke.mock.calls.length).toBeLessThanOrEqual(4);
    releases.forEach((r) => r(res({})));
    await Promise.allSettled(ps);
  });
});
