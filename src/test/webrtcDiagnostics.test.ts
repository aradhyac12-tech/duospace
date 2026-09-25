import { describe, it, expect } from "vitest";
import { collectLiveKitDiagnostics } from "@/lib/callEngine/webrtcDiagnostics";

// Minimal fake matching the subset of RTCStatsReport (a Map-like) and
// LiveKit Room/Track surface collectLiveKitDiagnostics actually reads.
function fakeStatsReport(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map<string, unknown>();
  entries.forEach((e) => map.set(e.id as string, e));
  return map as unknown as RTCStatsReport;
}

function fakeRoom(entries: Record<string, unknown>[], opts: { noTrack?: boolean } = {}) {
  const track = opts.noTrack ? undefined : {
    getRTCStatsReport: async () => fakeStatsReport(entries),
  };
  return {
    state: "connected",
    localParticipant: {
      audioTrackPublications: new Map([["pub1", { track }]]),
    },
  } as unknown as import("livekit-client").Room;
}

describe("collectLiveKitDiagnostics", () => {
  it("returns null for a null room", async () => {
    expect(await collectLiveKitDiagnostics(null)).toBeNull();
  });

  it("returns a connectionState-only snapshot when there's no publishable audio track", async () => {
    const snapshot = await collectLiveKitDiagnostics(fakeRoom([], { noTrack: true }));
    expect(snapshot).toMatchObject({ connectionState: "connected", selectedCandidateType: null, usingTurnRelay: false });
  });

  it("extracts candidate type, RTT, jitter, and packet loss from a relay-selected pair", async () => {
    const snapshot = await collectLiveKitDiagnostics(fakeRoom([
      { id: "pair1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local1", currentRoundTripTime: 0.084, availableOutgoingBitrate: 128000 },
      { id: "local1", type: "local-candidate", candidateType: "relay" },
      { id: "in1", type: "inbound-rtp", kind: "audio", jitter: 0.012, packetsLost: 5, packetsReceived: 995 },
    ]));
    expect(snapshot).toMatchObject({
      selectedCandidateType: "relay",
      usingTurnRelay: true,
      roundTripTimeMs: 84,
      jitterMs: 12,
      packetsLost: 5,
      packetLossPct: 0.5,
      availableOutgoingBitrateKbps: 128,
    });
  });

  it("reports usingTurnRelay false for a host candidate pair", async () => {
    const snapshot = await collectLiveKitDiagnostics(fakeRoom([
      { id: "pair1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local1" },
      { id: "local1", type: "local-candidate", candidateType: "host" },
    ]));
    expect(snapshot?.selectedCandidateType).toBe("host");
    expect(snapshot?.usingTurnRelay).toBe(false);
  });

  it("degrades gracefully with all-null fields when no candidate pair is selected yet", async () => {
    const snapshot = await collectLiveKitDiagnostics(fakeRoom([]));
    expect(snapshot).toMatchObject({ selectedCandidateType: "unknown", usingTurnRelay: false, roundTripTimeMs: null });
  });
});
