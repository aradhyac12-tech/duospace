import { describe, it, expect, beforeEach } from "vitest";
import { clearEvents, getRecentEvents } from "@/lib/telemetry";

import { beginTrace, mark, finishTrace, stashIncomingStage } from "@/lib/callLatency";

const CALL = "11111111-1111-4111-8111-111111111111";
const tick = (ms = 4) => new Promise<void>((r) => setTimeout(r, ms));
beforeEach(() => { clearEvents(); });
// Reads the REAL telemetry ring buffer (no mock), through the real privacy
// redactor, and parses the summary line the way a log reader would. Going
// through the buffer is the point: it proves the token-stage numbers and the
// full stage list survive the redactor's key rules and the 200-char cut.
const last = () => {
  const evs = getRecentEvents().filter((e) => e.context === "call.latency");
  const msg = evs[evs.length - 1].message;
  const stagesMs: Record<string, number> = {};
  const flat: Record<string, number | null> = {};
  for (const part of msg.split(" ")) {
    const m = /^([A-Za-z_.]+)=(-?\d+)$/.exec(part);
    if (!m) continue;
    if (m[1].startsWith("stage.")) stagesMs[m[1].slice(6)] = Number(m[2]);
    else flat[m[1]] = Number(m[2]);
  }
  // Metrics that were not measured are ABSENT from the line; expose as null.
  const KPI = ["acceptToRemoteAudioPlayingMs", "remoteTrackToAudioPlayingMs", "acceptToTokenMs", "acceptToAcceptSentMs", "tokenToLivekitConnectedMs", "livekitToRemoteTrackMs", "signalingReadyMs", "inviteSentMs"];
  for (const k of KPI) if (!(k in flat)) flat[k] = null;
  return { stagesMs, ...flat } as Record<string, any>;
};

describe("Phase 4 latency stages", () => {
  it("incoming: ring-time stages recorded BEFORE the trace exist show up as offsets at-or-before accept, and accept_pressed aliases the accept tap", async () => {
    stashIncomingStage(CALL, "invite_received");
    await tick();
    stashIncomingStage(CALL, "ringing_displayed");
    await tick();
    beginTrace("incoming", "voice", "self_hosted", CALL);
    mark("accept_sent"); await tick();
    mark("token_requested"); mark("token_received"); await tick();
    mark("livekit_connect_started"); mark("livekit_connected"); await tick();
    mark("remote_track_received"); mark("remote_audio_attached"); await tick();
    mark("remote_audio_playing");
    finishTrace("connected");
    const m = last();
    expect(m.stagesMs.accept_pressed).toBe(0);
    expect(m.stagesMs.invite_received).toBeLessThan(0);
    expect(m.stagesMs.ringing_displayed).toBeLessThan(0);
    expect(m.stagesMs.invite_received).toBeLessThan(m.stagesMs.ringing_displayed);
    expect(typeof m.acceptToRemoteAudioPlayingMs).toBe("number");
    expect(m.acceptToRemoteAudioPlayingMs).toBeGreaterThan(0);
    expect(m.acceptToTokenMs).toBeGreaterThanOrEqual(0);
    expect(m.tokenToLivekitConnectedMs).toBeGreaterThanOrEqual(0);
    expect(m.livekitToRemoteTrackMs).toBeGreaterThanOrEqual(0);
    expect(m.remoteTrackToAudioPlayingMs).toBeGreaterThanOrEqual(0);
    expect(m.acceptToAcceptSentMs).toBeGreaterThanOrEqual(0);
  });

  it("NEVER invents a number: a call that never reached remote audio playing reports null for the KPI", () => {
    beginTrace("incoming", "voice", "self_hosted", CALL);
    mark("token_requested"); mark("livekit_connected"); mark("first_remote_audio"); // attached, but never 'playing'
    finishTrace("connected");
    const m = last();
    expect(m.acceptToRemoteAudioPlayingMs).toBeNull();
    expect(m.remoteTrackToAudioPlayingMs).toBeNull();
    expect(m.acceptToTokenMs).toBeNull();
  });

  it("outgoing: signaling_ready / invite_sent are measured from the call button; incoming-only metrics stay null", async () => {
    beginTrace("outgoing", "video", "self_hosted");
    await tick(); mark("signaling_ready");
    await tick(); mark("invite_sent");
    finishTrace("connected");
    const m = last();
    expect(m.signalingReadyMs).toBeGreaterThan(0);
    expect(m.inviteSentMs).toBeGreaterThan(m.signalingReadyMs);
    expect(m.acceptToRemoteAudioPlayingMs).toBeNull();
    expect(m.stagesMs.accept_pressed).toBeUndefined(); // only incoming traces alias it
  });

  it("stashed ring stages belong to ONE call: a different call's trace does not inherit them", () => {
    stashIncomingStage(CALL, "invite_received");
    beginTrace("incoming", "voice", "self_hosted", "22222222-2222-4222-8222-222222222222");
    finishTrace("cancelled");
    expect(last().stagesMs.invite_received).toBeUndefined();
    // ...and they are consumed by the trace that owned them:
    beginTrace("incoming", "voice", "self_hosted", CALL);
    finishTrace("cancelled");
    expect(last().stagesMs.invite_received).toBeLessThanOrEqual(0);
  });

  it("first occurrence wins, so a REAL mark can't be pre-empted by a later duplicate", async () => {
    beginTrace("incoming", "voice", "self_hosted", CALL);
    mark("token_received");
    await tick();
    mark("token_received");
    finishTrace("failed");
    expect(last().stagesMs.token_received).toBeLessThan(4); // the FIRST mark (t≈0), not the one 4ms later
  });
});
