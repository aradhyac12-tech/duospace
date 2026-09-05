import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, ReactNode } from "react";
import { useDailyCall } from "@/hooks/useDailyCall";
import IncomingCallOverlay from "@/components/IncomingCallOverlay";
import MinimizedCallBubble from "@/components/calls/MinimizedCallBubble";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { withTimeout } from "@/lib/withTimeout";
import { loadDailySdk } from "@/hooks/useDailyCall";
import { extractErrorMessage } from "@/lib/errorMessage";
import { getDeviceId } from "@/lib/deviceId";
import { startCallBackgroundSupport, stopCallBackgroundSupport } from "@/lib/callBackgroundSupport";
import { Capacitor } from "@capacitor/core";
import { ensureMediaPermission } from "@/lib/mediaPermissions";

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
  /** Aborts an in-flight acceptIncomingCall() while it's still in the
   *  claim→token network window (before callState leaves "idle" — see
   *  cancelAcceptingCall's own comment). Safe to call at any time;
   *  a no-op once the call has actually joined. */
  cancelAcceptingCall: () => void;
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
  /** WhatsApp-style "minimize call" — set true when either call screen's
   *  minimize button is tapped. Chat.tsx/Calls.tsx each read this (shared
   *  via context, same reason activeCallId/activeCallType are) to fall
   *  back to their normal page content instead of the full-screen call UI,
   *  showing their own small persistent banner instead (using the partner
   *  info/duration each page already fetches locally — not duplicated
   *  here). Reset automatically once the call actually ends, same as
   *  activeCallType above, so the next call always starts un-minimized. */
  isCallMinimized: boolean;
  setIsCallMinimized: (v: boolean) => void;
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
  const [isCallMinimized, setIsCallMinimized] = useState(false);

  // Reset once the call session is fully over — otherwise a voice call's
  // type would leak into the next call's "connecting…" render before its
  // own setActiveCallType() call (from startCall/acceptIncomingCall) runs.
  // isCallMinimized resets alongside it for the same reason: a call
  // minimized right before it ends shouldn't leave the NEXT call starting
  // pre-minimized.
  useEffect(() => {
    if (call.callState === "idle") { setActiveCallType(null); setIsCallMinimized(false); }
  }, [call.callState]);

  // BACKGROUND-TAB RESILIENCE (browsers only — native iOS/Android already
  // handle this via CallKit/Telecom + PushKit/FCM, see
  // native/ios/CallKitManager.swift and native/android/CallBridge.kt):
  // screen wake lock (re-acquired on visibilitychange, since browsers
  // release it automatically on tab-hide) + Media Session metadata/hangup
  // action, so a call backgrounded on mobile web or a desktop tab switch
  // stays alive and hangup-able instead of silently degrading. Keyed off
  // callState alone, not activeCallType, so it starts the instant a call
  // actually connects regardless of which page/flow joined it.
  useEffect(() => {
    if (call.callState === "joined") {
      startCallBackgroundSupport({ callType: activeCallType ?? "voice", onHangup: () => { void call.leaveCall(); } });
    } else {
      stopCallBackgroundSupport();
    }
  }, [call.callState, activeCallType, call.leaveCall]);

  // Idle prefetch of the lazily-loaded Daily SDK. The SDK is no longer in
  // the entry bundle (see useDailyCall's BUNDLE FIX note); warming it during
  // browser idle time right after boot keeps "tap call → ringing" instant
  // without making every first paint download ~600 KB of WebRTC code.
  //
  // CONNECTING-LATENCY FIX: the "daily-call" edge function is the other big
  // contributor to a slow "Connecting…" — Supabase Edge Functions cold-start
  // an isolate on their first invocation after a period of inactivity, and
  // that cold start (up to ~25s, the reason create-and-token/get-token both
  // use a 25s timeout) used to only ever happen on the critical path, in
  // front of the very first call of a session. Firing one throwaway request
  // at it during the same idle window pays that cold-start cost ahead of
  // time instead of while the person is staring at "Connecting…". Any
  // action name works for this — it's here purely to wake the function's
  // container, not to do real Daily API work — and the resulting 400
  // ("Unknown action") is expected and discarded.
  useEffect(() => {
    const warm = () => {
      void loadDailySdk();
      invokeEdgeFunction("daily-call", { body: { action: "warm" }, timeoutMs: 25_000 }).catch(() => {});
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback!(warm, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(warm, 3000);
    return () => clearTimeout(t);
  }, []);

  // ROOT-CAUSE FIX (Calls.tsx "End call" during accept did nothing real):
  // Calls.tsx's in-call screen renders as soon as `isAcceptingCall` is true
  // — before `callState` ever leaves "idle", since joinCall() below isn't
  // even called until AFTER claim_call + get-token both resolve (each a
  // real network round trip, up to 25s on a cold-started edge function).
  // The screen's hang-up button, though, decided which cancel path to use
  // by checking `callState === "idle"` alone — which is ALSO true during
  // isStartingCall's pre-join window (the outgoing-call case that check was
  // actually written for). So tapping "End call" while ACCEPTING routed to
  // Calls.tsx's page-local `cancelStartingCall()`, built for the outgoing
  // flow: it set a ref this function never reads, called `leaveCall()`
  // (harmless here since nothing's joined yet), and showed "Call
  // cancelled" — but nothing stopped the accept's own in-flight
  // claim_call/get-token/joinCall chain from continuing in the background.
  // The call would then actually connect a few seconds later, silently
  // re-showing the full-screen call UI (`callState === "joined"` alone
  // satisfies Calls.tsx's screen gate) even though the person was told it
  // was cancelled.
  //
  // Fixed with a dedicated ref checked at both await boundaries below,
  // exactly the same pattern Calls.tsx's own startCall() already uses for
  // its own cancellation window (callCancelledRef) — this is that same
  // fix, just for the accept side, which never had it.
  const acceptCancelledRef = useRef(false);

  const acceptIncomingCall = useCallback(async (callId: string, roomUrl: string, callType: string) => {
    if (isAcceptingCall) return; // guard against double-accept (e.g. double-tap)
    // Shared call session guard — protects against accepting a new call
    // while already on one, regardless of which page triggered either call.
    if (call.callState === "joining" || call.callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before accepting a new one." });
      return;
    }
    acceptCancelledRef.current = false;
    setIsAcceptingCall(true);
    // VOICE/VIDEO UI FIX: previously only set once joinCall() below had
    // already resolved — but CallStage renders (via isAcceptingCall) the
    // instant Accept is tapped, long before that. In between, it fell back
    // to the page's own page-local `callMode` (Chat.tsx/Calls.tsx), which
    // is only ever updated by an OUTGOING call and defaults to "video" —
    // so accepting an incoming VOICE call showed full video-call chrome
    // (self-preview camera box, no voice-call layout) for the whole
    // claim→token→join window. Setting it here, from the callType we
    // already know the instant accept happens, makes the receiver's screen
    // correct from the first frame, matching the caller's own path (which
    // already sets this immediately in startCall()).
    setActiveCallType(callType === "voice" ? "voice" : "video");
    // STUCK-FOREVER SAFETY NET (see Calls.tsx/Chat.tsx's startCall for the
    // full reasoning — this is the same fix for the accept side, which
    // never had it): the claim/token/join sequence below has real
    // per-step timeouts (see the withTimeout and invokeEdgeFunction calls
    // in it), but this is a last-resort backstop for anything neither
    // catches, so a hang here can't leave isAcceptingCall true — and the
    // full-screen call UI on "Connecting…" — forever with nothing to
    // break it out. Cleared as soon as this function actually finishes.
    const acceptWatchdog = setTimeout(() => {
      if (acceptCancelledRef.current) return;
      acceptCancelledRef.current = true;
      call.leaveCall();
      setIsAcceptingCall(false);
      toast({ title: "Couldn't join call", description: "That took too long to connect. Check your connection and try again.", variant: "destructive" });
    }, 40_000);
    try {
      // Multi-device claim: atomically wins this call for this device
      // before doing any Daily work, so two devices that both received
      // the incoming push/realtime event can't both join.
      const deviceId = await getDeviceId();
      // LATENCY FIX (accept-side was the one call-setup path that never
      // got the caller-side treatment — see Calls.tsx's "create-and-token"
      // comment for that half): claim_call and get-token don't actually
      // depend on each other's result. get-token only needs the roomUrl
      // we were already handed with the incoming call, and claim_call only
      // needs deviceId — neither reads the other's response. Running them
      // sequentially was paying for two full network round trips (RPC +
      // edge function, each potentially a cold start up to 25s) stacked in
      // front of joinCall(), on top of the actual WebRTC join. Firing both
      // at once overlaps that latency instead of adding it up. If we lose
      // the claim, the token fetched in parallel is simply discarded — an
      // unused Daily token has no side effects to undo.
      // STUCK-FOREVER FIX: raw `supabase.rpc()` (claim_call) has no
      // timeout of its own, unlike invokeEdgeFunction (get-token) below —
      // and because both sides of this Promise.all must settle before
      // either result is usable, a hung claim_call would block the ENTIRE
      // accept even though get-token itself would have failed fast at
      // 25s. Unlike the busy-check in startCall(), this result actually
      // matters (we need to know if we won the claim), so a timeout here
      // is surfaced as a real failure rather than silently assumed.
      const [claimResult, tokenData] = await Promise.all([
        withTimeout(
          supabase.rpc("claim_call" as any, { _call_id: callId, _device_id: deviceId }),
          15_000, "Call claim",
        ),
        // CONNECT-RELIABILITY FIX: 25s for the cold-start edge function path
        // (see Calls.tsx's matching comment) — the 15s default could fail an
        // incoming-call accept that was actually just a slow cold start.
        invokeEdgeFunction<{ token: string }>("daily-call",
          { body: { action: "get-token", roomName: roomUrl.split("/").pop() }, timeoutMs: 25_000 }),
      ]);
      const { data: claimed, error: claimErr } = claimResult;
      if (claimErr || claimed !== true) {
        clearTimeout(acceptWatchdog);
        toast({ title: "Call answered elsewhere", description: "This call was already picked up on another device." });
        setIsAcceptingCall(false);
        return;
      }
      if (acceptCancelledRef.current) {
        // Cancelled while claim_call/get-token were in flight. We already
        // own the claim (claimed_by = us), so decline_call() won't touch
        // this row (it requires claimed_by IS NULL) — end it directly
        // instead, the same way endCall() closes out its own row, via the
        // receiver-side UPDATE the RLS policy already allows
        // (`auth.uid() = receiver_id`). Best-effort: a failure here just
        // leaves a claimed-but-never-ended row for the ring-expiry sweep to
        // close out later, not a crash.
        clearTimeout(acceptWatchdog);
        await supabase.from("call_history").update({
          status: "missed", ended_at: new Date().toISOString(), declined_at: new Date().toISOString(),
        } as never).eq("id", callId).eq("status", "in_progress").then(() => {}).catch(() => {});
        return;
      }
      // From here on, joinCall()'s own join watchdog (useDailyCall.ts,
      // 25s) covers the rest of the path to "joined" — this function's
      // own backstop's job (guarding the claim/token window above) is done.
      clearTimeout(acceptWatchdog);
      // BUG FIX (camera never opens accepting a native video call) — same
      // root cause as the outgoing side (see Calls.tsx's
      // requestMediaPermission): a bare getUserMedia({video:true}) inside
      // Daily's own join() never triggers the OS camera-permission prompt
      // inside a Capacitor WebView, so accepting a video call on native
      // joined with the camera silently stuck on "not granted" forever.
      // This only touches Capacitor's native permission bridge (no
      // getUserMedia stream opened), so it can't race PeekGuard/cameraBus
      // for the camera device — safe to fire right before joinCall().
      // Best-effort: if it's denied, joinCall() still proceeds and the
      // existing call-error handling (classifyCallError/CallErrorScreen)
      // surfaces that same as any other join failure.
      if (callType !== "voice" && Capacitor.isNativePlatform()) {
        await ensureMediaPermission("camera").catch(() => {});
      }
      await call.joinCall(roomUrl, tokenData.token, callType === "voice");
      if (acceptCancelledRef.current) {
        // Cancelled in the narrow window while joinCall() itself was
        // resolving — the call object now exists, so this time the real
        // hang-up path (leaveCall, not a DB update) is what actually stops
        // it from staying connected.
        call.leaveCall();
        await supabase.from("call_history").update({
          status: "completed", ended_at: new Date().toISOString(),
        } as never).eq("id", callId).eq("status", "in_progress").then(() => {}).catch(() => {});
        return;
      }
      setActiveCallId(callId);
      setActiveCallType(callType === "voice" ? "voice" : "video");
      toast({ title: "Call connected 📞" });
    } catch (err: unknown) {
      clearTimeout(acceptWatchdog);
      toast({ title: "Couldn't join call", description: extractErrorMessage(err), variant: "destructive" });
    }
    clearTimeout(acceptWatchdog);
    setIsAcceptingCall(false);
  }, [call, isAcceptingCall, toast]);

  // Companion to acceptIncomingCall's own cancellation checks above — sets
  // the ref those checks read, drops the UI out of the "accepting" screen
  // immediately (not waiting for the in-flight network call to notice), and
  // tears down anything that may have already joined. Idempotent/safe to
  // call more than once or after the call has already connected normally.
  const cancelAcceptingCall = useCallback(() => {
    acceptCancelledRef.current = true;
    call.leaveCall();
    setIsAcceptingCall(false);
    toast({ title: "Call cancelled" });
  }, [call, toast]);

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

  const value: CallContextValue = useMemo(() => ({
    ...call, activeCallId, setActiveCallId, isAcceptingCall, cancelAcceptingCall, activeCallType, setActiveCallType, isCallMinimized, setIsCallMinimized,
  }), [call, activeCallId, setActiveCallId, isAcceptingCall, cancelAcceptingCall, activeCallType, setActiveCallType, isCallMinimized, setIsCallMinimized]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <IncomingCallOverlay onAccept={acceptIncomingCall} onDecline={declineIncomingCall} />
      <MinimizedCallBubble />
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
