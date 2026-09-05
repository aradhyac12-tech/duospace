import { motion, AnimatePresence, useMotionValue, animate as animateValue } from "framer-motion";
import {
  Phone, PhoneOff, VideoIcon, VideoOff, Monitor, MonitorOff, Captions,
  Volume2, VolumeX, Bluetooth, Headphones, Ear, Minimize2, Lock, Wifi, PictureInPicture2, MoreHorizontal,
  SwitchCamera,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { useAudioRoute } from "@/hooks/useAudioRoute";
import type { AudioRoute } from "duospace-audio-route";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium, hapticHeavy, hapticSelection } from "@/lib/haptics";
import { startRingtoneLoop, stopRingtoneLoop } from "@/lib/sounds";
import { deriveCallUiState } from "@/lib/callUiState";
import { snappySpring, standardTransition } from "@/lib/motion";
import { ReconnectingBanner, AudioFallbackBanner, PartnerLeftBanner } from "@/components/calls/CallStatusBanner";

// ─── CallStage ──────────────────────────────────────────────────────────────
// The single "in-call" screen (ringing / connecting / connected), shared by
// BOTH call entry points — pages/Calls.tsx's own live-call screen and
// Chat.tsx's CallOverlay — so there is exactly one implementation of this
// UI instead of two hand-maintained copies that drift apart (which is how
// the chat entry point ended up with a plainer control row, no camera
// switch/PiP, and no voice/video distinction for the auto-hide behavior).
//
// Pulls everything it can straight from CallContext (useCall()) since both
// call sites already sit inside <CallProvider>. Only genuinely page-local
// orchestration state — the stuff that differs between "I just tapped the
// call button here" vs "I accepted this call from Chat" — is passed in as
// props. onCallAgain/onDismissOutcome/the error screen stay OUTSIDE this
// component (each caller's own gate decides when to mount CallStage at
// all); this component only ever renders the ringing/connecting/connected
// states.

const qualityResolution: Record<string, string> = {
  excellent: "1080p HD", good: "720p HD", fair: "480p", poor: "360p",
};

const RouteIcon = ({ type }: { type?: AudioRoute["type"] }) => {
  const props = { className: "h-5 w-5 text-call-stage-foreground", "aria-hidden": true as const };
  switch (type) {
    case "speaker": return <Volume2 {...props} />;
    case "bluetooth": return <Bluetooth {...props} />;
    case "wired_headset": return <Headphones {...props} />;
    default: return <Ear {...props} />;
  }
};

const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

interface NetworkInformation {
  downlink?: number;
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

export interface CallStageProps {
  /** Outgoing pre-join window (button tapped, network setup not done yet)
   *  or a page's own "starting" flag. */
  isStartingCall: boolean;
  cancelStartingCall: () => void;
  endCall: () => void;
  /** "video" | "voice" this call started as — used only as a fallback for
   *  the brief window before CallContext's activeCallType is set (e.g. the
   *  very start of an outgoing call). Once set, activeCallType (shared,
   *  correct for BOTH the caller and an accepting device) takes over. */
  callMode: "video" | "voice";
  everConnected: boolean;
  partnerName: string;
  partnerAvatar: string | null;
  /** Honest ringing-stage hint ("their phone is on silent") — optional,
   *  only the Calls page currently computes this. */
  ringHint?: string | null;
  showLipReading: boolean;
  setShowLipReading: React.Dispatch<React.SetStateAction<boolean>>;
}

const CallStage = ({
  isStartingCall, cancelStartingCall, endCall, callMode, everConnected,
  partnerName, partnerAvatar, ringHint, showLipReading, setShowLipReading,
}: CallStageProps) => {
  const { toast } = useToast();
  const {
    callState, isVideoOn, isScreenSharing,
    toggleVideo, toggleScreenShare, listCameras, cycleCamera, facingMode,
    localVideoRef, remoteVideoRef, screenShareRef, reattachRemoteVideo,
    networkQuality: callNetworkQuality, participantCount, callDuration, autoAudioFallback,
    isAcceptingCall, cancelAcceptingCall, activeCallType, setIsCallMinimized,
  } = useCall();

  // BLANK-VIDEO FIX (expanding from the minimized bubble showed nothing):
  // CallStage's own <video ref={remoteVideoRef}> and MinimizedCallBubble's
  // small one share the same ref, and only one of the two is ever mounted
  // at a time — see reattachRemoteVideo's doc comment in useDailyCall.ts.
  // CallStage remounts fresh every time it becomes visible again (the
  // parent page conditionally returns it, not just hides it via CSS), so a
  // run-once-on-mount effect is exactly the right time to re-attach.
  useEffect(() => {
    reattachRemoteVideo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectiveCallType = activeCallType ?? callMode;
  // VOICE-CALL LOCK FIX: this used to also require `!isVideoOn`, on the
  // idea that a video call briefly counts as "voice-shaped" before its
  // camera comes on. In practice that made isVoiceCall flip false the
  // instant the video-toggle button was tapped — even on a call that was
  // started as voice — which is exactly how the camera preview and lip
  // reading (both gated on `!isVoiceCall`) were popping up mid voice-call.
  // A voice call is a voice call for its whole duration: whether the
  // camera can turn on at all is now decided once, by call TYPE, not by
  // isVideoOn. The video-toggle button itself is hidden below for voice
  // calls, so isVideoOn can no longer flip true on one in the first place.
  const isVoiceCall = effectiveCallType === "voice";

  const callUiState = deriveCallUiState({
    callState: callState as "idle" | "joining" | "joined" | "error",
    isStartingCall, participantCount, everConnected,
    networkQuality: callNetworkQuality as "excellent" | "good" | "fair" | "poor",
  });

  // Caller-side ringback tone ("dring... dring...") while the other end
  // hasn't picked up yet — a real phone call rings audibly for the caller
  // too, not just the receiver. Stops the instant the call state moves on
  // (answered, cancelled, or failed) since callUiState itself changes away
  // from "ringing" in every one of those cases.
  useEffect(() => {
    if (callUiState === "ringing") {
      startRingtoneLoop();
      return () => stopRingtoneLoop();
    }
    stopRingtoneLoop();
  }, [callUiState]);

  // ── Controls auto-hide — VIDEO calls only, always recoverable ──────────
  // Scoped to connected video calls per the brief: a voice call's small
  // glass control group doesn't sit over content the user is trying to
  // see, so it never hides. For video calls, controls fade after a few
  // seconds idle. Recovery is intentionally redundant — a tap ANYWHERE on
  // the stage (the root container's own onClick, not just the video
  // element) brings them back, so there is no dead zone that can leave the
  // panel stuck hidden with no way to reach it again.
  const CONTROLS_HIDE_MS = 3500;
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const wake = useCallback(() => {
    setControlsVisible(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (callUiState === "connected" && !isVoiceCall) {
      idleTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
    }
  }, [callUiState, isVoiceCall]);
  useEffect(() => {
    wake();
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callUiState, isVoiceCall]);
  // Voice calls: always visible, regardless of the timer above (belt and
  // suspenders — wake() already skips arming the timer for voice calls,
  // this also covers the moment isVoiceCall flips true mid-call before the
  // effect above has re-run).
  const visible = controlsVisible || isVoiceCall || callUiState !== "connected";
  const toggleVisible = useCallback(() => {
    if (isVoiceCall) return;
    if (controlsVisible) {
      setControlsVisible(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    } else {
      wake();
    }
  }, [isVoiceCall, controlsVisible, wake]);

  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [cameras, setCameras] = useState<{ deviceId: string; label: string }[]>([]);
  useEffect(() => {
    if (callState !== "joined") return;
    listCameras().then(setCameras).catch(() => {});
  }, [callState, listCameras]);

  const audioRoute = useAudioRoute(callState === "joined" || callState === "joining");

  // Speaker button in the main control row — a quick on/off toggle, not
  // the full device picker (that's still one tap away in "More" > Audio
  // output, for choosing Bluetooth/wired specifically).
  //
  // On native builds with the audio-route plugin, this toggles between
  // the OS's speaker route and whatever non-speaker route it reports
  // (earpiece/wired/Bluetooth — whichever the OS is actually offering),
  // falling back to opening the full picker if there's no clear "other"
  // route to toggle to (e.g. only one route exists).
  //
  // On web (audioRoute.supported is false in dev/browser preview — see
  // useAudioRoute.ts), there is no OS-level route to control at all: the
  // browser owns output device selection, and JS can only ever influence
  // it via the experimental, Chromium-only HTMLMediaElement.setSinkId.
  // DEAD-BUTTON FIX: this used to flip `speakerOn` and show a "Speaker
  // on/off" toast UNCONDITIONALLY, whether or not setSinkId actually
  // exists or the call to it actually succeeded — so on every browser
  // that lacks it (which is most mobile browsers/webviews, including
  // Capacitor's, and all of Safari/iOS) the button looked like it worked
  // every time while doing nothing at all. Now: if setSinkId isn't even
  // present, say so plainly and don't touch any state; if it IS present,
  // only flip the visible state and claim success once setSinkId has
  // actually resolved. Honest > pretending.
  const [sinkIdSupported, setSinkIdSupported] = useState(false);
  useEffect(() => {
    setSinkIdSupported(typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype);
  }, []);
  const [speakerOn, setSpeakerOn] = useState(true);
  const toggleSpeaker = useCallback(() => {
    hapticMedium();
    if (audioRoute.supported) {
      const speakerRoute = audioRoute.routes.find(r => r.type === "speaker");
      const otherRoute = audioRoute.routes.find(r => r.type !== "speaker");
      const isSpeaker = audioRoute.current?.type === "speaker";
      const target = isSpeaker ? otherRoute : speakerRoute;
      if (target) {
        audioRoute.setRoute(target).catch(() => {
          toast({ title: "Couldn't switch audio output", description: "Try picking a specific route from More instead.", variant: "destructive" });
        });
      } else {
        // No clear single "other" route to toggle to (e.g. Bluetooth AND
        // wired both available) — open the full picker instead of
        // guessing which one the person wants.
        setShowRoutePicker(true);
      }
      wake();
      return;
    }
    if (!sinkIdSupported) {
      toast({
        title: "Can't switch audio output here",
        description: "This browser doesn't support it — use your phone's own volume or Bluetooth settings instead.",
        variant: "destructive",
      });
      wake();
      return;
    }
    const next = !speakerOn;
    (async () => {
      try {
        const media = remoteVideoRef.current as (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | null;
        if (!media?.setSinkId || !navigator.mediaDevices?.enumerateDevices) {
          toast({ title: "Can't switch audio output here", variant: "destructive" });
          return;
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const speakerDevice = devices.find(d => d.kind === "audiooutput" && /speaker/i.test(d.label));
        const defaultDevice = devices.find(d => d.kind === "audiooutput" && d.deviceId === "default") ?? devices.find(d => d.kind === "audiooutput");
        const pick = next ? (speakerDevice ?? defaultDevice) : defaultDevice;
        if (!pick) {
          toast({ title: "No other audio output found", variant: "destructive" });
          return;
        }
        await media.setSinkId(pick.deviceId);
        setSpeakerOn(next);
        toast({ title: next ? "Speaker on" : "Speaker off" });
      } catch {
        toast({ title: "Couldn't switch audio output", variant: "destructive" });
      }
    })();
    wake();
  }, [audioRoute, sinkIdSupported, speakerOn, remoteVideoRef, toast, wake]);

  // SCREEN-SHARE DEAD-BUTTON FIX: startScreenShare()/stopScreenShare() ride
  // on the browser's getDisplayMedia() API, which simply doesn't exist in
  // most mobile browsers and is NOT available at all inside a Capacitor
  // WebView (there's no OS-level screen-broadcast plugin wired into this
  // app — that would need its own native module, like ReplayKit/
  // MediaProjection). Showing the button there meant every tap silently
  // failed with nothing to show for it. Feature-detect up front and hide
  // the control entirely when it can't possibly work, the same way the
  // camera-switcher and audio-route picker already hide themselves when
  // unsupported — an honestly absent control beats a dead one.
  const [screenShareSupported, setScreenShareSupported] = useState(false);
  useEffect(() => {
    setScreenShareSupported(!!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices);
  }, []);

  const [pipSupported, setPipSupported] = useState(false);
  const [isPip, setIsPip] = useState(false);
  useEffect(() => {
    setPipSupported(typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled);
  }, []);
  const togglePip = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (remoteVideoRef.current) await remoteVideoRef.current.requestPictureInPicture();
    } catch { /* some platforms reject despite reporting support — fail silently */ }
  }, [remoteVideoRef]);
  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    el.addEventListener("enterpictureinpicture", onEnter);
    el.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      el.removeEventListener("enterpictureinpicture", onEnter);
      el.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [remoteVideoRef, callState]);

  // Browser-side network quality, for the resolution badge while not yet
  // joined (identical source Calls.tsx's hub screen already used).
  const [browserNetworkQuality, setBrowserNetworkQuality] = useState<"excellent" | "good" | "fair" | "poor">("good");
  useEffect(() => {
    const nav = navigator as NavigatorWithConnection;
    const getQuality = () => {
      const c = nav.connection;
      if (c) {
        const downlink = c.downlink ?? 0;
        const eff = c.effectiveType;
        if (eff === "4g" && downlink >= 10) return "excellent" as const;
        if (eff === "4g") return "good" as const;
        if (eff === "3g") return "fair" as const;
        return "poor" as const;
      }
      return "good" as const;
    };
    setBrowserNetworkQuality(getQuality());
    const handler = () => setBrowserNetworkQuality(getQuality());
    nav.connection?.addEventListener?.("change", handler);
    return () => nav.connection?.removeEventListener?.("change", handler);
  }, []);
  const activeQuality = callState === "joined" ? (callNetworkQuality as "excellent" | "good" | "fair" | "poor") : browserNetworkQuality;
  const resolutionLabel = qualityResolution[activeQuality] ?? qualityResolution.good;

  // ── Self-preview: draggable, edge-snapping, safe-area aware ────────────
  const dragBoundsRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewX = useMotionValue(0);
  const previewY = useMotionValue(0);
  const snapPreviewToNearestCorner = useCallback(() => {
    const bounds = dragBoundsRef.current;
    const el = previewRef.current;
    if (!bounds || !el) return;
    const bRect = bounds.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const isRight = (eRect.left + eRect.width / 2) > (bRect.left + bRect.width / 2);
    const isBottom = (eRect.top + eRect.height / 2) > (bRect.top + bRect.height / 2);
    const targetLeft = isRight ? (bRect.right - eRect.width) : bRect.left;
    const targetTop = isBottom ? (bRect.bottom - eRect.height) : bRect.top;
    animateValue(previewX, previewX.get() + (targetLeft - eRect.left), { type: "spring", stiffness: 500, damping: 34 });
    animateValue(previewY, previewY.get() + (targetTop - eRect.top), { type: "spring", stiffness: 500, damping: 34 });
  }, [previewX, previewY]);

  const handleEnd = () => {
    hapticHeavy();
    if (isAcceptingCall) cancelAcceptingCall();
    else if (callState === "idle") cancelStartingCall();
    else endCall();
  };

  return (
    // SWIPE-NAV FIX: this screen is a `fixed inset-0` overlay stacked on TOP
    // of AppLayout's <main ref={swipeRef}> (Chat's CallOverlay renders
    // inside Chat, which sits inside that main), not a sibling of it — so
    // touchstart/touchend still bubble up through the DOM to the swipe-nav
    // listener underneath, and a left/right swipe meant to drag the
    // self-preview or dismiss the "more" sheet was instead read as "swipe
    // to Chat/Calls", yanking the person out of an active call. useSwipeNav
    // opts out any element under `[data-swipe-nav-ignore]` for exactly this
    // kind of stacked-overlay case — apply it at the root so nothing inside
    // this screen can ever trigger tab navigation.
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      onClick={wake}
      data-swipe-nav-ignore
      className="fixed inset-0 z-[100] flex flex-col h-[100dvh] bg-call-stage relative">
      {/* Safe-area-padded region the self-preview may be dragged within. */}
      <div ref={dragBoundsRef} className="absolute pointer-events-none" style={{
        top: "calc(env(safe-area-inset-top, 0px) + 8px)",
        right: "calc(env(safe-area-inset-right, 0px) + 8px)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 116px)",
        left: "calc(env(safe-area-inset-left, 0px) + 8px)",
      }} />

      <video ref={remoteVideoRef} autoPlay playsInline onClick={(e) => { e.stopPropagation(); toggleVisible(); }}
        className={`absolute inset-0 w-full h-full object-cover ${(isScreenSharing || isVoiceCall) ? "hidden" : ""}`} />
      <video ref={screenShareRef} autoPlay playsInline onClick={(e) => { e.stopPropagation(); toggleVisible(); }}
        className="absolute inset-0 w-full h-full object-contain bg-black" style={{ display: isScreenSharing ? "block" : "none" }} />

      {/* Minimal cinematic voice-call layout — partner avatar, name,
          duration, nothing else. The remote <video> element stays mounted
          (Daily still needs it for the audio track) but is hidden via
          className, not unmounted. Steps aside automatically the instant
          either party's camera turns on. */}
      <AnimatePresence initial={false}>
        {isVoiceCall && (callUiState === "connected" || callUiState === "reconnecting") && (
          <motion.div key="voice-connected" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={standardTransition}
            className="absolute inset-0 flex flex-col items-center justify-center px-6">
            <span className="relative h-56 w-56 max-w-[62vw] max-h-[62vw] rounded-full overflow-hidden bg-call-stage-foreground/10 flex items-center justify-center">
              {partnerAvatar
                ? <img loading="lazy" decoding="async" src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                : <span className="text-5xl font-serif text-call-stage-foreground/90">{(partnerName || "P").charAt(0).toUpperCase()}</span>}
            </span>
            <span className="sr-only" role="status" aria-live="polite">
              {callUiState === "reconnecting" ? "Reconnecting…" : `Connected, ${formatDuration(callDuration)}`}
            </span>
          </motion.div>
        )}

        {callUiState === "ringing" && (
          <motion.div key="ringing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={standardTransition}
            className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-call-stage-foreground/80">
              <div className="relative h-20 w-20 mx-auto mb-4">
                <motion.span className="absolute inset-0 rounded-full bg-call-stage-foreground/15"
                  animate={{ scale: [1, 1.5], opacity: [0.3, 0] }} transition={{ repeat: Infinity, duration: 1.8, ease: "easeOut" }} aria-hidden="true" />
                <div className="relative h-20 w-20 rounded-full bg-call-stage-foreground/10 flex items-center justify-center overflow-hidden">
                  {isVoiceCall && partnerAvatar
                    ? <img loading="lazy" decoding="async" src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                    : <Phone className="h-8 w-8" />}
                </div>
              </div>
              <p className="text-lg font-serif" role="status" aria-live="polite">Ringing…</p>
              <p className="text-sm opacity-60 mt-1">Waiting for {partnerName || "your partner"} to answer</p>
              {ringHint && <p className="text-xs opacity-50 mt-2 max-w-[260px] mx-auto" role="note">{ringHint}</p>}
            </div>
          </motion.div>
        )}

        {callUiState === "connecting" && (
          <motion.div key="connecting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={standardTransition}
            className="absolute inset-0 flex items-center justify-center bg-call-stage">
            <p className="text-lg font-serif animate-pulse-soft text-call-stage-foreground/80" role="status" aria-live="polite">Connecting...</p>
          </motion.div>
        )}
      </AnimatePresence>

      {callUiState === "partner-left" && <PartnerLeftBanner partnerName={partnerName || "Partner"} />}
      {callUiState === "reconnecting" && !isVoiceCall && <ReconnectingBanner />}
      {callUiState === "connected" && autoAudioFallback && <AudioFallbackBanner />}

      {/* Self-preview — never rendered during a voice call (isVoiceCall is
          already false the instant either side's camera comes on, since
          it's defined as effectiveCallType==="voice" && !isVideoOn — so
          this alone is both the "hide it for voice" and the "bring it
          back the instant video turns on" rule, no extra isVideoOn check
          needed here). */}
      {!isVoiceCall && (
        <motion.div ref={previewRef} drag dragConstraints={dragBoundsRef} dragElastic={0.06} dragMomentum={false}
          onDragEnd={snapPreviewToNearestCorner} whileDrag={{ scale: 1.05 }}
          onClick={(e) => e.stopPropagation()}
          style={{ x: previewX, y: previewY, top: "calc(env(safe-area-inset-top, 0px) + 64px)", right: "calc(env(safe-area-inset-right, 0px) + 8px)" }}
          className="absolute w-20 h-28 rounded-[20px] overflow-hidden shadow-lg ring-1 ring-call-stage-foreground/15 z-10 cursor-grab active:cursor-grabbing">
          {/* MIRROR FIX: the front camera used to render exactly as the
              sensor captured it — un-mirrored — so your own left hand
              showed up on the right, the "backwards" feeling being
              reported. Every native camera app mirrors the FRONT camera's
              preview (matching what you'd see in an actual mirror) while
              leaving the BACK camera un-mirrored (matching what it's
              actually pointed at). facingMode is read straight off the
              live track (see attachTrack/cycleCamera in useDailyCall), so
              this flips automatically and correctly either way. */}
          <video ref={localVideoRef} autoPlay playsInline muted
            style={facingMode === "user" ? { transform: "scaleX(-1)" } : undefined}
            className="w-full h-full object-cover" />
          {!isVideoOn && (
            <div className="absolute inset-0 bg-call-stage/80 flex items-center justify-center">
              <VideoOff className="h-5 w-5 text-call-stage-foreground/60" />
            </div>
          )}
          {/* CAMERA-SWITCH FIX: a flip button lives directly ON the camera
              screen now — right on the self-preview, exactly where a
              front/back toggle belongs, instead of being buried inside
              "More". One tap, no picker, no list of confusingly similar
              lens names — just front vs back, via cycleCamera(). Only
              shown once there's actually more than one camera to switch
              between, and only while video is on (nothing to flip when
              the camera's off). */}
          {isVideoOn && cameras.length > 1 && (
            <button
              // DOUBLE-TAP FIX: this button lives inside a framer-motion
              // `drag` container (the self-preview above). Drag's gesture
              // recognizer starts listening on pointerdown, before a click
              // ever fires — so the FIRST tap here was being consumed as a
              // (near-zero-distance) drag start instead of a click, and only
              // the second tap actually registered as onClick. Stopping
              // propagation at pointerdown/touchstart — not just click —
              // keeps the drag gesture from ever seeing this press, so one
              // tap flips the camera one time.
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); hapticSelection(); void cycleCamera(); }}
              aria-label="Switch to the other camera"
              className="absolute bottom-1 right-1 h-6 w-6 rounded-full bg-call-stage/70 backdrop-blur flex items-center justify-center active:scale-90 transition-transform">
              <SwitchCamera className="h-3.5 w-3.5 text-call-stage-foreground" />
            </button>
          )}
        </motion.div>
      )}

      {/* WhatsApp-style header: minimize / name + lock-and-status / lip
          reading toggle. Same glass-sheet material the app's composer
          tray and dock use — not an ad hoc bg-white/10 blur — so the call
          screen's chrome reads as the SAME material as the rest of the
          app instead of a bespoke one-off. */}
      <motion.div
        animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : -8 }}
        transition={visible ? snappySpring : { duration: 0.15 }}
        style={{ pointerEvents: visible ? "auto" : "none", paddingTop: "calc(env(safe-area-inset-top, 0px) + 18px)" }}
        className="absolute top-0 inset-x-0 z-10 flex items-center justify-between gap-2 px-4">
        <button onClick={(e) => { e.stopPropagation(); hapticSelection(); setIsCallMinimized(true); }}
          aria-label="Minimize call"
          className="h-11 w-11 shrink-0 rounded-full flex items-center justify-center glass-sheet">
          <Minimize2 className="h-4 w-4 text-call-stage-foreground" aria-hidden="true" />
        </button>
        <div className="flex-1 text-center min-w-0">
          <p className="text-lg font-semibold text-call-stage-foreground truncate">{partnerName || "Partner"}</p>
          <p className="flex items-center justify-center gap-1 text-xs text-call-stage-foreground/55">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {callUiState === "connected" || callUiState === "reconnecting"
              ? (callUiState === "reconnecting" ? "Reconnecting…" : formatDuration(callDuration))
              : "End-to-end encrypted"}
          </p>
        </div>
        {/* LIP-READING-ON-VOICE-CALL FIX: reads lip movement off
            remoteVideoRef, which never has a stream on a voice call — the
            button (and the overlay it opens) has no reason to exist there
            and was showing up regardless. */}
        {!isVoiceCall && (
          <button onClick={(e) => { e.stopPropagation(); setShowLipReading(v => !v); wake(); }}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`h-11 w-11 shrink-0 rounded-full flex items-center justify-center transition-colors ${showLipReading ? "bg-success/85" : "glass-sheet"}`}>
            <Captions className="h-4 w-4 text-call-stage-foreground" aria-hidden="true" />
          </button>
        )}
      </motion.div>

      {/* Secondary info row — resolution + screen-sharing badges, video
          calls only (a voice call's minimal layout doesn't need one). */}
      {(!isVoiceCall || isScreenSharing) && (
        <motion.div
          animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : -8 }}
          transition={visible ? snappySpring : { duration: 0.15 }}
          style={{ pointerEvents: visible ? "auto" : "none", top: "calc(env(safe-area-inset-top, 0px) + 72px)" }}
          className="absolute inset-x-0 z-10 flex items-center justify-center gap-2">
          {!isVoiceCall && (
            <div className="glass-sheet rounded-full px-3 py-1 flex items-center gap-1.5">
              <Wifi className="h-3 w-3 text-call-stage-foreground" />
              <span className="text-[11px] text-call-stage-foreground font-medium">{resolutionLabel}</span>
            </div>
          )}
          {isScreenSharing && (
            <div className="bg-primary/80 backdrop-blur-md rounded-full px-3 py-1 flex items-center gap-1.5">
              <Monitor className="h-3 w-3 text-call-stage-foreground" />
              <span className="text-[10px] text-call-stage-foreground font-medium">Sharing</span>
            </div>
          )}
        </motion.div>
      )}

      <AnimatePresence>
        {!isVoiceCall && showLipReading && callState === "joined" && (
          <LipReadingOverlay videoRef={remoteVideoRef} onClose={() => setShowLipReading(false)} />
        )}
      </AnimatePresence>

      {/* Single-row control bar — a glass-DOCK pill, the SAME material and
          alpha the real bottom dock/chat-box (DuoSpaceBottomSurface,
          FloatingDock) uses, so this screen's own "dock" reads as
          consistent with the rest of the app instead of noticeably more
          solid. This used to be .glass-sheet (0.78 base alpha, the
          composer/sheet material) under the theory that it matched "the
          chat composer" — it didn't; the actual chat surface uses
          .glass-dock (0.10 base alpha, near-transparent, picks up colour
          from whatever's behind it) for both the composer+nav shell and
          the standalone dock. Simplified to exactly three icon-only
          buttons in a line: Speaker, Video toggle, End call — End sits
          at the right end, sized and colored to read as the "different"
          action it is. The screen-share button and the "More" (⋯)
          overflow menu — which used to hold audio-output routing,
          camera switch, and picture-in-picture — have been removed from
          this bar; their underlying hooks/state are left untouched so
          nothing else in the call pipeline is affected. */}
      <motion.div
        animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 16 }}
        transition={visible ? snappySpring : { duration: 0.15 }}
        style={{ pointerEvents: visible ? "auto" : "none" }}
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 left-0 right-0 z-10 safe-bottom pb-8 px-4" role="toolbar" aria-label="Call controls">
        <div className="glass-dock rounded-full flex items-center justify-between gap-1 px-2 py-2 max-w-[400px] mx-auto">
          <button onClick={toggleSpeaker}
            aria-label={(audioRoute.supported ? audioRoute.current?.type === "speaker" : speakerOn) ? "Turn off speaker" : "Turn on speaker"}
            aria-pressed={audioRoute.supported ? audioRoute.current?.type === "speaker" : speakerOn}
            className={`h-14 w-14 shrink-0 rounded-full flex items-center justify-center transition-colors ${(audioRoute.supported ? audioRoute.current?.type === "speaker" : speakerOn) ? "bg-primary" : ""}`}>
            {(audioRoute.supported ? audioRoute.current?.type === "speaker" : speakerOn)
              ? <Volume2 className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />
              : <VolumeX className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />}
          </button>

          {/* CAMERA-ON-VOICE-CALL FIX: this button used to render on every
              call, voice included — tapping it mid voice-call called
              toggleVideo() and popped the camera (and self-preview) open
              on what was supposed to be an audio-only call. Voice vs video
              is decided once, by which button (Phone vs Video) started the
              call — see startCall(mode) in Chat.tsx/Calls.tsx — so a voice
              call should never expose a way back into video. */}
          {!isVoiceCall && (
            <button onClick={() => { hapticMedium(); toggleVideo(); wake(); }}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"} aria-pressed={!isVideoOn}
              className={`h-14 w-14 shrink-0 rounded-full flex items-center justify-center transition-colors ${isVideoOn ? "bg-primary" : ""}`}>
              {isVideoOn ? <VideoIcon className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" /> : <VideoOff className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />}
            </button>
          )}

          <button onClick={handleEnd} aria-label="End call"
            className="h-14 w-14 shrink-0 rounded-full bg-destructive flex items-center justify-center shadow-lg">
            <PhoneOff className="h-6 w-6 text-call-stage-foreground" aria-hidden="true" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default CallStage;
