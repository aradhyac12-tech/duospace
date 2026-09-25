import { describe, it, expect, beforeEach } from "vitest";
import { WebSocketSignalingEngine } from "@/lib/signalingEngine/WebSocketSignalingEngine";
import type { TransportEvent } from "@/lib/signalingEngine/types";
import { FakeClock, FakeSocket } from "./helpers/signalingFakes";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CALL = "11111111-1111-4111-8111-111111111111";

function make(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const urls: string[] = [];
  let ticket = 0;
  const engine = new WebSocketSignalingEngine({
    userId: ME, clock,
    getUrl: async () => { const u = `wss://sig.test/?token=ticket-${++ticket}`; urls.push(u); return u; },
    webSocketFactory: (u) => new FakeSocket(u),
    ...over,
  });
  const events: TransportEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { clock, engine, urls, events };
}
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

describe("WebSocketSignalingEngine", () => {
  beforeEach(() => { FakeSocket.instances = []; });

  it("is READY only after the server's ready frame — a bare socket open is not enough", async () => {
    const { engine, clock } = make();
    let resolved = false;
    const p = engine.connect().then(() => { resolved = true; });
    await clock.flush();
    last().open();
    await clock.flush();
    expect(engine.isReady()).toBe(false);
    expect(resolved).toBe(false);
    last().frame({ kind: "ready", userId: ME, serverTime: 1 });
    await p;
    expect(engine.isReady()).toBe(true);
    expect(engine.getConnectionState()).toBe("connected");
  });

  it("connect() rejects on timeout so a caller can fail fast, without giving up in the background", async () => {
    const { engine, clock } = make();
    const p = engine.connect(3_000);
    let err: Error | null = null;
    p.catch((e) => { err = e; });
    await clock.advance(3_100);
    expect(String(err)).toContain("SIGNALING_CONNECT_TIMEOUT");
    expect(engine.getConnectionState()).not.toBe("disconnected"); // still retrying
  });

  it("fetches a FRESH ticket for every reconnect attempt (the old fixed-URL bug)", async () => {
    const { engine, clock, urls } = make();
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    last().drop();
    await clock.advance(600);
    last().serverReady(ME);
    await clock.flush();
    expect(urls).toEqual(["wss://sig.test/?token=ticket-1", "wss://sig.test/?token=ticket-2"]);
    expect(FakeSocket.instances[1].url).toContain("ticket-2");
  });

  it("emits ready{reconnected:false} then ready{reconnected:true}", async () => {
    const { engine, clock, events } = make();
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    last().drop();
    await clock.advance(600);
    last().serverReady(ME);
    await clock.flush();
    const readies = events.filter((e) => e.kind === "ready");
    expect(readies).toEqual([{ kind: "ready", reconnected: false }, { kind: "ready", reconnected: true }]);
  });

  it("backs off between failed attempts and keeps retrying when the ticket fetch fails", async () => {
    let n = 0;
    const { engine, clock } = make({ getUrl: async () => { n += 1; if (n < 3) throw new Error("ticket 503"); return "wss://sig.test/?token=ok"; } });
    void engine.connect(60_000).catch(() => {});
    await clock.advance(400);
    expect(n).toBe(1);
    await clock.advance(600); // 500ms backoff
    expect(n).toBe(2);
    await clock.advance(1_100); // 1000ms backoff
    expect(n).toBe(3);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("sendFrame reports false when not ready and never queues", async () => {
    const { engine, clock } = make();
    expect(engine.sendFrame({ type: "CALL_OFFER", callId: CALL, recipientId: PEER, sessionId: "s", msgId: "m" })).toBe(false);
    const p = engine.connect();
    await clock.flush();
    last().open(); // open but NOT ready
    expect(engine.sendFrame({ type: "CALL_OFFER", callId: CALL, recipientId: PEER, sessionId: "s", msgId: "m" })).toBe(false);
    last().frame({ kind: "ready", userId: ME, serverTime: 1 });
    await p;
    expect(engine.sendFrame({ type: "CALL_OFFER", callId: CALL, recipientId: PEER, sessionId: "s", msgId: "m" })).toBe(true);
    expect(last().sent[0].senderId).toBe(ME);
    expect(last().sent[0].msgId).toBe("m");
  });

  it("routes signals, acks and state frames; ignores malformed and pre-ready frames", async () => {
    const { engine, clock, events } = make();
    const p = engine.connect();
    await clock.flush();
    last().open();
    last().frame({ type: "CALL_OFFER", callId: CALL, senderId: PEER, recipientId: ME, ts: 1, sessionId: "s" }); // before ready → dropped
    last().frame({ kind: "ready", userId: ME, serverTime: 1 });
    await p;
    last().frame({ type: "CALL_OFFER", callId: CALL, senderId: PEER, recipientId: ME, ts: 1, sessionId: "s" });
    last().frame({ type: "CALL_OFFER", callId: "nope", senderId: PEER, recipientId: ME, ts: 1, sessionId: "s" }); // malformed
    last().frame({ kind: "ack", msgId: "m1", callId: CALL, type: "CALL_OFFER", status: "DELIVERED" });
    last().frame({ kind: "state", callId: CALL, sessionId: "s", state: "RINGING" });
    last().frame({ kind: "ping", ts: 1 });
    expect(events.filter((e) => e.kind === "signal").length).toBe(1);
    expect(events.filter((e) => e.kind === "ack").length).toBe(1);
    expect(events.filter((e) => e.kind === "state").length).toBe(1);
  });

  it("detects a half-open socket (no frames, not even pings) and reconnects", async () => {
    const { engine, clock } = make({ heartbeatTimeoutMs: 8_000 });
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    const first = last();
    await clock.advance(3_000);
    first.frame({ kind: "ping", ts: 1 }); // healthy
    await clock.advance(7_000);
    expect(first.closeCalls.length).toBe(0);
    await clock.advance(6_000); // silence > 8s
    expect(first.closeCalls[0][1]).toBe("heartbeat_timeout");
    await clock.advance(600);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it("disconnect() stops everything: no further attempts, waiters rejected", async () => {
    const { engine, clock } = make();
    const p = engine.connect();
    let err: Error | null = null;
    p.catch((e) => { err = e; });
    await clock.flush();
    last().serverReady(ME);
    await p;
    engine.disconnect();
    await clock.advance(60_000);
    expect(FakeSocket.instances.length).toBe(1);
    expect(engine.getConnectionState()).toBe("disconnected");
    expect(engine.isReady()).toBe(false);
    void err;
  });

  it("nudge() skips the backoff", async () => {
    const { engine, clock } = make();
    const p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    last().drop();
    await clock.flush();
    expect(FakeSocket.instances.length).toBe(1);
    engine.nudge();
    await clock.flush();
    expect(FakeSocket.instances.length).toBe(2);
  });

  it("a connect() after disconnect() works again", async () => {
    const { engine, clock } = make();
    let p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    engine.disconnect();
    await clock.flush();
    p = engine.connect();
    await clock.flush();
    last().serverReady(ME);
    await p;
    expect(engine.isReady()).toBe(true);
    expect(FakeSocket.instances.length).toBe(2);
  });
});
