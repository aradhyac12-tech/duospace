/**
 * SelfHostedCallEngineAdapter — the ONLY CallEngine: LiveKit media over
 * LiveKit Cloud, which also provides managed TURN when direct paths fail.
 *
 * Call control (ring/accept/reject/cancel/end) is NOT done here — that is
 * the authenticated DuoSpace WebSocket signaling (src/lib/signalingEngine).
 * This adapter only turns an already-authorized call into media:
 *
 *   joinCall(callId)
 *     → livekit-token (server derives identity + room from the call row)
 *     → room.connect(url, token)          [bounded]
 *     → publish microphone                 [bounded]
 *     → remote participant / track / audio [observed, not assumed]
 *
 * Every stage is bounded; a stage that exceeds its budget fails the join
 * with a classified error instead of leaving the UI on "Connecting…".
 * NOT RUNTIME-VERIFIED against a live LiveKit server from this repository's
 * build environment — see docs/calling-architecture.md.
 */
import {
  reconnectGraceMs, remoteVideoQualityFor, createAdaptiveCapture, captureProfileForTier, normalizeConnectionKind,
  powerLimitFor, samePowerLimit, type PowerLimit, type PowerState,
  type AdaptiveCapture, type ConnectionKind,
} from "./callNetworkPolicy";
import { createAudioFirstFallback, mapConnectionQuality, type AudioFirstFallback } from "./audioFirstFallback";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Room as LiveKitRoom,
  RemoteParticipant,
  RemoteTrack,
  LocalParticipant,
} from "livekit-client";
import { extractErrorMessage } from "@/lib/errorMessage";
import { classifyCallError, type CallError } from "@/lib/callErrors";
import { logInfo, logWarn } from "@/lib/telemetry";
import { mark as markCallLatency } from "@/lib/callLatency";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { collectLiveKitDiagnostics } from "./webrtcDiagnostics";
import { roomNameForCall } from "@/lib/signalingEngine/types";
import type { CallEngine, CallEngineVideoDevice } from "./types";

type LiveKitStatic = typeof import("livekit-client");

// Same lazy-load-once-and-cache-only-on-success pattern as
// The call engine adapter's loadLiveKitSdk — see that file's BUNDLE FIX / STUCK-
// FOREVER FIX comments for why. LiveKit's client bundle is comparable in
// size to the call engine's; it must not enter the entry chunk either.
let livekitSdkPromise: Promise<LiveKitStatic> | null = null;
export const loadLiveKitSdk = (): Promise<LiveKitStatic> => {
  if (!livekitSdkPromise) {
    livekitSdkPromise = import("livekit-client");
    livekitSdkPromise.catch(() => { livekitSdkPromise = null; });
  }
  return livekitSdkPromise;
};

interface TokenResponse {
  token: string;
  url: string; // wss:// LiveKit server URL — server-controlled, not hard-coded client-side (STEP 7)
  roomName: string;
}

// PHASE 2 addition: livekit-token's own TTL (default 600s — see that
// function's TOKEN_TTL_SECONDS) is not returned in TokenResponse, so this
// client can't know the *exact* expiry it was minted with. Decoding the
// JWT's own `exp` claim (base64, no signature verification needed — we're
// not trusting this for authorization, only reading a timestamp we were
// already handed) gives the real value regardless of server config
// changes, rather than assuming a constant that could drift out of sync.
function decodeJwtExpiry(token: string): number | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null; // malformed token — STEP 3's "handle token expiry" degrades to "don't schedule a watchdog for it", not a crash
  }
}

// PHASE 2 addition (STEP 3 "handles reconnect"): mirrors the call engine adapter's
// reconnectTimerRef pattern exactly — see that file's CALL-07 comment. On
// LiveKit's ConnectionState entering "reconnecting", start a watchdog; if
// it clears back to "connected" before the timeout, cancel the watchdog;
// if not, treat it as a real failure and tear down. Same 30s duration as
// The call engine's, so the two providers behave identically from the person's
// perspective regardless of which is active.

// ── Bounded connection stages (the "stuck on Connecting…" fix) ──────────────
// Previously room.connect() and setMicrophoneEnabled() were awaited with no
// bound of our own. A LiveKit URL that was unreachable (wrong LIVEKIT_URL,
// TLS/proxy problem, UDP+TCP blocked with no TURN) or a mic prompt that never
// resolved kept joinCall() pending, and the only exit was an outer watchdog
// minutes later with a generic error. Each stage now has its own budget and
// a specific, classified failure.
export const TOKEN_TIMEOUT_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const MIC_PUBLISH_TIMEOUT_MS = 12_000;

class StageTimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`${stage} timeout after ${Math.round(ms / 1000)}s`);
    this.name = "StageTimeoutError";
  }
}
/** Thrown when the join was superseded (leaveCall / newer joinCall). */
export class JoinCancelledError extends Error {
  constructor() { super("join cancelled"); this.name = "JoinCancelledError"; }
}

/**
 * The real media stages of a call, in order. "LiveKit room joined" is only
 * `livekit_connected` — a call is `call_connected` ONLY once remote audio is
 * actually playing. Exposed as `mediaStage` so UI/state code can never
 * mistake a joined room for a usable call.
 */
export const MEDIA_STAGES = [
  "idle", "token_ready", "livekit_connected", "microphone_published",
  "remote_participant_connected", "remote_track_received", "remote_audio_attached",
  "remote_audio_playing", "call_connected",
] as const;
export type MediaStage = (typeof MEDIA_STAGES)[number];
const stageRank = (s: MediaStage) => MEDIA_STAGES.indexOf(s);

export function withStageTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StageTimeoutError(stage, ms)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Participant count INCLUDING the local participant, computed from the live
 * `remoteParticipants` map. FIX (stuck on "Ringing…" even though the other
 * person had picked up and audio/video were flowing): this used to read
 * `room.numParticipants`, which LiveKit only fills in from server-side room
 * metadata updates — it can still say 1 at the instant ParticipantConnected
 * fires (and on a self-hosted server it may never be refreshed), so the
 * caller's UI never saw "more than one participant" and never left
 * "Ringing…". `remoteParticipants` is updated locally by the SDK itself
 * before the event is emitted, so it is always current.
 */
function countParticipants(room: { remoteParticipants: { size: number } }): number {
  return room.remoteParticipants.size + 1;
}

export const useSelfHostedCallEngineAdapter = (): CallEngine => {
  const [callState, setCallState] = useState<"idle" | "joining" | "joined" | "error">("idle");
  const [isAudioOn, setIsAudioOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [networkQuality, setNetworkQuality] = useState<"excellent" | "good" | "fair" | "poor">("good");
  // Auto audio-first: camera paused by US because the link stayed bad (restored when it recovers).
  const [autoAudioFallbackOn, setAutoAudioFallbackOn] = useState(false);
  const fallbackRef = useRef<AudioFirstFallback | null>(null);
  // Adaptive CAPTURE resolution of our own camera (tier steps down at once on a weak link, back up after 10s of good).
  const captureRef = useRef<AdaptiveCapture | null>(null);
  // Battery / long-call cap on the TOP capture tier (30fps, or 720p30 when nearly empty). Heuristic, not a thermal reading.
  const powerStateRef = useRef<PowerState>({ level: null, charging: null });
  const powerLimitRef = useRef<PowerLimit | null>(null);
  const callDurationRef = useRef(0);
  // Wi-Fi vs mobile data (for banner wording only; never changes behaviour).
  const [connectionKind, setConnectionKind] = useState<ConnectionKind>("unknown");
  // Device connectivity + the partner's link quality (for banners and patient reconnects).
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  const [remoteNetworkQuality, setRemoteNetworkQuality] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const armWatchdogRef = useRef<(() => void) | null>(null);
  const [participantCount, setParticipantCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [callErrorState, setCallErrorState] = useState<CallError | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  callDurationRef.current = callDuration;
  const [facingMode, setFacingModeState] = useState<"user" | "environment" | undefined>(undefined);
  const facingModeRef = useRef<"user" | "environment">("user");
  const setFacingMode = useCallback((m: "user" | "environment") => { facingModeRef.current = m; setFacingModeState(m); }, []);
  const [mediaStage, setMediaStageState] = useState<MediaStage>("idle");
  const [remoteAudioReady, setRemoteAudioReady] = useState(false);
  // True while the partner's camera is actually sending video (subscribed AND
  // not muted). Drives the "camera off" avatar on the video-call screen.
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);

  const roomRef = useRef<LiveKitRoom | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const screenShareRef = useRef<HTMLVideoElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  // PHASE 2 additions — see joinCall's ConnectionStateChanged handler.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenExpiresAtRef = useRef<number | null>(null);
  const diagnosticsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Join generation: every joinCall()/leaveCall() bumps it. Any async step
  // that resumes under an older generation abandons its work (and
  // disconnects the room it created) — covers "cancelled while joining",
  // duplicate joins, and a stale call finishing after a newer one started.
  const joinGenRef = useRef(0);
  const activeCallIdRef = useRef<string | null>(null);
  const userLeftRef = useRef(false);

  // ── Media stages ─────────────────────────────────────────────────────
  // Waiters resolve with `true` when their stage is reached, or `false`
  // on timeout OR as soon as the call is left/superseded (leaveCall flushes
  // them) — so a flow awaiting an old call never hangs for its full budget
  // after the person already hung up, and can detect staleness immediately.
  const mediaStageRef = useRef<MediaStage>("idle");
  const remoteAudioReadyRef = useRef(false);
  const remoteParticipantRef = useRef(false);
  const remoteAudioWaitersRef = useRef<Array<(ok: boolean) => void>>([]);
  const participantWaitersRef = useRef<Array<(ok: boolean) => void>>([]);
  const remoteAudioElsRef = useRef<HTMLMediaElement[]>([]);

  const setMediaStage = useCallback((next: MediaStage, force = false) => {
    if (!force && stageRank(next) <= stageRank(mediaStageRef.current)) return; // stages only move forward within a call
    mediaStageRef.current = next;
    if (next !== "idle") markCallLatency(next === "remote_participant_connected" ? "remote_participant_detected" : next);
    if (mountedRef.current) setMediaStageState(next);
  }, []);

  const flushWaiters = (list: React.MutableRefObject<Array<(ok: boolean) => void>>, ok: boolean) => {
    const waiters = list.current;
    list.current = [];
    waiters.forEach((w) => w(ok));
  };

  const startDurationTimer = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      if (mountedRef.current) setCallDuration((d) => d + 1);
    }, 1000);
  }, []);

  const notifyRemoteParticipant = useCallback(() => {
    setMediaStage("remote_participant_connected");
    if (remoteParticipantRef.current) return;
    remoteParticipantRef.current = true;
    flushWaiters(participantWaitersRef, true);
  }, [setMediaStage]);

  const notifyRemoteAudioReady = useCallback(() => {
    if (remoteAudioReadyRef.current) return;
    remoteAudioReadyRef.current = true;
    setMediaStage("remote_audio_playing");
    markCallLatency("remote_audio_ready");
    setMediaStage("call_connected");
    if (mountedRef.current) setRemoteAudioReady(true);
    // The call duration (and therefore "completed" vs "cancelled" in
    // history) starts when the call is actually usable — NOT at local room
    // join, which for the caller also covers the whole ringing period.
    startDurationTimer();
    flushWaiters(remoteAudioWaitersRef, true);
  }, [setMediaStage, startDurationTimer]);

  const waitForStage = (flag: React.MutableRefObject<boolean>, list: React.MutableRefObject<Array<(ok: boolean) => void>>, timeoutMs: number): Promise<boolean> => {
    if (flag.current) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => {
        list.current = list.current.filter((w) => w !== done);
        done(false);
      }, timeoutMs);
      list.current.push(done);
    });
  };

  const waitForRemoteAudioReady = useCallback((timeoutMs: number): Promise<boolean> =>
    waitForStage(remoteAudioReadyRef, remoteAudioWaitersRef, timeoutMs), []);
  const waitForRemoteParticipant = useCallback((timeoutMs: number): Promise<boolean> =>
    waitForStage(remoteParticipantRef, participantWaitersRef, timeoutMs), []);

  /** Degraded-media recovery: an autoplay-blocked / stalled remote audio
   *  element gets one more explicit play() attempt. Never fakes success —
   *  only a real `playing` event marks the call connected. */
  const retryRemoteAudioPlayback = useCallback(() => {
    for (const el of remoteAudioElsRef.current) {
      try { void Promise.resolve(el.play?.()).catch(() => { /* still blocked */ }); } catch { /* gone */ }
    }
  }, []);

  // ── LiveKit token prefetch (latency) ──────────────────────────────────
  // The receiver can request its token as soon as claim_call is won, in
  // parallel with the CALL_ACCEPTED round trip; joinCall() for the SAME
  // call consumes it instead of paying a second round trip. The token is
  // still authorized server-side (claim + active + partners), and the
  // LiveKit connection itself still only starts in joinCall().
  const prefetchRef = useRef<{ callId: string; promise: Promise<TokenResponse> } | null>(null);
  const prefetchToken = useCallback((callId: string) => {
    if (prefetchRef.current?.callId === callId) return;
    const promise = invokeEdgeFunction<TokenResponse>("livekit-token", { body: { callId }, timeoutMs: TOKEN_TIMEOUT_MS });
    promise.catch(() => { if (prefetchRef.current?.promise === promise) prefetchRef.current = null; });
    prefetchRef.current = { callId, promise };
    void loadLiveKitSdk().catch(() => {});
  }, []);

  const attachRemoteTrack = useCallback((track: RemoteTrack) => {
    if (track.kind === "video" && remoteVideoRef.current) {
      track.attach(remoteVideoRef.current);
      if (mountedRef.current) setRemoteVideoOn(!track.isMuted);
      markCallLatency("first_remote_video");
    } else if (track.kind === "audio") {
      // PHASE 4 (measurement honesty): "attached" is NOT "playing". The
      // remote_track_received / remote_audio_attached / remote_audio_playing
      // stages are recorded separately so the accept → remote-audio-playing
      // KPI reflects the moment the element actually reports playback, not
      // just the moment we attached it. first_remote_audio keeps its
      // original (attach-time) meaning for existing dashboards.
      setMediaStage("remote_track_received");
      const el = track.attach() as HTMLMediaElement | undefined;
      setMediaStage("remote_audio_attached");
      markCallLatency("first_remote_audio");
      if (el) remoteAudioElsRef.current.push(el);
      const playing = () => { notifyRemoteAudioReady(); };
      if (!el || typeof el.addEventListener !== "function") { playing(); return; } // nothing to observe
      if (!el.paused && el.readyState >= 2) { playing(); return; }
      el.addEventListener("playing", playing, { once: true });
      // Autoplay-policy hedge: nudge playback once. If the browser still
      // blocks it we do NOT claim it is playing — waitForRemoteAudioReady's
      // own bounded timeout reports that honestly.
      void Promise.resolve(el.play?.()).catch(() => { /* blocked: reported by the timeout, not faked */ });
    }
  }, [notifyRemoteAudioReady, setMediaStage]);

  // Defined BEFORE joinCall (PHASE 2 reorder) so joinCall's own event
  // handlers — the reconnect-timeout watchdog and the connection-failure
  // path — can call it directly instead of duplicating its cleanup
  // inline. Mirrors the call engine adapter's own ordering (teardownLiveCall is
  // defined, then referenced by later handlers).
  const leaveCall = useCallback(() => {
    joinGenRef.current += 1; // abandons any in-flight join
    activeCallIdRef.current = null;
    userLeftRef.current = true;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    fallbackRef.current?.cancel();
    fallbackRef.current = null;
    captureRef.current?.cancel();
    captureRef.current = null;
    armWatchdogRef.current = null;
    setAutoAudioFallbackOn(false);
    if (diagnosticsPollRef.current) { clearInterval(diagnosticsPollRef.current); diagnosticsPollRef.current = null; }
    tokenExpiresAtRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    prefetchRef.current = null;
    remoteAudioReadyRef.current = false;
    remoteParticipantRef.current = false;
    remoteAudioElsRef.current = [];
    // Anyone still awaiting this call's media learns NOW that it's gone.
    flushWaiters(remoteAudioWaitersRef, false);
    flushWaiters(participantWaitersRef, false);
    mediaStageRef.current = "idle";
    if (mountedRef.current) {
      setMediaStageState("idle");
      setRemoteAudioReady(false);
      setRemoteVideoOn(false);
      setCallState("idle");
      setParticipantCount(0);
      setCallDuration(0);
      setCallErrorState(null);
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  /**
   * joinCall's signature is shared with the call engine adapter for
   * interface compatibility, but this adapter's actual identifiers are
   * LiveKit's (room name / access token), not the call engine's (room URL). The
   * `url` param here is expected to be the callId — CallContext.tsx's
   * generic call-setup path passes whatever the active engine needs;
   * see useCallEngine.ts's doc comment on this seam. `token`, if passed,
   * is ignored — this adapter always fetches its own short-lived token
   * (STEP 7: never trust/reuse a caller-supplied token across engines).
   */
  const joinCall = useCallback(async (callId: string, _token?: string, videoOff?: boolean) => {
    // DUPLICATE-JOIN GUARD: a second joinCall for the call we're already
    // joining/in is a no-op; a join for a DIFFERENT call first tears the old
    // one down (never two rooms at once).
    if (activeCallIdRef.current === callId && roomRef.current) {
      logInfo("call.self_hosted.duplicate_join_ignored", callId);
      return;
    }
    if (roomRef.current) leaveCall();
    const gen = ++joinGenRef.current;
    activeCallIdRef.current = callId;
    userLeftRef.current = false;
    const assertCurrent = () => { if (gen !== joinGenRef.current) throw new JoinCancelledError(); };

    setCallState("joining");
    setError(null);
    setCallErrorState(null);
    markCallLatency("join_started");
    markCallLatency("provider_selected");
    let createdRoom: LiveKitRoom | null = null;
    try {
      // LATENCY: the token request and the LiveKit SDK chunk load used to run
      // one after the other (SDK first). They are independent, so start the
      // token request NOW and let it overlap the SDK load.
      markCallLatency("token_requested");
      const prefetched = prefetchRef.current?.callId === callId ? prefetchRef.current.promise : null;
      prefetchRef.current = null;
      const tokenPromise = withStageTimeout(
        prefetched ?? invokeEdgeFunction<TokenResponse>("livekit-token", { body: { callId }, timeoutMs: TOKEN_TIMEOUT_MS }),
        TOKEN_TIMEOUT_MS + 1_000, "livekit token",
      );
      tokenPromise.catch(() => { /* awaited below; avoids an unhandled rejection if the SDK load fails first */ });
      const LiveKit = await loadLiveKitSdk();
      assertCurrent();
      // LATENCY: start capturing the microphone NOW — in parallel with the
      // token round trip (which is the slow part on a cold edge function) and
      // the websocket/ICE handshake — instead of after the token arrived.
      // getUserMedia on a phone WebView can take up to ~1s; it is now fully
      // hidden behind the network work. Discarded on any failure/cancel below.
      const micCapture: Promise<import("livekit-client").LocalAudioTrack> | null =
        typeof (LiveKit as { createLocalAudioTrack?: unknown }).createLocalAudioTrack === "function"
          ? LiveKit.createLocalAudioTrack()
          : null;
      micCapture?.catch(() => { /* surfaced where awaited below */ });
      const discardMicCapture = () => { micCapture?.then((t) => { try { t.stop(); } catch { /* gone */ } }).catch(() => {}); };
      let tokenData: TokenResponse;
      try {
        tokenData = await tokenPromise;
        assertCurrent();
      } catch (tokenErr) { discardMicCapture(); throw tokenErr; }
      if (!tokenData?.token || !tokenData?.url) { discardMicCapture(); throw new Error("livekit-token returned no token/url"); }
      // Room identity check: the server derives the room from the call id;
      // refuse to connect anywhere else.
      if (tokenData.roomName && tokenData.roomName !== roomNameForCall(callId)) {
        discardMicCapture();
        throw new Error("livekit room mismatch for this call");
      }
      setMediaStage("token_ready");
      markCallLatency("token_received");
      tokenExpiresAtRef.current = decodeJwtExpiry(tokenData.token);

      // VIDEO QUALITY: explicit capture + publish defaults instead of SDK
      // defaults. 720p/30fps capture, 3-layer simulcast (the SFU hands each
      // viewer the best layer their bandwidth allows and drops layers nobody
      // watches — dynacast), a bitrate cap that keeps mobile data sane, and
      // "maintain-framerate" so a weak link lowers sharpness before it makes
      // motion choppy. Audio gets the full voice-processing chain.
      const room = new LiveKit.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          // ORIENTATION-AWARE: a fixed 1280x720 (landscape) request makes a phone
          // held in portrait send landscape frames, which the other side then has
          // to crop/zoom or letterbox. Ask for portrait frames on a portrait screen.
          // Top tier: up to 1080p/60 requested as `ideal` (the browser clamps to what the camera can do; the 90fps
          // step for capable devices is applied once the track exists and its capabilities are readable).
          resolution: (typeof window !== "undefined" && window.innerHeight > window.innerWidth)
            ? { width: 1080, height: 1920, frameRate: 60 }
            : { width: 1920, height: 1080, frameRate: 60 },
          facingMode: "user",
        },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        publishDefaults: {
          simulcast: true,
          // Layers below the top one let receivers on weak links take 720p/360p/180p; the top (1080p) layer is the main encoding.
          videoSimulcastLayers: [LiveKit.VideoPresets.h180, LiveKit.VideoPresets.h360, LiveKit.VideoPresets.h720],
          // CEILINGS, not targets: bandwidth estimation still picks the real rate. 8 Mbps ~ 1080p at 90fps (see maxBitrateFor).
          videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 90 },
          degradationPreference: "maintain-framerate",
          backupCodec: true,
          dtx: true,
          red: true,
        },
      });
      roomRef.current = room;
      createdRoom = room;
      markCallLatency("engine_initialized");

      // STALE-ROOM GUARD: every handler below first checks that this room's
      // join generation is still current. A late event from a room that was
      // already left (or superseded by a newer call) must never mark the
      // NEWER call's participant/audio ready or change its state.
      const live = () => gen === joinGenRef.current && roomRef.current === room;
      room.on(LiveKit.RoomEvent.TrackSubscribed, (track: RemoteTrack) => { if (live()) attachRemoteTrack(track); });
      room.on(LiveKit.RoomEvent.ParticipantConnected, () => {
        if (!live()) return;
        setParticipantCount(countParticipants(room));
        markCallLatency("participant_joined");
        notifyRemoteParticipant();
      });
      // Partner turned their camera on/off (LiveKit mutes the track rather than
      // unpublishing it). Only the partner's camera counts — not our own tracks
      // and not their screen share.
      const isRemoteCamera = (pub: { kind?: string; source?: string }, participant: unknown) =>
        participant !== room.localParticipant && pub?.kind === "video" && pub?.source !== "screen_share";
      room.on(LiveKit.RoomEvent.TrackMuted, (pub: { kind?: string; source?: string }, participant: unknown) => {
        if (live() && isRemoteCamera(pub, participant) && mountedRef.current) setRemoteVideoOn(false);
      });
      room.on(LiveKit.RoomEvent.TrackUnmuted, (pub: { kind?: string; source?: string }, participant: unknown) => {
        if (live() && isRemoteCamera(pub, participant) && mountedRef.current) setRemoteVideoOn(true);
      });
      room.on(LiveKit.RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (live() && track.kind === "video" && mountedRef.current) setRemoteVideoOn(false);
      });
      room.on(LiveKit.RoomEvent.ParticipantDisconnected, () => {
        if (!live()) return;
        setParticipantCount(countParticipants(room));
      });
      // REAL network quality. networkQuality used to be only "good" (on connect)
      // or "poor" (while reconnecting) — it never reflected the actual link, so
      // the degraded-connection UI could not tell a weak call from a fine one.
      // LiveKit's own per-participant estimate -> our 4 levels, plus a
      // WhatsApp-style audio-first fallback: if the link is Lost/Poor for ~8s
      // with the camera on, pause OUR camera (voice keeps going); resume it
      // after ~10s of a good link.
      const fallback = createAudioFirstFallback({
        isCameraOn: () => room.localParticipant.isCameraEnabled,
        pause: () => {
          if (!mountedRef.current || !live()) return;
          setAutoAudioFallbackOn(true);
          setIsVideoOn(false);
          room.localParticipant.setCameraEnabled(false).catch(() => { /* best-effort */ });
        },
        resume: () => {
          if (!mountedRef.current || !live()) return;
          setAutoAudioFallbackOn(false);
          room.localParticipant.setCameraEnabled(true)
            .then(() => { if (mountedRef.current) { setIsVideoOn(true); setFacingMode("user"); captureRef.current?.reapply(); } })
            .catch(() => { /* best-effort */ });
        },
      });
      fallbackRef.current = fallback;
      // Adaptive capture: constrain OUR camera track itself (not just the simulcast layers) so a weak link
      // isn't asked to encode 720p. Best-effort: browsers may refuse/ignore applyConstraints.
      captureRef.current?.cancel();
      captureRef.current = createAdaptiveCapture({
        apply: (tier) => {
          if (!mountedRef.current || !live()) return;
          try {
            const pub = room.localParticipant.getTrackPublication(LiveKit.Track.Source.Camera);
            const mst = (pub?.videoTrack as { mediaStreamTrack?: MediaStreamTrack } | undefined)?.mediaStreamTrack;
            if (!mst) return;
            const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
            const c = (mst.getCapabilities?.() ?? {}) as { width?: { max?: number }; height?: { max?: number }; frameRate?: { max?: number } };
            const p = captureProfileForTier(tier, portrait, { maxWidth: c.width?.max, maxHeight: c.height?.max, maxFps: c.frameRate?.max }, powerLimitRef.current);
            void mst.applyConstraints({ width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.frameRate } })
              .then(() => logInfo("call.self_hosted.capture_tier", `${tier} ${p.width}x${p.height}@${p.frameRate}`))
              .catch((err) => logWarn("call.self_hosted.capture_tier_failed", extractErrorMessage(err)));
          } catch (err) { logWarn("call.self_hosted.capture_tier_failed", extractErrorMessage(err)); }
        },
      });
      // The camera track now exists (join, manual re-enable, audio-first resume): apply the current tier with the
      // device's real capabilities (this is where 90fps / 1080p gets requested on devices that support it).
      room.on(LiveKit.RoomEvent.LocalTrackPublished, (pub: { source?: string }) => {
        if (!live() || pub?.source !== LiveKit.Track.Source.Camera) return;
        captureRef.current?.reapply();
      });
      room.on(LiveKit.RoomEvent.ConnectionQualityChanged, (quality: string, participant: { isLocal?: boolean }) => {
        if (!mountedRef.current || !live()) return;
        const q = mapConnectionQuality(quality);
        if (!participant?.isLocal) { setRemoteNetworkQuality(q); return; }
        setNetworkQuality(q);
        fallback.onQuality(q);
        captureRef.current?.onQuality(q);
        // Receive side: while OUR link is weak, pull the partner's LOW video layer so audio keeps priority.
        try {
          const want = remoteVideoQualityFor(q) === "low" ? LiveKit.VideoQuality.LOW : LiveKit.VideoQuality.HIGH;
          room.remoteParticipants.forEach((rp: RemoteParticipant) => rp.videoTrackPublications.forEach((pub) => pub.setVideoQuality(want)));
        } catch { /* best-effort */ }
      });
      // PHASE 2 fix (STEP 3 "handles reconnect" / "handles token expiry"):
      // this handler used to only ever SET a callErrorState on
      // disconnected/failed and never actually transitioned callState,
      // ran a reconnect watchdog, or cleaned anything up — a real
      // disconnect would leave the UI showing a stale "joined" call
      // indefinitely. Now mirrors the call engine adapter's network-connection
      // handler (CALL-07) exactly: "reconnecting" starts a 30s watchdog
      // and degrades networkQuality; "connected" (recovering from a prior
      // reconnect) clears it; a watchdog firing, or an outright "failed",
      // tears the call down via leaveCall() and surfaces a classified
      // error — same shape as a join-time failure, just later in the
      // call's life. A token that has already expired at the moment of
      // failure is reported as that specifically (TOKEN_EXPIRED, via
      // classifyCallError's own mapping) rather than a generic
      // connection error, since that's an actionable, different-root-cause
      // signal from an actual network/ICE failure.
      room.on(LiveKit.RoomEvent.ConnectionStateChanged, (state: string) => {
        if (!mountedRef.current || !live()) return;
        if (state === "connected") {
          markCallLatency("ice_connected");
          armWatchdogRef.current = null;
          if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
          setNetworkQuality("good");
          return;
        }
        if (state === "reconnecting") {
          setNetworkQuality("poor");
          // PATIENT RECONNECT: with the device offline (tunnel, lift, network
          // handoff) give it 90s instead of 30s; coming back online re-arms a
          // fresh window (see the online listener below).
          const arm = () => {
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(() => {
              if (!mountedRef.current) return;
              const expired = tokenExpiresAtRef.current !== null && Date.now() > tokenExpiresAtRef.current;
              // ORDER FIX: leaveCall() ends with setCallState("idle"). Called
              // AFTER setCallState("error") (as it used to be), React batched
              // both and "error" was never rendered — CallContext's drop
              // handler never ran, so the call was neither recovered nor
              // closed out (row stuck 'in_progress', UI stuck on the call).
              leaveCall();
              setError(expired ? "Your call session expired." : "Network reconnect timed out");
              setCallErrorState(classifyCallError(new Error(expired ? "livekit_token_expired" : "livekit_reconnect_timeout")));
              setCallState("error");
            }, reconnectGraceMs(typeof navigator === "undefined" ? true : navigator.onLine !== false));
          };
          armWatchdogRef.current = arm;
          arm();
          return;
        }
        if (state === "disconnected" || state === "failed") {
          const expired = tokenExpiresAtRef.current !== null && Date.now() > tokenExpiresAtRef.current;
          setCallErrorState(classifyCallError(new Error(expired ? "livekit_token_expired" : `livekit_connection_${state}`)));
        }
      });
      // An UNEXPECTED disconnect of a live call (server closed the room,
      // network gave up after LiveKit's own retries, participant removed)
      // used to only flip callState to "idle" with no error and no cleanup.
      // It now releases media/timers and surfaces a classified error;
      // a disconnect we caused ourselves (leaveCall) stays silent.
      room.on(LiveKit.RoomEvent.Disconnected, (reason?: unknown) => {
        if (!mountedRef.current || gen !== joinGenRef.current || userLeftRef.current) return;
        const msg = `livekit disconnected${reason !== undefined ? ` (${String(reason)})` : ""}`;
        logWarn("call.self_hosted.unexpected_disconnect", msg);
        const err = classifyCallError(new Error(msg));
        leaveCall();
        setError("The call was disconnected.");
        setCallErrorState(err);
        setCallState("error");
      });

      markCallLatency("livekit_connect_started");
      try {
      await withStageTimeout(
        room.connect(tokenData.url, tokenData.token, {
          autoSubscribe: true,
          // LiveKit's own internal bounds, kept inside our stage budget.
          websocketTimeout: 10_000,
          peerConnectionTimeout: 15_000,
          maxRetries: 1,
        } as never),
        CONNECT_TIMEOUT_MS,
        "livekit connect",
      );
      } catch (connectErr) { discardMicCapture(); throw connectErr; }
      if (gen !== joinGenRef.current) discardMicCapture();
      assertCurrent();
      setMediaStage("livekit_connected");

      // AUDIO UNLOCK: remote audio is attached manually (attachRemoteTrack), so
      // a browser/WebView autoplay block would leave the call on "Connecting…"
      // and then fail it. Ask LiveKit to unlock playback now (the person just
      // tapped Call/Accept, so user activation is fresh) and again on the next
      // tap if the platform still reports playback as blocked.
      // Optional-call guarded: older/mocked Room objects may not expose startAudio.
      const startAudioSafe = () => { try { void Promise.resolve(room.startAudio?.()).catch(() => { /* needs a later gesture */ }); } catch { /* optional API */ } };
      startAudioSafe();
      const unlockOnTap = () => {
        startAudioSafe();
        retryRemoteAudioPlayback();
        if (room.canPlaybackAudio) removeUnlockListeners();
      };
      const removeUnlockListeners = () => {
        document.removeEventListener("pointerdown", unlockOnTap, true);
        document.removeEventListener("touchend", unlockOnTap, true);
        document.removeEventListener("keydown", unlockOnTap, true);
      };
      room.on(LiveKit.RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!live()) return;
        if (room.canPlaybackAudio) { retryRemoteAudioPlayback(); removeUnlockListeners(); }
        else {
          document.addEventListener("pointerdown", unlockOnTap, true);
          document.addEventListener("touchend", unlockOnTap, true);
          document.addEventListener("keydown", unlockOnTap, true);
        }
      });
      room.on(LiveKit.RoomEvent.Disconnected, removeUnlockListeners);
      markCallLatency("sfu_connected");
      markCallLatency("joined_meeting");

      // PHASE 2 fix (STEP 13 "audio first"): this used to `await` both
      // setMicrophoneEnabled AND setCameraEnabled sequentially before
      // callState ever flipped to "joined" — for a video call, first
      // audio was needlessly gated behind camera acquisition (which can
      // be the slower/flakier of the two, e.g. a camera already claimed
      // by another app). Microphone publish is now awaited alone; camera
      // publish for a video call is fired without blocking join
      // completion, so "joined" (and therefore first remote audio) is
      // reachable as soon as the mic path is ready regardless of how long
      // camera acquisition takes. cycleCamera/switchCamera's existing
      // "best-effort, no user-facing failure" handling covers a camera
      // that never comes up; markCallLatency's own first_remote_video
      // mark (in attachRemoteTrack) is unaffected — it fires off the
      // REMOTE track, not this local publish.
      const local: LocalParticipant = room.localParticipant;
      let micPublished = false;
      if (micCapture) {
        try {
          const micTrack = await withStageTimeout(micCapture, MIC_PUBLISH_TIMEOUT_MS, "microphone capture");
          if (gen !== joinGenRef.current) { try { micTrack.stop(); } catch { /* gone */ } throw new JoinCancelledError(); }
          await withStageTimeout(
            local.publishTrack(micTrack, { source: LiveKit.Track.Source.Microphone }),
            MIC_PUBLISH_TIMEOUT_MS, "microphone publish",
          );
          micPublished = true;
        } catch (micErr) {
          discardMicCapture(); // never leave a capture (mic indicator) running after a failed/cancelled join
          if (micErr instanceof JoinCancelledError || micErr instanceof StageTimeoutError) throw micErr;
          logWarn("call.self_hosted.mic_precapture_failed", extractErrorMessage(micErr));
        }
      }
      if (!micPublished) {
        await withStageTimeout(local.setMicrophoneEnabled(true), MIC_PUBLISH_TIMEOUT_MS, "microphone publish");
      }
      assertCurrent();
      setMediaStage("microphone_published");
      setIsAudioOn(true);
      if (!videoOff) {
        local.setCameraEnabled(true)
          .then(() => {
            if (!mountedRef.current) return;
            setIsVideoOn(true);
            setFacingMode("user");
            if (localVideoRef.current) {
              for (const pub of local.videoTrackPublications.values()) pub.track?.attach(localVideoRef.current);
            }
          })
          .catch((err) => {
            // Mirrors the call engine adapter's camera-failure handling: a failed
            // camera publish degrades the call to audio-only rather than
            // failing the whole join — the person is already connected by
            // the time this settles.
            logWarn("call.self_hosted.camera_publish_failed", extractErrorMessage(err));
            if (mountedRef.current) setIsVideoOn(false);
          });
      } else {
        setIsVideoOn(false);
      }

      // Already-present remote participants (joining an existing room, or
      // reconnect) — LiveKit only fires TrackSubscribed for tracks
      // published AFTER we subscribe unless we walk existing state too.
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        markCallLatency("participant_joined");
        notifyRemoteParticipant();
        p.trackPublications.forEach((pub) => { if (pub.track) attachRemoteTrack(pub.track); });
      });
      setParticipantCount(countParticipants(room));

      // "joined" = OUR side is in the room with the mic published. It is NOT
      // "connected": that is mediaStage === "call_connected" (remote audio
      // actually playing), which is also when the duration timer starts.
      if (mountedRef.current) setCallState("joined");

      // PHASE 2 addition (STEP 10/12): dev-only diagnostics polling — see
      // webrtcDiagnostics.ts's own doc comment for why this never reaches
      // production users. Logged via logInfo so it flows through the same
      // telemetry.ts sink as everything else, not a bespoke console.log.
      if (import.meta.env.DEV) {
        diagnosticsPollRef.current = setInterval(() => {
          if (!mountedRef.current || !roomRef.current) return;
          collectLiveKitDiagnostics(roomRef.current).then((snapshot) => {
            if (snapshot) logInfo("call.self_hosted.diagnostics", JSON.stringify(snapshot));
          }).catch(() => { /* best-effort dev diagnostic, never surfaced to the call itself */ });
        }, 5_000);
      }
    } catch (err) {
      // Release whatever this attempt created, whatever stage failed.
      if (createdRoom) {
        try { createdRoom.disconnect(); } catch { /* already gone */ }
        if (roomRef.current === createdRoom) roomRef.current = null;
      }
      if (err instanceof JoinCancelledError || gen !== joinGenRef.current) {
        // Superseded by leaveCall()/a newer join: not a user-facing error.
        logInfo("call.self_hosted.join_cancelled", callId);
        throw new JoinCancelledError();
      }
      activeCallIdRef.current = null;
      const message = extractErrorMessage(err);
      logWarn("call.self_hosted.join_failed", message);
      if (mountedRef.current) {
        setError(message);
        setCallErrorState(classifyCallError(err));
        setCallState("error");
      }
      throw err;
    }
  }, [attachRemoteTrack, leaveCall, setMediaStage, notifyRemoteParticipant, retryRemoteAudioPlayback]);

  /** Synchronous: is `callId` the call this engine is joining/in right now?
   *  (false the instant leaveCall() runs — no render needed). */
  const isActiveCall = useCallback((callId: string) => activeCallIdRef.current === callId, []);

  const toggleAudio = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setIsAudioOn((prev) => {
      const next = !prev;
      room.localParticipant.setMicrophoneEnabled(next).catch(() => { /* best-effort: a failed toggle leaves the previous state */ });
      return next;
    });
  }, []);

  const toggleVideo = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    // A manual tap always wins over the automatic audio-first pause.
    fallbackRef.current?.cancel();
    setAutoAudioFallbackOn(false);
    setIsVideoOn((prev) => {
      const next = !prev;
      if (next) setFacingMode("user"); // a re-enabled camera starts on the default (front) lens
      room.localParticipant.setCameraEnabled(next)
        .then(() => { if (next) captureRef.current?.reapply(); })
        .catch(() => { /* best-effort */ });
      return next;
    });
  }, []);

  // Not implemented this phase — see file doc comment.
  const toggleScreenShare = useCallback(() => {
    logInfo("call.self_hosted.screen_share_unimplemented", "toggleScreenShare called on SelfHostedCallEngineAdapter — no-op in Phase 1");
  }, []);

  const listCameras = useCallback(async (): Promise<CallEngineVideoDevice[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === "videoinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 6)}` }));
    } catch {
      return [];
    }
  }, []);

  const switchCamera = useCallback(async (deviceId: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.switchActiveDevice("videoinput", deviceId);
    } catch {
      /* silent — mirrors the call engine adapter's switchCamera error handling */
    }
  }, []);

  // FLIP CAMERA (was a no-op stub — the button did nothing). Restarts the live
  // camera track on the opposite lens in place (no republish, no renegotiation).
  // Falls back to cycling the enumerated video input devices if the browser
  // rejects the facingMode constraint.
  const cycleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const LiveKit = await loadLiveKitSdk();
    const pub = room.localParticipant.getTrackPublication(LiveKit.Track.Source.Camera);
    const track = pub?.videoTrack as import("livekit-client").LocalVideoTrack | undefined;
    if (!track) return;
    const target: "user" | "environment" = facingModeRef.current === "environment" ? "user" : "environment";
    try {
      await track.restartTrack({ facingMode: target });
      facingModeRef.current = target;
      setFacingMode(target);
      captureRef.current?.reapply(); // a restarted track comes back at default constraints
      return;
    } catch (err) {
      logWarn("call.self_hosted.flip_camera_facing_failed", extractErrorMessage(err));
    }
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId);
      if (cams.length < 2) return;
      const currentId = track.mediaStreamTrack.getSettings().deviceId;
      const idx = cams.findIndex((d) => d.deviceId === currentId);
      const next = cams[(idx + 1) % cams.length];
      await room.switchActiveDevice("videoinput", next.deviceId);
      facingModeRef.current = target;
      setFacingMode(target);
    } catch (err) {
      logWarn("call.self_hosted.flip_camera_failed", extractErrorMessage(err));
    }
  }, []);

  const reattachRemoteVideo = useCallback(() => {
    const room = roomRef.current;
    if (!room || !remoteVideoRef.current) return;
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      p.videoTrackPublications.forEach((pub) => { pub.track?.attach(remoteVideoRef.current!); });
    });
  }, []);

  // Device connectivity during a call: surface it, and when it returns give the
  // reconnect watchdog a fresh window (LiveKit resumes/ICE-restarts on its own).
  useEffect(() => {
    const onOffline = () => { if (mountedRef.current) setIsOffline(true); };
    const onOnline = () => {
      if (!mountedRef.current) return;
      setIsOffline(false);
      armWatchdogRef.current?.();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => { window.removeEventListener("offline", onOffline); window.removeEventListener("online", onOnline); };
  }, []);

  // Battery source for the power cap: native plugin (Android/iOS) else web Battery API (best-effort, often absent).
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const recompute = () => {
      if (cancelled || !mountedRef.current) return;
      const next = powerLimitFor(powerStateRef.current, callDurationRef.current * 1000);
      if (samePowerLimit(next, powerLimitRef.current)) return;
      powerLimitRef.current = next;
      logInfo("call.self_hosted.power_limit", next ? next.reason : "none");
      captureRef.current?.reapply(); // only changes the top tier's profile; lower tiers ignore the limit
    };
    const setState = (level: number | null | undefined, charging: boolean | null | undefined) => {
      powerStateRef.current = { level: typeof level === "number" ? level : null, charging: typeof charging === "boolean" ? charging : null };
      recompute();
    };
    void (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (Capacitor.isPluginAvailable("DuospaceDeviceStatus")) {
          const { DuospaceDeviceStatus } = await import("duospace-device-status");
          const st = await DuospaceDeviceStatus.getStatus().catch(() => null);
          if (st) setState(st.batteryLevel, st.charging);
          const h = await DuospaceDeviceStatus.addListener("statusChanged", (n) => setState(n.batteryLevel, n.charging));
          if (cancelled) void h.remove(); else cleanups.push(() => { void h.remove(); });
          return;
        }
      } catch { /* fall through to the web API */ }
      try {
        const b = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }> }).getBattery?.();
        if (!b || cancelled) return;
        const read = () => setState(Math.round(b.level * 100), b.charging);
        read();
        b.addEventListener("levelchange", read); b.addEventListener("chargingchange", read);
        cleanups.push(() => { b.removeEventListener("levelchange", read); b.removeEventListener("chargingchange", read); });
      } catch { /* no battery info: no battery cap, long-call cap still applies */ }
    })();
    const timer = setInterval(recompute, 30_000); // long-call rule needs a clock, not an event
    return () => { cancelled = true; clearInterval(timer); cleanups.forEach((f) => f()); };
  }, []);

  // Wi-Fi vs mobile data: Capacitor Network on native, Network Information API on the web (often absent -> "unknown").
  useEffect(() => {
    let cancelled = false;
    let removeNative: (() => void) | null = null;
    const webType = () => (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
    const apply = (type: string | undefined, connected: boolean) => { if (!cancelled && mountedRef.current) setConnectionKind(normalizeConnectionKind(type, connected)); };
    apply(webType(), navigator.onLine !== false);
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    const onWebChange = () => apply(webType(), navigator.onLine !== false);
    conn?.addEventListener?.("change", onWebChange);
    void (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        const { Network } = await import("@capacitor/network");
        const st = await Network.getStatus();
        apply(st.connectionType, st.connected);
        const h = await Network.addListener("networkStatusChange", (n) => apply(n.connectionType, n.connected));
        if (cancelled) { void h.remove(); } else { removeNative = () => { void h.remove(); }; }
      } catch { /* plugin unavailable — web value stays */ }
    })();
    return () => { cancelled = true; conn?.removeEventListener?.("change", onWebChange); removeNative?.(); };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (diagnosticsPollRef.current) clearInterval(diagnosticsPollRef.current);
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  return {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras, cycleCamera, facingMode,
    isAudioOn, isVideoOn, isScreenSharing: false, callState,
    localVideoRef, remoteVideoRef, screenShareRef, reattachRemoteVideo,
    networkQuality, participantCount, error, callError: callErrorState, callDuration,
    detailedNetworkQuality: networkQuality === "excellent" ? "excellent" : networkQuality === "good" ? "good" : networkQuality === "fair" ? "fair" : "poor",
    autoAudioFallback: autoAudioFallbackOn,
    isOffline,
    connectionKind,
    remoteNetworkQuality,
    waitForRemoteAudioReady,
    waitForRemoteParticipant,
    retryRemoteAudioPlayback,
    prefetchToken,
    isActiveCall,
    mediaStage,
    remoteAudioReady,
    remoteVideoOn,
  };
};
