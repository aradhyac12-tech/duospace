import { motion } from "framer-motion";
import { PhoneOff } from "lucide-react";
import { hapticMedium } from "@/lib/haptics";
import type { CallOutcome } from "@/lib/callUiState";
import CallOutcomeScreen from "@/components/calls/CallOutcomeScreen";
import CallStage from "@/components/calls/CallStage";

// ─── CallOverlay ────────────────────────────────────────────────────────────
// Chat's entry point into the in-call UI. Pure presentational wrapper —
// decides WHICH screen to show (outcome / error / the live call) and
// otherwise renders the exact same <CallStage/> the Calls page uses, so
// both call entry points are byte-for-byte identical instead of two
// hand-rolled copies slowly drifting apart. Owns no call/media logic
// itself; call state and mutators come from CallContext (via CallStage) or
// are passed down from Chat.tsx for the bits that are genuinely page-local
// (isStartingCall, endCall, partner info, etc). Renders null when no
// condition applies, so Chat.tsx can mount it unconditionally instead of
// branching with an early return.

interface CallOverlayProps {
  callState: string;
  isStartingCall: boolean;
  callError: string | null;
  leaveCall: () => void;
  cancelStartingCall: () => void;
  endCall: () => void;
  /** True during acceptIncomingCall()'s own pre-join network window — see
   *  CallContext.tsx's acceptCancelledRef comment. Distinct from
   *  isStartingCall (the OUTGOING equivalent): both can leave `callState`
   *  at "idle", so CallStage's hang-up button checks this first rather
   *  than inferring which flow is active from callState alone. */
  isAcceptingCall?: boolean;
  callMode: "video" | "voice";
  partnerAvatar: string | null;
  partnerName: string;
  showLipReading: boolean;
  setShowLipReading: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether this call session has ever had a second participant join —
   *  see callUiState.ts. Distinguishes "partner left" from "still
   *  ringing". */
  everConnected?: boolean;
  /** Terminal outcome (no-answer / cancelled-elsewhere / failed), shown
   *  instead of returning to the chat behind it. leaveCall() is expected
   *  to have already run by the time this is set. */
  outcome?: CallOutcome | null;
  onCallAgain?: () => void;
  onDismissOutcome?: () => void;
}

const CallOverlay = ({
  callState, isStartingCall, callError, leaveCall, cancelStartingCall, endCall,
  isAcceptingCall = false, callMode, partnerAvatar, partnerName,
  showLipReading, setShowLipReading, everConnected = false,
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

  if (callState === "error") {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        role="alert"
        data-swipe-nav-ignore
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
  // both complete. Including isStartingCall/isAcceptingCall here means
  // this whole screen appears the instant the button is tapped/accept is
  // confirmed, and the actual network setup happens behind it instead of
  // in front of it.
  if (isStartingCall || isAcceptingCall || callState === "joined" || callState === "joining") {
    return (
      <CallStage
        isStartingCall={isStartingCall || isAcceptingCall}
        cancelStartingCall={cancelStartingCall}
        endCall={endCall}
        callMode={callMode}
        everConnected={everConnected}
        partnerAvatar={partnerAvatar}
        partnerName={partnerName}
        showLipReading={showLipReading}
        setShowLipReading={setShowLipReading}
      />
    );
  }

  return null;
};

export default CallOverlay;
