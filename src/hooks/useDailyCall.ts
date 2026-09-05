// useDailyCall — fixes:
// CALL-02: Voice call now uses startWithVideoOff flag so camera never opens
// CALL-03: Camera device picker — enumerateDevices + setInputDevicesAsync
// CALL-04: endCall safe even in "joining" state
// CALL-07: Network reconnect — ICE/network-connection event auto-rejoin
import { useCallback, useEffect, useRef, useState } from "react";
import type { DailyCall, DailyParticipant as SDKDailyParticipant, DailyEventObjectTrack, DailyEventObjectNetworkQualityEvent } from "@daily-co/daily-js";
// BUNDLE FIX: @daily-co/daily-js is ~600 KB minified and was statically
// imported here — which pulled it into the app's entry chunk via
// App.tsx → CallContext → this hook, so every first paint downloaded and
// parsed the whole WebRTC SDK whether or not the user ever called. Types
// remain compile-time only (`import type`, erased at build); the runtime
// SDK is now dynamically imported once and cached below.
import type DailyIface from "@daily-co/daily-js";

type DailyStatic = typeof DailyIface;

// Lazily load the Daily SDK exactly once. The returned promise is cached so
// concurrent callers (double-tap join) share a single network fetch.
// STUCK-FOREVER FIX: this used to cache the promise unconditionally,
// including a REJECTED one — a single transient failure (a dropped chunk
// request, e.g. during the idle prefetch in CallContext.tsx's `warm()`)
// meant `dailySdkPromise` stayed rejected for the rest of the page's
// lifetime, and since the `if (!dailySdkPromise)` guard only re-fetches
// when it's still null, EVERY future call attempt would immediately fail
// the same way with no way to recover short of a full page reload. Now
// only a successful load is cached; a failure clears it so the next
// attempt gets a fresh fetch.
let dailySdkPromise: Promise<DailyStatic> | null = null;
export const loadDailySdk = (): Promise<DailyStatic> => {
  if (!dailySdkPromise) {
    dailySdkPromise = import("@daily-co/daily-js").then((m) => m.default as DailyStatic);
    dailySdkPromise.catch(() => { dailySdkPromise = null; });
  }
  return dailySdkPromise;
};
import { extractErrorMessage } from "@/lib/errorMessage";
import { classifyCallError, type CallError } from "@/lib/callErrors";
import { logInfo, logWarn } from "@/lib/telemetry";

// Use SDK types directly to avoid drift.
type DailyParticipant = SDKDailyParticipant;
type DailyTrackEvent = DailyEventObjectTrack;
type DailyNetworkEvent = DailyEventObjectNetworkQualityEvent;
interface DailyErrorEvent {
  errorMsg: string;
}
interface DailyNetworkConnectionEvent {
  event: "interrupted" | "connected";
  type?: string;
}
// Daily SDK already exposes setInputDevicesAsync — no extra typing needed.

type NetworkQuality = "excellent" | "good" | "fair" | "poor";

export interface VideoDevice {
  deviceId: string;
  label: string;
}

interface UseDailyCallReturn {
  joinCall: (url: string, token?: string, videoOff?: boolean) => Promise<void>;
  leaveCall: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  switchCamera: (deviceId: string) => Promise<void>;
  listCameras: () => Promise<VideoDevice[]>;
  /** Flip between the phone's front and back camera (see cycleCamera above). */
  cycleCamera: () => Promise<void>;
  /** Which physical camera is active — used to mirror the self-preview for "user" (front). */
  facingMode: "user" | "environment" | undefined;
  isAudioOn: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  callState: "idle" | "joining" | "joined" | "error";
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  screenShareRef: React.RefObject<HTMLVideoElement>;
  /**
   * Re-attach the current remote participant's live video track to
   * whatever DOM node remoteVideoRef currently points at. Needed because
   * remoteVideoRef is shared between CallStage's full-screen <video> and
   * MinimizedCallBubble's small <video> — only one of those two is ever
   * mounted at a time (minimizing/expanding fully unmounts the other), so
   * every time the mounted target swaps, the ref points at a brand-new DOM
   * node with no srcObject on it. Daily only fires "track-started" once
   * per genuinely new track, not on every remount, so nothing else
   * re-attaches it — the same class of bug the BLANK-PREVIEW FIX below
   * already found and fixed for the LOCAL video/self-preview swap; this is
   * that same fix for the remote side, called by both mount points.
   */
  reattachRemoteVideo: () => void;
  networkQuality: NetworkQuality;
  participantCount: number;
  error: string | null;
  /** Structured version of `error` — code/severity/recoverable/retryable. */
  callError: CallError | null;
  callDuration: number;
  /**
   * True once this call has auto-downgraded to audio-only because the
   * network stayed poor for a sustained period. Video stays off until the
   * user explicitly turns it back on (see toggleVideo) — auto re-enabling
   * on a still-shaky connection would just flap back and forth.
   */
  autoAudioFallback: boolean;
}

export const useDailyCall = (): UseDailyCallReturn => {
  const [callState,       setCallState]       = useState<"idle"|"joining"|"joined"|"error">("idle");
  const [isAudioOn,       setIsAudioOn]       = useState(true);
  const [isVideoOn,       setIsVideoOn]       = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [networkQuality,  setNetworkQuality]  = useState<NetworkQuality>("good");
  const [participantCount,setParticipantCount]= useState(0);
  const [error,           setError]           = useState<string | null>(null);
  const [callErrorState,  setCallErrorState]  = useState<CallError | null>(null);
  const [callDuration,    setCallDuration]    = useState(0);
  const [autoAudioFallback, setAutoAudioFallback] = useState(false);
  // MIRROR FIX: which physical camera is currently active, read from the
  // local track's own getSettings().facingMode once attached — used only
  // to mirror the self-preview for a front-facing camera (see attachTrack
  // and CallStage's mirroring transform).
  const [facingMode, setFacingMode] = useState<"user" | "environment" | undefined>(undefined);

  const callRef        = useRef<DailyCall | null>(null);
  const localVideoRef  = useRef<HTMLVideoElement>(null!);
  const remoteVideoRef = useRef<HTMLVideoElement>(null!);
  const screenShareRef = useRef<HTMLVideoElement>(null!);
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioElemsRef  = useRef<HTMLAudioElement[]>([]);
  // FAIL-PATH FIX: hoist reconnect timer to a ref so leaveCall/unmount can clear it.
  // Previously lived in joinCall closure → fired setState on unmounted instance.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog for the audio-only fallback: started when quality drops to
  // "poor", cleared if it recovers before the deadline. Kept separate from
  // reconnectTimerRef (which is about giving up on the call entirely) —
  // this one is about proactively protecting call continuity by shedding
  // video before things get bad enough to drop the call.
  const poorQualityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // BUG FIX: "Duplicate DailyIframe instances are not allowed"
  // Root cause: joinCall is async and does its duplicate-cleanup check
  // (`if (callRef.current) {...}`) synchronously at the top, but a fast
  // double-tap of the call button (very easy on mobile, before React
  // re-renders the disabled state) invoked joinCall() twice. Both
  // invocations read callRef.current as null before either had a chance
  // to assign its new call object, so DailyIframe.createCallObject() ran
  // twice concurrently — Daily's SDK throws when a second instance exists
  // anywhere on the page. This ref is a synchronous lock set *before* any
  // await, so a second concurrent call is rejected immediately instead of
  // racing.
  const joinInProgressRef = useRef(false);
  // Generation counter for the join attempt currently holding
  // joinInProgressRef — lets the watchdog below (and joinCall's own
  // finally) release the re-entrancy lock safely without racing a STALE
  // attempt that eventually settles late (see the watchdog comment for
  // why "eventually settles" can't be relied on at all).
  const joinAttemptIdRef = useRef(0);
  // "UNABLE TO CONNECT" FIX (stuck-connecting watchdog): call.join() can
  // hang indefinitely — ICE never completes, the room was deleted between
  // token fetch and join, a captive portal silently blackholes WebRTC —
  // and in that state neither "joined-meeting" nor "error" ever fires, so
  // the UI sat on "Connecting…" forever. This watchdog converts a hung
  // join into a structured, retryable failure after 25s (longer than the
  // edge-function timeout that precedes it, so it only ever fires for a
  // genuinely dead join, not a slow setup).
  //
  // STUCK-FOREVER FIX: the watchdog used to only ever surface the error —
  // it left `joinInProgressRef` (the synchronous re-entrancy guard above)
  // set to true, on the assumption that the hung `call.join()` promise
  // would eventually settle and let joinCall's own `finally` clear it.
  // For a genuinely dead connection (the whole reason the watchdog exists)
  // that promise can simply never settle — Daily's join() has no built-in
  // timeout of its own. With the lock never released, EVERY subsequent
  // call attempt hit the re-entrancy guard above and silently no-opped
  // (console.warn only, no state change at all) — the first hang made
  // calling permanently broken instead of just failing once. The watchdog
  // now clears the lock itself (guarded by joinAttemptIdRef so it can't
  // clobber a *new* attempt if the stale join somehow settles later).
  const joinWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearJoinWatchdog = useCallback(() => {
    if (joinWatchdogRef.current) { clearTimeout(joinWatchdogRef.current); joinWatchdogRef.current = null; }
  }, []);
  // BUG FIX (same "Duplicate DailyIframe instances" error, a second cause):
  // `DailyCall.destroy()` is itself async (it tears down WebRTC/media
  // internals), but every call site here used to fire-and-forget it
  // (`callRef.current.destroy()` with no `await`) before immediately
  // letting a subsequent `createCallObject()` run. If a fresh joinCall()
  // landed while a previous destroy() from leaveCall()/unmount hadn't
  // actually finished yet, Daily's SDK could still consider the old
  // instance "alive" and reject the new one with the same duplicate-
  // instance error — even with only one call site now (see CallContext).
  // This tracks any in-flight destroy so joinCall() can genuinely wait for
  // it to finish before creating a new instance, closing that window.
  const pendingDestroyRef = useRef<Promise<void> | null>(null);
  const destroyCall = useCallback((call: DailyCall) => {
    pendingDestroyRef.current = Promise.resolve(call.destroy())
      .catch((err) => console.warn('[useDailyCall] destroy() failed:', err))
      .then(() => { pendingDestroyRef.current = null; });
  }, []);

  // Single entry point for surfacing a call failure — keeps the plain
  // string `error` (existing UI reads this directly) and the structured
  // `callError` (code/severity/recoverable/retryable) in sync, and logs it
  // once instead of scattering console/telemetry calls across every catch
  // block that used to just call setError().
  const applyError = useCallback((raw: unknown, traceId?: string) => {
    const classified = classifyCallError(raw);
    setError(classified.message);
    setCallErrorState(classified);
    setCallState("error");
    logWarn("call.error", `${classified.code}: ${classified.detail}`, { severity: classified.severity, retryable: classified.retryable }, traceId);
  }, []);

  const cleanupAudioElements = useCallback(() => {
    audioElemsRef.current.forEach(a => { a.srcObject = null; a.remove(); });
    audioElemsRef.current = [];
  }, []);

  const attachTrack = useCallback((participant: DailyParticipant, ref: React.RefObject<HTMLVideoElement>) => {
    if (!ref.current) return;
    const track = participant?.tracks?.video?.persistentTrack;
    if (track) {
      ref.current.srcObject = new MediaStream([track]);
      // MIRROR FIX: front vs back camera is read straight off the track's
      // own settings (the source of truth — not an assumption), so the
      // self-preview mirrors ONLY for a front/"user"-facing camera, exactly
      // like every native camera app. Only meaningful for the local
      // preview; remote video is never mirrored.
      if (ref === localVideoRef) {
        const settings = track.getSettings?.();
        if (settings?.facingMode) setFacingMode(settings.facingMode as "user" | "environment");
      }
    }
  }, []);

  const attachAudioTrack = useCallback((participant: DailyParticipant) => {
    const track = participant?.tracks?.audio?.persistentTrack;
    if (!track) return;
    const dup = audioElemsRef.current.find(a => {
      const s = a.srcObject as MediaStream | null;
      return s?.getTracks().some(t => t.id === track.id);
    });
    if (dup) return;
    const audio = new Audio();
    audio.srcObject = new MediaStream([track]);
    // CALL-06: iOS requires user gesture for audio — use a Promise catch instead of ignoring
    audio.play().catch(err => {
      if ((err instanceof Error ? err.name : "") !== "NotAllowedError") { /* Audio blocked by browser policy — no-op in production */ }
    });
    audioElemsRef.current.push(audio);
  }, []);

  // CALL-02 FIX: Accept videoOff flag so voice calls never open the camera.
  // Previously: joinCall() always opened camera, then toggleVideo() turned it off
  // — this meant the camera briefly opened (LED flash on device) before being disabled.
  // Now: pass startVideoOff: true to Daily.co so it never activates the camera.
  const joinCall = useCallback(async (url: string, token?: string, videoOff = false) => {
    // Synchronous re-entrancy guard — must run before any `await` so a
    // second concurrent invocation (double-tap, double-accept, etc.) is
    // rejected immediately instead of racing past the callRef.current
    // check below and creating two DailyIframe instances at once.
    if (joinInProgressRef.current) {
      console.warn('[useDailyCall] joinCall already in progress — ignoring duplicate call');
      return;
    }
    joinInProgressRef.current = true;
    const attemptId = ++joinAttemptIdRef.current;
    try {
      setCallState("joining");
      setError(null);
      setCallErrorState(null);
      setAutoAudioFallback(false);
      setCallDuration(0);
      // VOICE/VIDEO UI FIX: this used to only be set once "joined-meeting"
      // fired below — which can be several seconds (or, on a cold-started
      // edge function / slow network, tens of seconds) after joinCall()
      // is first called. Every screen that decides "is this a voice call"
      // (CallStage's isVoiceCall) keys off isVideoOn, so for that entire
      // ringing/connecting window a voice call still looked exactly like a
      // video call — self-preview camera box included — with no
      // practical difference between the two. Setting it synchronously
      // here, the instant we know whether this call started with video
      // off, makes the voice/video distinction correct from the very
      // first frame instead of only after the call actually connects.
      setIsVideoOn(!videoOff);

      // BUG-03 FIX: destroy existing call object before creating a new one
      if (callRef.current) {
        try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() on reconnect (already left):', err); }
        destroyCall(callRef.current);
        callRef.current = null;
        cleanupAudioElements();
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      }
      // Wait out any destroy() still in flight from a *previous* leaveCall()
      // or unmount before creating a new instance — see pendingDestroyRef's
      // doc comment above for why this matters.
      if (pendingDestroyRef.current) await pendingDestroyRef.current;

      // Load the SDK on demand (usually already warmed by CallContext's idle
      // prefetch of loadDailySdk). A rejection here is a structured,
      // retryable join error, not a crash.
      const DailyIframe = await loadDailySdk();

      const call = DailyIframe.createCallObject({
        subscribeToTracksAutomatically: true,
        // CALL-02: start with video off for voice calls — avoids camera LED flash
        ...(videoOff ? { startVideoOff: true } : {}),
        // LAG FIX (mobile-first simulcast ladder): Daily's default camera
        // encodings assume conference-room bandwidth and can push a
        // high-bitrate video track that saturates an average mobile uplink,
        // which is exactly the "call feels laggy" report. This explicit
        // three-layer simulcast ladder caps the top layer at ~700kbps@30fps
        // and provides graceful middle/low layers so the receiver's
        // downlink (and the sender's uplink) can drop resolution before
        // dropping frames or audio quality. Unknown-key risk is nil — this
        // is a documented createCallObject dailyConfig option.
        dailyConfig: {
          camSimulcastEncodings: [
            { maxBitrate: 120_000, maxFramerate: 15, scaleResolutionDownBy: 4 },
            { maxBitrate: 300_000, maxFramerate: 24, scaleResolutionDownBy: 2 },
            { maxBitrate: 700_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
          ],
        },
      });
      callRef.current = call;

      call.on("joined-meeting", () => {
        clearJoinWatchdog();
        setCallState("joined");
        if (videoOff) setIsVideoOn(false);
        const local = call.participants().local;
        attachTrack(local, localVideoRef);
        // DURATION FIX: the timer used to start right here, i.e. the moment
        // *we* join the Daily room — which is also the entire ringing/
        // waiting-for-the-other-side window for the caller. That meant
        // duration_seconds (what call history shows and stores) counted
        // dead ring time as if the call were connected. The timer now
        // starts only once a second participant is actually present.
        // Usually that's detected in "participant-joined" below, but when
        // *we're* the one joining second (accepting an incoming call), the
        // other side is already in the room by the time our own
        // "joined-meeting" fires and no "participant-joined" event follows
        // for them — so check here too.
        if (Object.keys(call.participants()).length > 1 && !timerRef.current) {
          timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
        }

        // Premium audio: Daily's built-in noise cancellation (Krisp).
        // Best-effort — not every plan/browser combination supports it, and
        // a rejected call here must never fail the call itself.
        call.updateInputSettings({
          audio: { processor: { type: "noise-cancellation" } },
        }).then(() => {
          logInfo("call.audio", "Noise cancellation enabled");
        }).catch((err) => {
          logInfo("call.audio", "Noise cancellation unavailable, continuing without it", extractErrorMessage(err, ""));
        });
      });

      call.on("participant-joined", evt => {
        if (evt?.participant) {
          attachTrack(evt.participant, remoteVideoRef);
          attachAudioTrack(evt.participant);
        }
        const count = Object.keys(call.participants()).length;
        setParticipantCount(count);
        // DURATION FIX: start counting only once the call is actually
        // connected (a second participant — the partner — is present),
        // not from whenever we ourselves joined the room. `!timerRef.current`
        // guards against restarting/duplicating the interval on a later
        // participant-joined event (e.g. a brief reconnect) once it's
        // already running.
        if (count > 1 && !timerRef.current) {
          timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
        }
      });

      call.on("track-started", (evt: DailyTrackEvent) => {
        if (!evt?.participant || !evt.track) return;
        if (evt.track.kind === "video") {
          // BUG FIX (screen share invisible to the person sharing):
          // Daily represents an active screen share as a plain
          // "video"-kind track, told apart from the camera only by
          // whether it matches participant.tracks.screenVideo.persistentTrack
          // — that check has nothing to do with local vs. remote. This
          // used to only run inside the `!evt.participant.local` branch,
          // so when YOU started sharing, your own screenVideo track fell
          // into the generic "local video" branch below (which just
          // re-attaches the camera track, a no-op for screen share) and
          // screenShareRef's display style never left "none" — the
          // sharer's own screen was never shown to them, even though the
          // remote peer received it fine.
          const isScreenTrack = evt.participant.tracks?.screenVideo?.persistentTrack === evt.track;
          if (isScreenTrack) {
            if (screenShareRef.current) {
              screenShareRef.current.srcObject = new MediaStream([evt.track]);
              screenShareRef.current.style.display = "block";
            }
            return;
          }
          if (evt.participant.local) attachTrack(evt.participant, localVideoRef);
          else attachTrack(evt.participant, remoteVideoRef);
        } else if (evt.track.kind === "audio" && !evt.participant.local) {
          attachAudioTrack(evt.participant);
        }
      });

      call.on("track-stopped", (evt: DailyTrackEvent) => {
        // BUG FIX: matches the track-started fix above — clear
        // screenShareRef whenever the track that stopped is the one
        // currently playing there, regardless of whether the share that
        // just ended was local (you tapped "Stop sharing") or remote.
        if (evt?.track?.kind === "video" && screenShareRef.current?.srcObject) {
          const stream = screenShareRef.current.srcObject as MediaStream;
          if (stream.getTracks().some(t => t.id === evt.track.id)) {
            screenShareRef.current.srcObject = null;
            screenShareRef.current.style.display = "none";
          }
        }
      });

      call.on("participant-left", () => {
        setParticipantCount(Object.keys(call.participants()).length);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (screenShareRef.current)  screenShareRef.current.srcObject  = null;
      });

      call.on("network-quality-change", (evt: DailyNetworkEvent) => {
        const q = evt?.threshold;
        if      (q === "good")     setNetworkQuality("excellent");
        else if (q === "low")      setNetworkQuality("fair");
        else if (q === "very-low") setNetworkQuality("poor");
        else                       setNetworkQuality("good");

        // Proactive audio-only fallback: WhatsApp/FaceTime shed video
        // before a marginal connection drops the call outright. If quality
        // stays at "very-low" for 8s straight, turn video off and keep
        // audio alive rather than waiting for the call to fail. Any
        // recovery (quality improves before the deadline) cancels this —
        // it only fires on a *sustained* problem, not a single bad sample.
        if (q === "very-low") {
          if (!poorQualityTimerRef.current) {
            poorQualityTimerRef.current = setTimeout(() => {
              poorQualityTimerRef.current = null;
              if (!mountedRef.current || !callRef.current) return;
              setIsVideoOn((wasOn) => {
                if (!wasOn) return wasOn;
                try {
                  callRef.current!.setLocalVideo(false);
                  setAutoAudioFallback(true);
                  logInfo("call.quality", "Auto-downgraded to audio-only after sustained poor network");
                } catch (err) {
                  logWarn("call.quality", "Failed to auto-downgrade to audio-only", extractErrorMessage(err, ""));
                }
                return false;
              });
            }, 8000);
          }
        } else if (poorQualityTimerRef.current) {
          clearTimeout(poorQualityTimerRef.current);
          poorQualityTimerRef.current = null;
        }
      });

      call.on("error", (evt: DailyErrorEvent) => {
        clearJoinWatchdog();
        applyError(evt);
      });

      // Watchdog arm point: after handlers are attached, before join(). If
      // neither joined-meeting nor error arrives within 25s of join()
      // starting, fail with a retryable classification instead of spinning.
      clearJoinWatchdog();
      joinWatchdogRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        applyError(new Error("Couldn't connect to the call within 25 seconds. Check your connection and try again."));
        // Tear down the half-joined object so the next attempt starts clean
        // instead of racing the zombie instance (see pendingDestroyRef).
        if (callRef.current) {
          try { callRef.current.leave(); } catch { /* already left */ }
          destroyCall(callRef.current);
          callRef.current = null;
        }
        // Release the re-entrancy lock ourselves — see the STUCK-FOREVER
        // FIX comment above. Only if this watchdog's own attempt is still
        // the current one: if a fresh joinCall() already started (e.g. the
        // person retried immediately after some other error path), don't
        // stomp on ITS lock.
        if (joinAttemptIdRef.current === attemptId) {
          joinInProgressRef.current = false;
        }
      }, 25_000);

      // CALL-07: Detect transient network drops and let Daily auto-recover.
      // FAIL-PATH FIX: timer lives on a ref so leaveCall + unmount can clear it.
      call.on("network-connection" as never, ((evt: DailyNetworkConnectionEvent) => {
        if (evt?.event === "interrupted") {
          setNetworkQuality("poor");
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            applyError("Network reconnect timed out");
          }, 30000);
        } else if (evt?.event === "connected") {
          if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
          setNetworkQuality("good");
        }
      }) as never);

      call.on("left-meeting", () => {
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      });

      const joinOpts: Record<string, unknown> = { url };
      if (token) joinOpts.token = token;
      await call.join(joinOpts);
      setParticipantCount(Object.keys(call.participants()).length);
    } catch (err: unknown) {
      /* AUDIT FIX #16: join error captured via setError — removed console.error */
      clearJoinWatchdog();
      applyError(err);
    } finally {
      // Release the lock once join() has settled either way. Note this is
      // intentionally NOT tied to call duration — it only guards the
      // create+join sequence itself, so leaveCall()/a fresh joinCall() can
      // still run right after.
      // Generation-guarded (see STUCK-FOREVER FIX above): if the watchdog
      // already released this attempt's lock and a NEWER joinCall() is now
      // in flight, this stale attempt finally settling must NOT clear
      // that newer attempt's lock out from under it.
      if (joinAttemptIdRef.current === attemptId) {
        joinInProgressRef.current = false;
      }
    }
  }, [attachTrack, attachAudioTrack, cleanupAudioElements, destroyCall, applyError, clearJoinWatchdog]);

  // CALL-04 FIX: leaveCall is safe even if callState is "joining"
  const leaveCall = useCallback(() => {
    joinInProgressRef.current = false;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (poorQualityTimerRef.current) { clearTimeout(poorQualityTimerRef.current); poorQualityTimerRef.current = null; }
    clearJoinWatchdog();
    cleanupAudioElements();
    if (callRef.current) {
      try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() failed (already left):', err); }
      destroyCall(callRef.current);
      callRef.current = null;
    }
    setCallState("idle");
    setParticipantCount(0);
    setIsScreenSharing(false);
    setIsVideoOn(true);
    setIsAudioOn(true);
    setCallDuration(0);
    setAutoAudioFallback(false);
    setCallErrorState(null);
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (screenShareRef.current) screenShareRef.current.srcObject = null;
  }, [cleanupAudioElements, destroyCall, clearJoinWatchdog]);

  const toggleAudio = useCallback(() => {
    if (!callRef.current) return;
    setIsAudioOn(prev => { callRef.current!.setLocalAudio(!prev); return !prev; });
  }, []);

  const toggleVideo = useCallback(() => {
    if (!callRef.current) return;
    setIsVideoOn(prev => {
      const next = !prev;
      callRef.current!.setLocalVideo(next);
      // Manually turning video back on is an explicit override of the
      // auto-downgrade — don't keep showing "auto" once the user chose this.
      if (next) setAutoAudioFallback(false);
      return next;
    });
  }, []);

  // BLANK-PREVIEW FIX ("camera turned on is blank"): setLocalVideo(true)
  // usually RESUMES the same underlying track rather than creating a new
  // one, so Daily's "track-started" event — the only other place
  // attachTrack() gets called for the local participant — never fires
  // again. Meanwhile the self-preview <video> element is conditionally
  // rendered (CallStage hides it entirely during a voice call), so turning
  // video on remounts a BRAND NEW <video> node with no srcObject at all.
  // Nothing was ever re-attaching the (still-live) track to that new node.
  // This effect re-attaches on every render where isVideoOn is true —
  // after React has committed the DOM, so a freshly mounted preview
  // element is already in place by the time it runs — which covers both
  // "video was on from the start" and "just toggled on mid-call".
  useEffect(() => {
    if (!isVideoOn || !callRef.current) return;
    const local = callRef.current.participants().local;
    if (local) attachTrack(local, localVideoRef);
  }, [isVideoOn, attachTrack]);

  // See reattachRemoteVideo's doc comment on the interface above — this is
  // the CallStage⟷MinimizedCallBubble equivalent of the local-video
  // re-attach effect just above, exposed as a callable instead of an
  // effect here since the two mount points need it at two different times
  // (CallStage: on its own mount; the bubble: on ITS mount) rather than
  // reacting to one shared piece of state the way isVideoOn drives the
  // local-video effect.
  const reattachRemoteVideo = useCallback(() => {
    if (!callRef.current) return;
    const remote = Object.values(callRef.current.participants()).find((p) => !p.local);
    if (remote) attachTrack(remote, remoteVideoRef);
  }, [attachTrack]);

  const toggleScreenShare = useCallback(async () => {
    if (!callRef.current) return;
    try {
      if (isScreenSharing) { await callRef.current.stopScreenShare();  setIsScreenSharing(false); }
      else                 { await callRef.current.startScreenShare(); setIsScreenSharing(true);  }
    } catch { setIsScreenSharing(false); }
  }, [isScreenSharing]);

  // CALL-03: Camera device picker — enumerate inputs and switch via Daily.co API
  const listCameras = useCallback(async (): Promise<VideoDevice[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === "videoinput")
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
        }));
    } catch {
      return [];
    }
  }, []);

  // CALL-03: Switch active camera (works mid-call for dongle/external cameras)
  const switchCamera = useCallback(async (deviceId: string) => {
    if (!callRef.current) return;
    try {
      // Daily.co API: setInputDevicesAsync switches the video input at runtime
      await callRef.current.setInputDevicesAsync({ videoDeviceId: deviceId });
      // Re-attach local video after device switch
      const local = callRef.current.participants().local;
      if (local) attachTrack(local, localVideoRef);
    } catch {
      /* camera switch error — silent in production */
    }
  }, [attachTrack]);

  // CAMERA-SWITCH SIMPLIFICATION: the phone's "extra" lenses (ultra-wide,
  // telephoto, macro) all show up as separate entries from
  // enumerateDevices(), which is why the old picker listed 4-5 confusingly
  // similar "Camera" entries instead of a simple front/back choice. Daily's
  // cycleCamera() is purpose-built for exactly this — it flips between the
  // front and back-facing camera the same way a native camera app's flip
  // button does, ignoring extra lenses entirely, and hands back which way
  // it landed so the self-preview can mirror correctly (see facingMode).
  const cycleCamera = useCallback(async () => {
    if (!callRef.current) return;
    try {
      const result = await callRef.current.cycleCamera() as { facingMode?: "user" | "environment" };
      if (result?.facingMode) setFacingMode(result.facingMode as "user" | "environment");
      // Same re-attach requirement as toggleVideo's effect above — belt
      // and suspenders in case this particular device doesn't fire a
      // fresh "track-started" for the swapped camera.
      const local = callRef.current.participants().local;
      if (local) attachTrack(local, localVideoRef);
    } catch {
      /* camera cycle error — silent, matches switchCamera's own handling */
    }
  }, [attachTrack]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (poorQualityTimerRef.current) { clearTimeout(poorQualityTimerRef.current); poorQualityTimerRef.current = null; }
      clearJoinWatchdog();
      cleanupAudioElements();
      if (callRef.current) {
        try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() failed (already left):', err); }
        destroyCall(callRef.current);
        callRef.current = null;
      }
    };
  }, [cleanupAudioElements, destroyCall, clearJoinWatchdog]);

  return {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras, cycleCamera, facingMode,
    isAudioOn, isVideoOn, isScreenSharing, callState,
    localVideoRef, remoteVideoRef, screenShareRef, reattachRemoteVideo,
    networkQuality, participantCount, error, callError: callErrorState, callDuration,
    autoAudioFallback,
  };
};
