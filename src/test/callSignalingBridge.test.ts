import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const resolveSignalingUrlMock = vi.fn();
vi.mock("@/lib/signalingEngine/signalingConfig", () => ({
  // Runtime config lookup: the backend has no URL either → still unconfigured.
  loadRuntimeSignalingUrl: () => Promise.resolve(null),
  resolveSignalingUrl: () => resolveSignalingUrlMock(),
}));

const fetchSignalingTicketMock = vi.fn();
vi.mock("@/lib/signalingEngine/signalingTicket", () => ({
  fetchSignalingConfig: () => Promise.resolve({ signalingUrl: null }),
  fetchSignalingTicket: () => fetchSignalingTicketMock(),
}));

// Fake transport — the bridge builds a CallSignalingClient around it.
// vi.hoisted: vi.mock factories are hoisted above normal declarations, so
// the class must be created in the hoisted scope too (this file previously
// failed to load with "Cannot access 'FakeEngine' before initialization").
const { FakeEngine } = vi.hoisted(() => {
  class FakeEngine {
  static instances: FakeEngine[] = [];
  state: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  handlers = new Set<(e: unknown) => void>();
  constructor(public opts: { getUrl: () => Promise<string>; userId: string }) { FakeEngine.instances.push(this); }
  async connect() { this.state = "connected"; }
  disconnect() { this.state = "disconnected"; }
  isReady() { return this.state === "connected"; }
  getConnectionState() { return this.state; }
  sendFrame() { return this.isReady(); }
  subscribe(h: (e: unknown) => void) { this.handlers.add(h); return () => this.handlers.delete(h); }
  nudge() {}
}
  return { FakeEngine };
});
vi.mock("@/lib/signalingEngine/WebSocketSignalingEngine", () => ({ WebSocketSignalingEngine: FakeEngine }));
vi.mock("@/lib/telemetry", () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

import { useCallSignalingBridge } from "@/lib/signalingEngine/callSignalingBridge";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CALL = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resolveSignalingUrlMock.mockReset();
  fetchSignalingTicketMock.mockReset();
  FakeEngine.instances = [];
});

describe("useCallSignalingBridge — safe when signaling is not configured", () => {
  it("opens NO transport, fetches NO ticket, and reports NOT_CONFIGURED (never a silent success)", async () => {
    resolveSignalingUrlMock.mockReturnValue(null);
    const { result } = renderHook(() => useCallSignalingBridge(ME));
    expect(result.current.isConfigured()).toBe(false);
    expect(await result.current.ensureReady()).toEqual({ ready: false, reason: "NOT_CONFIGURED" });
    result.current.prewarm();
    const offer = await result.current.offer({ callId: CALL, sessionId: "s", peerId: PEER, callType: "voice" });
    expect(offer).toMatchObject({ status: "FAILED", reason: "NOT_CONFIGURED" });
    for (const r of [await result.current.accept(CALL), await result.current.reject(CALL), await result.current.cancel(CALL), await result.current.end(CALL), await result.current.terminate(CALL, { connected: true })]) {
      expect(r).toMatchObject({ status: "FAILED", reason: "NOT_CONFIGURED" });
    }
    expect(FakeEngine.instances.length).toBe(0);
    expect(fetchSignalingTicketMock).not.toHaveBeenCalled();
  });

  it("does no network work merely by mounting the hook", () => {
    resolveSignalingUrlMock.mockReturnValue("wss://sig.example");
    renderHook(() => useCallSignalingBridge(ME));
    expect(FakeEngine.instances.length).toBe(0);
    expect(fetchSignalingTicketMock).not.toHaveBeenCalled();
  });

  it("onMessage() returns an unsubscribe function", () => {
    resolveSignalingUrlMock.mockReturnValue(null);
    const { result } = renderHook(() => useCallSignalingBridge(ME));
    expect(typeof result.current.onMessage(() => {})).toBe("function");
  });
});

describe("useCallSignalingBridge — configured", () => {
  it("ensureReady() connects through a transport that mints a FRESH ticket per connection attempt", async () => {
    resolveSignalingUrlMock.mockReturnValue("wss://sig.example");
    fetchSignalingTicketMock.mockResolvedValueOnce("ticket-1").mockResolvedValueOnce("ticket-2");
    const { result } = renderHook(() => useCallSignalingBridge(ME));
    let ready;
    await act(async () => { ready = await result.current.ensureReady(); });
    expect(ready).toMatchObject({ ready: true });
    expect(FakeEngine.instances.length).toBe(1);
    const { getUrl } = FakeEngine.instances[0].opts;
    expect(await getUrl()).toBe("wss://sig.example?token=ticket-1");
    expect(await getUrl()).toBe("wss://sig.example?token=ticket-2");
  });

  it("is not ready without a user id", async () => {
    resolveSignalingUrlMock.mockReturnValue("wss://sig.example");
    const { result } = renderHook(() => useCallSignalingBridge(null));
    expect(await result.current.ensureReady()).toEqual({ ready: false, reason: "NO_USER" });
    expect(FakeEngine.instances.length).toBe(0);
  });

  it("listeners registered before the client exists survive a disconnect + re-creation", async () => {
    resolveSignalingUrlMock.mockReturnValue("wss://sig.example");
    fetchSignalingTicketMock.mockResolvedValue("t");
    const { result } = renderHook(() => useCallSignalingBridge(ME));
    const seen: string[] = [];
    result.current.onMessage((m) => seen.push(m.type));
    await act(async () => { await result.current.ensureReady(); });
    act(() => result.current.disconnect());
    await act(async () => { await result.current.ensureReady(); });
    expect(FakeEngine.instances.length).toBe(2);
    // an inbound offer on the NEW client's transport reaches the original listener
    FakeEngine.instances[1].handlers.forEach((h) => h({
      kind: "signal",
      message: { type: "CALL_OFFER", callId: CALL, senderId: PEER, recipientId: ME, ts: 1, sessionId: "s", payload: { callType: "voice" } },
    }));
    expect(seen).toEqual(["CALL_OFFER"]);
  });
});
