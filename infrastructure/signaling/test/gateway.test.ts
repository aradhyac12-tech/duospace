import { describe, it, expect } from "vitest";
import { SignalingGateway, SERVER_SENDER_ID, roomNameForCall, sanitizeRelayPayload } from "../src/gateway.js";
import {
  CALLER, CALLEE, STRANGER, CALL_ID, CALL_ID_2, SESSION, SESSION_2, FakeConn, FakeAuthorizer, facts, harness,
} from "./helpers.js";

async function offered(h = harness()) {
  const ack = await h.send(CALLER, h.caller, "CALL_OFFER");
  expect(ack.status).toBe("DELIVERED");
  return h;
}
async function accepted(h = harness()) {
  await offered(h);
  h.auth.set(facts({ claimedBy: CALLEE })); // claim_call() already won in Supabase
  const ack = await h.send(CALLEE, h.callee, "CALL_ACCEPTED");
  expect(ack.status).toBe("DELIVERED");
  return h;
}

describe("connection lifecycle", () => {
  it("sends a READY frame only after registration (authenticated + usable session)", () => {
    const h = harness();
    const ready = h.caller.frames()[0];
    expect(ready.kind).toBe("ready");
    expect((ready as { userId: string }).userId).toBe(CALLER);
  });

  it("a second connection for the same user replaces the first and routes to the new one", async () => {
    const h = harness();
    const second = new FakeConn();
    h.gw.connect(CALLEE, second);
    expect(h.callee.closedWith?.[1]).toBe("replaced_by_new_connection");
    await h.send(CALLER, h.caller, "CALL_OFFER");
    expect(second.signals().length).toBe(1);
    expect(h.callee.signals().length).toBe(0);
  });

  it("a stale socket's delayed disconnect does not evict the newer connection", async () => {
    const h = harness();
    const second = new FakeConn();
    h.gw.connect(CALLEE, second);
    h.gw.disconnect(CALLEE, h.callee);
    expect(h.gw.sessions.isOnline(CALLEE)).toBe(true);
  });
});

describe("stale socket control (self-hosted-only migration)", () => {
  it("a message arriving on a REPLACED socket is rejected STALE_CONNECTION and never reaches the peer", async () => {
    const h = await offered();
    h.auth.set(facts({ claimedBy: CALLEE }));
    const newer = new FakeConn();
    h.gw.connect(CALLEE, newer);             // old callee socket replaced
    h.callee.open = true;                    // simulate a frame racing the close
    const before = h.caller.signals().length;
    const ack = await h.send(CALLEE, h.callee, "CALL_ACCEPTED");
    expect(ack.status).toBe("REJECTED");
    expect(ack.reason).toBe("STALE_CONNECTION");
    expect(h.caller.signals().length).toBe(before);
  });

  it("the newer socket can still control the same call", async () => {
    const h = await offered();
    h.auth.set(facts({ claimedBy: CALLEE }));
    const newer = new FakeConn();
    h.gw.connect(CALLEE, newer);
    const ack = await h.send(CALLEE, newer, "CALL_ACCEPTED");
    expect(ack.status).toBe("DELIVERED");
  });
});

describe("CALL_OFFER", () => {
  it("delivers a SERVER-BUILT offer straight to the callee over the socket (no Supabase Realtime involved)", async () => {
    const h = harness();
    const ack = await h.send(CALLER, h.caller, "CALL_OFFER", {
      senderId: STRANGER, // forged — must be ignored
      payload: { roomName: "someone-elses-room", callType: "video" }, // client payload — must NOT be relayed
    });
    expect(ack).toEqual({ kind: "ack", msgId: ack.msgId, callId: CALL_ID, type: "CALL_OFFER", status: "DELIVERED", state: "RINGING", sessionId: SESSION });
    const offer = h.callee.signals()[0];
    expect(offer.type).toBe("CALL_OFFER");
    expect(offer.senderId).toBe(CALLER);
    expect(offer.sessionId).toBe(SESSION);
    expect(offer.payload).toEqual({ callType: "voice", roomName: roomNameForCall(CALL_ID), ringTtlMs: 40_000 });
  });

  it("reports RECIPIENT_OFFLINE when the callee has no socket, and replays the still-ringing offer when they connect", async () => {
    const h = harness({ connectCallee: false });
    const ack = await h.send(CALLER, h.caller, "CALL_OFFER");
    expect(ack.status).toBe("RECIPIENT_OFFLINE");
    h.clock.t += 10_000;
    const late = new FakeConn();
    h.gw.connect(CALLEE, late);
    const replayed = late.signals()[0];
    expect(replayed.type).toBe("CALL_OFFER");
    expect((replayed.payload as { replayed: boolean }).replayed).toBe(true);
    expect((replayed.payload as { ringTtlMs: number }).ringTtlMs).toBe(30_000);
  });

  it("does NOT replay an offer after the ring window has elapsed", async () => {
    const h = harness({ connectCallee: false });
    await h.send(CALLER, h.caller, "CALL_OFFER");
    h.clock.t += 41_000;
    const late = new FakeConn();
    h.gw.connect(CALLEE, late);
    expect(late.signals().length).toBe(0);
  });

  it("refuses an offer from the callee (wrong direction), a stranger, a wrong recipient, an unknown call, and a wrong session", async () => {
    const h = harness();
    expect((await h.send(CALLEE, h.callee, "CALL_OFFER")).reason).toBe("INVALID_STATE");
    const stranger = new FakeConn();
    h.gw.connect(STRANGER, stranger);
    const strangerAck = await h.send(STRANGER, stranger, "CALL_OFFER", { recipientId: CALLEE });
    expect(strangerAck.reason).toBe("NOT_A_PARTICIPANT");
    expect(strangerAck.state).toBeUndefined(); // a stranger learns nothing about the call
    expect(strangerAck.sessionId).toBeUndefined();
    expect((await h.send(CALLER, h.caller, "CALL_OFFER", { recipientId: STRANGER })).reason).toBe("RECIPIENT_MISMATCH");
    expect((await h.send(CALLER, h.caller, "CALL_OFFER", { callId: CALL_ID_2 })).reason).toBe("UNKNOWN_CALL");
    expect((await h.send(CALLER, h.caller, "CALL_OFFER", { sessionId: "forged-session" })).reason).toBe("SESSION_MISMATCH");
    expect(h.callee.signals().length).toBe(0); // nothing leaked through
  });

  it("refuses a legacy-provider call, non-partners, and an already-claimed call", async () => {
    let h = harness();
    h.auth.set(facts({ provider: "daily" }));
    expect((await h.send(CALLER, h.caller, "CALL_OFFER")).reason).toBe("WRONG_PROVIDER");

    h = harness();
    h.auth.set(facts({ arePartners: false }));
    expect((await h.send(CALLER, h.caller, "CALL_OFFER")).reason).toBe("NOT_PARTNERS");

    h = harness();
    h.auth.set(facts({ claimedBy: CALLEE }));
    expect((await h.send(CALLER, h.caller, "CALL_OFFER")).reason).toBe("INVALID_STATE");
  });

  it("refuses an offer for a call whose persisted ring window already lapsed", async () => {
    const h = harness();
    h.auth.set(facts({ expiresAt: h.clock.t - 1 }));
    expect((await h.send(CALLER, h.caller, "CALL_OFFER")).reason).toBe("CALL_TERMINAL");
  });

  it("never extends the ring past the persisted expires_at", async () => {
    const h = harness();
    h.auth.set(facts({ expiresAt: h.clock.t + 12_000 }));
    await h.send(CALLER, h.caller, "CALL_OFFER");
    expect((h.callee.signals()[0].payload as { ringTtlMs: number }).ringTtlMs).toBe(12_000);
  });

  it("fails CLOSED and retryably when the authorizer is down, and the SAME msgId succeeds once it recovers", async () => {
    const h = harness();
    h.auth.down = true;
    const msg = JSON.stringify({ type: "CALL_OFFER", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "retry-1" });
    await h.gw.handleRaw(CALLER, h.caller, msg);
    expect(h.caller.lastAck().reason).toBe("AUTHZ_UNAVAILABLE");
    expect(h.callee.signals().length).toBe(0);
    h.auth.down = false;
    await h.gw.handleRaw(CALLER, h.caller, msg);
    expect(h.caller.lastAck().status).toBe("DELIVERED"); // transient refusal was not cached as "the answer"
  });

  it("a repeated offer is a DUPLICATE and does not ring twice", async () => {
    const h = await offered();
    const again = await h.send(CALLER, h.caller, "CALL_OFFER");
    expect(again.status).toBe("DUPLICATE");
    expect(h.callee.signals().length).toBe(1);
  });
});

describe("idempotency", () => {
  it("the same msgId gets the same answer and is never re-applied or re-forwarded", async () => {
    const h = harness();
    const raw = JSON.stringify({ type: "CALL_OFFER", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "same" });
    await h.gw.handleRaw(CALLER, h.caller, raw);
    await h.gw.handleRaw(CALLER, h.caller, raw);
    expect(h.caller.acks().map((a) => a.status)).toEqual(["DELIVERED", "DELIVERED"]);
    expect(h.callee.signals().length).toBe(1);
  });

  it("two concurrent copies of one msgId are processed once", async () => {
    const h = harness();
    const raw = JSON.stringify({ type: "CALL_OFFER", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "race" });
    await Promise.all([h.gw.handleRaw(CALLER, h.caller, raw), h.gw.handleRaw(CALLER, h.caller, raw)]);
    expect(h.callee.signals().length).toBe(1);
    expect(h.auth.lookups).toBe(1);
  });
});

describe("CALL_ACCEPTED", () => {
  it("is delivered to the caller over the socket once the callee really holds the claim", async () => {
    const h = await accepted();
    const got = h.caller.signals().find((m) => m.type === "CALL_ACCEPTED");
    expect(got?.senderId).toBe(CALLEE);
    expect(got?.sessionId).toBe(SESSION);
    expect(h.caller.lastAck().type).not.toBe("CALL_ACCEPTED"); // (caller's own acks are for its own sends)
  });

  it("is refused with NOT_CLAIMED if the accepter never won claim_call() — a WebSocket accept alone never wins a call", async () => {
    const h = await offered();
    const ack = await h.send(CALLEE, h.callee, "CALL_ACCEPTED");
    expect(ack.reason).toBe("NOT_CLAIMED");
    expect(h.caller.signals().some((m) => m.type === "CALL_ACCEPTED")).toBe(false);
  });

  it("is refused when the persisted call is no longer in_progress", async () => {
    const h = await offered();
    h.auth.set(facts({ status: "cancelled", claimedBy: CALLEE }));
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("CALL_TERMINAL");
  });

  it("the caller cannot send CALL_ACCEPTED", async () => {
    const h = await offered();
    expect((await h.send(CALLER, h.caller, "CALL_ACCEPTED")).reason).toBe("INVALID_STATE");
  });

  it("a second accept is a DUPLICATE, not a second delivery", async () => {
    const h = await accepted();
    const before = h.caller.signals().length;
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).status).toBe("DUPLICATE");
    expect(h.caller.signals().length).toBe(before);
  });

  it("fails closed (retryable) if Supabase can't confirm the claim", async () => {
    const h = await offered();
    h.auth.down = true;
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("AUTHZ_UNAVAILABLE");
  });
});

describe("CALL_REJECTED / CALL_CANCELLED / CALL_ENDED state validation", () => {
  it("reject while ringing reaches the caller immediately and forwards only a sanitized reason", async () => {
    const h = await offered();
    const ack = await h.send(CALLEE, h.callee, "CALL_REJECTED", { payload: { reason: "timeout", evil: "<script>" } });
    expect(ack.status).toBe("DELIVERED");
    const got = h.caller.signals().find((m) => m.type === "CALL_REJECTED");
    expect(got?.payload).toEqual({ reason: "timeout" });
  });

  it("CALL_REJECTED after accepted is refused (would destroy a connected call)", async () => {
    const h = await accepted();
    const ack = await h.send(CALLEE, h.callee, "CALL_REJECTED");
    expect(ack.reason).toBe("INVALID_STATE");
    expect(ack.state).toBe("ACCEPTED");
    expect(h.caller.signals().some((m) => m.type === "CALL_REJECTED")).toBe(false);
  });

  it("CALL_CANCELLED after accepted is refused and tells the sender the call is ACCEPTED (so it can convert to an end)", async () => {
    const h = await accepted();
    const ack = await h.send(CALLER, h.caller, "CALL_CANCELLED");
    expect(ack.reason).toBe("INVALID_STATE");
    expect(ack.state).toBe("ACCEPTED");
    expect(h.callee.signals().some((m) => m.type === "CALL_CANCELLED")).toBe(false);
  });

  it("cancel while ringing terminates the callee's ring; the callee cannot cancel", async () => {
    const h = await offered();
    expect((await h.send(CALLEE, h.callee, "CALL_CANCELLED")).reason).toBe("INVALID_STATE");
    expect((await h.send(CALLER, h.caller, "CALL_CANCELLED")).status).toBe("DELIVERED");
    expect(h.callee.signals().some((m) => m.type === "CALL_CANCELLED")).toBe(true);
  });

  it("CALL_CANCELLED after ended is refused as terminal", async () => {
    const h = await accepted();
    await h.send(CALLER, h.caller, "CALL_ENDED");
    expect((await h.send(CALLER, h.caller, "CALL_CANCELLED")).reason).toBe("CALL_TERMINAL");
  });

  it("CALL_ACCEPTED after a terminal state is refused", async () => {
    let h = await offered();
    await h.send(CALLEE, h.callee, "CALL_REJECTED");
    h.auth.set(facts({ claimedBy: CALLEE }));
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("CALL_TERMINAL");

    h = await offered();
    await h.send(CALLER, h.caller, "CALL_CANCELLED");
    h.auth.set(facts({ claimedBy: CALLEE }));
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("CALL_TERMINAL");
  });

  it("CALL_ENDED: either participant may end an accepted call; a stranger may not; it can't end a call that was never accepted", async () => {
    let h = await offered();
    expect((await h.send(CALLER, h.caller, "CALL_ENDED")).reason).toBe("INVALID_STATE"); // still ringing → that's a cancel

    h = await accepted();
    const stranger = new FakeConn();
    h.gw.connect(STRANGER, stranger);
    expect((await h.send(STRANGER, stranger, "CALL_ENDED", { recipientId: CALLEE })).reason).toBe("NOT_A_PARTICIPANT");
    expect((await h.send(CALLEE, h.callee, "CALL_ENDED")).status).toBe("DELIVERED");
    expect(h.caller.signals().some((m) => m.type === "CALL_ENDED")).toBe(true);
    expect((await h.send(CALLEE, h.callee, "CALL_ENDED")).status).toBe("DUPLICATE");
  });

  it("CALL_ENDED is delivered to the other side straight over the socket so it can tear down its provider session", async () => {
    const h = await accepted();
    await h.send(CALLER, h.caller, "CALL_ENDED");
    const got = h.callee.signals().find((m) => m.type === "CALL_ENDED");
    expect(got).toBeDefined();
    expect(got?.senderId).toBe(CALLER);
  });

  it("CALL_BUSY from the callee terminates a ringing call for the caller", async () => {
    const h = await offered();
    expect((await h.send(CALLEE, h.callee, "CALL_BUSY")).status).toBe("DELIVERED");
    expect(h.caller.signals().some((m) => m.type === "CALL_BUSY")).toBe(true);
  });
});

describe("stale sessions and other calls", () => {
  it("an old call's late events can never touch a newer call between the same two people", async () => {
    const h = await accepted();
    await h.send(CALLER, h.caller, "CALL_ENDED"); // call 1 over
    h.auth.set(facts({ callId: CALL_ID_2, sessionId: SESSION_2 })); // call 2 starts
    const ack2 = await h.send(CALLER, h.caller, "CALL_OFFER", { callId: CALL_ID_2, sessionId: SESSION_2 });
    expect(ack2.status).toBe("DELIVERED");

    // Old CALL_ACCEPTED / CALL_CANCELLED / CALL_ENDED for call 1 arrive now.
    h.auth.set(facts({ status: "completed", claimedBy: CALLEE }));
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("CALL_TERMINAL");
    expect((await h.send(CALLER, h.caller, "CALL_CANCELLED")).reason).toBe("CALL_TERMINAL");
    expect((await h.send(CALLER, h.caller, "CALL_ENDED")).status).toBe("DUPLICATE");
    // ...and using call 1's SESSION on call 2's id is refused.
    expect((await h.send(CALLEE, h.callee, "CALL_REJECTED", { callId: CALL_ID_2 })).reason).toBe("SESSION_MISMATCH");
    // Call 2 is still ringing and unaffected.
    expect(h.gw.registry.get(CALL_ID_2)?.state).toBe("RINGING");
  });
});

describe("ring timeout (server-originated)", () => {
  it("clients can never send CALL_TIMEOUT", async () => {
    const h = await offered();
    expect((await h.send(CALLER, h.caller, "CALL_TIMEOUT")).reason).toBe("SERVER_ONLY_EVENT");
  });

  it("sweep() times out a still-ringing call, tells BOTH sides (server sender), and later accepts are refused", async () => {
    const h = await offered();
    h.clock.t += 41_000;
    h.gw.sweep();
    for (const conn of [h.caller, h.callee]) {
      const t = conn.signals().find((m) => m.type === "CALL_TIMEOUT");
      expect(t?.senderId).toBe(SERVER_SENDER_ID);
    }
    h.auth.set(facts({ claimedBy: CALLEE }));
    expect((await h.send(CALLEE, h.callee, "CALL_ACCEPTED")).reason).toBe("CALL_TERMINAL");
  });

  it("an accepted call is never timed out by the sweep", async () => {
    const h = await accepted();
    h.clock.t += 10 * 60_000;
    h.gw.sweep();
    expect(h.gw.registry.get(CALL_ID)?.state).toBe("ACCEPTED");
  });
});

describe("input hardening", () => {
  it("rate-limited senders get a retryable RATE_LIMITED refusal and nothing is processed", async () => {
    const h = harness({ limiter: () => false });
    const ack = await h.send(CALLER, h.caller, "CALL_OFFER");
    expect(ack.reason).toBe("RATE_LIMITED");
    expect(h.auth.lookups).toBe(0);
  });

  it("malformed messages with a msgId are answered MALFORMED; without one they're dropped", async () => {
    const h = harness();
    await h.gw.handleRaw(CALLER, h.caller, JSON.stringify({ type: "DELETE_EVERYTHING", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "x1" }));
    expect(h.caller.lastAck().reason).toBe("MALFORMED");
    const framesBefore = h.caller.sent.length;
    await h.gw.handleRaw(CALLER, h.caller, JSON.stringify({ type: "CALL_OFFER", callId: "not-a-uuid", recipientId: CALLEE, sessionId: SESSION }));
    await h.gw.handleRaw(CALLER, h.caller, "not json");
    await h.gw.handleRaw(CALLER, h.caller, JSON.stringify({ type: "CALL_OFFER", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION })); // no msgId
    expect(h.caller.sent.length).toBe(framesBefore);
  });

  it("oversized frames are dropped before parsing", async () => {
    const h = harness();
    const before = h.caller.sent.length;
    await h.gw.handleRaw(CALLER, h.caller, "x".repeat(9_000));
    expect(h.caller.sent.length).toBe(before);
  });
});

describe("CALL_SYNC (reconnect resync)", () => {
  it("a participant reconnecting mid-call is told the call's state and nothing is recreated", async () => {
    const h = await accepted();
    const reconnected = new FakeConn();
    h.gw.connect(CALLER, reconnected);
    await h.gw.handleRaw(CALLER, reconnected, JSON.stringify({ type: "CALL_SYNC", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "sync1" }));
    const state = reconnected.frames().find((f) => f.kind === "state");
    expect(state).toEqual({ kind: "state", callId: CALL_ID, sessionId: SESSION, state: "ACCEPTED" });
    expect(h.gw.registry.size()).toBe(1);
  });

  it("after the call ended, a late sync reports the terminal state so stale UI can stand down", async () => {
    const h = await accepted();
    await h.send(CALLEE, h.callee, "CALL_ENDED");
    const reconnected = new FakeConn();
    h.gw.connect(CALLER, reconnected);
    await h.gw.handleRaw(CALLER, reconnected, JSON.stringify({ type: "CALL_SYNC", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "sync2" }));
    expect((reconnected.frames().find((f) => f.kind === "state") as { state: string }).state).toBe("ENDED");
  });

  it("a sync for the wrong session or by a stranger yields no state", async () => {
    const h = await accepted();
    const stranger = new FakeConn();
    h.gw.connect(STRANGER, stranger);
    await h.gw.handleRaw(STRANGER, stranger, JSON.stringify({ type: "CALL_SYNC", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "s3" }));
    expect(stranger.frames().some((f) => f.kind === "state")).toBe(false);
    await h.gw.handleRaw(CALLER, h.caller, JSON.stringify({ type: "CALL_SYNC", callId: CALL_ID, recipientId: CALLEE, sessionId: "old-session", msgId: "s4" }));
    expect(h.caller.frames().filter((f) => f.kind === "state").length).toBe(0);
  });
});

describe("server restart (registry lost)", () => {
  it("rebuilds an in-progress, claimed call from Supabase facts and still validates against it", async () => {
    const auth = new FakeAuthorizer();
    auth.set(facts({ claimedBy: CALLEE }));
    const gw = new SignalingGateway({ authorizer: auth, messageLimiter: { check: () => true } });
    const a = new FakeConn(); const b = new FakeConn();
    gw.connect(CALLER, a); gw.connect(CALLEE, b);
    await gw.handleRaw(CALLER, a, JSON.stringify({ type: "CALL_ENDED", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "e1" }));
    expect(a.lastAck().status).toBe("DELIVERED");
    expect(b.signals().some((m) => m.type === "CALL_ENDED")).toBe(true);
    // a stranger still can't
    const s = new FakeConn(); gw.connect(STRANGER, s);
    await gw.handleRaw(STRANGER, s, JSON.stringify({ type: "CALL_ENDED", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "e2" }));
    expect(s.lastAck().reason).toBe("NOT_A_PARTICIPANT");
  });

  it("an OFFER for a rebuilt (non-offer-originated) entry still re-verifies the partnership", async () => {
    const h = harness();
    // Entry gets created by a SYNC (no partner check on that path)...
    h.auth.set(facts({ arePartners: false }));
    await h.gw.handleRaw(CALLER, h.caller, JSON.stringify({ type: "CALL_SYNC", callId: CALL_ID, recipientId: CALLEE, sessionId: SESSION, msgId: "s0" }));
    // ...but a later OFFER must not inherit trust from it.
    expect((await h.send(CALLER, h.caller, "CALL_OFFER")).reason).toBe("NOT_PARTNERS");
  });
});

describe("relay-only events", () => {
  it("relays only a tiny flat primitive payload between the two participants of a live call", async () => {
    const h = await accepted();
    await h.send(CALLER, h.caller, "NETWORK_CHANGED", { payload: { quality: "poor", nested: { x: 1 }, big: "y".repeat(500), n: 3 } });
    const got = h.callee.signals().find((m) => m.type === "NETWORK_CHANGED");
    expect(got?.payload).toEqual({ quality: "poor", n: 3 });
  });

  it("does not relay for a terminated call", async () => {
    const h = await accepted();
    await h.send(CALLER, h.caller, "CALL_ENDED");
    expect((await h.send(CALLER, h.caller, "PARTICIPANT_READY")).reason).toBe("CALL_TERMINAL");
  });

  it("sanitizeRelayPayload drops arrays/objects/non-finite numbers", () => {
    expect(sanitizeRelayPayload([1, 2])).toBeUndefined();
    expect(sanitizeRelayPayload({ a: Number.NaN, b: true })).toEqual({ b: true });
  });
});

describe("heartbeat", () => {
  it("pings every live connection", () => {
    const h = harness();
    h.gw.heartbeat();
    expect(h.caller.frames().some((f) => f.kind === "ping")).toBe(true);
    expect(h.callee.frames().some((f) => f.kind === "ping")).toBe(true);
  });
});
