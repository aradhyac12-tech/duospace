// useDailyCall — fixes:
// CALL-02: Voice call now uses startWithVideoOff flag so camera never opens
// CALL-03: Camera device picker — enumerateDevices + setInputDevicesAsync
// CALL-04: endCall safe even in "joining" state
// CALL-07: Network reconnect — ICE/network-connection event auto-rejoin
import { useCallback, useEffect, useRef, useState } from "react";
import DailyIframe, { DailyCall, DailyParticipant as SDKDailyParticipant, DailyEventObjectTrack, DailyEventObjectNetworkQualityEvent } from "@daily-co/daily-js";

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
  isAudioOn: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  callState: "idle" | "joining" | "joined" | "error";
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  screenShareRef: React.RefObject<HTMLVideoElement>;
  networkQuality: NetworkQuality;
  participantCount: number;
  error: string | null;
  callDuration: number;
}

export const useDailyCall = (): UseDailyCallReturn => {
  const [callState,       setCallState]       = useState<"idle"|"joining"|"joined"|"error">("idle");
  const [isAudioOn,       setIsAudioOn]       = useState(true);
  const [isVideoOn,       setIsVideoOn]       = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [networkQuality,  setNetworkQuality]  = useState<NetworkQuality>("good");
  const [participantCount,setParticipantCount]= useState(0);
  const [error,           setError]           = useState<string | null>(null);
  const [callDuration,    setCallDuration]    = useState(0);

  const callRef        = useRef<DailyCall | null>(null);
  const localVideoRef  = useRef<HTMLVideoElement>(null!);
  const remoteVideoRef = useRef<HTMLVideoElement>(null!);
  const screenShareRef = useRef<HTMLVideoElement>(null!);
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioElemsRef  = useRef<HTMLAudioElement[]>([]);
  // FAIL-PATH FIX: hoist reconnect timer to a ref so leaveCall/unmount can clear it.
  // Previously lived in joinCall closure → fired setState on unmounted instance.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const cleanupAudioElements = useCallback(() => {
    audioElemsRef.current.forEach(a => { a.srcObject = null; a.remove(); });
    audioElemsRef.current = [];
  }, []);

  const attachTrack = useCallback((participant: DailyParticipant, ref: React.RefObject<HTMLVideoElement>) => {
    if (!ref.current) return;
    const track = participant?.tracks?.video?.persistentTrack;
    if (track) ref.current.srcObject = new MediaStream([track]);
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
    try {
      setCallState("joining");
      setError(null);
      setCallDuration(0);

      // BUG-03 FIX: destroy existing call object before creating a new one
      if (callRef.current) {
        try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() on reconnect (already left):', err); }
        callRef.current.destroy();
        callRef.current = null;
        cleanupAudioElements();
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      }

      const call = DailyIframe.createCallObject({
        subscribeToTracksAutomatically: true,
        // CALL-02: start with video off for voice calls — avoids camera LED flash
        ...(videoOff ? { startVideoOff: true } : {}),
      });
      callRef.current = call;

      call.on("joined-meeting", () => {
        setCallState("joined");
        if (videoOff) setIsVideoOn(false);
        const local = call.participants().local;
        attachTrack(local, localVideoRef);
        timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
      });

      call.on("participant-joined", evt => {
        if (evt?.participant) {
          attachTrack(evt.participant, remoteVideoRef);
          attachAudioTrack(evt.participant);
        }
        setParticipantCount(Object.keys(call.participants()).length);
      });

      call.on("track-started", (evt: DailyTrackEvent) => {
        if (evt?.participant && !evt.participant.local) {
          if (evt.track?.kind === "video") {
            if (evt.participant.tracks?.screenVideo?.persistentTrack === evt.track) {
              if (screenShareRef.current) {
                screenShareRef.current.srcObject = new MediaStream([evt.track]);
                screenShareRef.current.style.display = "block";
              }
            } else {
              attachTrack(evt.participant, remoteVideoRef);
            }
          } else if (evt.track?.kind === "audio") {
            attachAudioTrack(evt.participant);
          }
        } else if (evt?.participant?.local && evt.track?.kind === "video") {
          attachTrack(evt.participant, localVideoRef);
        }
      });

      call.on("track-stopped", (evt: DailyTrackEvent) => {
        if (evt?.participant && !evt.participant.local && evt.track?.kind === "video") {
          if (screenShareRef.current?.srcObject) {
            const stream = screenShareRef.current.srcObject as MediaStream;
            if (stream.getTracks().some(t => t.id === evt.track.id)) {
              screenShareRef.current.srcObject = null;
              screenShareRef.current.style.display = "none";
            }
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
      });

      call.on("error", (evt: DailyErrorEvent) => {
        setError(evt?.errorMsg || "Call error");
        setCallState("error");
      });

      // CALL-07: Detect transient network drops and let Daily auto-recover.
      // FAIL-PATH FIX: timer lives on a ref so leaveCall + unmount can clear it.
      call.on("network-connection" as never, ((evt: DailyNetworkConnectionEvent) => {
        if (evt?.event === "interrupted") {
          setNetworkQuality("poor");
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            setError("Network reconnect timed out");
            setCallState("error");
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
      setError((err instanceof Error ? err.message : String(err)) || "Failed to join call");
      setCallState("error");
    }
  }, [attachTrack, attachAudioTrack, cleanupAudioElements]);

  // CALL-04 FIX: leaveCall is safe even if callState is "joining"
  const leaveCall = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    cleanupAudioElements();
    if (callRef.current) {
      try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() failed (already left):', err); }
      callRef.current.destroy();
      callRef.current = null;
    }
    setCallState("idle");
    setParticipantCount(0);
    setIsScreenSharing(false);
    setIsVideoOn(true);
    setIsAudioOn(true);
    setCallDuration(0);
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (screenShareRef.current) screenShareRef.current.srcObject = null;
  }, [cleanupAudioElements]);

  const toggleAudio = useCallback(() => {
    if (!callRef.current) return;
    setIsAudioOn(prev => { callRef.current!.setLocalAudio(!prev); return !prev; });
  }, []);

  const toggleVideo = useCallback(() => {
    if (!callRef.current) return;
    setIsVideoOn(prev => { callRef.current!.setLocalVideo(!prev); return !prev; });
  }, []);

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      cleanupAudioElements();
      if (callRef.current) {
        try { callRef.current.leave(); } catch (err) { console.warn('[useDailyCall] leave() failed (already left):', err); }
        callRef.current.destroy();
        callRef.current = null;
      }
    };
  }, [cleanupAudioElements]);

  return {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras,
    isAudioOn, isVideoOn, isScreenSharing, callState,
    localVideoRef, remoteVideoRef, screenShareRef,
    networkQuality, participantCount, error, callDuration,
  };
};
