import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, ReactNode } from "react";
import { useCallEngine } from "@/lib/callEngine/useCallEngine";
import IncomingCallOverlay from "@/components/IncomingCallOverlay";
import MinimizedCallBubble from "@/components/calls/MinimizedCallBubble";
import { supabase } from "@/integrations/supabase/appClient";
import { useToast } from "@/hooks/use-toast";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { withTimeout } from "@/lib/withTimeout";
import { loadLiveKitSdk } from "@/lib/callEngine/SelfHostedCallEngineAdapter";
import { logWarn } from "@/lib/telemetry";
import { isServerAccepted, type RejectReason, type SignalingMessage } from "@/lib/signalingEngine/types";
import { awaitCallMedia, mediaFailureMessage, RECEIVER_PARTICIPANT_TIMEOUT_MS } from "@/lib/callEngine/awaitCallMedia";
import { extractErrorMessage } from "@/lib/errorMessage";
import { getDeviceId } from "@/lib/deviceId";
import { startCallBackgroundSupport, stopCallBackgroundSupport } from "@/lib/callBackgroundSupport";
import { beginTrace as beginCallLatencyTrace, mark as markCallLatency, finishTrace as finishCallLatencyTrace } from "@/lib/callLatency";
import { classifyCallError } from "@/lib/callErrors";
import { useAuth } from "@/hooks/useAuth";
import { ToastAction } from "@/components/ui/toast";
import { useCallSignalingBridge } from "@/lib/signalingEngine/callSignalingBridge";
import { pauseCameraConsumers } from "@/lib/cameraBus";
import { Capacitor } from "@capacitor/core";
import { ensureMediaPermission } from "@/lib/mediaPermissions";
import { reportCallNowConnected, reportCallEndedNative } from "@/lib/nativeCallReporting";
import { persistActiveCallSession, clearActiveCallSession, readActiveCallSession } from "@/lib/callSessionRecovery";
import {
  reduceCallMachine, initialCallMachineState, isCurrentGeneration, isCurrentCall, isTerminal,
  type CallMachineState,
} from "@/lib/callStateMachine";

/**
 * BUG FIX ("Duplicate call-object instances are not allowed"):
 *
 * Chat.tsx and Calls.tsx each used to call the call engine adapter independently —
 * two entirely separate hook instances, each with its own `callRef` and
 * its own `joinInProgressRef` re-entrancy lock. That lock only ever
 * protected against a double-tap *within one page*; it had no way to know
 * about a call object created by the *other* page's instance. The call engine's SDK
 * only allows a single call object to exist anywhere on the page at
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
type CallContextValue = ReturnType<typeof useCallEngine> & {
  /** Id of the call_history row for the call currently in progress
   *  (either one this device started, or one it accepted). Shared
   *  app-wide for the same reason the underlying the call engine call object is —
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
  /**
   * Race-safety layer (see src/lib/callStateMachine.ts). CallProvider's own
   * accept flow, IncomingCallOverlay (ring/decline/cancel/missed), and
   * Calls.tsx's outgoing-call flow (startCall/endCall) all dispatch into
   * this same shared instance — one machine per device for the whole call
   * lifecycle, not a per-component notion of "what's happening right now".
   * Exposed read-only/dispatch-only here for any further call surface that
   * still tracks its own local ad hoc state to adopt incrementally.
   */
  callMachineState: CallMachineState;
  dispatchCallEvent: (event: Parameters<typeof reduceCallMachine>[1]) => CallMachineState;
  /** REMEDIATION (calling phase 3) — see callSignalingBridge.ts's own doc
   *  comment. Dormant unless a signaling server is actually configured
   *  (VITE_SIGNALING_URL); exposed here so Calls.tsx/Chat.tsx's outgoing
   *  flow can send CALL_INVITE/CALL_CANCEL without a second bridge
   *  instance. */
  signalingBridge: ReturnType<typeof useCallSignalingBridge>;
  /** PHASE 4 — after a page's own endCall/cancel/hang-up has done the
   *  authoritative call_history write, tell the OTHER side over the
   *  signaling layer (CANCELLED while ringing, ENDED once connected) so
   *  it tears its side down without waiting for a database change to
   *  round-trip through Realtime. No-op for the call engine and when signaling
   *  isn't configured. `connected` = the call had actually been
   *  answered. Fire-and-track: the outcome is retried/logged inside the
   *  signaling client, never silently dropped. */
  signalCallTerminated: (callId: string | null | undefined, hint: { connected: boolean }) => void;
  /** PHASE 4 — caller-side cancel of a still-ringing self-hosted call:
   *  cancel_call() FIRST (the atomic authority — it refuses once the
   *  callee has claimed), then CALL_CANCELLED over the socket. If the
   *  callee already accepted, the stale cancel is converted into an END
   *  instead. Returns whether the DB cancel won. */
  cancelOutgoingCall: (callId: string, reason?: string) => Promise<boolean>;
  /** Immediate hang-up: media/UI down now, peer told now, history finalized
   *  in the background (guarded write). */
  hangUpCall: (callId: string | null | undefined, opts?: { onHistoryWritten?: () => void }) => void;
};

const CallContext = createContext<CallContextValue | null>(null);

/** Bounded wait for an authenticated+registered signaling socket before
 *  CALL_ACCEPTED (covers cold start / reconnect backoff). */
export const SIGNALING_ACCEPT_READY_TIMEOUT_MS = 8_000;
/** Bounded wait for the gateway to ACK CALL_ACCEPTED (with same-msgId retries). */
export const SIGNALING_ACCEPT_ACK_DEADLINE_MS = 8_000;
/** Last-resort backstop for the whole accept (claim + signaling + token + connect + media). */
const ACCEPT_WATCHDOG_MS = 60_000;
/** Gateway refusals that mean "this call is already over" (not a transport problem). */
export const ACCEPT_CALL_OVER_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "CALL_TERMINAL", "SESSION_MISMATCH", "UNKNOWN_CALL", "OFFER_EXPIRED",
]);

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
 * same property that made it the right place to dedupe the call engine call
 * object). Accepting/declining now lives here too, so it works regardless
 * of which page is on screen, and `activeCallId` is promoted from
 * page-local state to context so Chat.tsx/Calls.tsx's own `endCall` can
 * still find the right call_history row to close out even when the call
 * was accepted from a different page.
 */
export const CallProvider = ({ children }: { children: ReactNode }) => {
  // Phase 1 calling-architecture migration: was the call engine adapter directly.
  // useCallEngine() resolves to the call engine adapter by default (still
  // literally the call engine adapter under the hood, unchanged) or
  // SelfHostedCallEngineAdapter when explicitly opted in — see
  // src/lib/callProviderConfig.ts. See docs/calling-architecture-v2.md.
  const call = useCallEngine();
  const { user } = useAuth();
  // REMEDIATION (calling phase 3): one signaling bridge per authenticated
  // session — see callSignalingBridge.ts's own doc comment for why this
  // is safe to hold even though it's completely dormant in every
  // deployment today (no signaling server configured anywhere yet).
  // Exposed via context (`signalingBridge` in the value object below) so
  // Calls.tsx/Chat.tsx can send CALL_INVITE/CALL_CANCEL from the outgoing
  // side without each needing their own bridge instance.
  const signalingBridge = useCallSignalingBridge(user?.id);

  // PHASE 4 PREWARMING (self-hosted only; the call engine has its own warm-up below).
  // A callee can only be rung over a socket that already exists, and a
  // caller shouldn't pay ticket-fetch + TLS + handshake between tapping
  // Call and the invite. So for the self-hosted provider: open the
  // signaling socket as soon as the user is signed in, and — in browser idle
  // time — load the LiveKit SDK chunk and wake the livekit-token isolate.
  // Deliberately NOT done: no microphone/camera/permission request, no
  // fake call_history row, no LiveKit connection, no long-lived media
  // credential (the token warm-up is an empty request that fails 400
  // after auth, minting nothing).
  useEffect(() => {
    if (!user?.id) return;
    signalingBridge.prewarm();
    const warm = () => {
      void loadLiveKitSdk().catch(() => {});
      invokeEdgeFunction("livekit-token", { body: {}, timeoutMs: 25_000 }).catch(() => {});
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(warm, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(warm, 3000);
    return () => clearTimeout(t);
  }, [call.activeProvider, user?.id, signalingBridge]);
  const { toast } = useToast();
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [isAcceptingCall, setIsAcceptingCall] = useState(false);
  const [activeCallType, setActiveCallType] = useState<"video" | "voice" | null>(null);
  const [isCallMinimized, setIsCallMinimized] = useState(false);

  // ---- PHASE 4: self-hosted call-control over the signaling layer ----------
  const activeProviderRef = useRef(call.activeProvider);
  activeProviderRef.current = call.activeProvider;
  const activeCallIdRef = useRef<string | null>(null);
  activeCallIdRef.current = activeCallId;

  const signalCallTerminated = useCallback((callId: string | null | undefined, hint: { connected: boolean }) => {
    if (!callId) return;
    void signalingBridge.terminate(callId, hint).then((r) => {
      if (!isServerAccepted(r) && r.status !== "QUEUED") {
        logWarn("call.signaling", "terminate_not_confirmed", { status: r.status, connected: hint.connected });
      }
    });
  }, [signalingBridge]);

  const cancelOutgoingCall = useCallback(async (callId: string, reason = "caller_cancelled"): Promise<boolean> => {
    let cancelled = false;
    try {
      const { data } = await supabase.rpc("cancel_call" as any, { _call_id: callId, _reason: reason });
      cancelled = data === true;
    } catch { /* fall through: treated as "not cancelled" */ }
    {
      if (cancelled) void signalingBridge.cancel(callId);
      // cancel_call() refused: the callee already claimed (or the call is
      // already over). A CANCELLED must never destroy a connected call, so
      // this becomes an END, which the gateway only accepts for an
      // accepted call.
      else void signalingBridge.terminate(callId, { connected: true });
    }
    return cancelled;
  }, [signalingBridge]);


  // RACE-SAFETY LAYER (generation-ID state machine — see
  // src/lib/callStateMachine.ts for the full rationale). This does NOT
  // replace isAcceptingCall/acceptCancelledRef/acceptLockRef below — those
  // already correctly guard the cases they were written for, and are left
  // untouched. What this adds is a single, explicit generation counter
  // that the accept flow's async steps (claim, token) can check against
  // *after* they resolve: if a newer call/attempt has started in the
  // meantime, the stale result is a no-op even in a scenario the
  // per-purpose refs don't individually cover (e.g. a future code path
  // that starts a second accept attempt without going through
  // acceptLockRef). A ref mirrors the reducer state so in-flight async
  // code always reads the latest generation synchronously, the same
  // pattern acceptCancelledRef/acceptLockRef already use — React state
  // alone updates only on the next render, which is too late for a
  // check made mid-async-function.
  const machineRef = useRef<CallMachineState>(initialCallMachineState);
  const [machineVersion, setMachineVersion] = useState(0);
  const dispatchCall = useCallback((event: Parameters<typeof reduceCallMachine>[1]) => {
    const next = reduceCallMachine(machineRef.current, event);
    if (next !== machineRef.current) {
      machineRef.current = next;
      setMachineVersion((v) => v + 1); // only re-render on an actually-accepted transition
    }
    return next;
  }, []);

  // Reset once the call session is fully over — otherwise a voice call's
  // type would leak into the next call's "connecting…" render before its
  // own setActiveCallType() call (from startCall/acceptIncomingCall) runs.
  // isCallMinimized resets alongside it for the same reason: a call
  // minimized right before it ends shouldn't leave the NEXT call starting
  // pre-minimized.
  const prevDailyStateRef = useRef(call.callState);
  useEffect(() => {
    const prevDailyState = prevDailyStateRef.current;
    prevDailyStateRef.current = call.callState;
    if (call.callState === "idle") {
      setActiveCallType(null);
      setIsCallMinimized(false);
      // Bring the state machine back to IDLE too, but only in two cases:
      //   1. it's already sitting in a terminal state (DECLINED/CANCELLED/
      //      .../ENDED) from one of the explicit dispatches above, or
      //   2. The call engine's own callState just made a genuine joining/joined/error
      //      -> idle EDGE transition (a real leaveCall()/hang-up), tracked
      //      via prevDailyStateRef so this only fires on the actual
      //      transition, not on every render while callState just HAPPENS
      //      to already be "idle" — which is also true for the entire
      //      ACCEPTING/claim/token window (joinCall() hasn't run yet), and
      //      resetting the machine mid-accept would wrongly cancel it.
      // This covers call-ending paths outside acceptIncomingCallImpl
      // (e.g. Calls.tsx/Chat.tsx's own endCall() calling call.leaveCall()
      // directly) that don't dispatch ENDED themselves — without that,
      // the machine could be stranded in CONNECTED forever after a call
      // ended through one of those paths, and the NEXT accept's
      // `if (isTerminal(...) || status !== "IDLE") dispatchCall(RESET)`
      // guard would just paper over it a call late rather than fix it here.
      const genuineHangUp = prevDailyState !== "idle" && call.callState === "idle";
      if (isTerminal(machineRef.current.status) || (genuineHangUp && machineRef.current.status !== "IDLE")) {
        dispatchCall({ type: "RESET", source: "call-ended-cleanup" });
      }
    }
  }, [call.callState, dispatchCall]);

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

  // Idle prefetch of the lazily-loaded LiveKit SDK, plus one throwaway
  // request to the livekit-token edge function so its isolate cold start
  // (up to tens of seconds) is paid during idle time instead of in front of
  // the first call's "Connecting…". The 400 ("callId is required") is
  // expected and discarded.
  useEffect(() => {
    const warm = () => {
      void loadLiveKitSdk();
      invokeEdgeFunction("livekit-token", { body: {}, timeoutMs: 25_000 }).catch(() => {});
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback!(warm, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(warm, 3000);
    return () => clearTimeout(t);
  }, []);

  // rejoinRecoveredCall is defined further down (needs dispatchCall/
  // machineRef, declared below) but the mount effect right after this
  // needs a stable reference to call it from — a ref bridges the two
  // without reordering this whole file's declaration order around a
  // fairly rare code path.
  const rejoinRecoveredCallRef = useRef<((session: NonNullable<ReturnType<typeof readActiveCallSession>>, opts?: { finalizeOnFailure?: boolean }) => Promise<"connected" | "stale" | "failed">) | null>(null);
  // Auto-recovery bookkeeping for a mid-call media drop (see the
  // MID-CALL DROP RECOVERY effect below). `cancelled` is flipped by every
  // user-initiated hang-up so an in-flight retry loop stops immediately.
  const autoRecoverRef = useRef<{ callId: string | null; cancelled: boolean }>({ callId: null, cancelled: false });

  // ACCIDENTAL-CLOSE RECOVERY FIX: see src/lib/callSessionRecovery.ts's own
  // doc comment for the full "why" — this is the other half, the actual
  // recovery prompt on relaunch. Runs once per mount (CallProvider mounts
  // once for the whole authenticated app, right after login — same
  // lifetime as everything else in this effect group above). Never trusts
  // the local marker alone: re-checks the call_history row server-side
  // first, since the marker surviving doesn't mean the call is still
  // live — the other side may have hung up, declined, or the call may
  // simply have ended normally with this device's own end-of-call cleanup
  // failing to fire (app killed mid-teardown). Only a row still genuinely
  // 'in_progress' with no ended_at gets a rejoin offer; anything else just
  // clears the stale marker silently.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const session = readActiveCallSession();
      if (!session) return;
      const { data: row } = await supabase
        .from("call_history")
        .select("id,status,ended_at,caller_id,receiver_id")
        .eq("id", session.callId)
        .maybeSingle();
      if (cancelled) return;
      const stillLive = row && (row as any).status === "in_progress" && !(row as any).ended_at
        && ((row as any).caller_id === user.id || (row as any).receiver_id === user.id);
      if (!stillLive) {
        clearActiveCallSession();
        return;
      }
      // RECOVERY-TOAST FIX: Radix closes a toast when its action is tapped,
      // which fires onOpenChange(false) — the handler below used to treat
      // that exactly like a dismissal and mark the call 'cancelled' + wipe
      // the recovery marker in the same tick the Rejoin started, so Rejoin
      // could never work. The flag separates "tapped Rejoin" from "ignored".
      let rejoinTapped = false;
      toast({
        title: "You have a call in progress",
        description: `Reconnect to your ${session.callType} call with ${session.partnerName}?`,
        duration: 30_000,
        action: (
          <ToastAction
            altText="Rejoin call"
            onClick={() => { rejoinTapped = true; void rejoinRecoveredCallRef.current?.(session); }}
          >
            Rejoin
          </ToastAction>
        ),
        // Dismissing (swipe/timeout, not the Rejoin tap) without acting
        // still leaves an abandoned 'in_progress' row and a partner who may
        // still be sitting in the room — end it properly rather than
        // leaving it to whatever the ring-expiry sweep eventually catches
        // (that sweep is currently scoped to unclaimed rows only, so a
        // claimed-and-abandoned row like this one wouldn't be caught at
        // all otherwise).
        onOpenChange: (open) => {
          if (open || rejoinTapped) return;
          clearActiveCallSession();
          supabase.from("call_history").update({
            status: "cancelled", cancel_reason: "recovery_prompt_dismissed", ended_at: new Date().toISOString(),
          } as never).eq("id", session.callId).eq("status", "in_progress").then(() => {}).catch(() => {});
        },
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per user login, not on every toast/dispatchCall identity change
  }, [user?.id]);

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
  // DEFENSE-IN-DEPTH FIX: `isAcceptingCall` below has the same
  // state-vs-ref timing gap as Calls.tsx's startCallLockRef (see its
  // comment for the full mechanism) — a fast double-tap on Accept can
  // invoke this function twice before React re-renders. The server-side
  // `claim_call` RPC is a genuine atomic compare-and-swap
  // (`WHERE claimed_by IS NULL`), so this is NOT a correctness gap the
  // way the equivalent one in Calls.tsx was — at most one of the two
  // concurrent claims can ever win. Without this ref, though, a self
  // double-tap still fires a second wasted get-token request and shows a
  // confusing "Call answered elsewhere" toast for what was just one
  // person tapping twice. Cheap to close the same way.
  const acceptLockRef = useRef(false);

  // ROOT-CAUSE FIX ("can't pick up / keeps ringing / lags"): `call` is a brand
  // new object on EVERY render (useCallEngine returns `{ ...engine,
  // activeProvider }`, and the call engine adapter itself re-renders on every media/
  // network tick), so a useCallback keyed on `call` — as this and
  // acceptIncomingCallImpl below were — got a new identity every render. That
  // identity is what IncomingCallOverlay receives as `onAccept`, and it was in
  // the dependency list of that component's subscribe/cold-start-poll effect,
  // so the effect tore down and re-ran on every CallProvider render: it
  // re-subscribed the realtime channels, stopped the ringtone/vibration, and —
  // through the cold-start poll — found the call still 'in_progress' and
  // re-hydrated it, i.e. RE-RANG and RE-SHOWED the incoming screen right after
  // Accept was tapped. Reading the latest values through refs instead keeps
  // this callback's identity stable for the whole session while it still
  // always sees fresh state.
  const callRef = useRef(call);
  callRef.current = call;
  const isAcceptingCallRef = useRef(isAcceptingCall);
  isAcceptingCallRef.current = isAcceptingCall;
  const acceptImplRef = useRef<((callId: string, roomUrl: string, callType: string) => Promise<void>) | null>(null);

  const acceptIncomingCall = useCallback(async (callId: string, roomUrl: string, callType: string) => {
    if (isAcceptingCallRef.current) return; // guard against double-accept (e.g. double-tap)
    if (acceptLockRef.current) return; // see acceptLockRef's comment above — the actual synchronous guard
    // Shared call session guard — protects against accepting a new call
    // while already on one, regardless of which page triggered either call.
    const currentCall = callRef.current;
    if (currentCall.callState === "joining" || currentCall.callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before accepting a new one." });
      return;
    }
    acceptLockRef.current = true;
    try {
      await acceptImplRef.current?.(callId, roomUrl, callType);
    } finally {
      acceptLockRef.current = false;
    }
  }, [toast]);

  // True whenever no accept flow is mid-flight (read by the watchdog/cleanup paths).
  const acceptFlowDoneRef = useRef(true);

  // Per-attempt token for the accept flow. NOTE: the state machine's
  // `generation` is NOT usable for this — it increments on EVERY accepted
  // transition, so capturing it at ACCEPT_TAPPED and re-checking after
  // CLAIM_WON/CONNECTING always reported the attempt as stale, which tore
  // down every accepted call right after it joined LiveKit (P0). This token
  // only changes when a NEW accept attempt starts or the current one is
  // cancelled.
  const acceptAttemptRef = useRef(0);

  /**
   * Make sure this device can send CALL_ACCEPTED for `callId` RIGHT NOW:
   * signaling socket authenticated + registered, and the call's session
   * (callId + authoritative session_id + caller) known to the client.
   * Never relies on an earlier prewarm / overlay registration — on a cold
   * launch, a push/native accept, a killed process or a reconnecting
   * socket those may not have happened (or were dropped because the
   * runtime signaling URL wasn't loaded yet).
   */
  const ensureSignalingForIncoming = useCallback(async (callId: string, callType: string): Promise<{ ready: boolean; reason?: string }> => {
    const r = await signalingBridge.ensureReady({ timeoutMs: SIGNALING_ACCEPT_READY_TIMEOUT_MS });
    if (!r.ready) return { ready: false, reason: r.reason ?? "NOT_READY" };
    if (signalingBridge.getSession(callId)) return { ready: true };
    try {
      const { data } = await withTimeout(
        supabase.from("call_history").select("caller_id, session_id, provider").eq("id", callId).maybeSingle() as unknown as Promise<{ data: unknown }>,
        8_000, "Call session lookup",
      );
      const row = data as { caller_id: string; session_id: string | null; provider: string | null } | null;
      if (!row?.session_id || row.provider !== "self_hosted") return { ready: false, reason: "NO_SESSION" };
      signalingBridge.registerIncoming({ callId, sessionId: row.session_id, peerId: row.caller_id, callType: callType === "voice" ? "voice" : "video" });
    } catch {
      return { ready: false, reason: "NO_SESSION" };
    }
    return signalingBridge.getSession(callId) ? { ready: true } : { ready: false, reason: "NO_SESSION" };
  }, [signalingBridge]);

  const acceptIncomingCallImpl = useCallback(async (callId: string, roomUrl: string, callType: string) => {
    const attempt = ++acceptAttemptRef.current;
    acceptFlowDoneRef.current = false;
    acceptCancelledRef.current = false;
    setIsAcceptingCall(true);
    const isVoice = callType === "voice";
    beginCallLatencyTrace("incoming", isVoice ? "voice" : "video", call.activeProvider, callId);
    // Seed/advance the state machine (see the long note in git history):
    // reuse INCOMING_RINGING if the overlay already dispatched it for this
    // exact call, otherwise RESET + reseed.
    const alreadyRingingThisCall = machineRef.current.status === "INCOMING_RINGING" && machineRef.current.session.callId === callId;
    if (!alreadyRingingThisCall) {
      if (machineRef.current.status !== "IDLE") dispatchCall({ type: "RESET", source: "accept-new-call" });
      dispatchCall({ type: "INCOMING_CALL", callId, callType: isVoice ? "voice" : "video", source: "accept-tapped" });
    }
    dispatchCall({ type: "ACCEPT_TAPPED", source: "user-tap" });
    setActiveCallType(isVoice ? "voice" : "video");

    /** Still the attempt the person is waiting on? (not cancelled, not
     *  superseded by a newer accept, machine still on this call). */
    const isCurrent = () => !acceptCancelledRef.current && attempt === acceptAttemptRef.current
      && isCurrentCall(machineRef.current, callId) && !isTerminal(machineRef.current.status);

    // Every exit after the claim is won goes through ONE cleanup so the
    // LiveKit room, native call UI, recovery marker and history are always
    // released together. History writes are guarded `status = in_progress`
    // so an old async failure can never overwrite a newer terminal state.
    const abandonClaimedCall = (status: "failed" | "cancelled" | "missed", reason: string, native: "failed" | "unanswered" | "remoteEnded") => {
      call.leaveCall();
      const patch = status === "cancelled"
        ? { status, cancel_reason: reason, ended_at: new Date().toISOString() }
        : { status, ended_at: new Date().toISOString() };
      void supabase.from("call_history").update(patch as never).eq("id", callId).eq("status", "in_progress").then(() => {}, () => {});
      signalCallTerminated(callId, { connected: false });
      void reportCallEndedNative(native);
      clearActiveCallSession();
    };

    const acceptWatchdog = setTimeout(() => {
      if (!isCurrent()) return;
      acceptCancelledRef.current = true;
      dispatchCall({ type: "FAILED", source: "accept-watchdog-timeout" });
      abandonClaimedCall("failed", "accept_watchdog", "failed");
      finishCallLatencyTrace("failed", undefined, "TIMEOUT");
      setIsAcceptingCall(false);
      toast({ title: "Couldn't join call", description: "That took too long to connect. Check your connection and try again.", variant: "destructive" });
    }, ACCEPT_WATCHDOG_MS);

    let claimWon = false;
    try {
      const deviceId = await getDeviceId();
      // Signaling readiness is started IN PARALLEL with the claim (it does
      // not depend on it) but is AWAITED before CALL_ACCEPTED is sent.
      const signalingReadyPromise = ensureSignalingForIncoming(callId, callType);
      void loadLiveKitSdk().catch(() => {});
      markCallLatency("claim_started");
      const claimResult = await withTimeout(
        supabase.rpc("claim_call" as any, { _call_id: callId, _device_id: deviceId }),
        15_000, "Call claim",
      ).then((r) => { markCallLatency("claim_completed"); return r; });
      const { data: claimed, error: claimErr } = claimResult as { data: boolean | null; error: unknown | null };
      if (claimErr || claimed !== true) {
        clearTimeout(acceptWatchdog);
        const wasCurrent = isCurrent();
        dispatchCall({ type: "CANCELLED", source: "claim-lost" });
        finishCallLatencyTrace("cancelled");
        void reportCallEndedNative("answeredElsewhere");
        if (wasCurrent) toast({ title: "Call answered elsewhere", description: "This call was already picked up on another device." });
        acceptFlowDoneRef.current = true;
        setIsAcceptingCall(false);
        return;
      }
      claimWon = true;
      dispatchCall({ type: "CLAIM_WON", source: "claim-rpc" });
      if (!isCurrent()) {
        clearTimeout(acceptWatchdog);
        abandonClaimedCall("missed", "receiver_cancelled_before_connect", "unanswered");
        acceptFlowDoneRef.current = true;
        return;
      }
      // Latency: the token request only needs the won claim, so it overlaps
      // the CALL_ACCEPTED round trip. The LiveKit CONNECTION still waits for
      // the gateway to confirm the accept (below).
      call.prefetchToken(callId);

      // ── ensure signaling ready → CALL_ACCEPTED (awaited, typed) ─────────
      const ready = await signalingReadyPromise;
      if (!isCurrent()) { clearTimeout(acceptWatchdog); abandonClaimedCall("missed", "receiver_cancelled_before_connect", "unanswered"); acceptFlowDoneRef.current = true; return; }
      if (!ready.ready) throw Object.assign(new Error(`Couldn't reach the calling service (${ready.reason ?? "not ready"}).`), { name: "SignalingNotReadyError" });
      markCallLatency("signaling_connected");
      // NOT returnQueued: a QUEUED send is not a delivered accept. Only a
      // server-acknowledged result (DELIVERED / RECIPIENT_OFFLINE /
      // DUPLICATE) lets the call proceed to media.
      const acceptResult = await signalingBridge.accept(callId, { deadlineMs: SIGNALING_ACCEPT_ACK_DEADLINE_MS, returnQueued: false });
      if (!isCurrent()) { clearTimeout(acceptWatchdog); abandonClaimedCall("missed", "receiver_cancelled_before_connect", "unanswered"); acceptFlowDoneRef.current = true; return; }
      if (!isServerAccepted(acceptResult)) {
        const callOver = acceptResult.status === "REJECTED" && ACCEPT_CALL_OVER_REASONS.has(acceptResult.reason);
        logWarn("call.signaling", callOver ? "accept_refused_call_over" : "accept_not_confirmed", {
          status: acceptResult.status, reason: "reason" in acceptResult ? acceptResult.reason : undefined,
        });
        if (callOver) {
          clearTimeout(acceptWatchdog);
          dispatchCall({ type: "CANCELLED", source: "signaling-accept-refused" });
          abandonClaimedCall("missed", "call_over_before_accept", "remoteEnded");
          finishCallLatencyTrace("cancelled");
          toast({ title: "Call ended", description: "The caller hung up before the call connected." });
          acceptFlowDoneRef.current = true;
          setIsAcceptingCall(false);
          return;
        }
        throw Object.assign(new Error("Couldn't confirm the answer with the calling service. Check your connection and try again."), { name: "SignalingNotReadyError" });
      }
      markCallLatency("accept_sent");
      if (acceptResult.status === "DELIVERED") markCallLatency("accept_delivered");

      if (!isVoice && Capacitor.isNativePlatform()) {
        await ensureMediaPermission("camera").catch(() => {});
      }
      // FIX (Peek Guard / MoodDetector kept scanning through answered
      // calls): Calls.tsx's startCallImpl already does this for the
      // OUTGOING side (`pauseCameraConsumers("call-start")`) so the call
      // engine can claim the device cleanly, but the receiving side never
      // did — accepting a call (voice OR video) never told the camera bus
      // anything was starting. Peek Guard's own camera loop kept running
      // for the whole call, on a device that's now typically held to an
      // ear, face angled away, or with the phone laid down — exactly the
      // read that trips a false stranger/no-face lock mid-call. Voice
      // calls need this exactly as much as video calls: they never touch
      // acquireCamera at all (no WebRTC video track), so nothing else was
      // ever going to pause Peek Guard for them. Resume is already
      // unconditional and direction-agnostic (the `callState === "idle" ||
      // "error"` safety-net effect below, plus every explicit hang-up path
      // in this file and Calls.tsx), so this only needed the missing pause.
      pauseCameraConsumers("call-accept");
      dispatchCall({ type: "CONNECTING", source: "joinCall" });
      await call.joinCall(callId, undefined, isVoice);
      if (!isCurrent()) { clearTimeout(acceptWatchdog); abandonClaimedCall("cancelled", "receiver_cancelled_before_connect", "unanswered"); acceptFlowDoneRef.current = true; return; }

      // ── remote participant → remote audio PLAYING (never assumed) ──────
      const media = await awaitCallMedia({
        waitForRemoteParticipant: call.waitForRemoteParticipant,
        waitForRemoteAudioReady: call.waitForRemoteAudioReady,
        retryRemoteAudioPlayback: call.retryRemoteAudioPlayback,
        isCurrent: () => isCurrent() && call.isActiveCall(callId),
        onDegraded: () => { markCallLatency("media_degraded"); dispatchCall({ type: "MEDIA_DEGRADED", source: "remote-audio-timeout" }); },
      }, { participantTimeoutMs: RECEIVER_PARTICIPANT_TIMEOUT_MS });
      clearTimeout(acceptWatchdog);
      if (media.result === "stale") {
        if (acceptCancelledRef.current) abandonClaimedCall("cancelled", "receiver_cancelled_before_connect", "unanswered");
        else if (isCurrent()) {
          // The engine dropped the room on its own (LiveKit disconnect) before
          // audio ever played: a failed call, not a silent return.
          dispatchCall({ type: "FAILED", source: "media-lost-before-connect" });
          abandonClaimedCall("failed", "media_lost_before_connect", "failed");
          finishCallLatencyTrace("failed", undefined, "MEDIA_LOST");
          toast({ title: "Couldn't connect call", description: "The connection dropped while connecting. Try again.", variant: "destructive" });
          setIsAcceptingCall(false);
        }
        acceptFlowDoneRef.current = true;
        return;
      }
      if (media.result !== "connected") {
        dispatchCall({ type: "FAILED", source: media.result });
        abandonClaimedCall("failed", media.result, "failed");
        finishCallLatencyTrace("failed", undefined, media.result === "no_remote_audio" ? "REMOTE_AUDIO_TIMEOUT" : "REMOTE_PARTICIPANT_TIMEOUT");
        toast({ title: "Couldn't connect call", description: mediaFailureMessage(media), variant: "destructive" });
        acceptFlowDoneRef.current = true;
        setIsAcceptingCall(false);
        return;
      }
      dispatchCall({ type: "CONNECTED", source: media.degraded ? "remote-audio-late" : "remote-audio-ready" });
      void reportCallNowConnected(callId, !isVoice);
      persistActiveCallSession({ callId, roomUrl, callType: isVoice ? "voice" : "video", direction: "incoming", partnerName: "Partner" });
      setActiveCallId(callId);
      finishCallLatencyTrace("connected");
    } catch (err: unknown) {
      clearTimeout(acceptWatchdog);
      if ((err as Error | null)?.name === "JoinCancelledError" || (claimWon && !isCurrent() && acceptCancelledRef.current)) {
        // cancelAcceptingCall() already tore this attempt down.
        if (claimWon) abandonClaimedCall("cancelled", "receiver_cancelled_before_connect", "unanswered");
        acceptFlowDoneRef.current = true;
        setIsAcceptingCall(false);
        return;
      }
      dispatchCall({ type: "FAILED", source: "accept-exception" });
      if (claimWon) abandonClaimedCall("failed", "accept_exception", "failed");
      else { call.leaveCall(); void reportCallEndedNative("failed"); clearActiveCallSession(); }
      toast({ title: "Couldn't join call", description: extractErrorMessage(err), variant: "destructive" });
      finishCallLatencyTrace("failed", undefined, (err as Error | null)?.name === "SignalingNotReadyError" ? "SIGNALING_UNAVAILABLE" : classifyCallError(err).code);
    }
    clearTimeout(acceptWatchdog);
    acceptFlowDoneRef.current = true;
    setIsAcceptingCall(false);
  }, [call, toast, dispatchCall, signalingBridge, signalCallTerminated, ensureSignalingForIncoming]);
  // Always points at the newest closure — see the note above acceptIncomingCall.
  acceptImplRef.current = acceptIncomingCallImpl;

  // Companion to acceptIncomingCall's own cancellation checks above — sets
  // the ref those checks read, drops the UI out of the "accepting" screen
  // immediately (not waiting for the in-flight network call to notice), and
  // tears down anything that may have already joined. Idempotent/safe to
  // call more than once or after the call has already connected normally.
  const cancelAcceptingCall = useCallback(() => {
    acceptCancelledRef.current = true;
    acceptAttemptRef.current += 1; // any in-flight step of the old attempt is now stale
    // (No signal here on purpose: before claim_call resolves this device
    // doesn't yet own the call, and telling the caller "rejected" could be
    // wrong if another device wins the claim. acceptIncomingCallImpl
    // signals from its own cancelled-after-claim branch instead.)
    dispatchCall({ type: "CANCELLED", source: "cancel-button" });
    finishCallLatencyTrace("cancelled");
    call.leaveCall();
    void reportCallEndedNative("unanswered");
    clearActiveCallSession();
    setIsAcceptingCall(false);
    toast({ title: "Call cancelled" });
  }, [call, toast, dispatchCall]);

  const declineIncomingCall = useCallback((_id: string) => {
    toast({ title: "Call declined" });
  }, [toast]);

  // Actual rejoin logic for the recovery prompt above — fetches a fresh
  // The call engine token (the persisted one may be near/past its expiry by the time
  // someone actually taps Rejoin) via the same get-token action the normal
  // accept flow uses, then replays the same RESET+reseed dance
  // acceptIncomingCallImpl/Calls.tsx's startCall already do for their own
  // flows, ending in the same CONNECTING -> CONNECTED sequence. Kept
  // intentionally simple relative to the full accept/outgoing flows above
  // (no claim_call — this device already owned the call before the app
  // closed, no busy-check — obviously not busy with itself, no watchdog —
  // this is already a recovery path, a second failure here just surfaces
  // as an ordinary "couldn't join call" toast like any other).
  const rejoinRecoveredCall = useCallback(async (
    session: NonNullable<ReturnType<typeof readActiveCallSession>>,
    opts: { finalizeOnFailure?: boolean } = {},
  ): Promise<"connected" | "stale" | "failed"> => {
    const finalizeOnFailure = opts.finalizeOnFailure !== false;
    beginCallLatencyTrace(session.direction === "outgoing" ? "outgoing" : "incoming", session.callType, call.activeProvider);
    dispatchCall({ type: "RESET", source: "recovery-rejoin" });
    if (session.direction === "outgoing") {
      dispatchCall({ type: "START_OUTGOING", callType: session.callType, source: "recovery-rejoin" });
      dispatchCall({ type: "OUTGOING_SESSION_CREATED", callId: session.callId, source: "recovery-rejoin" });
    } else {
      dispatchCall({ type: "INCOMING_CALL", callId: session.callId, callType: session.callType, source: "recovery-rejoin" });
      dispatchCall({ type: "ACCEPT_TAPPED", source: "recovery-rejoin" });
      dispatchCall({ type: "CLAIM_WON", source: "recovery-rejoin" });
    }
    setActiveCallType(session.callType);
    setIsAcceptingCall(true);
    try {
      if (user?.id) {
        // App restarted mid-call: re-attach the signaling session (same
        // callId + authoritative sessionId — NOT a new logical call) so the
        // peer's CALL_ENDED still reaches this device and a resync catches
        // anything missed while we were away. Best-effort: media rejoin
        // does not depend on it.
        try {
          const { data: row } = await supabase.from("call_history")
            .select("caller_id, receiver_id, session_id").eq("id", session.callId).maybeSingle();
          const r = row as { caller_id: string; receiver_id: string; session_id: string | null } | null;
          if (r?.session_id) {
            const iAmCaller = r.caller_id === user.id;
            signalingBridge.registerRecovered({
              callId: session.callId, sessionId: r.session_id, role: iAmCaller ? "caller" : "receiver",
              peerId: iAmCaller ? r.receiver_id : r.caller_id, state: "ACCEPTED",
            });
            signalingBridge.prewarm();
          }
        } catch { /* recovery of signaling is best-effort */ }
      }
      const tokenData = { token: "" }; // adapter fetches its own LiveKit token
      dispatchCall({ type: "CONNECTING", source: "recovery-rejoin" });
      await call.joinCall(session.callId, tokenData.token, session.callType === "voice");
      const rejoinCallId = session.callId;
      const media = await awaitCallMedia({
        waitForRemoteParticipant: call.waitForRemoteParticipant,
        waitForRemoteAudioReady: call.waitForRemoteAudioReady,
        retryRemoteAudioPlayback: call.retryRemoteAudioPlayback,
        isCurrent: () => call.isActiveCall(rejoinCallId) && isCurrentCall(machineRef.current, rejoinCallId) && !isTerminal(machineRef.current.status),
        onDegraded: () => dispatchCall({ type: "MEDIA_DEGRADED", source: "recovery-remote-audio-timeout" }),
      }, { participantTimeoutMs: RECEIVER_PARTICIPANT_TIMEOUT_MS });
      if (media.result === "stale") { setIsAcceptingCall(false); return "stale"; }
      if (media.result !== "connected") throw new Error(mediaFailureMessage(media));
      dispatchCall({ type: "CONNECTED", source: media.degraded ? "remote-audio-late" : "remote-audio-ready" });
      void reportCallNowConnected(session.callId, session.callType !== "voice");
      persistActiveCallSession(session);
      setActiveCallId(session.callId);
      toast({ title: "Call reconnected 📞" });
      finishCallLatencyTrace("connected");
      setIsAcceptingCall(false);
      return "connected";
    } catch (err: unknown) {
      call.leaveCall();
      if (!finalizeOnFailure) {
        // Auto-recovery attempt: keep the row live, the recovery marker and
        // the peer's session intact — the caller decides whether to retry.
        finishCallLatencyTrace("failed", undefined, classifyCallError(err).code);
        setIsAcceptingCall(false);
        return "failed";
      }
      signalCallTerminated(session.callId, { connected: false });
      dispatchCall({ type: "FAILED", source: "recovery-rejoin-exception" });
      finishCallLatencyTrace("failed", undefined, classifyCallError(err).code);
      clearActiveCallSession();
      // Best-effort: this device couldn't get back in — close the row out
      // rather than leaving it dangling for the sweep gap noted above.
      await supabase.from("call_history").update({
        status: "failed", ended_at: new Date().toISOString(),
      } as never).eq("id", session.callId).eq("status", "in_progress").then(() => {}).catch(() => {});
      toast({ title: "Couldn't reconnect", description: extractErrorMessage(err), variant: "destructive" });
    }
    setIsAcceptingCall(false);
    return "failed";
  }, [call, toast, dispatchCall, user?.id, signalingBridge, signalCallTerminated]);

  useEffect(() => { rejoinRecoveredCallRef.current = rejoinRecoveredCall; }, [rejoinRecoveredCall]);

  // MID-CALL FAILURE CLEANUP (DB correctness): the adapter tears a LIVE call
  // down on its own when LiveKit gives up (reconnect timeout, unexpected
  // disconnect) and reports callState "error". Nothing previously finalized
  // call_history, told the peer, or ended the native call for that path, so
  // the row stayed 'in_progress' forever. Handled once, here, for both
  // directions (the machine's session.callId covers caller and receiver).
  // Join-time failures are NOT handled here — their own flows already do it
  // (only CONNECTED / MEDIA_DEGRADED / RECONNECTING count as "live").
  const lastDurationRef = useRef(0);
  if (call.callDuration > 0) lastDurationRef.current = call.callDuration;
  useEffect(() => {
    if (call.callState !== "error") return;
    const m = machineRef.current;
    // Only calls that were fully connected. Pre-connect failures are owned by
    // the start/accept flows, which clean up their own history + signaling.
    const liveStates = new Set(["CONNECTED", "RECONNECTING"]);
    const callId = m.session.callId;
    if (!callId || !liveStates.has(m.status)) return;
    const duration = lastDurationRef.current;
    lastDurationRef.current = 0;
    const finalizeLost = () => {
      signalCallTerminated(callId, { connected: true });
      void supabase.from("call_history").update((duration > 0
        ? { status: "completed", duration_seconds: duration, ended_at: new Date().toISOString() }
        : { status: "failed", ended_at: new Date().toISOString() }) as never,
      ).eq("id", callId).eq("status", "in_progress").then(() => {}, () => {});
      void reportCallEndedNative("failed");
      clearActiveCallSession();
      setActiveCallId(null);
    };
    // MID-CALL DROP RECOVERY: LiveKit giving up (Wi-Fi <-> mobile switch,
    // a tunnel, a few seconds offline) used to end the call for BOTH people
    // on the spot — row finalized, peer told CALL_ENDED, recovery marker
    // wiped — so there was nothing left to rejoin. Now the call is kept
    // alive server-side and this device silently rejoins the same room a
    // few times (the peer's device does the same), only finalizing if the
    // row is no longer live or every attempt fails.
    const session = readActiveCallSession();
    if (session && session.callId === callId && autoRecoverRef.current.callId !== callId) {
      autoRecoverRef.current = { callId, cancelled: false };
      dispatchCall({ type: "FAILED", source: "media-connection-lost-recovering" });
      toast({ title: "Connection lost", description: "Reconnecting your call…" });
      void (async () => {
        const delays = [800, 2500, 5000, 8000];
        for (const delay of delays) {
          await new Promise((r) => setTimeout(r, delay));
          if (autoRecoverRef.current.cancelled || autoRecoverRef.current.callId !== callId) return;
          if (typeof navigator !== "undefined" && navigator.onLine === false) continue;
          const { data: row } = await supabase.from("call_history")
            .select("status,ended_at").eq("id", callId).maybeSingle()
            .then((r) => r, () => ({ data: null }));
          const live = row && (row as { status: string }).status === "in_progress" && !(row as { ended_at: string | null }).ended_at;
          if (row && !live) break; // the other side ended it — nothing to rejoin
          if (autoRecoverRef.current.cancelled) return;
          const result = await rejoinRecoveredCallRef.current?.(session, { finalizeOnFailure: false });
          if (result === "connected" || result === "stale") { autoRecoverRef.current.callId = null; return; }
        }
        if (autoRecoverRef.current.cancelled) return;
        autoRecoverRef.current.callId = null;
        dispatchCall({ type: "RESET", source: "media-connection-lost-final" });
        finalizeLost();
        toast({ title: "Call dropped", description: "Couldn't reconnect. You can call again from the chat.", variant: "destructive" });
      })();
      return;
    }
    dispatchCall({ type: "FAILED", source: "media-connection-lost" });
    finalizeLost();
  }, [call.callState, dispatchCall, signalCallTerminated, toast]);

  /**
   * FAST HANG-UP (the "End doesn't end immediately" fix). Every end button
   * used to `await` the call_history UPDATE (and on Calls.tsx a full history
   * re-fetch) BEFORE calling leaveCall(), so the call — mic, remote audio,
   * full-screen UI — stayed up for one or two network round trips, much
   * longer on a slow link. Now: tear media + UI down synchronously, tell the
   * peer over signaling immediately, and finalize history in the
   * background. The history write is still guarded `status = in_progress`,
   * so it can never overwrite a terminal state set by the other side.
   */
  const hangUpCall = useCallback((callId: string | null | undefined, opts: { onHistoryWritten?: () => void } = {}) => {
    const duration = Math.max(call.callDuration, 0);
    const connected = duration > 0; // duration only runs once remote audio actually played
    // Terminal state FIRST (synchronous ref update), then leave: any flow
    // awaiting this call's media sees it as stale, never as a failure.
    autoRecoverRef.current.cancelled = true; // stop any mid-call drop auto-rejoin loop
    dispatchCall({ type: "ENDED", source: "hang-up" });
    call.leaveCall();
    void reportCallEndedNative("remoteEnded");
    clearActiveCallSession();
    lastDurationRef.current = 0;
    if (!callId) return;
    signalCallTerminated(callId, { connected });
    void (async () => {
      try {
        await supabase.from("call_history").update(
          (connected
            ? { status: "completed", duration_seconds: duration, ended_at: new Date().toISOString() }
            : { status: "cancelled", cancel_reason: "caller_ended_before_connect", ended_at: new Date().toISOString() }) as never,
        ).eq("id", callId).eq("status", "in_progress");
      } catch { /* best-effort; guarded write, ring sweep covers unclaimed rows */ }
      opts.onHistoryWritten?.();
    })();
  }, [call, dispatchCall, signalCallTerminated]);

  // Inbound events that terminate the ACTIVE call on this device. The
  // client has already dropped anything stale (old call, old session,
  // wrong sender, illegal state) — what arrives here is for a call this
  // device is really in.
  useEffect(() => {
    return signalingBridge.onMessage((m: SignalingMessage) => {
      if (m.type !== "CALL_ENDED") return;
      const current = activeCallIdRef.current ?? (machineRef.current.session.callId || null);
      if (!current || m.callId !== current) return;
      // The other side hung up: terminate the provider session. History was
      // (or is being) finalized by the sender through the secure DB path —
      // this side does not write it again.
      dispatchCall({ type: "ENDED", source: "signaling-remote-ended" });
      callRef.current.leaveCall();
      clearActiveCallSession();
      void reportCallEndedNative("remoteEnded");
      setActiveCallId(null);
    });
  }, [call.activeProvider, signalingBridge, dispatchCall]);

  // Native (background) decline can't reach the signaling client from
  // usePushNotifications (it runs outside this provider) — it announces the
  // decline on a window event; if the socket is alive, tell the caller.
  useEffect(() => {
    const onNativeDecline = (event: Event) => {
      const callId = ((event as CustomEvent).detail as { callId?: string } | undefined)?.callId;
      if (!callId) return;
      void (async () => {
        // A background decline never hydrated the overlay, so this client may
        // not know the call yet: fetch its session (the authoritative
        // call_history.session_id) so the reject can be addressed + accepted.
        if (!signalingBridge.getSession(callId)) {
          try {
            const { data } = await supabase.from("call_history").select("caller_id, session_id, provider").eq("id", callId).maybeSingle();
            const row = data as { caller_id: string; session_id: string | null; provider: string | null } | null;
            if (!row?.session_id || row.provider !== "self_hosted") return;
            signalingBridge.registerIncoming({ callId, sessionId: row.session_id, peerId: row.caller_id });
          } catch { return; }
        }
        void signalingBridge.reject(callId, "user");
      })();
    };
    window.addEventListener("duospace-call-native-decline", onNativeDecline);
    return () => window.removeEventListener("duospace-call-native-decline", onNativeDecline);
  }, [signalingBridge]);

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
      const detail = (event as CustomEvent).detail as { action?: string; callId?: string } | undefined;
      if (!detail?.action) return;
      const currentId = activeCallIdRef.current ?? machineRef.current.session.callId;
      // Stale-call guard: a native control for a different (older) call
      // must never touch the call that's live now.
      if (detail.callId && currentId && detail.callId !== currentId) return;
      if (!currentId) return; // nothing live — ignore (was: hangUp(null) + native end reports)
      if (detail.action === "mute" && call.isAudioOn) call.toggleAudio();
      else if (detail.action === "unmute" && !call.isAudioOn) call.toggleAudio();
      else if (detail.action === "end") {
        // Native (Telecom / CallKit / Bluetooth / car) hang-up: same fast
        // path as the in-app End button, including the history write.
        hangUpCall(activeCallIdRef.current ?? machineRef.current.session.callId);
      }
    };
    window.addEventListener("duospace-call-control", handleCallControl);
    return () => window.removeEventListener("duospace-call-control", handleCallControl);
  }, [call, hangUpCall]);

  // RECONNECTING-STATE-MACHINE FIX: the call engine adapter can't import dispatchCall
  // (circular dep — it's defined here in CallContext, above the hook).
  // It fires "duospace-call-network" window events instead; we listen here
  // and advance the shared state machine accordingly.
  // CONNECTED → RECONNECTING on interruption, RECONNECTING → CONNECTED on
  // recovery — both legal transitions in callStateMachine.ts.
  useEffect(() => {
    const handleNetworkEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { event?: string } | undefined;
      if (!detail?.event) return;
      if (detail.event === "interrupted") {
        dispatchCall({ type: "RECONNECTING", source: "network-interrupted" });
      } else if (detail.event === "connected") {
        // RECOVERED is the machine event for RECONNECTING → CONNECTED.
        dispatchCall({ type: "RECOVERED", source: "network-reconnected" });
      }
    };
    window.addEventListener("duospace-call-network", handleNetworkEvent);
    return () => window.removeEventListener("duospace-call-network", handleNetworkEvent);
  }, [dispatchCall]);

  const value: CallContextValue = useMemo(() => ({
    ...call, activeCallId, setActiveCallId, isAcceptingCall, cancelAcceptingCall, activeCallType, setActiveCallType, isCallMinimized, setIsCallMinimized,
    signalingBridge, signalCallTerminated, cancelOutgoingCall, hangUpCall,
    // machineVersion drives recomputation (it's in the deps array below);
    // machineRef.current is read for its latest value, not tracked by
    // reference itself — the version bump is what guarantees they're in
    // sync (see dispatchCall above).
    callMachineState: machineRef.current, dispatchCallEvent: dispatchCall,
  }), [call, activeCallId, setActiveCallId, isAcceptingCall, cancelAcceptingCall, activeCallType, setActiveCallType, isCallMinimized, setIsCallMinimized, dispatchCall, machineVersion, signalingBridge, signalCallTerminated, cancelOutgoingCall, hangUpCall]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <IncomingCallOverlay onAccept={acceptIncomingCall} onDecline={declineIncomingCall} dispatchCallEvent={dispatchCall} signalingBridge={signalingBridge} activeProvider={call.activeProvider} />
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
