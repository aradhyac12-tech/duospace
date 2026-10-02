/** Device-verification instrumentation: required stage names, ids, failure codes. */
import { describe, it, expect, vi, beforeEach } from "vitest";
const logInfo = vi.fn();
vi.mock("@/lib/telemetry", () => ({ logInfo: (...a: unknown[]) => logInfo(...a), logWarn: () => {}, logError: () => {} }));
import { beginTrace, mark, finishTrace, setTraceIds } from "@/lib/callLatency";

const lastMetrics = () => logInfo.mock.calls.at(-1)![2] as { stagesMs: Record<string, number>; callId: string; sessionId: string; failureReason?: string; outcome: string };
beforeEach(() => logInfo.mockReset());

describe("call instrumentation", () => {
  it("records the required stage names (incl. aliases) with callId/sessionId", () => {
    beginTrace("outgoing", "voice");
    setTraceIds({ callId: "call-1", sessionId: "sess-1" });
    for (const s of ["signaling_connect_started", "signaling_connected", "offer_sent", "offer_delivered", "token_requested", "token_ready",
      "livekit_connect_started", "livekit_connected", "remote_participant_detected", "remote_track_received", "remote_audio_ready"] as const) mark(s);
    finishTrace("connected");
    const m = lastMetrics();
    for (const s of ["call_started", "signaling_connect_started", "signaling_connected", "offer_sent", "offer_delivered", "token_requested",
      "token_ready", "livekit_connect_started", "livekit_connected", "remote_participant_connected", "remote_audio_track_received", "remote_audio_ready", "call_connected"]) {
      expect(m.stagesMs, s).toHaveProperty(s);
    }
    expect(m).toMatchObject({ callId: "call-1", sessionId: "sess-1", outcome: "connected" });
  });

  it("a failure always carries a machine-readable code; free text is never stored", () => {
    beginTrace("incoming", "voice", "self_hosted", "call-2");
    finishTrace("failed", undefined, "NETWORK_TIMEOUT");
    expect(lastMetrics()).toMatchObject({ failureReason: "NETWORK_TIMEOUT", callId: "call-2" });
    expect(lastMetrics().stagesMs).toHaveProperty("call_failed");
    beginTrace("outgoing", "voice");
    finishTrace("failed", undefined, "They said: my partner is <private text>");
    expect(lastMetrics().failureReason).toBe("UNSPECIFIED");
    beginTrace("outgoing", "voice");
    finishTrace("failed");
    expect(lastMetrics().failureReason).toBe("UNSPECIFIED");
  });
});
