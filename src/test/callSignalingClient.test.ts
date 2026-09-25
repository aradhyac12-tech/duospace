import { describe, it, expect } from "vitest";
import { World, ALICE, BOB, MALLORY } from "./helpers/world";
import { SERVER_SENDER_ID, type SignalingMessage } from "@/lib/signalingEngine/types";

async function setup() {
  const w = new World();
  const alice = w.client(ALICE);
  const bob = w.client(BOB);
  await alice.ensureReady();
  await bob.ensureReady();
  const bobInbox: SignalingMessage[] = [];
  const aliceInbox: SignalingMessage[] = [];
  bob.onMessage((m) => bobInbox.push(m));
  alice.onMessage((m) => aliceInbox.push(m));
  const row = w.db.insert(ALICE, BOB);
  return { w, alice, bob, row, bobInbox, aliceInbox };
}
const offerArgs = (row: { id: string; session_id: string }) => ({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" as const });
const msg = (over: Partial<SignalingMessage>): SignalingMessage => ({
  type: "CALL_ACCEPTED", callId: "x", senderId: BOB, recipientId: ALICE, ts: 1, sessionId: "s", ...over,
});

describe("ensureReady", () => {
  it("resolves ready with no waiting when already ready", async () => {
    const { alice } = await setup();
    expect(await alice.ensureReady()).toEqual({ ready: true, waitedMs: 0 });
  });
  it("reports NO_USER without a user id and never creates a transport", async () => {
    const w = new World();
    const { CallSignalingClient } = await import("@/lib/signalingEngine/CallSignalingClient");
    let created = 0;
    const c = new CallSignalingClient({ userId: null, configured: true, createTransport: () => { created += 1; return w.transport(ALICE); } });
    expect(await c.ensureReady()).toEqual({ ready: false, reason: "NO_USER" });
    expect(created).toBe(0);
  });
  it("reports CONNECT_TIMEOUT when the gateway is unreachable (fail fast, no fallback)", async () => {
    const w = new World();
    w.transport(ALICE).unreachable = true;
    const p = w.client(ALICE).ensureReady({ timeoutMs: 500 });
    await w.clock.advance(600);
    expect(await p).toEqual({ ready: false, reason: "CONNECT_TIMEOUT" });
  });
});

describe("critical sends: never silent", () => {
  it("retries a lost ack under the SAME msgId and the gateway applies it once", async () => {
    const { w, alice, row, bobInbox } = await setup();
    const t = w.transport(ALICE);
    t.dropOutbound = true;
    const p = alice.offer(offerArgs(row));
    await w.clock.advance(100); // first write is lost in flight
    t.dropOutbound = false;
    await w.clock.advance(200); // ack timeout (200ms) → retry succeeds
    const r = await p;
    expect(r.status).toBe("DELIVERED");
    if (r.status === "DELIVERED") expect(r.attempts).toBe(2);
    expect(new Set(t.writes.map((x) => x.msgId)).size).toBe(1);
    expect(bobInbox.length).toBe(1);
  });

  it("returns TIMEOUT (not success) when acks never arrive", async () => {
    const { w, alice, row } = await setup();
    w.transport(ALICE).dropOutbound = true;
    const p = alice.offer(offerArgs(row));
    await w.clock.advance(2_000);
    const r = await p;
    expect(r.status).toBe("TIMEOUT");
    if (r.status === "TIMEOUT") expect(r.attempts).toBe(3);
    expect(alice.getSession(row.id)?.state).toBe("ENDED"); // a failed offer is not a live ring
  });

  it("reject while offline is QUEUED, then settles DELIVERED after reconnect", async () => {
    const { w, alice, bob, row, aliceInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.transport(BOB).dropConnection();
    w.db.decline(row.id, BOB);
    const settled: string[] = [];
    const r = await bob.reject(row.id, "user", { onSettled: (x) => settled.push(x.status) });
    expect(r.status).toBe("QUEUED");
    w.transport(BOB).reconnect();
    await w.clock.flush();
    expect(settled).toEqual(["DELIVERED"]);
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_REJECTED"]);
  });

  it("a definitive refusal is returned with its reason and NOT retried", async () => {
    const { w, alice, row } = await setup();
    const r = await alice.offer({ ...offerArgs(row), sessionId: "forged" });
    expect(r.status).toBe("REJECTED");
    if (r.status === "REJECTED") expect(r.reason).toBe("SESSION_MISMATCH");
    expect(w.transport(ALICE).writes.length).toBe(1);
  });

  it("retries a retryable refusal (authorizer down) and succeeds when it recovers", async () => {
    const { w, alice, row } = await setup();
    w.db.down = true;
    const p = alice.offer(offerArgs(row));
    await w.clock.advance(100);
    w.db.down = false;
    await w.clock.advance(500);
    expect((await p).status).toBe("DELIVERED");
  });

  it("accept without holding the claim is refused NOT_CLAIMED and local state reverts", async () => {
    const { alice, bob, row } = await setup();
    await alice.offer(offerArgs(row));
    const r = await bob.accept(row.id); // never called claim
    expect(r.status).toBe("REJECTED");
    if (r.status === "REJECTED") expect(r.reason).toBe("NOT_CLAIMED");
    expect(bob.getSession(row.id)?.state).toBe("RINGING");
  });

  it("repeating a terminal action is a local DUPLICATE, not another network send", async () => {
    const { w, alice, bob, row } = await setup();
    await alice.offer(offerArgs(row));
    w.db.decline(row.id, BOB);
    await bob.reject(row.id);
    const writes = w.transport(BOB).writes.length;
    expect((await bob.reject(row.id)).status).toBe("DUPLICATE");
    expect(w.transport(BOB).writes.length).toBe(writes);
  });

  it("terminate() picks cancel / reject / end from the call's state", async () => {
    const { w, alice, bob, row, bobInbox, aliceInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.db.claim(row.id, BOB);
    await bob.accept(row.id);
    await bob.terminate(row.id, { connected: true });
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_ACCEPTED", "CALL_ENDED"]);
    const r2 = w.db.insert(ALICE, BOB);
    await alice.offer(offerArgs(r2));
    await alice.terminate(r2.id, { connected: false });
    expect(bobInbox.map((m) => m.type).slice(-1)).toEqual(["CALL_CANCELLED"]);
  });

  it("operations on an unknown call FAIL with NO_SESSION rather than pretending", async () => {
    const { alice } = await setup();
    const r = await alice.end("0000000a-0000-4000-8000-00000000000a");
    expect(r).toMatchObject({ status: "FAILED", reason: "NO_SESSION" });
  });
});

describe("inbound validation (stale / forged / duplicate events never reach the UI)", () => {
  it("drops an old call's CALL_ACCEPTED / CANCELLED / ENDED once a newer call exists", async () => {
    const { w, alice, bob, row, aliceInbox, bobInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.db.claim(row.id, BOB);
    await bob.accept(row.id);
    await alice.end(row.id); // call 1 over
    const call2 = w.db.insert(ALICE, BOB);
    await alice.offer(offerArgs(call2));
    aliceInbox.length = 0; bobInbox.length = 0;

    const toAlice = w.transport(ALICE);
    const toBob = w.transport(BOB);
    toAlice.inject(msg({ type: "CALL_ACCEPTED", callId: row.id, sessionId: row.session_id })); // old accept, call 1 already ended
    toAlice.inject(msg({ type: "CALL_ACCEPTED", callId: call2.id, sessionId: row.session_id })); // call 2's id, call 1's session
    toBob.inject(msg({ type: "CALL_CANCELLED", callId: row.id, sessionId: row.session_id, senderId: ALICE, recipientId: BOB }));
    toBob.inject(msg({ type: "CALL_ENDED", callId: row.id, sessionId: row.session_id, senderId: ALICE, recipientId: BOB }));
    expect(aliceInbox.length).toBe(0);
    expect(bobInbox.length).toBe(0);
    expect(alice.getSession(call2.id)?.state).toBe("RINGING"); // untouched
  });

  it("drops wrong-recipient, unknown-call, wrong-sender and illegal-direction events", async () => {
    const { w, alice, bob, row, aliceInbox, bobInbox } = await setup();
    await alice.offer(offerArgs(row));
    aliceInbox.length = 0; bobInbox.length = 0;
    const ta = w.transport(ALICE), tb = w.transport(BOB);
    ta.inject(msg({ callId: row.id, sessionId: row.session_id, recipientId: MALLORY }));
    ta.inject(msg({ callId: "0000000a-0000-4000-8000-00000000000a", sessionId: "s" }));
    ta.inject(msg({ callId: row.id, sessionId: row.session_id, senderId: MALLORY })); // not the peer
    ta.inject(msg({ type: "CALL_TIMEOUT", callId: row.id, sessionId: row.session_id, senderId: BOB })); // only the server may time out
    tb.inject(msg({ type: "CALL_ACCEPTED", callId: row.id, sessionId: row.session_id, senderId: ALICE, recipientId: BOB })); // callee can't receive an accept
    expect(aliceInbox.length + bobInbox.length).toBe(0);
    void bob;
  });

  it("accepts a genuine server CALL_TIMEOUT once, then treats the call as over", async () => {
    const { w, alice, row, aliceInbox } = await setup();
    await alice.offer(offerArgs(row));
    const timeout = msg({ type: "CALL_TIMEOUT", callId: row.id, sessionId: row.session_id, senderId: SERVER_SENDER_ID });
    w.transport(ALICE).inject(timeout);
    w.transport(ALICE).inject(timeout);
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_TIMEOUT"]);
    expect(alice.getSession(row.id)?.state).toBe("TIMED_OUT");
  });

  it("a duplicate CALL_OFFER (replay + push) surfaces exactly once; a different session for the same call is refused", async () => {
    const { w, alice, row, bobInbox } = await setup();
    await alice.offer(offerArgs(row));
    const again = { type: "CALL_OFFER" as const, callId: row.id, senderId: ALICE, recipientId: BOB, ts: 1, sessionId: row.session_id, payload: { callType: "voice" } };
    w.transport(BOB).inject(again);
    w.transport(BOB).inject({ ...again, sessionId: "another" });
    expect(bobInbox.length).toBe(1);
  });
});

describe("reconnect", () => {
  it("callee that was offline when the offer was sent gets it (once) when it reconnects", async () => {
    const w = new World();
    const alice = w.client(ALICE);
    const bob = w.client(BOB);
    await alice.ensureReady();
    const row = w.db.insert(ALICE, BOB);
    expect((await alice.offer(offerArgs(row))).status).toBe("RECIPIENT_OFFLINE");
    const inbox: SignalingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.ensureReady();
    await w.clock.flush();
    expect(inbox.map((m) => m.type)).toEqual(["CALL_OFFER"]);
    expect(inbox[0].payload?.replayed).toBe(true);
    expect(bob.getSession(row.id)?.role).toBe("receiver");
    // ...and it can accept over the socket.
    w.db.claim(row.id, BOB);
    expect((await bob.accept(row.id)).status).toBe("DELIVERED");
  });

  it("a callee that missed a CANCEL while disconnected is told after reconnect (via resync), once", async () => {
    const { w, alice, bob, row, bobInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.transport(BOB).dropConnection();
    w.db.cancel(row.id, ALICE);
    expect((await alice.cancel(row.id)).status).toBe("RECIPIENT_OFFLINE");
    bobInbox.length = 0;
    w.transport(BOB).reconnect();
    await w.clock.flush();
    expect(bobInbox.map((m) => m.type)).toEqual(["CALL_CANCELLED"]);
    expect((bobInbox[0].payload as { viaSync?: boolean }).viaSync).toBe(true);
    w.transport(BOB).dropConnection();
    w.transport(BOB).reconnect();
    await w.clock.flush();
    expect(bobInbox.length).toBe(1); // no repeat
    void bob;
  });

  it("caller that missed accept+end while disconnected sees accept then end (legal order), and no new call is created", async () => {
    const { w, alice, bob, row, aliceInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.transport(ALICE).dropConnection();
    w.db.claim(row.id, BOB);
    await bob.accept(row.id);
    await bob.end(row.id);
    aliceInbox.length = 0;
    w.transport(ALICE).reconnect();
    await w.clock.flush();
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_ACCEPTED", "CALL_ENDED"]);
    expect(w.gateway.registry.size()).toBe(1);
  });

  it("reconnecting mid-call is invisible: nothing surfaces and the call stays active", async () => {
    const { w, alice, bob, row, aliceInbox, bobInbox } = await setup();
    await alice.offer(offerArgs(row));
    w.db.claim(row.id, BOB);
    await bob.accept(row.id);
    aliceInbox.length = 0; bobInbox.length = 0;
    w.transport(ALICE).dropConnection();
    w.transport(ALICE).reconnect();
    await w.clock.flush();
    expect(aliceInbox.length + bobInbox.length).toBe(0);
    expect(alice.getSession(row.id)?.state).toBe("ACCEPTED");
    // an END from before-the-reconnect era can't resurrect anything: still one live call
    expect((await bob.end(row.id)).status).toBe("DELIVERED");
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_ENDED"]);
  });

  it("recovered receiver session (app restarted while ringing) can still accept over the socket", async () => {
    const { w, alice, row } = await setup();
    await alice.offer(offerArgs(row));
    const bob2 = new (await import("@/lib/signalingEngine/CallSignalingClient")).CallSignalingClient({
      userId: BOB, configured: true, createTransport: () => w.transport(BOB), clock: w.clock,
    });
    bob2.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    w.db.claim(row.id, BOB);
    expect((await bob2.accept(row.id)).status).toBe("DELIVERED");
  });
});
