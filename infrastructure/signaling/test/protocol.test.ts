import { describe, it, expect } from "vitest";
import { isWellFormedMessage } from "../src/types.js";
import { SessionRegistry } from "../src/session.js";
import { CallRegistry, evaluateTransition, type CallEntry } from "../src/callRegistry.js";
import { parseCallFacts, initialStateFromFacts, SupabaseRpcCallAuthorizer, AuthorizerUnavailableError } from "../src/authorizer.js";
import { CALLER, CALLEE, STRANGER, CALL_ID, SESSION, FakeConn, facts } from "./helpers.js";

const base = { type: "CALL_OFFER", callId: CALL_ID, recipientId: CALLEE, sessionId: "s1", msgId: "m1" };

describe("isWellFormedMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isWellFormedMessage(base)).toBe(true);
  });
  it("REQUIRES a msgId (there would be nothing to ack)", () => {
    const { msgId: _m, ...noId } = base;
    expect(isWellFormedMessage(noId)).toBe(false);
    expect(isWellFormedMessage({ ...base, msgId: "" })).toBe(false);
    expect(isWellFormedMessage({ ...base, msgId: "x".repeat(65) })).toBe(false);
  });
  it("rejects missing callId/recipientId/sessionId", () => {
    expect(isWellFormedMessage({ type: "CALL_OFFER" })).toBe(false);
    expect(isWellFormedMessage({ ...base, callId: undefined })).toBe(false);
    expect(isWellFormedMessage({ ...base, recipientId: undefined })).toBe(false);
    expect(isWellFormedMessage({ ...base, sessionId: undefined })).toBe(false);
  });
  it("does not require senderId — the server overwrites it regardless", () => {
    expect(isWellFormedMessage({ ...base, senderId: "forged" })).toBe(true);
  });
  it("rejects non-UUID ids, unknown types and absurd session ids", () => {
    expect(isWellFormedMessage({ ...base, callId: "c1" })).toBe(false);
    expect(isWellFormedMessage({ ...base, recipientId: "u2" })).toBe(false);
    expect(isWellFormedMessage({ ...base, type: "DELETE_EVERYTHING" })).toBe(false);
    expect(isWellFormedMessage({ ...base, sessionId: "x".repeat(500) })).toBe(false);
  });
});

describe("SessionRegistry", () => {
  it("replaces a stale connection for the same user and closes the old one", () => {
    const reg = new SessionRegistry();
    const first = new FakeConn(); const second = new FakeConn();
    reg.register("u", first); reg.register("u", second);
    expect(reg.getConnection("u")).toBe(second);
    expect(first.closedWith).toEqual([4000, "replaced_by_new_connection"]);
  });
  it("a stale socket's delayed close does not evict the newer connection", () => {
    const reg = new SessionRegistry();
    const first = new FakeConn(); const second = new FakeConn();
    reg.register("u", first); reg.register("u", second);
    reg.unregister("u", first);
    expect(reg.isOnline("u")).toBe(true);
  });
  it("isOnline is false for a registered-but-closed connection", () => {
    const reg = new SessionRegistry();
    const c = new FakeConn();
    reg.register("u", c);
    c.open = false;
    expect(reg.isOnline("u")).toBe(false);
  });
});

function entry(over: Partial<CallEntry> = {}): CallEntry {
  return {
    callId: CALL_ID, sessionId: SESSION, callerId: CALLER, receiverId: CALLEE, callType: "voice", state: "RINGING",
    ringExpiresAt: 10_000, updatedAt: 0, offerDelivered: false, partnersVerified: true, pendingOffer: null, ...over,
  };
}

describe("evaluateTransition (pure state machine)", () => {
  it("allows the legal edges", () => {
    expect(evaluateTransition(entry(), "CALL_ACCEPTED", CALLEE)).toEqual({ ok: true, next: "ACCEPTED", changed: true });
    expect(evaluateTransition(entry(), "CALL_REJECTED", CALLEE)).toEqual({ ok: true, next: "REJECTED", changed: true });
    expect(evaluateTransition(entry(), "CALL_CANCELLED", CALLER)).toEqual({ ok: true, next: "CANCELLED", changed: true });
    expect(evaluateTransition(entry({ state: "ACCEPTED" }), "CALL_ENDED", CALLER)).toEqual({ ok: true, next: "ENDED", changed: true });
    expect(evaluateTransition(entry({ state: "ACCEPTED" }), "CALL_ENDED", CALLEE)).toEqual({ ok: true, next: "ENDED", changed: true });
  });
  it("treats a repeat as unchanged (idempotent)", () => {
    expect(evaluateTransition(entry({ state: "ACCEPTED" }), "CALL_ACCEPTED", CALLEE)).toEqual({ ok: true, next: "ACCEPTED", changed: false });
  });
  it("refuses everything illegal", () => {
    expect(evaluateTransition(entry({ state: "ACCEPTED" }), "CALL_REJECTED", CALLEE)).toEqual({ ok: false, reason: "INVALID_STATE", state: "ACCEPTED" });
    expect(evaluateTransition(entry({ state: "ACCEPTED" }), "CALL_CANCELLED", CALLER)).toEqual({ ok: false, reason: "INVALID_STATE", state: "ACCEPTED" });
    expect(evaluateTransition(entry({ state: "ENDED" }), "CALL_ACCEPTED", CALLEE)).toEqual({ ok: false, reason: "CALL_TERMINAL", state: "ENDED" });
    expect(evaluateTransition(entry(), "CALL_ENDED", CALLER)).toEqual({ ok: false, reason: "INVALID_STATE", state: "RINGING" });
    expect(evaluateTransition(entry(), "CALL_ENDED", STRANGER)).toEqual({ ok: false, reason: "NOT_A_PARTICIPANT", state: "RINGING" });
    expect(evaluateTransition(entry(), "CALL_ACCEPTED", CALLER)).toEqual({ ok: false, reason: "INVALID_STATE", state: "RINGING" });
  });
});

describe("CallRegistry", () => {
  it("sweep times out ringing calls and evicts old terminal ones", () => {
    const reg = new CallRegistry(1_000);
    reg.put(entry());
    expect(reg.sweep(5_000)).toEqual([]);
    const timedOut = reg.sweep(10_000);
    expect(timedOut.length).toBe(1);
    expect(reg.get(CALL_ID)?.state).toBe("TIMED_OUT");
    reg.sweep(12_000);
    expect(reg.get(CALL_ID)).toBeUndefined();
  });
  it("is bounded", () => {
    const reg = new CallRegistry(60_000, 2);
    reg.put(entry({ callId: "1" })); reg.put(entry({ callId: "2", state: "ENDED" })); reg.put(entry({ callId: "3" }));
    expect(reg.size()).toBe(2);
    expect(reg.get("2")).toBeUndefined(); // the terminal one was evicted first
  });
});

describe("authorizer", () => {
  const raw = { found: true, id: CALL_ID, caller_id: CALLER, receiver_id: CALLEE, provider: "self_hosted", status: "in_progress", claimed_by: null, session_id: SESSION, expires_at: "2026-09-20T10:00:40.000Z", call_type: "video", declined: false, are_partners: true };
  it("parses the RPC contract", () => {
    const f = parseCallFacts(raw);
    expect(f?.callerId).toBe(CALLER);
    expect(f?.callType).toBe("video");
    expect(f?.arePartners).toBe(true);
    expect(f?.expiresAt).toBe(Date.parse("2026-09-20T10:00:40.000Z"));
  });
  it("treats found:false, junk and bad ids as an unknown call", () => {
    expect(parseCallFacts({ found: false })).toBeNull();
    expect(parseCallFacts(null)).toBeNull();
    expect(parseCallFacts({ ...raw, caller_id: "nope" })).toBeNull();
    expect(parseCallFacts({ ...raw, session_id: undefined })).toBeNull();
  });
  it("only an explicit are_partners:true counts as partners", () => {
    expect(parseCallFacts({ ...raw, are_partners: undefined })?.arePartners).toBe(false);
  });
  it("maps persisted status to server state", () => {
    const now = 1_000;
    expect(initialStateFromFacts(facts(), now)).toBe("RINGING");
    expect(initialStateFromFacts(facts({ claimedBy: CALLEE }), now)).toBe("ACCEPTED");
    expect(initialStateFromFacts(facts({ expiresAt: 500 }), now)).toBe("TIMED_OUT");
    expect(initialStateFromFacts(facts({ status: "completed" }), now)).toBe("ENDED");
    expect(initialStateFromFacts(facts({ status: "cancelled" }), now)).toBe("CANCELLED");
    expect(initialStateFromFacts(facts({ status: "missed", declined: true }), now)).toBe("REJECTED");
    expect(initialStateFromFacts(facts({ status: "missed" }), now)).toBe("TIMED_OUT");
    expect(initialStateFromFacts(facts({ status: "weird" }), now)).toBe("ENDED");
  });
  it("SupabaseRpcCallAuthorizer sends ONLY the call id, with service-role auth, to the one RPC", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const a = new SupabaseRpcCallAuthorizer({
      supabaseUrl: "https://proj.supabase.co/", serviceRoleKey: "svc",
      fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return { ok: true, json: async () => raw }; }) as unknown as typeof fetch,
    });
    const f = await a.getCallFacts(CALL_ID);
    expect(f?.callId).toBe(CALL_ID);
    expect(seen!.url).toBe("https://proj.supabase.co/rest/v1/rpc/signaling_get_call_facts");
    expect(seen!.init.body).toBe(JSON.stringify({ _call_id: CALL_ID }));
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer svc");
  });
  it("never forwards a non-uuid id, and turns transport/HTTP failures into AuthorizerUnavailableError", async () => {
    let called = false;
    const ok = new SupabaseRpcCallAuthorizer({ supabaseUrl: "https://p", serviceRoleKey: "k", fetchImpl: (async () => { called = true; return { ok: true, json: async () => null }; }) as unknown as typeof fetch });
    expect(await ok.getCallFacts("1; drop table")).toBeNull();
    expect(called).toBe(false);
    const http500 = new SupabaseRpcCallAuthorizer({ supabaseUrl: "https://p", serviceRoleKey: "k", fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch });
    await expect(http500.getCallFacts(CALL_ID)).rejects.toThrow(/http 500/);
    const boom = new SupabaseRpcCallAuthorizer({ supabaseUrl: "https://p", serviceRoleKey: "k", fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    let err: unknown;
    try { await boom.getCallFacts(CALL_ID); } catch (e) { err = e; }
    expect(err instanceof AuthorizerUnavailableError).toBe(true);
  });
});
