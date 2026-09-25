/**
 * SelfHostedCallEngineAdapter — bounded join stages, cancellation,
 * duplicate joins, room identity, and unexpected disconnects.
 * LiveKit and the livekit-token edge function are faked; this verifies the
 * adapter's state machine, NOT a real LiveKit/TURN connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { FakeRoom, invokeMock, ctl } = vi.hoisted(() => {
  const ctl = { connect: "ok" as "ok" | "hang" | "reject", mic: "ok" as "ok" | "hang" };
  class FakeRoom {
    static instances: FakeRoom[] = [];
    handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    disconnected = false;
    numParticipants = 1;
    remoteParticipants = new Map();
    localParticipant = {
      setMicrophoneEnabled: () => ctl.mic === "hang" ? new Promise(() => {}) : Promise.resolve(),
      setCameraEnabled: () => Promise.resolve(),
      videoTrackPublications: new Map(),
    };
    constructor() { FakeRoom.instances.push(this); }
    on(ev: string, h: (...a: unknown[]) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(h); return this; }
    emit(ev: string, ...a: unknown[]) { (this.handlers.get(ev) ?? []).forEach((h) => h(...a)); }
    connect() {
      if (ctl.connect === "hang") return new Promise(() => {});
      if (ctl.connect === "reject") return Promise.reject(new Error("could not establish signal connection"));
      return Promise.resolve();
    }
    disconnect() { this.disconnected = true; }
  }
  return { FakeRoom, invokeMock: vi.fn(), ctl };
});

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: "TrackSubscribed", ParticipantConnected: "ParticipantConnected",
    ParticipantDisconnected: "ParticipantDisconnected", ConnectionStateChanged: "ConnectionStateChanged",
    Disconnected: "Disconnected",
  },
}));
vi.mock("@/lib/edgeFunction", () => ({ invokeEdgeFunction: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@/lib/telemetry", () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

import {
  useSelfHostedCallEngineAdapter, CONNECT_TIMEOUT_MS, MIC_PUBLISH_TIMEOUT_MS,
} from "@/lib/callEngine/SelfHostedCallEngineAdapter";

const CALL = "11111111-1111-4111-8111-111111111111";
const tokenFor = (callId: string, roomName = `duo-call-${callId}`) =>
  ({ token: "h.eyJleHAiOjk5OTk5OTk5OTl9.s", url: "wss://lk.example", roomName });

beforeEach(() => {
  FakeRoom.instances = [];
  invokeMock.mockReset();
  ctl.connect = "ok"; ctl.mic = "ok";
});
afterEach(() => { vi.useRealTimers(); });

describe("SelfHostedCallEngineAdapter — join", () => {
  it("happy path: token → connect → mic → joined, token requested for THIS call only", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    expect(invokeMock).toHaveBeenCalledWith("livekit-token", expect.objectContaining({ body: { callId: CALL } }));
    expect(result.current.callState).toBe("joined");
  });

  it("ignores any client-supplied token (always fetches its own)", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, "attacker-token", true); });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a token for a DIFFERENT room (LiveKit room mismatch)", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL, "duo-call-someone-else"));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await expect(result.current.joinCall(CALL, undefined, true)).rejects.toThrow(/room mismatch/); });
    expect(result.current.callState).toBe("error");
    expect(FakeRoom.instances.length).toBe(0); // never connected anywhere
  });

  it("LiveKit unreachable: connect is BOUNDED and ends in a classified error, not endless Connecting", async () => {
    vi.useFakeTimers();
    ctl.connect = "hang";
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    let err: unknown;
    await act(async () => {
      const p = result.current.joinCall(CALL, undefined, true).catch((e) => { err = e; });
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 10);
      await p;
    });
    expect(String(err)).toMatch(/livekit connect timeout/);
    expect(result.current.callState).toBe("error");
    expect(result.current.callError?.code).toBe("NETWORK_TIMEOUT");
    expect(FakeRoom.instances[0].disconnected).toBe(true); // media/socket released
  });

  it("LiveKit refuses the connection (e.g. TURN/ICE unavailable): classified failure + room released", async () => {
    ctl.connect = "reject";
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await expect(result.current.joinCall(CALL, undefined, true)).rejects.toThrow(); });
    expect(result.current.callState).toBe("error");
    expect(FakeRoom.instances[0].disconnected).toBe(true);
  });

  it("microphone publish that never resolves is bounded too", async () => {
    vi.useFakeTimers();
    ctl.mic = "hang";
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    let err: unknown;
    await act(async () => {
      const p = result.current.joinCall(CALL, undefined, true).catch((e) => { err = e; });
      await vi.advanceTimersByTimeAsync(MIC_PUBLISH_TIMEOUT_MS + 10);
      await p;
    });
    expect(String(err)).toMatch(/microphone publish timeout/);
    expect(result.current.callState).toBe("error");
  });

  it("server refuses the token (expired/cancelled/non-partner call): no room is ever created", async () => {
    invokeMock.mockRejectedValue(new Error("This call is no longer active"));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await expect(result.current.joinCall(CALL, undefined, true)).rejects.toThrow(); });
    expect(FakeRoom.instances.length).toBe(0);
    expect(result.current.callError?.code).toBe("ROOM_NOT_FOUND");
  });

  it("cancel while joining (leaveCall during token fetch) → JoinCancelledError, no error UI, no room", async () => {
    let release!: (v: unknown) => void;
    invokeMock.mockReturnValue(new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    let err: unknown;
    await act(async () => {
      const p = result.current.joinCall(CALL, undefined, true).catch((e) => { err = e; });
      result.current.leaveCall();
      release(tokenFor(CALL));
      await p;
    });
    expect((err as Error).name).toBe("JoinCancelledError");
    expect(result.current.callState).toBe("idle");
    expect(FakeRoom.instances.length).toBe(0);
  });

  it("a duplicate joinCall for the same call is ignored (one room only)", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    expect(FakeRoom.instances.length).toBe(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("unexpected disconnect of a live call → error state + cleanup; a user hang-up stays silent", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    act(() => { FakeRoom.instances[0].emit("Disconnected", "SIGNAL_CLOSE"); });
    expect(result.current.callState).toBe("error");
    expect(FakeRoom.instances[0].disconnected).toBe(true);

    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    act(() => { result.current.leaveCall(); });
    act(() => { FakeRoom.instances[1].emit("Disconnected", "CLIENT_INITIATED"); });
    expect(result.current.callState).toBe("idle");
  });
});

describe("SelfHostedCallEngineAdapter — media stages (phase 5)", () => {
  const CALL2 = "22222222-2222-4222-8222-222222222222";
  const audioTrack = () => {
    const handlers: Record<string, () => void> = {};
    const el = { paused: true, readyState: 0, addEventListener: (ev: string, h: () => void) => { handlers[ev] = h; }, play: () => Promise.resolve() };
    return { track: { kind: "audio", attach: () => el }, play: () => handlers.playing?.() };
  };

  it("joined ≠ connected: remoteAudioReady and the duration timer wait for audio actually PLAYING", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    expect(result.current.callState).toBe("joined");
    expect(result.current.mediaStage).toBe("microphone_published");
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(result.current.callDuration).toBe(0); // ringing time is NOT call time
    const room = FakeRoom.instances[0];
    const t = audioTrack();
    await act(async () => { room.emit("ParticipantConnected"); room.emit("TrackSubscribed", t.track); });
    expect(result.current.remoteAudioReady).toBe(false);
    expect(result.current.mediaStage).toBe("remote_audio_attached");
    await act(async () => { t.play(); });
    expect(result.current.remoteAudioReady).toBe(true);
    expect(result.current.mediaStage).toBe("call_connected");
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(result.current.callDuration).toBe(3);
  });

  it("late events from an OLD room cannot mark a NEWER call's participant/audio ready", async () => {
    invokeMock.mockImplementation((_n: string, o: { body: { callId: string } }) => Promise.resolve(tokenFor(o.body.callId)));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    const oldRoom = FakeRoom.instances[0];
    await act(async () => { result.current.leaveCall(); });
    await act(async () => { await result.current.joinCall(CALL2, undefined, true); });
    const waitP = result.current.waitForRemoteParticipant(50);
    const t = audioTrack();
    await act(async () => { oldRoom.emit("ParticipantConnected"); oldRoom.emit("TrackSubscribed", t.track); t.play(); });
    expect(await waitP).toBe(false);
    expect(result.current.remoteAudioReady).toBe(false);
    expect(result.current.isActiveCall(CALL2)).toBe(true);
    expect(result.current.isActiveCall(CALL)).toBe(false);
  });

  it("leaveCall resolves pending media waits with false IMMEDIATELY (not after their timeout)", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    let settled: boolean | null = null;
    void result.current.waitForRemoteAudioReady(60_000).then((v) => { settled = v; });
    await act(async () => { result.current.leaveCall(); });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(result.current.isActiveCall(CALL)).toBe(false);
  });

  it("a prefetched token for the SAME call is reused (one livekit-token request)", async () => {
    invokeMock.mockResolvedValue(tokenFor(CALL));
    const { result } = renderHook(() => useSelfHostedCallEngineAdapter());
    act(() => { result.current.prefetchToken(CALL); });
    await act(async () => { await result.current.joinCall(CALL, undefined, true); });
    expect(invokeMock.mock.calls.filter((c) => c[0] === "livekit-token").length).toBe(1);
  });
});
