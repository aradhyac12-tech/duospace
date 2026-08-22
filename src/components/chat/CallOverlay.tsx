import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, Monitor, MonitorOff, Captions } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { hapticMedium, hapticLight } from "@/lib/haptics";
import { deriveCallUiState } from "@/lib/callUiState";
import type { CallOutcome } from "@/lib/callUiState";
import { ReconnectingBanner, AudioFallbackBanner, PartnerLeftBanner } from "@/components/calls/CallStatusBanner";
import CallOutcomeScreen from "@/components/calls/CallOutcomeScreen";

// ─── CallOverlay ────────────────────────────────────────────────────────────
// Pure presentational component — full-screen call UI, driven by the same
// explicit-state derivation as pages/Calls.tsx (see src/lib/callUiState.ts)
// so both call entry points show identical feedback for identical states
// instead of two hand-rolled "isStartingCall || joining || joined" gates
// slowly drifting apart, which is what this used to be. Owns no call/media
// logic itself; all state and mutators (from useCall() + Chat.tsx's own
// state) are passed as props. Renders null when no condition applies, so
// Chat.tsx can mount it unconditionally instead of branching with an early
// return.

const formatCallDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

interface CallOverlayProps {
  callState: string;
  isStartingCall: boolean;
  callError: string | null;
  leaveCall: () => void;
  cancelStartingCall: () => void;
  endCall: () => void;
  remoteVideoRef: RefObject<HTMLVideoElement>;
  localVideoRef: RefObject<HTMLVideoElement>;
  screenShareRef: RefObject<HTMLVideoElement>;
  isScreenSharing: boolean;
  isVideoOn: boolean;
  isAudioOn: boolean;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  participantCount: number;
  partnerAvatar: string | null;
  partnerName: string;
  callNetworkQuality: string;
  callDuration: number;
  showLipReading: boolean;
  setShowLipReading: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether this call session has ever had a second participant join —
   *  see callUiState.ts. Optional/defaulted so existing call sites don't
   *  break; without it, "partner left" can't be told apart from "still
   *  ringing" (falls back to always showing "ringing"). */
  everConnected?: boolean;
  autoAudioFallback?: boolean;
  /** Terminal outcome (no-answer / cancelled-elsewhere / failed), shown
   *  instead of returning to the chat behind it. leaveCall() is expected
   *  to have already run by the time this is set. */
  outcome?: CallOutcome | null;
  onCallAgain?: () => void;
  onDismissOutcome?: () => void;
}

const CallOverlay = ({
  callState, isStartingCall, callError, leaveCall, cancelStartingCall, endCall,
  remoteVideoRef, localVideoRef, screenShareRef, isScreenSharing,
  isVideoOn, isAudioOn, toggleAudio, toggleVideo, toggleScreenShare,
  participantCount, partnerAvatar, partnerName, callNetworkQuality, callDuration,
  showLipReading, setShowLipReading,
  everConnected = false, autoAudioFallback = false,
  outcome, onCallAgain, onDismissOutcome,
}: CallOverlayProps) => {
  if (outcome && onCallAgain && onDismissOutcome) {
    return (
      <CallOutcomeScreen
        outcome={outcome}
        partnerName={partnerName || "Partner"}
        onCallAgain={onCallAgain}
        onDismiss={onDismissOutcome}
      />
    );
  }

  if (callState==="error") {
    return (
      <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }}
        role="alert"
        className="fixed inset-0 z-[100] flex flex-col h-[100dvh] bg-destructive/10 items-center justify-center gap-4 px-6">
        <div className="text-center space-y-2">
          <PhoneOff className="h-12 w-12 text-destructive mx-auto" />
          <p className="text-base font-semibold text-foreground">Call failed</p>
          {callError && <p className="text-sm text-muted-foreground">{callError}</p>}
        </div>
        <button onClick={() => { hapticMedium(); leaveCall(); }}
          className="h-11 px-6 rounded-full bg-primary text-primary-foreground text-sm font-medium">
          Back to chat
        </button>
      </motion.div>
    );
  }

  // BUG FIX (call latency): this used to gate on callState alone, which
  // only becomes "joining" deep inside joinCall() — itself called only
  // after the create-and-token network call and the call_history insert
  // both complete. The button just showed a "Starting..." label for that
  // entire stretch with no other feedback. Including isStartingCall here
  // means this whole screen (with its own "Connecting..." state below)
  // appears the instant the button is tapped, and the actual network
  // setup happens behind it instead of in front of it.
  if (isStartingCall || callState==="joined" || callState==="joining") {
    const uiState = deriveCallUiState({
      callState: callState as "idle" | "joining" | "joined" | "error",
      isStartingCall, participantCount, everConnected,
      networkQuality: callNetworkQuality as "excellent" | "good" | "fair" | "poor",
    });
    // Phase 2 (visual correction): "controls should hide when not
    // interacting" / "do not make the control panel permanently visible" —
    // previously the top status row and bottom toolbar were always
    // rendered at full opacity for the entire call. Now both fade out
    // after a few seconds of no tap, and any tap on the video surface
    // brings them back. Only active once the call is actually CONNECTED
    // (uiState==="connected") — hiding controls during ringing/connecting
    // would be actively confusing, since there's nothing else to look at
    // yet and no reason to hide the only feedback the user has.
    return <CallOverlayConnected {...{
      uiState, remoteVideoRef, screenShareRef, isScreenSharing, partnerAvatar, partnerName,
      autoAudioFallback, localVideoRef, isVideoOn, callNetworkQuality, callDuration,
      showLipReading, setShowLipReading, callState, isAudioOn, toggleAudio, toggleVideo,
      toggleScreenShare, cancelStartingCall, endCall,
    }} />;
  }

  return null;
};

// Split out so the auto-hide timer (a hook) only runs while this branch is
// actually mounted — CallOverlay itself has early `return`s above it that
// would otherwise violate the rules of hooks if the timer lived directly
// in the parent component.
const CallOverlayConnected = ({
  uiState, remoteVideoRef, screenShareRef, isScreenSharing, partnerAvatar, partnerName,
  autoAudioFallback, localVideoRef, isVideoOn, callNetworkQuality, callDuration,
  showLipReading, setShowLipReading, callState, isAudioOn, toggleAudio, toggleVideo,
  toggleScreenShare, cancelStartingCall, endCall,
}: {
  uiState: string;
  remoteVideoRef: RefObject<HTMLVideoElement>;
  screenShareRef: RefObject<HTMLVideoElement>;
  isScreenSharing: boolean;
  partnerAvatar: string | null;
  partnerName: string;
  autoAudioFallback: boolean;
  localVideoRef: RefObject<HTMLVideoElement>;
  isVideoOn: boolean;
  callNetworkQuality: string;
  callDuration: number;
  showLipReading: boolean;
  setShowLipReading: React.Dispatch<React.SetStateAction<boolean>>;
  callState: string;
  isAudioOn: boolean;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  cancelStartingCall: () => void;
  endCall: () => void;
}) => {
  const CONTROLS_HIDE_MS = 4000;
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const wake = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (uiState === "connected") {
      hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
    }
  };
  useEffect(() => {
    wake();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState]);
  const visible = controlsVisible || uiState !== "connected";

  return (
    <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }}
      onPointerDown={wake}
      className="fixed inset-0 z-[100] flex flex-col h-[100dvh] bg-[hsl(var(--foreground))] relative">
      <video ref={remoteVideoRef} autoPlay playsInline
        className={`absolute inset-0 w-full h-full object-cover ${isScreenSharing?"hidden":""}`} />
      <video ref={screenShareRef} autoPlay playsInline
        className="absolute inset-0 w-full h-full object-contain bg-black" style={{ display:"none" }} />
      {uiState==="ringing" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-background">
            <motion.div animate={{ scale:[1,1.05,1] }} transition={{ repeat:Infinity, duration:2 }}
              className="h-24 w-24 rounded-full bg-background/10 flex items-center justify-center mx-auto mb-5">
              {partnerAvatar ? <img src={partnerAvatar} alt="" className="h-full w-full rounded-full object-cover" /> : <Phone className="h-10 w-10 text-background/60" />}
            </motion.div>
            <p className="text-xl font-medium">{partnerName}</p>
            <p className="text-sm text-background/40 mt-1" role="status" aria-live="polite">Ringing...</p>
          </div>
        </div>
      )}
      {uiState==="partner-left" && <PartnerLeftBanner partnerName={partnerName || "Partner"} />}
      {uiState==="reconnecting" && <ReconnectingBanner />}
      {uiState==="connected" && autoAudioFallback && <AudioFallbackBanner />}
      {uiState==="connecting" && (
        <div className="absolute inset-0 flex items-center justify-center bg-[hsl(var(--foreground))]">
          <p className="text-lg font-medium animate-pulse text-background/60" role="status" aria-live="polite">Connecting...</p>
        </div>
      )}
      <motion.div drag dragMomentum={false} dragElastic={0.1}
        dragConstraints={{ top: 0, left: -260, right: 0, bottom: 500 }}
        className="absolute top-14 right-4 w-[100px] h-[140px] rounded-2xl overflow-hidden shadow-2xl border border-background/10 z-10 cursor-grab active:cursor-grabbing">
        <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        {!isVideoOn && <div className="absolute inset-0 bg-muted flex items-center justify-center"><VideoOff className="h-5 w-5 text-muted-foreground" /></div>}
      </motion.div>
      <AnimatePresence>
        {visible && (
        <motion.div initial={{ opacity:0, y:-8 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-8 }} transition={{ duration:0.18 }}
          className="absolute top-4 left-4 right-28 z-10 flex items-center gap-2 safe-top">
          <div className="glass-sheet rounded-full px-3 py-1.5 flex items-center gap-1.5">
            <div className={`h-1.5 w-1.5 rounded-full ${callNetworkQuality==="excellent"||callNetworkQuality==="good"?"bg-success":callNetworkQuality==="fair"?"bg-warning":"bg-destructive"}`} />
            <span className="text-[11px] text-background/80 font-mono">{formatCallDuration(callDuration)}</span>
          </div>
          {isScreenSharing && <div className="bg-primary/60 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1"><Monitor className="h-3 w-3 text-background" /><span className="text-[10px] text-background">Sharing</span></div>}
          <button onClick={(e) => { e.stopPropagation(); hapticLight(); setShowLipReading(v=>!v); }}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`ml-auto rounded-full px-3 py-1.5 flex items-center gap-1.5 backdrop-blur-md transition-colors ${showLipReading?"bg-success/85":"bg-background/15"}`}>
            <Captions className="h-3.5 w-3.5 text-background" aria-hidden="true" />
            <span className="text-[10px] text-background font-medium">{showLipReading?"Reading":"Lip Read"}</span>
          </button>
        </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showLipReading && callState==="joined" && <LipReadingOverlay videoRef={remoteVideoRef} onClose={() => setShowLipReading(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {visible && (
        <motion.div initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:12 }} transition={{ duration:0.18 }}
          className="absolute bottom-10 left-0 right-0 z-10 safe-bottom" role="toolbar" aria-label="Call controls">
          <div className="flex items-center justify-center gap-4">
            <button onClick={(e) => { e.stopPropagation(); hapticMedium(); toggleAudio(); }}
              aria-label={isAudioOn ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!isAudioOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isAudioOn?"glass-sheet":"bg-destructive"}`}>
              {isAudioOn?<Mic className="h-5 w-5 text-background" aria-hidden="true" />:<MicOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); hapticMedium(); toggleVideo(); }}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!isVideoOn}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isVideoOn?"glass-sheet":"bg-destructive"}`}>
              {isVideoOn?<Video className="h-5 w-5 text-background" aria-hidden="true" />:<VideoOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); hapticMedium(); toggleScreenShare(); }}
              aria-label={isScreenSharing ? "Stop screen share" : "Start screen share"}
              aria-pressed={isScreenSharing}
              className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${isScreenSharing?"bg-primary":"glass-sheet"}`}>
              {isScreenSharing?<MonitorOff className="h-5 w-5 text-background" aria-hidden="true" />:<Monitor className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            {/* "Do not make it easy to accidentally press" — kept visually
                distinct (solid destructive fill, largest control) and now
                also spaced an extra step away from its neighbor (gap-4 →
                effectively ml-4 here) so it's not just another item in an
                evenly-spaced row. */}
            <button onClick={(e) => { e.stopPropagation(); hapticMedium(); if (callState==="idle") cancelStartingCall(); else endCall(); }}
              aria-label="End call"
              className="ml-4 h-14 w-14 rounded-full bg-destructive flex items-center justify-center shadow-lg">
              <PhoneOff className="h-6 w-6 text-background" aria-hidden="true" />
            </button>
          </div>
        </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default CallOverlay;
