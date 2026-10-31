import { useState } from "react";
import { Phone, PhoneOff, Video, RotateCcw } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useCall } from "@/contexts/CallContext";
import { useAuth } from "@/hooks/useAuth";
import { useRecoverableCall } from "@/hooks/useRecoverableCall";
import { useToast } from "@/hooks/use-toast";
import { isTerminal } from "@/lib/callStateMachine";

/**
 * Lost-call recovery. `floating` (mounted once in CallProvider) shows on every
 * page — including Chat — whenever a call is still live on the server but this
 * device isn't in it. `inline` is the same card embedded at the top of the
 * Calls page (the floating one hides itself there so there's only ever one).
 */
const RecoverableCallBanner = ({ variant = "floating" }: { variant?: "floating" | "inline" }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { pathname } = useLocation();
  const {
    callState, isAcceptingCall, callMachineState, rejoinCallById, endLostCall,
  } = useCall();
  // Busy = this device is (or is about to be) in a call. The state machine
  // covers the outgoing pre-join window that callState alone doesn't.
  const machineActive = callMachineState.status !== "IDLE" && !isTerminal(callMachineState.status);
  const busy = isAcceptingCall || callState === "joining" || callState === "joined" || machineActive;
  const { call, refresh } = useRecoverableCall({
    userId: user?.id ?? null, busy, refreshKey: `${callState}:${callMachineState.status}`,
  });
  const [working, setWorking] = useState<"rejoin" | "end" | null>(null);

  if (!call) return null;
  if (variant === "floating" && pathname.startsWith("/calls")) return null;

  const calling = call.kind === "calling";
  const onRejoin = async () => {
    setWorking("rejoin");
    const r = await rejoinCallById(call.callId, call.callType, call.direction);
    setWorking(null);
    if (r === "failed") toast({ title: "Couldn't rejoin", description: "The call may have ended. Try again or end it.", variant: "destructive" });
    void refresh();
  };
  const onEnd = async () => {
    setWorking("end");
    await endLostCall(call.callId);
    setWorking(null);
    void refresh();
  };

  const body = (
    <div role="status" data-swipe-nav-ignore
      className="mx-auto max-w-md flex items-center gap-3 rounded-2xl bg-call-stage text-call-stage-foreground shadow-xl px-3 py-2.5">
      <div className="h-9 w-9 rounded-full bg-success/20 flex items-center justify-center shrink-0">
        {call.callType === "video" ? <Video className="h-4 w-4" aria-hidden="true" /> : <Phone className="h-4 w-4" aria-hidden="true" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{calling ? "Your call is still ringing" : "Call still in progress"}</p>
        <p className="text-[11px] opacity-60">{calling ? "Get back to it or cancel" : "You're not on the line — rejoin or end it"}</p>
      </div>
      <button type="button" disabled={working !== null} onClick={onEnd} aria-label={calling ? "Cancel call" : "End call"}
        className="h-10 w-10 rounded-full bg-destructive flex items-center justify-center shrink-0 disabled:opacity-50">
        <PhoneOff className="h-5 w-5" aria-hidden="true" />
      </button>
      <button type="button" disabled={working !== null} onClick={onRejoin} aria-label="Rejoin call"
        className="h-10 px-3 rounded-full bg-success flex items-center gap-1.5 text-sm font-medium shrink-0 disabled:opacity-50">
        <RotateCcw className="h-4 w-4" aria-hidden="true" />{working === "rejoin" ? "Joining…" : "Rejoin"}
      </button>
    </div>
  );
  return variant === "inline"
    ? <div className="px-3 pt-2">{body}</div>
    : <div className="fixed top-0 inset-x-0 z-[90] safe-top px-3 pt-2">{body}</div>;
};

export default RecoverableCallBanner;
