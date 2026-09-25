/**
 * webrtcDiagnostics — best-effort ICE/DTLS/media stats collection for the
 * self-hosted call path (migration Phase 2 STEP 12).
 *
 * Purpose: distinguish signaling latency from token latency from ICE
 * latency from TURN latency from media-startup latency — callLatency.ts's
 * stage marks already time each of those phases, but they don't say
 * WHICH candidate type won (host/srflx/relay) or what the resulting
 * RTT/packet-loss/jitter actually was. This fills that gap using the
 * standard `RTCStatsReport` (via LiveKit client v2's
 * `Track.getRTCStatsReport()`, a real public API — not a private/internal
 * one), not a custom re-implementation of WebRTC stats parsing beyond
 * picking the fields this file cares about out of the standard report.
 *
 * NOT RUNTIME-VERIFIED — same standing limitation as the rest of the
 * self-hosted path: no live connection has ever produced a real
 * RTCStatsReport in this sandbox to validate field names/shapes against.
 * `RTCStatsReport` entry shapes are standardized (W3C webrtc-stats) and
 * stable across browsers for the fields read here, but browser-specific
 * quirks in what's actually populated are common in practice and can only
 * be caught by testing against a real connection.
 *
 * Dev/logging only (STEP 10: "Do not expose sensitive infrastructure
 * information to ordinary users"). Nothing here is wired into the
 * CallEngine interface or any UI-facing state — SelfHostedCallEngineAdapter
 * calls collectLiveKitDiagnostics() and logs the result via logInfo only
 * when import.meta.env.DEV, exactly like a console.debug would, not as a
 * feature a production user ever sees.
 */
import type { Room as LiveKitRoom } from "livekit-client";

export type IceCandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export interface CallDiagnosticsSnapshot {
  connectionState: string;
  iceConnectionState: string | null;
  selectedCandidateType: IceCandidateType | null;
  /** true if the selected local candidate was a TURN relay — i.e. TURN
   *  was actually load-bearing for this call, not just configured. This
   *  is the one field that answers "is TURN actually connected to the
   *  media architecture" (STEP 7) with evidence rather than
   *  configuration inspection alone. */
  usingTurnRelay: boolean;
  roundTripTimeMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  packetLossPct: number | null;
  availableOutgoingBitrateKbps: number | null;
}

const RTC_STATS_TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function candidateTypeFrom(report: RTCStatsReport, candidateId: unknown): IceCandidateType {
  if (typeof candidateId !== "string") return "unknown";
  const entry = report.get(candidateId) as { candidateType?: string } | undefined;
  const t = entry?.candidateType;
  return t === "host" || t === "srflx" || t === "prflx" || t === "relay" ? t : "unknown";
}

/**
 * Reads whichever local-participant audio track is currently publishing
 * and pulls the active candidate pair + inbound/outbound stats off it.
 * Prefers the audio track specifically — STEP 13's "audio first" KPI is
 * what this diagnostics module exists to explain, so audio's own
 * transport stats (not video's, which may be on a different simulcast
 * layer with its own characteristics) are the representative sample.
 */
export async function collectLiveKitDiagnostics(room: LiveKitRoom | null): Promise<CallDiagnosticsSnapshot | null> {
  if (!room) return null;
  const micPub = Array.from(room.localParticipant.audioTrackPublications.values())[0];
  const track = micPub?.track;
  if (!track || typeof track.getRTCStatsReport !== "function") {
    return {
      connectionState: room.state,
      iceConnectionState: null,
      selectedCandidateType: null,
      usingTurnRelay: false,
      roundTripTimeMs: null, jitterMs: null, packetsLost: null, packetLossPct: null,
      availableOutgoingBitrateKbps: null,
    };
  }

  const report = await withTimeout(track.getRTCStatsReport(), RTC_STATS_TIMEOUT_MS);
  if (!report) {
    return {
      connectionState: room.state, iceConnectionState: null, selectedCandidateType: null,
      usingTurnRelay: false, roundTripTimeMs: null, jitterMs: null, packetsLost: null,
      packetLossPct: null, availableOutgoingBitrateKbps: null,
    };
  }

  let selectedPair: Record<string, unknown> | null = null;
  let outbound: Record<string, unknown> | null = null;
  let inbound: Record<string, unknown> | null = null;

  report.forEach((entry) => {
    const e = entry as Record<string, unknown>;
    if (e.type === "candidate-pair" && (e.state === "succeeded") && (e.nominated === true || e.selected === true)) {
      selectedPair = e;
    } else if (e.type === "outbound-rtp" && e.kind === "audio") {
      outbound = e;
    } else if (e.type === "inbound-rtp" && e.kind === "audio") {
      inbound = e;
    }
  });

  const localCandidateType = selectedPair ? candidateTypeFrom(report, (selectedPair as Record<string, unknown>).localCandidateId) : "unknown";
  const rttSeconds = selectedPair ? (selectedPair as Record<string, unknown>).currentRoundTripTime as number | undefined : undefined;
  const outgoingBitrate = selectedPair ? (selectedPair as Record<string, unknown>).availableOutgoingBitrate as number | undefined : undefined;
  const jitter = inbound ? (inbound as Record<string, unknown>).jitter as number | undefined : undefined;
  const packetsLost = inbound ? (inbound as Record<string, unknown>).packetsLost as number | undefined : undefined;
  const packetsReceived = inbound ? (inbound as Record<string, unknown>).packetsReceived as number | undefined : undefined;

  return {
    connectionState: room.state,
    iceConnectionState: null, // not exposed on RTCStatsReport directly — would need PeerConnection.iceConnectionState, not accessible through LiveKit's public Track API
    selectedCandidateType: localCandidateType,
    usingTurnRelay: localCandidateType === "relay",
    roundTripTimeMs: typeof rttSeconds === "number" ? Math.round(rttSeconds * 1000) : null,
    jitterMs: typeof jitter === "number" ? Math.round(jitter * 1000) : null,
    packetsLost: typeof packetsLost === "number" ? packetsLost : null,
    packetLossPct: (typeof packetsLost === "number" && typeof packetsReceived === "number" && (packetsLost + packetsReceived) > 0)
      ? Math.round((packetsLost / (packetsLost + packetsReceived)) * 1000) / 10
      : null,
    availableOutgoingBitrateKbps: typeof outgoingBitrate === "number" ? Math.round(outgoingBitrate / 1000) : null,
  };
}
