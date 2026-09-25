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
const RECONNECT_TIMEOUT_MS = 30_000;

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

export const useSelfHostedCallEngineAdapter = (): CallEngine => {
  const [callState, setCallState] = useState<"idle" | "joining" | "joined" | "error">("idle");
  const [isAudioOn, setIsAudioOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [networkQuality, setNetworkQuality] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const [participantCount, setParticipantCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [callErrorState, setCallErrorState] = useState<CallError | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [facingMode, setFacingMode] = useState<"user" | "environment" | undefined>(undefined);
  const [mediaStage, setMediaStageState] = useState<MediaStage>("idle");
  const [remoteAudioReady, setRemoteAudioReady] = useState(false);

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
      const LiveKit = await loadLiveKitSdk();
      assertCurrent();
      markCallLatency("token_requested");
      const prefetched = prefetchRef.current?.callId === callId ? prefetchRef.current.promise : null;
      prefetchRef.current = null;
      const tokenData = await withStageTimeout(
        prefetched ?? invokeEdgeFunction<TokenResponse>("livekit-token", { body: { callId }, timeoutMs: TOKEN_TIMEOUT_MS }),
        TOKEN_TIMEOUT_MS + 1_000, "livekit token",
      );
      assertCurrent();
      if (!tokenData?.token || !tokenData?.url) throw new Error("livekit-token returned no token/url");
      // Room identity check: the server derives the room from the call id;
      // refuse to connect anywhere else.
      if (tokenData.roomName && tokenData.roomName !== roomNameForCall(callId)) {
        throw new Error("livekit room mismatch for this call");
      }
      setMediaStage("token_ready");
      markCallLatency("token_received");
      tokenExpiresAtRef.current = decodeJwtExpiry(tokenData.token);

      const room = new LiveKit.Room({
        adaptiveStream: true,
        dynacast: true,
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
        setParticipantCount(room.numParticipants);
        markCallLatency("participant_joined");
        notifyRemoteParticipant();
      });
      room.on(LiveKit.RoomEvent.ParticipantDisconnected, () => {
        if (!live()) return;
        setParticipantCount(room.numParticipants);
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
          if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
          setNetworkQuality("good");
          return;
        }
        if (state === "reconnecting") {
          setNetworkQuality("poor");
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
          }, RECONNECT_TIMEOUT_MS);
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
      assertCurrent();
      setMediaStage("livekit_connected");
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
      await withStageTimeout(local.setMicrophoneEnabled(true), MIC_PUBLISH_TIMEOUT_MS, "microphone publish");
      assertCurrent();
      setMediaStage("microphone_published");
      setIsAudioOn(true);
      if (!videoOff) {
        local.setCameraEnabled(true)
          .then(() => {
            if (!mountedRef.current) return;
            setIsVideoOn(true);
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
      setParticipantCount(room.numParticipants);

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
  }, [attachRemoteTrack, leaveCall, setMediaStage, notifyRemoteParticipant]);

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
    setIsVideoOn((prev) => {
      const next = !prev;
      room.localParticipant.setCameraEnabled(next).catch(() => { /* best-effort */ });
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

  const cycleCamera = useCallback(async () => {
    // LiveKit's client SDK has no built-in front/back cycle equivalent to
    // The call engine's cycleCamera() — would need to enumerate videoinputs and
    // infer facing mode ourselves. Not implemented; flagged rather than
    // guessed at (see migration brief: "do not invent unsupported APIs").
    logInfo("call.self_hosted.cycle_camera_unimplemented", "cycleCamera has no LiveKit-native equivalent — not implemented in Phase 1");
  }, []);

  const reattachRemoteVideo = useCallback(() => {
    const room = roomRef.current;
    if (!room || !remoteVideoRef.current) return;
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      p.videoTrackPublications.forEach((pub) => { pub.track?.attach(remoteVideoRef.current!); });
    });
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
    autoAudioFallback: false,
    waitForRemoteAudioReady,
    waitForRemoteParticipant,
    retryRemoteAudioPlayback,
    prefetchToken,
    isActiveCall,
    mediaStage,
    remoteAudioReady,
  };
};
