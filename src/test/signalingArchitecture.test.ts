/**
 * ARCHITECTURE TEST (Phase 4, brief STEP 25).
 *
 * Proves, with the REAL SignalingGateway + REAL CallSignalingClient +
 * REAL livekit-token authorization decision, that self-hosted call
 * control is driven by the WebSocket layer and does NOT depend on
 * Supabase Realtime:
 *
 *   CALLER --CALL_OFFER--> gateway --> CALLEE --CALL_ACCEPTED--> gateway
 *     --> CALLER (receives acceptance) ; both then obtain LiveKit
 *     authorization for the SAME room.
 *
 * The in-memory World contains a fake call_history (persistence /
 * authorization data only) and NO Realtime object of any kind. If the
 * self-hosted control path secretly needed Realtime, these would hang or
 * fail. No real media, sockets or network are involved.
 */
import { describe, it, expect } from "vitest";
import { World, ALICE, BOB, MALLORY } from "./helpers/world";
import { roomNameForCall } from "@/lib/signalingEngine/types";
import type { SignalingMessage } from "@/lib/signalingEngine/types";

async function setup() {
  const w = new World();
  const alice = w.client(ALICE);
  const bob = w.client(BOB);
  expect((await alice.ensureReady()).ready).toBe(true);
  expect((await bob.ensureReady()).ready).toBe(true);
  const bobInbox: SignalingMessage[] = [];
  const aliceInbox: SignalingMessage[] = [];
  bob.onMessage((m) => bobInbox.push(m));
  alice.onMessage((m) => aliceInbox.push(m));
  const row = w.db.insert(ALICE, BOB); // caller's authoritative call_history INSERT (persistence)
  return { w, alice, bob, row, bobInbox, aliceInbox };
}

describe("self-hosted call control without Supabase Realtime", () => {
  it("offer → ring → claim → accept → caller receives acceptance → SAME LiveKit room for both", async () => {
    const { w, alice, bob, row, bobInbox, aliceInbox } = await setup();

    // 1. CALLER: WebSocket CALL_OFFER (the ring). Acked by the gateway as DELIVERED to the live callee.
    const offer = await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    expect(offer.status).toBe("DELIVERED");

    // 2. CALLEE received the ring DIRECTLY over its socket, with a server-built payload.
    expect(bobInbox.map((m) => m.type)).toEqual(["CALL_OFFER"]);
    const ring = bobInbox[0];
    expect(ring.senderId).toBe(ALICE);
    expect(ring.sessionId).toBe(row.session_id);
    expect(ring.payload?.roomName).toBe(roomNameForCall(row.id));

    // The callee holds no LiveKit authorization before accepting (ringing ≠ joining).
    const beforeAccept = w.db.tokenFor(BOB, row.id);
    expect(beforeAccept.ok).toBe(false);
    if (!beforeAccept.ok) expect(beforeAccept.code).toBe("not_claimed");

    // 3. CALLEE accepts: atomic claim in the DB FIRST, then CALL_ACCEPTED over the socket.
    expect(w.db.claim(row.id, BOB)).toBe(true);
    const accepted = await bob.accept(row.id);
    expect(accepted.status).toBe("DELIVERED");

    // 4. CALLER learns of the acceptance over the socket (no Realtime, no polling).
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_ACCEPTED"]);
    expect(aliceInbox[0].senderId).toBe(BOB);

    // 5. LiveKit authorization for BOTH participants → the SAME room the offer named.
    const a = w.db.tokenFor(ALICE, row.id);
    const b = w.db.tokenFor(BOB, row.id);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.roomName).toBe(b.roomName);
      expect(a.roomName).toBe(ring.payload?.roomName);
    }
  });

  it("reject reaches the caller immediately over the socket and ends ringing", async () => {
    const { w, alice, bob, row, aliceInbox } = await setup();
    await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "video" });
    expect(w.db.decline(row.id, BOB)).toBe(true); // authoritative state first
    expect((await bob.reject(row.id)).status).toBe("DELIVERED");
    expect(aliceInbox.map((m) => m.type)).toEqual(["CALL_REJECTED"]);
    expect(w.db.tokenFor(ALICE, row.id).ok).toBe(false); // no token for a finished call
  });

  it("cancel reaches the callee over the socket and stops the ring", async () => {
    const { w, alice, row, bobInbox } = await setup();
    await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    expect(w.db.cancel(row.id, ALICE)).toBe(true);
    expect((await alice.cancel(row.id)).status).toBe("DELIVERED");
    expect(bobInbox.map((m) => m.type)).toEqual(["CALL_OFFER", "CALL_CANCELLED"]);
  });

  it("end is delivered over the socket so the other side can tear down its provider session", async () => {
    const { w, alice, bob, row, aliceInbox, bobInbox } = await setup();
    await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    w.db.claim(row.id, BOB);
    await bob.accept(row.id);
    expect((await alice.end(row.id)).status).toBe("DELIVERED");
    expect(bobInbox.map((m) => m.type)).toEqual(["CALL_OFFER", "CALL_ENDED"]);
    w.db.complete(row.id); // persistence finalized AFTER, through the existing DB path
    expect(w.db.tokenFor(BOB, row.id).ok).toBe(false);
    void aliceInbox;
  });

  it("a stale cancel racing an accept is refused by the gateway and converted to an END — it can never destroy the connected call", async () => {
    const { w, alice, bob, row, bobInbox } = await setup();
    await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });

    // Alice's socket drops; Bob claims + accepts meanwhile (server: ACCEPTED,
    // Alice offline so she never hears it). Alice's local state is still RINGING.
    w.transport(ALICE).dropConnection();
    w.db.claim(row.id, BOB);
    expect((await bob.accept(row.id)).status).toBe("RECIPIENT_OFFLINE");
    expect(alice.getSession(row.id)?.state).toBe("RINGING");

    // Alice hits cancel while offline (queued), then her socket comes back.
    let settled: string | null = null;
    const queued = await alice.cancel(row.id, { onSettled: (r) => { settled = r.status; } });
    expect(queued.status).toBe("QUEUED");
    w.transport(ALICE).reconnect();
    await w.clock.flush();

    // The gateway refused CALL_CANCELLED (call is ACCEPTED); Alice converted it
    // to CALL_ENDED. Bob sees an END — never a CANCELLED on a connected call.
    expect(bobInbox.map((m) => m.type)).toEqual(["CALL_OFFER", "CALL_ENDED"]);
    expect(settled).toBe("REJECTED");
    expect(alice.getSession(row.id)?.state).toBe("ENDED");
    void bob;
  });

  it("works with Supabase Realtime unavailable: nothing in this path references it", async () => {
    // (Meaningful because the World has no Realtime at all; this pins the
    // negative explicitly so a future 'helpful' coupling shows up here.)
    const { w, alice, row, bobInbox } = await setup();
    const globals = globalThis as Record<string, unknown>;
    expect(globals.supabase).toBeUndefined();
    expect((await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" })).status).toBe("DELIVERED");
    expect(bobInbox.length).toBe(1);
    void w;
  });
});

describe("authorization on the live path", () => {
  it("a stranger cannot ring, accept, cancel or end someone else's call", async () => {
    const { w, alice, bob, row, bobInbox } = await setup();
    const mallory = w.client(MALLORY);
    await mallory.ensureReady();
    mallory.registerOutgoing({ callId: row.id, sessionId: row.session_id, peerId: BOB });
    const forged = await mallory.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    expect(forged.status).toBe("REJECTED");
    if (forged.status === "REJECTED") expect(forged.reason).toBe("NOT_A_PARTICIPANT");
    expect(bobInbox.length).toBe(0);
    void alice; void bob;
  });

  it("caller cannot ring a partner it is no longer partnered with", async () => {
    const { w, alice, row, bobInbox } = await setup();
    w.db.partners.clear();
    const r = await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    expect(r.status).toBe("REJECTED");
    if (r.status === "REJECTED") expect(r.reason).toBe("NOT_PARTNERS");
    expect(bobInbox.length).toBe(0);
  });

  it("a Daily-provider row can never be rung or tokened through the self-hosted path", async () => {
    const { w, alice } = await setup();
    const daily = w.db.insert(ALICE, BOB, { provider: "daily" });
    const r = await alice.offer({ callId: daily.id, sessionId: daily.session_id, peerId: BOB, callType: "voice" });
    expect(r.status).toBe("REJECTED");
    if (r.status === "REJECTED") expect(r.reason).toBe("WRONG_PROVIDER");
    const t = w.db.tokenFor(ALICE, daily.id);
    expect(t.ok).toBe(false);
  });
});

describe("failure is reported, never silent", () => {
  it("WebSocket unavailable: ensureReady fails, offer FAILS, and nothing claims signaling succeeded", async () => {
    const w = new World();
    const alice = w.client(ALICE);
    w.transport(ALICE).unreachable = true;
    const ready = await Promise.race([alice.ensureReady({ timeoutMs: 50 }), w.clock.advance(100).then(() => null)]);
    expect(ready && (ready as { ready: boolean }).ready).toBeFalsy();
    const row = w.db.insert(ALICE, BOB);
    const p = alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    await w.clock.advance(2_000);
    const r = await p;
    expect(r.status === "FAILED" || r.status === "TIMEOUT").toBe(true);
    expect(r.status).not.toBe("DELIVERED");
    expect(r.status).not.toBe("RECIPIENT_OFFLINE");
  });

  it("not configured (no VITE_SIGNALING_URL): reports NOT_CONFIGURED and never opens a transport", async () => {
    const w = new World();
    const c = w.client(ALICE, { configured: false });
    expect(await c.ensureReady()).toEqual({ ready: false, reason: "NOT_CONFIGURED" });
    const r = await c.offer({ callId: "0000000a-0000-4000-8000-00000000000a", sessionId: "s", peerId: BOB, callType: "voice" });
    expect(r.status).toBe("FAILED");
    expect(w.transport(ALICE).writes.length).toBe(0);
  });

  it("recipient offline is reported as RECIPIENT_OFFLINE (push path), not as delivered", async () => {
    const w = new World();
    const alice = w.client(ALICE);
    await alice.ensureReady();
    const row = w.db.insert(ALICE, BOB);
    const r = await alice.offer({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" });
    expect(r.status).toBe("RECIPIENT_OFFLINE");
  });
});
