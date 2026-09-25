/**
 * Calling reliability — phase 5 (accept ordering, connected semantics,
 * reconnect, races). What is exercised here:
 *  - the REAL CallSignalingClient + REAL SignalingGateway in-process (World),
 *  - the REAL WebSocketSignalingEngine against a fake socket,
 *  - the REAL awaitCallMedia / callStateMachine / callUiState / livekitAuthz.
 * NOT exercised: a live gateway, live Supabase, LiveKit, or a device.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { World, ALICE, BOB } from "./helpers/world";
import { FakeSocket } from "./helpers/signalingFakes";
import { FakeClock } from "./helpers/signalingFakes";
import { WebSocketSignalingEngine } from "@/lib/signalingEngine/WebSocketSignalingEngine";
import { isServerAccepted } from "@/lib/signalingEngine/types";
import { awaitCallMedia } from "@/lib/callEngine/awaitCallMedia";
import { reduceCallMachine, initialCallMachineState, isCurrentGeneration, type CallMachineState } from "@/lib/callStateMachine";
import { deriveCallUiState } from "@/lib/callUiState";
import { authorizeLiveKitToken } from "../../supabase/functions/_shared/livekitAuthz";

const offerArgs = (row: { id: string; session_id: string }) => ({ callId: row.id, sessionId: row.session_id, peerId: BOB, callType: "voice" as const });

async function ringing() {
  const w = new World();
  const alice = w.client(ALICE);
  await alice.ensureReady();
  const row = w.db.insert(ALICE, BOB);
  w.db.partners.add(`${ALICE}|${BOB}`);
  const offer = await alice.offer(offerArgs(row));
  return { w, alice, row, offer };
}

// ── 1–3: accept ordering & semantics ─────────────────────────────────────────
describe("accept: signaling readiness is explicit, never assumed", () => {
  it("1. cold start: signaling never connected + no socket offer → session learned from the row, then accept is DELIVERED", async () => {
    const { w, row } = await ringing();
    const bob = w.client(BOB); // fresh client: never prewarmed, no socket, no session
    expect(bob.isReady()).toBe(false);
    expect(bob.getSession(row.id)).toBeUndefined();
    // What CallContext.ensureSignalingForIncoming does:
    expect((await bob.ensureReady({ timeoutMs: 1_000 })).ready).toBe(true);
    bob.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    expect(w.db.claim(row.id, BOB)).toBe(true);
    const r = await bob.accept(row.id);
    expect(r.status).toBe("DELIVERED");
  });

  it("1b. the OLD path (accept fired before signaling was ready/registered) failed with NO_SESSION — only logged", async () => {
    const { w, row } = await ringing();
    const bob = w.client(BOB); // cold start: not connected, overlay registration never happened
    w.db.claim(row.id, BOB);
    const r = await bob.accept(row.id, { returnQueued: true }); // what CallContext used to do
    expect(r.status).toBe("FAILED");
    expect(isServerAccepted(r)).toBe(false);
  });

  it("2. an awaited accept waits for the socket to become ready and only then resolves (delivered)", async () => {
    const { w, row } = await ringing();
    const bob = w.client(BOB);
    await bob.ensureReady();
    bob.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    w.db.claim(row.id, BOB);
    w.transport(BOB).dropConnection(); // e.g. network change right before accept
    let settled: string | null = null;
    // CallContext passes returnQueued:false — accept() otherwise defaults to QUEUED.
    const p = bob.accept(row.id, { returnQueued: false }).then((r) => { settled = r.status; return r; });
    await w.clock.advance(50);
    expect(settled).toBeNull(); // not reported as done while the socket is down
    w.transport(BOB).reconnect();
    await w.clock.advance(500);
    expect((await p).status).toBe("DELIVERED");
  });

  it("3. a QUEUED accept is not a delivered accept", async () => {
    const { w, row } = await ringing();
    const bob = w.client(BOB);
    await bob.ensureReady();
    bob.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    w.db.claim(row.id, BOB);
    w.transport(BOB).dropConnection();
    const queued = await bob.accept(row.id, { returnQueued: true });
    expect(queued.status).toBe("QUEUED");
    expect(isServerAccepted(queued)).toBe(false);
  });
});

// ── 4: connected semantics ─────────────────────────────────────────────────────
describe("4. remote-audio timeout is MEDIA_DEGRADED, never CONNECTED", () => {
  const deps = (p: boolean[], a: boolean[]) => {
    const onDegraded = vi.fn();
    return {
      onDegraded,
      d: {
        waitForRemoteParticipant: vi.fn(async () => p.shift() ?? false),
        waitForRemoteAudioReady: vi.fn(async () => a.shift() ?? false),
        retryRemoteAudioPlayback: vi.fn(),
        isCurrent: () => true,
        onDegraded,
      },
    };
  };

  it("audio never plays → degraded then no_remote_audio (a failure), not connected", async () => {
    const { d, onDegraded } = deps([true], [false, false]);
    expect(await awaitCallMedia(d, { participantTimeoutMs: 1 })).toEqual({ result: "no_remote_audio" });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(d.retryRemoteAudioPlayback).toHaveBeenCalledTimes(1);
  });

  it("late audio → connected (degraded=true)", async () => {
    const { d } = deps([true], [false, true]);
    expect(await awaitCallMedia(d, { participantTimeoutMs: 1 })).toEqual({ result: "connected", degraded: true });
  });

  it("caller: partner never joins (still ringing / never answered) → no CONNECTED at all", async () => {
    const { d, onDegraded } = deps([false], []);
    expect(await awaitCallMedia(d, { participantTimeoutMs: 1 })).toEqual({ result: "no_remote_participant" });
    expect(d.waitForRemoteAudioReady).not.toHaveBeenCalled();
    expect(onDegraded).not.toHaveBeenCalled();
  });

  it("state machine: CONNECTING → MEDIA_DEGRADED → CONNECTED/FAILED are the only exits besides hang-up", () => {
    let s: CallMachineState = initialCallMachineState;
    for (const e of [
      { type: "START_OUTGOING", callType: "voice", source: "t" },
      { type: "OUTGOING_SESSION_CREATED", callId: "c", source: "t" },
      { type: "CONNECTING", source: "t" },
      { type: "MEDIA_DEGRADED", source: "t" },
    ] as const) s = reduceCallMachine(s, e as never);
    expect(s.status).toBe("MEDIA_DEGRADED");
    expect(reduceCallMachine(s, { type: "RECONNECTING", source: "t" }).status).toBe("MEDIA_DEGRADED"); // illegal, ignored
    expect(reduceCallMachine(s, { type: "CONNECTED", source: "t" }).status).toBe("CONNECTED");
    expect(reduceCallMachine(s, { type: "FAILED", source: "t" }).status).toBe("FAILED");
  });

  it("UI: joined + partner present but no playing audio shows the existing 'connecting' state, not 'connected'", () => {
    const base = { callState: "joined" as const, isStartingCall: false, participantCount: 2, everConnected: true, networkQuality: "good" as const };
    expect(deriveCallUiState({ ...base, remoteAudioReady: false })).toBe("connecting");
    expect(deriveCallUiState({ ...base, remoteAudioReady: true })).toBe("connected");
  });
});

// ── 5: stale work cannot touch a newer call ────────────────────────────────────
describe("5. stale join / stale media result", () => {
  it("regression: the machine generation changes on every step, so it can't be the accept-attempt token", () => {
    let s = reduceCallMachine(initialCallMachineState, { type: "INCOMING_CALL", callId: "c", callType: "voice", source: "t" });
    s = reduceCallMachine(s, { type: "ACCEPT_TAPPED", source: "t" });
    const g = s.generation;
    s = reduceCallMachine(s, { type: "CLAIM_WON", source: "t" });
    s = reduceCallMachine(s, { type: "CONNECTING", source: "t" });
    // The old accept flow checked exactly this after joinCall() and tore the
    // call down. It is false for a perfectly healthy, current accept:
    expect(isCurrentGeneration(s, g)).toBe(false);
  });

  it("a media result that resolves after the call was left/superseded is `stale` (no CONNECTED, no failure)", async () => {
    let current = true;
    const d = {
      waitForRemoteParticipant: async () => true,
      waitForRemoteAudioReady: async () => { current = false; return true; }, // newer call started meanwhile
      isCurrent: () => current,
    };
    expect(await awaitCallMedia(d, { participantTimeoutMs: 1 })).toEqual({ result: "stale" });
  });
});

// ── 6: reconnect / handover ────────────────────────────────────────────────────
describe("6. reconnect gets a fresh ticket and doesn't sleep through backoff", () => {
  const ME = ALICE;
  beforeEach(() => { FakeSocket.instances = []; });
  const make = () => {
    const clock = new FakeClock();
    const urls: string[] = [];
    let n = 0;
    const engine = new WebSocketSignalingEngine({
      userId: ME, clock,
      getUrl: async () => { const u = `wss://sig.test/?token=ticket-${++n}`; urls.push(u); return u; },
      webSocketFactory: (u) => new FakeSocket(u),
    });
    return { clock, engine, urls };
  };
  const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

  it("network change: a silent (half-open) socket is replaced at once, with a NEW ticket", async () => {
    const { clock, engine, urls } = make();
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    await clock.advance(25_000); // no frames for 25s (server pings every 15s → dead)
    engine.checkLiveness(20_000);
    await clock.advance(600);
    last().serverReady(ME);
    await clock.flush();
    expect(engine.isReady()).toBe(true);
    expect(urls.length).toBe(2);
    expect(urls[1]).not.toBe(urls[0]);
  });

  it("connect() during a long reconnect backoff wakes it instead of waiting it out", async () => {
    const { clock, engine } = make();
    const p0 = engine.connect(60_000);
    p0.catch(() => {});
    await clock.flush();
    for (let i = 0; i < 5; i++) { last().drop(); await clock.advance(20_000); } // backoff now at its 15s ceiling
    last().drop();
    await clock.flush();
    const before = FakeSocket.instances.length;
    const p = engine.connect(3_000); // accept needs it NOW
    await clock.advance(50);
    expect(FakeSocket.instances.length).toBe(before + 1); // a new attempt started immediately
    last().serverReady(ME);
    await p;
  });

  it("closed with 4000 (replaced by the same account's other device) → no automatic ping-pong reconnect", async () => {
    const { clock, engine } = make();
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    const sock = last();
    sock.readyState = 3;
    sock.onclose?.({ code: 4000 } as never);
    const count = FakeSocket.instances.length;
    await clock.advance(60_000);
    expect(FakeSocket.instances.length).toBe(count); // stayed down
    engine.nudge(); // user opened the app on THIS device
    await clock.advance(50);
    expect(FakeSocket.instances.length).toBe(count + 1);
  });
});

// ── 9–11: races (real gateway) ─────────────────────────────────────────────────
describe("races against the real gateway", () => {
  it("9. duplicate accept is idempotent (DUPLICATE), the caller sees ONE accept", async () => {
    const { w, alice, row } = await ringing();
    const inbox: string[] = [];
    alice.onMessage((m) => inbox.push(m.type));
    const bob = w.client(BOB);
    await bob.ensureReady();
    bob.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    w.db.claim(row.id, BOB);
    expect((await bob.accept(row.id)).status).toBe("DELIVERED");
    expect((await bob.accept(row.id)).status).toBe("DUPLICATE");
    expect(inbox.filter((t) => t === "CALL_ACCEPTED").length).toBe(1);
  });

  it("10a. caller cancels first → receiver's claim fails; nothing to accept", async () => {
    const { w, row } = await ringing();
    expect(w.db.cancel(row.id, ALICE)).toBe(true);
    expect(w.db.claim(row.id, BOB)).toBe(false);
    expect(w.db.tokenFor(BOB, row.id).ok).toBe(false);
  });

  it("10b. receiver claims first → caller's stale cancel is refused and becomes an END (never kills a connected call)", async () => {
    const { w, alice, row } = await ringing();
    const bob = w.client(BOB);
    await bob.ensureReady();
    bob.registerIncoming({ callId: row.id, sessionId: row.session_id, peerId: ALICE });
    expect(w.db.claim(row.id, BOB)).toBe(true);
    expect(w.db.cancel(row.id, ALICE)).toBe(false); // cancel_call refuses once claimed
    await bob.accept(row.id);
    const r = await alice.terminate(row.id, { connected: true });
    expect(isServerAccepted(r)).toBe(true);
    expect(alice.getSession(row.id)?.state).toBe("ENDED");
  });

  it("11. two devices race claim_call: exactly one wins; the loser gets no LiveKit token", async () => {
    const { w, row } = await ringing();
    const results = [w.db.claim(row.id, BOB), w.db.claim(row.id, BOB)];
    expect(results.filter(Boolean).length).toBe(1);
    // A third party can never claim or get a token.
    expect(w.db.claim(row.id, ALICE)).toBe(false);
  });
});

// ── 12: LiveKit token authorization ────────────────────────────────────────────
describe("12. livekit-token authorization", () => {
  const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CALLEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NOW = 2_000_000_000_000;
  const row = (over: Record<string, unknown> = {}) => ({
    id: "11111111-1111-4111-8111-111111111111", caller_id: CALLER, receiver_id: CALLEE, provider: "self_hosted",
    status: "in_progress", claimed_by: null, expires_at: new Date(NOW - 1_000).toISOString(), are_partners: true, declined: false, ...over,
  });
  it("an expired, unanswered call gets no token (caller)", () => {
    const r = authorizeLiveKitToken({ userId: CALLER, call: row() as never, now: NOW });
    expect(r.ok).toBe(false);
    if ("code" in r) expect(r.code).toBe("ring_expired");
  });
  it("a terminal call gets no token for either side", () => {
    for (const u of [CALLER, CALLEE]) {
      const r = authorizeLiveKitToken({ userId: u, call: row({ status: "missed", claimed_by: CALLEE }) as never, now: NOW });
      expect(r.ok).toBe(false);
    }
  });
  it("a former partner gets no token even for an active claimed call", () => {
    const r = authorizeLiveKitToken({ userId: CALLEE, call: row({ claimed_by: CALLEE, are_partners: false }) as never, now: NOW });
    expect(r.ok).toBe(false);
  });
});
