import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useDailyCall } from "@/hooks/useDailyCall";
import IncomingCallOverlay from "@/components/IncomingCallOverlay";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { getDeviceId } from "@/lib/deviceId";

/**
 * BUG FIX ("Duplicate DailyIframe instances are not allowed"):
 *
 * Chat.tsx and Calls.tsx each used to call `useDailyCall()` independently —
 * two entirely separate hook instances, each with its own `callRef` and
 * its own `joinInProgressRef` re-entrancy lock. That lock only ever
 * protected against a double-tap *within one page*; it had no way to know
 * about a call object created by the *other* page's instance. Daily's SDK
 * only allows a single `DailyCall` object to exist anywhere on the page at
 * once, so any sequence that left one page's call object alive while the
 * other page tried to create its own (e.g. a call still active on Chat's
 * instance while quickly navigating to Calls and starting a new one before
 * the old instance's teardown had fully settled) threw exactly this error.
 *
 * The fix is to only ever create the hook once, here, and have every
 * consumer share the same instance via context — so there's exactly one
 * `callRef` and one re-entrancy lock for the whole app, and (as a bonus)
 * an active call now survives navigating between Chat and Calls instead of
 * being torn down by whichever page's instance happens to unmount.
 */
type CallContextValue = ReturnType<typeof useDailyCall> & {
  /** Id of the call_history row for the call currently in progress
   *  (either one this device started, or one it accepted). Shared
   *  app-wide for the same reason the underlying Daily call object is —
   *  see below. */
  activeCallId: string | null;
  setActiveCallId: (id: string | null) => void;
  /** True during the brief network window (claim → token → join) after
   *  tapping Accept on an incoming call, before `callState` itself moves
   *  to "joining". Pages use this alongside `callState` to decide whether
   *  to show the full-screen call UI. */
  isAcceptingCall: boolean;
  /**
   * Phase 2 (redesign continuation): "video" | "voice" | null, for the
   * minimal cinematic voice-call layout (see Calls.tsx). Before this, only
   * the CALLER's page-local state tracked which mode a call started in —
   * correct for outgoing calls, but never set at all for an ACCEPTED
   * incoming call, so a receiver joining a voice call had no reliable way
   * to know not to show the video-call chrome. Promoted here (same reason
   * activeCallId was promoted out of page-local state) so both the caller
   * and receiver path can set/read the same value regardless of which
   * page accepted the call. Not derived from `isVideoOn` because a
   * mid-call camera toggle shouldn't retroactively reclassify what kind
   * of call this was.
   */
  activeCallType: "video" | "voice" | null;
  setActiveCallType: (type: "video" | "voice" | null) => void;
};

const CallContext = createContext<CallContextValue | null>(null);

/**
 * BUG FIX (missed incoming calls off the Chat screen):
 *
 * IncomingCallOverlay — and the realtime subscription that powers it —
 * used to be mounted only inside Chat.tsx. That meant a call would only
 * ring, vibrate, and show the answer UI if the person happened to be on
 * the Chat tab; being on Calls, Gallery, Map, Settings, etc. meant the
 * call was silently missed in-app (it would still arrive as a push
 * notification, which is why the notification tap handler forced
 * navigation to /chat — a workaround for this gap, not a fix for it).
 *
 * The overlay itself is now mounted once here, inside CallProvider, which
 * already wraps every protected route and persists across navigation (the
 * same property that made it the right place to dedupe the Daily call
 * object). Accepting/declining now lives here too, so it works regardless
 * of which page is on screen, and `activeCallId` is promoted from
 * page-local state to context so Chat.tsx/Calls.tsx's own `endCall` can
 * still find the right call_history row to close out even when the call
 * was accepted from a different page.
 */
export const CallProvider = ({ children }: { children: ReactNode }) => {
  const call = useDailyCall();
  const { toast } = useToast();
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [isAcceptingCall, setIsAcceptingCall] = useState(false);
  const [activeCallType, setActiveCallType] = useState<"video" | "voice" | null>(null);

  // Reset once the call session is fully over — otherwise a voice call's
  // type would leak into the next call's "connecting…" render before its
  // own setActiveCallType() call (from startCall/acceptIncomingCall) runs.
  useEffect(() => {
    if (call.callState === "idle") setActiveCallType(null);
  }, [call.callState]);

  const acceptIncomingCall = useCallback(async (callId: string, roomUrl: string, callType: string) => {
    if (isAcceptingCall) return; // guard against double-accept (e.g. double-tap)
    // Shared call session guard — protects against accepting a new call
    // while already on one, regardless of which page triggered either call.
    if (call.callState === "joining" || call.callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before accepting a new one." });
      return;
    }
    setIsAcceptingCall(true);
    try {
      // Multi-device claim: atomically wins this call for this device
      // before doing any Daily work, so two devices that both received
      // the incoming push/realtime event can't both join.
      const deviceId = await getDeviceId();
      const { data: claimed, error: claimErr } = await supabase.rpc("claim_call" as any, { _call_id: callId, _device_id: deviceId });
      if (claimErr || claimed !== true) {
        toast({ title: "Call answered elsewhere", description: "This call was already picked up on another device." });
        setIsAcceptingCall(false);
        return;
      }
      const tokenData = await invokeEdgeFunction<{ token: string }>("daily-call",
        { body: { action: "get-token", roomName: roomUrl.split("/").pop() } });
      await call.joinCall(roomUrl, tokenData.token, callType === "voice");
      setActiveCallId(callId);
      setActiveCallType(callType === "voice" ? "voice" : "video");
      toast({ title: "Call connected 📞" });
    } catch (err: unknown) {
      toast({ title: "Couldn't join call", description: extractErrorMessage(err), variant: "destructive" });
    }
    setIsAcceptingCall(false);
  }, [call, isAcceptingCall, toast]);

  const declineIncomingCall = useCallback((_id: string) => {
    toast({ title: "Call declined" });
  }, [toast]);

  // Native call-control bridge (Android Telecom/Bluetooth/car head-unit —
  // see native/android/DuoSpaceConnection.kt). Decoupled from
  // usePushNotifications via a plain window event rather than a direct
  // function reference, since that hook runs outside this provider's
  // subtree (see the comment in usePushNotifications.ts) and this is
  // simpler and safer than restructuring the provider tree to thread the
  // call object upward. Guards against redundant toggles so an OS-reported
  // state that already matches doesn't flip it the wrong way.
  useEffect(() => {
    const handleCallControl = (event: Event) => {
      const detail = (event as CustomEvent).detail as { action?: string } | undefined;
      if (!detail?.action) return;
      if (detail.action === "mute" && call.isAudioOn) call.toggleAudio();
      else if (detail.action === "unmute" && !call.isAudioOn) call.toggleAudio();
      else if (detail.action === "end") call.leaveCall();
    };
    window.addEventListener("duospace-call-control", handleCallControl);
    return () => window.removeEventListener("duospace-call-control", handleCallControl);
  }, [call]);

  const value: CallContextValue = { ...call, activeCallId, setActiveCallId, isAcceptingCall, activeCallType, setActiveCallType };

  return (
    <CallContext.Provider value={value}>
      {children}
      <IncomingCallOverlay onAccept={acceptIncomingCall} onDecline={declineIncomingCall} />
    </CallContext.Provider>
  );
};

export const useCall = (): CallContextValue => {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCall() must be used within a <CallProvider> — it's mounted once in App.tsx around the protected app routes.");
  }
  return ctx;
};
