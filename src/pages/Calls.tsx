import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Video, Wifi, PhoneOff } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import { pauseCameraConsumers, resumeCameraConsumers } from "@/lib/cameraBus";
import { Capacitor } from "@capacitor/core";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { hapticMedium, hapticHeavy, hapticSelection } from "@/lib/haptics";
import { withTimeout } from "@/lib/withTimeout";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { fromGumError, invalidateNativeMicGrantCache } from "@/lib/mediaPermissions";
import { classifyCallError } from "@/lib/callErrors";
import { useCallOutcome } from "@/hooks/useCallOutcome";
import { deriveCallUiState } from "@/lib/callUiState";
import { isTerminal } from "@/lib/callStateMachine";
import { awaitCallMedia, mediaFailureMessage, CALLER_PARTICIPANT_TIMEOUT_MS } from "@/lib/callEngine/awaitCallMedia";
import { beginTrace as beginCallLatencyTrace, mark as markCallLatency, finishTrace as finishCallLatencyTrace, setTraceIds as setCallLatencyIds } from "@/lib/callLatency";
import CallOutcomeScreen from "@/components/calls/CallOutcomeScreen";
import CallStage from "@/components/calls/CallStage";
import CallHistoryRow from "@/components/calls/CallHistoryRow";
import CallHistorySkeleton from "@/components/skeletons/CallHistorySkeleton";
import { readCachedCallHistory, writeCachedCallHistory } from "@/lib/callHistoryCache";
import CallErrorScreen from "@/components/calls/CallErrorScreen";
import { reportOutgoingCallStarted, reportCallNowConnected, reportCallEndedNative } from "@/lib/nativeCallReporting";
import { persistActiveCallSession, clearActiveCallSession } from "@/lib/callSessionRecovery";
import { createOutgoingCallRoom } from "@/lib/callEngine/createOutgoingCallRoom";
import { isServerAccepted } from "@/lib/signalingEngine/types";
import { signalingNotReadyError, inviteFailureError } from "@/lib/signalingEngine/signalingFailure";
import { classifyCallOutcome } from "@/lib/callOutcome";
import { useBottomSurfaceHeight } from "@/contexts/BottomSurfaceContext";

interface NetworkInformation {
  downlink?: number;
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

type NetworkQuality = "excellent" | "good" | "fair" | "poor";

// A the call engine join permission failure doesn't say which device it was — but
// we usually know enough to guess accurately: a voice call never opens the
// camera at all, so any permission failure there has to be the mic; a video
// call's failure could be either, so fall back to sniffing the raw error
// text before defaulting to "camera" (the call engine requests camera first for video
// calls, and this was the only kind ever reported here before the native
// mic-grant cache made a mic-only failure surfacing this late more likely).
const permissionKindForCallFailure = (mode: "video" | "voice", detail: string): "microphone" | "camera" => {
  if (mode === "voice") return "microphone";
  return /microphone|mic\b|audio/i.test(detail) ? "microphone" : "camera";
};

// Exported so CallHistoryRow (extracted to its own file, DA-02) can type its
// `call` prop against the same shape instead of duplicating it.
export interface CallRecord {
  id: string;
  caller_id: string;
  receiver_id: string | null;
  call_type: string;
  call_direction: string;
  status: string;
  duration_seconds: number;
  room_name: string | null;
  started_at: string;
  ended_at: string | null;
  /** Set only when the receiver explicitly rejected the call (migration
   *  20260824_call_declined_marker.sql). status alone can't tell a
   *  declined call apart from one that just rang out — both land on
   *  'missed' — so CallHistoryRow needs this to label/icon them apart. */
  declined_at: string | null;
  /** Set by cancel_call() (pre-claim cancel) and by endCall()'s own
   *  cancelled-before-connect write (Calls.tsx) — a human-readable reason
   *  string ("caller_cancelled", "caller_ended_before_connect", ...), not
   *  itself rendered, but present so a future export/debug view has it. */
  cancel_reason?: string | null;
}

const qualityLabels: Record<NetworkQuality, { label: string; resolution: string; color: string; dot: string }> = {
  excellent: { label: "Excellent", resolution: "1080p HD", color: "text-success", dot: "bg-success" },
  good: { label: "Good", resolution: "720p HD", color: "text-success", dot: "bg-success" },
  fair: { label: "Fair", resolution: "480p", color: "text-warning", dot: "bg-warning" },
  poor: { label: "Poor", resolution: "360p", color: "text-destructive", dot: "bg-destructive" },
};

const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const Calls = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  // Redesign brief §2/§11: read the unified bottom surface's live measured
  // height (composer-collapsed on this tab, so just the nav row + safe
  // area) instead of the old hardcoded pb-24 — see
  // DuoSpaceBottomSurface.tsx's ResizeObserver.
  const bottomInset = useBottomSurfaceHeight();
  const [browserNetworkQuality, setBrowserNetworkQuality] = useState<NetworkQuality>("good");
  const [isStartingCall, setIsStartingCall] = useState(false);
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);
  // True until the FIRST history result (cached or network) is in. Without it
  // the "Recent" list started empty on every launch and flashed the "No calls
  // yet" empty state before any data had actually loaded.
  const [historyLoading, setHistoryLoading] = useState(true);
  // Set once the network fetch has returned — gates persisting to the local
  // cache so a stale cached list is never re-written as if it were fresh.
  const historyFreshRef = useRef(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState<string>("");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  // currentCallId/setCurrentCallId come from CallContext (activeCallId) —
  // see the useCall() destructure below — so this page's endCall still
  // resolves the right call_history row even when the call was accepted
  // on a different page. See CallContext.tsx for the full writeup.
  const [callMode, setCallMode] = useState<"video" | "voice">("video");
  const [showLipReading, setShowLipReading] = useState(false);
  const callStartTimeRef = useRef<Date | null>(null);
  // BUG FIX (call latency): the call screen now appears the instant the
  // button is tapped (isStartingCall), before the network setup that used
  // to gate it has even started — see the render gate below. That means
  // the hang-up button is now reachable *during* that setup, which wasn't
  // possible before. This flag lets a cancel during that window stop
  // startCall()'s in-flight async work from finishing the job (joining a
  // call the person already tried to back out of) instead of just
  // resetting local UI state and letting it join anyway a moment later.
  const callCancelledRef = useRef(false);
  // OUTGOING-CALL IDEMPOTENCY FIX: `isStartingCall` (the state flag the
  // guard below and the button's `disabled` prop both key off) is React
  // state — it doesn't take effect until the next render. A fast
  // double-tap of the call button, easy on mobile, can invoke startCall()
  // a second time before that re-render happens, so both invocations read
  // `isStartingCall` as still `false` and both proceed: two the call engine rooms
  // created, two `call_history` rows inserted, two ring signals sent to
  // the recipient for one tap — exactly the "duplicate call
  // records/rooms/notifications" this brief calls out, and exactly the
  // same synchronous-race class of bug the call engine adapter's own
  // `joinInProgressRef` already exists to close for the join step itself.
  // That guard was never applied one layer up, here, where the room
  // creation and signaling actually happen — a ref is checked and set
  // synchronously (no `await` in between), so a second concurrent call
  // is rejected immediately instead of racing past the check.
  const startCallLockRef = useRef(false);
  // Tracks whether *this* call session has ever had a second participant
  // join, so "no one else is here" can be told apart between "still
  // ringing" and "they left" — see src/lib/callUiState.ts.
  const [everConnected, setEverConnected] = useState(false);
  // Honest ringing-stage hint (e.g. "their phone is on silent") — set once
  // per ring from the partner's device-status sync, cleared when the ring
  // ends; see the effect near useCallOutcome below.
  const [ringHint, setRingHint] = useState<string | null>(null);

  const {
    joinCall, leaveCall, callState, waitForRemoteAudioReady, waitForRemoteParticipant, retryRemoteAudioPlayback, remoteAudioReady, isActiveCall,
    networkQuality: callNetworkQuality, participantCount, error, callError,
    callDuration, autoAudioFallback,
    activeCallId: currentCallId, setActiveCallId: setCurrentCallId, isAcceptingCall, cancelAcceptingCall,
    setActiveCallType, isCallMinimized, setIsCallMinimized,
    dispatchCallEvent, callMachineState,
    activeProvider,
    signalingBridge, signalCallTerminated, cancelOutgoingCall, hangUpCall,
  } = useCall();
  // Latest machine state for async checks inside startCall (React state is a render late).
  const callMachineRef = useRef(callMachineState);
  callMachineRef.current = callMachineState;

  useEffect(() => {
    if (participantCount > 1) setEverConnected(true);
  }, [participantCount]);

  const { ensure: ensureCallMedia, report: reportCallMediaFailure, permissionSheet: callPermissionSheet } = useMediaPermission();

  const callUiState = deriveCallUiState({
    callState, isStartingCall, participantCount, everConnected,
    networkQuality: callNetworkQuality,
    remoteAudioReady,
  });

  // A permission failure that surfaces through the call engine's own join attempt
  // never throws back to startCall()'s try/catch — the call engine adapter absorbs
  // it internally (applyError -> callState "error"). Watch callError here
  // instead so it still reaches the same recovery sheet the mic check
  // uses, rather than only the small inline error banner.
  const lastReportedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (callError?.code === "PERMISSION_DENIED" && lastReportedErrorRef.current !== callError.detail) {
      lastReportedErrorRef.current = callError.detail;
      const kind = permissionKindForCallFailure(callMode, callError.detail);
      if (kind === "microphone") invalidateNativeMicGrantCache();
      reportCallMediaFailure(fromGumError(kind, { name: "NotAllowedError", message: callError.detail }), () => startCall(callMode));
    }
  }, [callError, reportCallMediaFailure, callMode]);

  // CONFIRMED BUG FIX — see useCallOutcome.ts: the caller previously had no
  // way to find out the receiver declined/timed out/the call was cancelled
  // from another session, and just sat on "Ringing…" forever.
  // Shared cleanup for every pre-connect terminal outcome (remote decline,
  // server ring-expiry, or our own local safety timer below) — one body so
  // all three paths can never drift apart.
  const finishUnansweredCall = useCallback(() => {
    // Terminal state first (sync), then leave — so the in-flight media wait
    // in startCall sees a finished call, not a media failure.
    dispatchCallEvent({ type: "MISSED", source: "remote-outcome" });
    leaveCall();
    void reportCallEndedNative("unanswered");
    clearActiveCallSession();
    resumeCameraConsumers("call-remote-ended");
    setCurrentCallId(null);
    setIsStartingCall(false);
  }, [leaveCall, setCurrentCallId, dispatchCallEvent]);
  const { outcome, dismissOutcome, reportNoAnswer } = useCallOutcome({
    currentCallId,
    everConnected,
    onRemoteEnded: finishUnansweredCall,
    signalingBridge,
    activeProvider,
  });

  // HONEST RINGING STAGE — two truthful additions while the ring is live:
  //
  // 1. DEVICE HINT: the partner's device-status sync (battery/ringer,
  //    already running app-wide) tells us if their phone is on
  //    silent/vibrate. If so, say it — "Ringing…" alone would be a quiet
  //    lie when they physically cannot hear it. Only claimed for status
  //    fresh within the last hour; stale/absent status means no claim.
  //    NOTE: what we deliberately CANNOT know is whether they're busy in
  //    a third-party app (WhatsApp/Instagram/Snapchat) — mobile OSes don't
  //    expose other apps' call state to us, and we won't pretend to.
  // 2. NO-ANSWER SAFETY TIMER: the server expires the ring after ~30s and
  //    delivers 'missed' over realtime, but if that event is lost the
  //    caller must still reach the honest terminal screen instead of
  //    ringing forever. At 45s of unanswered ring we end with "No answer".
  useEffect(() => {
    if (callUiState !== "ringing" || !partnerId) return;
    let cancelled = false;
    supabase
      .from("profiles")
      .select("ringer_mode, device_status_updated_at")
      .eq("user_id", partnerId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        const ageMin = data.device_status_updated_at
          ? (Date.now() - new Date(data.device_status_updated_at).getTime()) / 60000
          : Infinity;
        if ((data.ringer_mode === "silent" || data.ringer_mode === "vibrate") && ageMin < 60) {
          setRingHint(`Their phone is on ${data.ringer_mode} — they may not hear the ring`);
        }
      });
    const safetyTimer = setTimeout(() => {
      if (cancelled) return;
      reportNoAnswer();
      finishUnansweredCall();
    }, 45_000);
    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      setRingHint(null);
    };
  }, [callUiState, partnerId, reportNoAnswer, finishUnansweredCall]);

  // Tell the person why their camera just turned off — a silent downgrade
  // would just look like a bug. Fires once per occurrence (guarded by the
  // prev-value ref) rather than on every render while it's true.
  const prevAutoFallbackRef = useRef(false);
  useEffect(() => {
    if (autoAudioFallback && !prevAutoFallbackRef.current) {
      toast({
        title: "Switched to audio-only",
        description: "Your connection is unstable, so video was turned off to keep the call going. Tap the camera icon to turn it back on.",
      });
    }
    prevAutoFallbackRef.current = autoAudioFallback;
  }, [autoAudioFallback, toast]);

  // Controls auto-hide (video calls only), camera switch, PiP, and the
  // audio-route picker are now all owned by the shared <CallStage/>
  // component (src/components/calls/CallStage.tsx) — see it for that
  // logic. This page only supplies the page-local orchestration state
  // CallStage can't derive from CallContext itself.

  // Load partner + call history.
  //
  // Stale-while-revalidate: the last successful history list is read from
  // the encrypted local cache (src/lib/callHistoryCache.ts) and painted right
  // away, then the normal network fetch below replaces it. On a first-ever
  // launch (nothing cached) the "Recent" list shows a skeleton instead of a
  // false "No calls yet" until the fetch returns.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    historyFreshRef.current = false;

    void readCachedCallHistory(user.id).then((cached) => {
      // Never let a slow cache read overwrite data the network already returned.
      if (cancelled || historyFreshRef.current || !cached) return;
      setCallHistory(cached);
      setHistoryLoading(false);
    });

    const load = async () => {
      try {
        const { data: profile } = await supabase.from("profiles").select("partner_id, pet_name").eq("user_id", user.id).single();
        if (cancelled) return;
        if (profile?.partner_id) {
          setPartnerId(profile.partner_id);
          // Name for the ringing/outcome/partner-left screens below — this
          // page previously had no notion of the partner's display name at
          // all (only their id), so those states could only ever say
          // "Partner" generically.
          const { data: pp } = await supabase.from("profiles")
            .select("display_name, avatar_url").eq("user_id", profile.partner_id).single();
          if (cancelled) return;
          if (pp) {
            setPartnerName(profile.pet_name || pp.display_name || "Partner");
            setPartnerAvatar(pp.avatar_url || null);
          }
        }

        const { data: history } = await supabase
          .from("call_history")
          .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,declined_at,created_at")
          .or(`caller_id.eq.${user.id},receiver_id.eq.${user.id}`)
          .order("started_at", { ascending: false })
          .limit(50);
        if (cancelled) return;
        if (history) {
          historyFreshRef.current = true;
          setCallHistory(history as CallRecord[]);
        }
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user]);

  // Persist the fresh list (including later refreshes/deletes) for the next
  // launch. Skipped until the network result has landed — see historyFreshRef.
  useEffect(() => {
    if (!user || !historyFreshRef.current) return;
    void writeCachedCallHistory(user.id, callHistory);
  }, [callHistory, user]);

  // Browser network quality
  useEffect(() => {
    const nav = navigator as NavigatorWithConnection;
    const getQuality = (): NetworkQuality => {
      const c = nav.connection;
      if (c) {
        const downlink = c.downlink ?? 0;
        const eff = c.effectiveType;
        if (eff === "4g" && downlink >= 10) return "excellent";
        if (eff === "4g") return "good";
        if (eff === "3g") return "fair";
        return "poor";
      }
      return "good";
    };
    setBrowserNetworkQuality(getQuality());
    const handler = () => setBrowserNetworkQuality(getQuality());
    nav.connection?.addEventListener?.("change", handler);
    return () => nav.connection?.removeEventListener?.("change", handler);
  }, []);

  // Mic permission check — routed through the app's shared
  // ensureMediaPermission()/PermissionDeniedSheet (the same one Gallery
  // uses) instead of the old ad hoc getUserMedia probe with a bare toast.
  // That's a confirmed gap this pass closes: a denied/blocked permission
  // now gets the real recovery UI (deep link to OS settings on native,
  // written steps on web, a "Try again" that re-checks) instead of a
  // dead-end toast the person had no way to act on. Camera is left for
  // The call engine to request at join time on WEB (unchanged) — probing it here
  // via ensureMediaPermission's web branch does a real getUserMedia probe
  // that would race cameraBus/PeekGuard for the camera before
  // pauseCameraConsumers() below has a chance to hand it over cleanly.
  //
  // BUG FIX (camera never opens on native video calls): that reasoning
  // does NOT hold on native. A bare getUserMedia({video:true}) inside
  // The call engine's join() never surfaces the OS camera-permission prompt inside
  // a Capacitor WebView the way it does in a real browser — the app has
  // to request it through the native plugin bridge first, exactly like
  // QRSignInScanner already does before it starts scanning. Without that,
  // native joins silently got camera:false from the OS forever (no prompt
  // ever shown), which is why video calls looked like they "never open
  // the camera" — the call engine wasn't broken, permission was never granted.
  // ensureMediaPermission("camera") on native calls Capacitor's
  // Camera.checkPermissions()/requestPermissions() only — it never opens
  // an actual video stream, so unlike the web probe above it can't race
  // cameraBus/PeekGuard for the camera device. Safe to run here,
  // before pauseCameraConsumers() below.
  const requestMediaPermission = useCallback(async (mode: "video" | "voice") => {
    if (mode === "video" && Capacitor.isNativePlatform()) {
      const camGranted = await ensureCallMedia("camera", () => startCall(mode));
      if (!camGranted) return false;
    }
    return ensureCallMedia("microphone", () => startCall(mode));
  }, [ensureCallMedia]);

  const activeQuality = callState === "joined" ? callNetworkQuality : browserNetworkQuality;
  const quality = qualityLabels[activeQuality];

  // Self-preview drag/snap, and the whole in-call visual layer, now live in
  // the shared <CallStage/> component — see src/components/calls/CallStage.tsx.

  const startCall = async (mode: "video" | "voice") => {
    if (!user) return;
    // BUG FIX: guard against a fast double-tap calling startCall twice —
    // the permission prompt below is async, widening the window in which
    // a second tap could race a second joinCall() and trip the call engine's
    // "Duplicate call-object instances are not allowed" error.
    if (isStartingCall) return;
    // See startCallLockRef's comment above — this is the actual
    // synchronous guard; the isStartingCall check above is kept as a
    // cheap fast-path but can't be relied on alone.
    if (startCallLockRef.current) return;
    startCallLockRef.current = true;
    // The call session is now shared app-wide (see CallContext) so a call
    // started from the Chat page stays alive if the person navigates here
    // — check for that too, not just this page's own isStartingCall flag,
    // otherwise tapping "Call" here while already on a call elsewhere would
    // silently waste a room-creation request that joinCall() then has to
    // discard via its own re-entrancy guard.
    if (callState === "joining" || callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before starting a new one." });
      startCallLockRef.current = false;
      return;
    }
    try {
      await startCallImpl(mode);
    } finally {
      startCallLockRef.current = false;
    }
  };

  const startCallImpl = async (mode: "video" | "voice") => {

    // INSTANT FEEDBACK (WhatsApp-style): the full-screen calling UI is
    // gated on isStartingCall, so it must come up IMMEDIATELY — before
    // permission probing and any network round trips — with its honest
    // "Connecting…" stage. The old order (permissions first, state last)
    // left the button showing "Starting…" for the entire camera warm-up,
    // which is exactly the "I tap and nothing happens" lag.
    setIsStartingCall(true);
    callCancelledRef.current = false;
    beginCallLatencyTrace("outgoing", mode, activeProvider);
    setEverConnected(false);
    dismissOutcome();
    setCallMode(mode);
    setActiveCallType(mode);

    // RACE-SAFETY LAYER (see src/lib/callStateMachine.ts / CallContext.tsx's
    // matching comment on the accept-side wiring — this is the same
    // additive generation guard for the outgoing side, which previously had
    // no equivalent). Doesn't replace callCancelledRef/startCallLockRef
    // above; those remain the primary guards. RESET first if a previous
    // call session left the shared machine non-idle (mirrors the
    // callCancelledRef/isStartingCall resets on the lines just above).
    if (isTerminal(callMachineState.status) || callMachineState.status !== "IDLE") {
      dispatchCallEvent({ type: "RESET", source: "start-new-outgoing-call" });
    }
    // Reducer's own illegal-transition rejection (see callStateMachine.ts)
    // is what guards this attempt against being superseded later in this
    // function — no generation value needs to be captured here for that.
    dispatchCallEvent({ type: "START_OUTGOING", callType: mode, source: "user-tap" });

    // STUCK-FOREVER SAFETY NET: everything from here down to joinCall() is
    // the "pre-join" phase — busy check, permission prompt, room creation,
    // call_history insert. Individually most of these are already bounded
    // (invokeEdgeFunction has its own 25s timeout; the busy check now has
    // one below too), but this is a last-resort backstop for anything that
    // isn't — a hang here has NO other watchdog protecting it, unlike the
    // join phase itself (see the call engine adapter's join watchdog). Without
    // this, a stalled raw Supabase call could leave isStartingCall true
    // and the UI on "Connecting…" forever with nothing to break it out.
    // Cleared the instant startCall() actually finishes below; only fires
    // if something genuinely got stuck.
    const preJoinWatchdog = setTimeout(() => {
      if (callCancelledRef.current) return;
      callCancelledRef.current = true;
      setIsStartingCall(false);
      resumeCameraConsumers("call-start-timeout");
      toast({ title: "Call failed", description: "That took too long to start. Check your connection and try again.", variant: "destructive" });
    }, 40_000);

    // LATENCY FIX: the partner-busy check, the permission prompt, and
    // room creation used to run fully sequentially — three round trips
    // stacked in front of joinCall() even though none of them actually
    // need each other's result to *start*. is_partner_on_call only needs
    // partnerId, create-and-token only needs user.id, and the permission
    // prompt needs neither. Firing all three the instant the button is
    // tapped means their latencies overlap instead of adding up — this is
    // on top of (not instead of) the create-and-token merge and the
    // deferred call_history insert already below, which were the previous
    // pass's fixes for this same tap-to-ringing path.
    // STUCK-FOREVER FIX: raw `supabase.rpc()` has no timeout of its own —
    // unlike invokeEdgeFunction below, a stalled fetch here would hang
    // forever, never hitting the .catch() (that only handles a REJECTION,
    // not a promise that simply never settles) — and since this is
    // `await`ed before anything else, the whole call would never progress
    // past "Connecting…". withTimeout bounds it to 8s; either way this
    // check is advisory only, so timing out is treated the same as any
    // other failure (proceed as if busy status is unknown).
    const busyCheckPromise: Promise<{ data: boolean | null }> = partnerId
      ? withTimeout(
          supabase.rpc("is_partner_on_call" as never, { p_partner_id: partnerId } as never) as PromiseLike<{ data: boolean | null }>,
          8_000, "Partner busy check",
        ).catch(() => ({ data: null as boolean | null }))
      : Promise.resolve({ data: null as boolean | null });
    // Self-hosted is the only provider: authenticated DuoSpace WebSocket
    // signaling for call control, LiveKit for media. Started here so it
    // overlaps the busy check / permission prompt. Failure fails the call —
    // no Supabase-Realtime fallback.
    const signalingReadyPromise = signalingBridge.ensureReady({ timeoutMs: 5_000 });
    const permissionPromise = requestMediaPermission(mode);
    const discardRoom = () => { /* nothing is pre-created on the self-hosted path */ };
    let startedCallId: string | null = null;

    // HONEST BUSY PRE-CHECK: if the partner is already on a DuoSpace call,
    // say so NOW instead of ringing a phone that can't answer. Uses the
    // is_partner_on_call SECURITY DEFINER helper because call_history RLS
    // only exposes rows the viewer participates in — this deliberately
    // leaks exactly one bit (busy / not busy), nothing else. Advisory:
    // any failure here never blocks the call attempt.
    const { data: partnerBusy } = await busyCheckPromise;
    if (partnerBusy === true) {
      clearTimeout(preJoinWatchdog);
      setIsStartingCall(false);
      discardRoom();
      dispatchCallEvent({ type: "BUSY", source: "partner-busy-check" });
      finishCallLatencyTrace("failed", undefined, "PARTNER_BUSY");
      toast({
        title: `${partnerName || "Your partner"} is on a call`,
        description: "They're currently on another DuoSpace call. Try again in a few minutes.",
      });
      return;
    }

    // Permissions next — still inside the visible calling screen, so the
    // OS prompt appears over honest "Connecting…" rather than over nothing.
    const hasPermission = await permissionPromise;
    if (!hasPermission) {
      clearTimeout(preJoinWatchdog);
      setIsStartingCall(false);
      discardRoom();
      dispatchCallEvent({ type: "FAILED", source: "permission-denied" });
      finishCallLatencyTrace("failed", undefined, "PERMISSION_DENIED");
      return;
    }
    // From here on, roomPromise (25s timeout) and joinCall()'s own join
    // watchdog (the call engine adapter, 25s) between them cover the rest of the
    // path to "joined" — the pre-join watchdog's job (guarding the
    // otherwise-unbounded busy-check/permission window above) is done.
    clearTimeout(preJoinWatchdog);
    // Hand the camera to the call: stop PeekGuard / MoodDetector / face
    // enrollment streams so the call engine can claim the device cleanly.
    pauseCameraConsumers("call-start");

    // PHASE 2 WIRING (calling-architecture migration): self-hosted takes a
    // completely separate path from here rather than branching inside the
    // The call engine block below — see createOutgoingCallRoom.ts's own doc comment
    // for exactly why the ordering has to differ (call_history must exist
    // BEFORE joinCall for self_hosted, the opposite of the call engine's
    // insert-overlaps-with-join optimization just below). This mirrors
    // The call engine branch's own busy-check/permission/watchdog/cancellation/
    // error handling as closely as the reordering allows, but is a
    // parallel implementation, not a shared one — NOT RUNTIME-VERIFIED,
    // see docs/calling-architecture-v2.md's Phase 2 section.
    {
      try {
        const ready = await signalingReadyPromise;
        if (!ready.ready) throw signalingNotReadyError(ready);
        markCallLatency("signaling_ready");
        const room = await createOutgoingCallRoom("self_hosted", {
          userId: user.id,
          insertCallHistoryForSelfHosted: async ({ callId, roomName }) => {
            const { data, error } = await supabase.from("call_history").insert({
              id: callId,
              caller_id: user.id,
              receiver_id: partnerId,
              call_type: mode,
              call_direction: "outgoing",
              status: "in_progress",
              room_name: roomName,
              started_at: new Date().toISOString(),
              // REMEDIATION P0-2: every call_history insert must set this
              // explicitly — the column defaults to 'daily' in
              // 20260916130000_call_history_provider_column.sql, so a
              // self-hosted call whose insert omitted this would be
              // silently mis-recorded as the call engine, corrupting the very
              // provider-comparison telemetry the column exists for.
              provider: "self_hosted",
            } as never).select().single();
            if (error || !data) throw error ?? new Error("call_history insert failed");
            const row = data as { id: string; session_id?: string | null };
            return { id: row.id, sessionId: row.session_id ?? "" };
          },
        });
        if (room.provider !== "self_hosted") throw new Error("createOutgoingCallRoom returned the wrong provider shape");

        if (callCancelledRef.current) {
          // Cancelled while the insert above was in flight — the row
          // already exists (unlike the call engine's equivalent bailout, which
          // deletes an orphaned the call engine room instead), so mark it cancelled
          // rather than leaving it 'in_progress' ringing the recipient.
          await cancelOutgoingCall(room.roomId);
          dispatchCallEvent({ type: "CANCELLED", source: "cancelled-before-join" });
          finishCallLatencyTrace("cancelled");
          setIsStartingCall(false);
          return;
        }

        startedCallId = room.roomId;
        setCurrentCallId(room.roomId);
        setCallLatencyIds({ callId: room.roomId, sessionId: room.sessionId });
        markCallLatency("call_session_created");
        dispatchCallEvent({ type: "OUTGOING_SESSION_CREATED", callId: room.roomId, source: "insert-resolved" });
        void reportOutgoingCallStarted(room.roomId, partnerName || "Partner", mode === "video");
        dispatchCallEvent({ type: "CONNECTING", source: "insert-resolved" });
        // PHASE 4: CALL_OFFER over the WebSocket IS the ring. The row is
        // persisted first (the gateway authorizes the offer against it and
        // livekit-token authorizes against it), then the offer goes out and
        // we WAIT for the gateway's answer — DELIVERED to the live callee,
        // or RECIPIENT_OFFLINE (the push/native path rings them). Anything
        // else means the callee was not rung through the call-control layer:
        // stop the DB-side ring and fail clearly. Supabase Realtime is not
        // awaited for anything here.
        const invite = await signalingBridge.offer({ callId: room.roomId, sessionId: room.sessionId, peerId: partnerId, callType: mode });
        if (!isServerAccepted(invite)) {
          await cancelOutgoingCall(room.roomId, "signaling_invite_failed");
          setCurrentCallId(null);
          throw inviteFailureError(invite);
        }
        markCallLatency("invite_sent");

        if (callCancelledRef.current) {
          await cancelOutgoingCall(room.roomId);
          dispatchCallEvent({ type: "CANCELLED", source: "cancelled-before-join" });
          finishCallLatencyTrace("cancelled");
          void reportCallEndedNative("unanswered");
          clearActiveCallSession();
          setIsStartingCall(false);
          return;
        }

        await joinCall(room.roomId, undefined, mode === "voice");

        if (callCancelledRef.current) {
          await cancelOutgoingCall(room.roomId);
          dispatchCallEvent({ type: "CANCELLED", source: "cancelled-during-join" });
          finishCallLatencyTrace("cancelled");
          void reportCallEndedNative("unanswered");
          clearActiveCallSession();
          setIsStartingCall(false);
          return;
        }

        // CONNECTED only once the partner has answered AND their audio is
        // actually playing. The caller is in the room while the partner's
        // phone rings, so the participant wait is bounded by the ring window;
        // decline / ring-timeout / hang-up leave the call, which resolves
        // these waits immediately as `stale`.
        const outgoingCallId = room.roomId;
        const media = await awaitCallMedia({
          waitForRemoteParticipant, waitForRemoteAudioReady, retryRemoteAudioPlayback,
          isCurrent: () => !callCancelledRef.current && isActiveCall(outgoingCallId)
            && callMachineRef.current.session.callId === outgoingCallId && !isTerminal(callMachineRef.current.status),
          onDegraded: () => { markCallLatency("media_degraded"); dispatchCallEvent({ type: "MEDIA_DEGRADED", source: "remote-audio-timeout" }); },
        }, { participantTimeoutMs: CALLER_PARTICIPANT_TIMEOUT_MS });
        if (media.result === "stale") {
          // Declined / ring timeout / hang-up already cleaned up via their own
          // paths. If the ENGINE dropped the room by itself (LiveKit failure)
          // while still ringing, close the call out here.
          if (!callCancelledRef.current && !isActiveCall(outgoingCallId) && callMachineRef.current.session.callId === outgoingCallId && !isTerminal(callMachineRef.current.status)) {
            await cancelOutgoingCall(outgoingCallId, "media_lost_before_connect").catch(() => false);
            dispatchCallEvent({ type: "FAILED", source: "media-lost-before-connect" });
            finishCallLatencyTrace("failed", undefined, "MEDIA_LOST");
            void reportCallEndedNative("failed");
            clearActiveCallSession();
          }
          setIsStartingCall(false);
          return;
        }
        if (media.result !== "connected") {
          leaveCall();
          await cancelOutgoingCall(room.roomId, media.result).catch(() => false);
          setCurrentCallId(null);
          dispatchCallEvent({ type: "FAILED", source: media.result });
          finishCallLatencyTrace("failed", undefined, media.result === "no_remote_audio" ? "REMOTE_AUDIO_TIMEOUT" : "REMOTE_PARTICIPANT_TIMEOUT");
          void reportCallEndedNative("failed");
          clearActiveCallSession();
          resumeCameraConsumers("call-media-failed");
          toast({ title: "Couldn't connect call", description: mediaFailureMessage(media), variant: "destructive" });
          setIsStartingCall(false);
          return;
        }
        dispatchCallEvent({ type: "CONNECTED", source: media.degraded ? "remote-audio-late" : "remote-audio-ready" });
        void reportCallNowConnected(room.roomId, mode === "video");
        // roomUrl has no real meaning for self_hosted (there is no the call engine-
        // style joinable URL) — session.callId is what rejoinRecoveredCall
        // actually uses for this provider (see CallContext.tsx's own
        // provider branch there); this field is kept populated only so
        // callSessionRecovery.ts's stored shape stays consistent.
        persistActiveCallSession({ callId: room.roomId, roomUrl: room.roomId, callType: mode, direction: "outgoing", partnerName: partnerName || "Partner" });

        finishCallLatencyTrace("connected");
      } catch (err: unknown) {
        resumeCameraConsumers("call-start-failed");
        if ((err as Error | null)?.name === "JoinCancelledError") {
          // The person cancelled while joining: cancelStartingCall already
          // ended the session. Not a failure — no error UI.
          finishCallLatencyTrace("cancelled");
          setIsStartingCall(false);
          return;
        }
        // DETERMINISTIC CLEANUP after the call row exists (token/LiveKit
        // connect/join failure): release media, cancel over signaling +
        // persistence so the callee stops ringing and history is correct.
        if (startedCallId) {
          leaveCall();
          await cancelOutgoingCall(startedCallId, "join_failed").catch(() => false);
          setCurrentCallId(null);
        }
        dispatchCallEvent({ type: "FAILED", source: "start-call-exception" });
        finishCallLatencyTrace("failed", undefined, classifyCallError(err).code);
        void reportCallEndedNative("failed");
        clearActiveCallSession();
        if (classifyCallError(err).code === "PERMISSION_DENIED") {
          const kind = permissionKindForCallFailure(mode, extractErrorMessage(err));
          if (kind === "microphone") invalidateNativeMicGrantCache();
          reportCallMediaFailure(fromGumError(kind, err), () => startCall(mode));
        } else {
          toast({ title: "Call failed", description: extractErrorMessage(err), variant: "destructive" });
        }
      }
      setIsStartingCall(false);
      return;
    }
  };

  const endCall = () => {
    // Instant: media + UI go down now; history is finalized in the
    // background (see CallContext.hangUpCall), then the list refreshes.
    const callId = currentCallId;
    const uid = user?.id;
    setCurrentCallId(null);
    hangUpCall(callId, {
      onHistoryWritten: () => {
        if (!uid) return;
        void supabase
          .from("call_history")
          .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,declined_at,cancel_reason,created_at")
          .or(`caller_id.eq.${uid},receiver_id.eq.${uid}`)
          .order("started_at", { ascending: false })
          .limit(50)
          .then(({ data: history }) => { if (history) setCallHistory(history as CallRecord[]); }, () => {});
      },
    });
    resumeCameraConsumers("call-end");
    toast({ title: "Call ended" });
  };

  // BUG FIX (call latency): cancel a call that's still in the pre-join
  // network setup phase (create-and-token / call_history insert), reachable
  // now that the call screen — and its hang-up button — shows up the
  // instant the call button is tapped instead of only once actually
  // joined. Sets callCancelledRef so startCall()'s in-flight work bails
  // out instead of joining a call the person already backed out of.
  const cancelStartingCall = () => {
    callCancelledRef.current = true;
    // PHASE 4 (self-hosted): if the row/offer already exist, stop the callee's
    // ring NOW instead of after the in-flight join finishes. Idempotent with
    // the bail-out inside startCall() (cancel_call refuses a second time).
    if (currentCallId) void cancelOutgoingCall(currentCallId);
    dispatchCallEvent({ type: "CANCELLED", source: "cancel-starting-call-button" });
    finishCallLatencyTrace("cancelled");
    leaveCall(); // safe no-op if joinCall() hasn't created a call object yet
    void reportCallEndedNative("unanswered");
    clearActiveCallSession();
    setIsStartingCall(false);
    resumeCameraConsumers("call-cancelled");
    toast({ title: "Call cancelled" });
  };

  // Safety net: if the call ever leaves an active state without endCall()
  // being invoked (error, peer drop, or programmatic leave), make sure
  // PeekGuard / MoodDetector can reclaim the camera.
  useEffect(() => {
    if (callState === "idle" || callState === "error") {
      resumeCameraConsumers(`callstate-${callState}`);
    }
  }, [callState]);

  const deleteCallRecord = async (id: string) => {
    await supabase.from("call_history").delete().eq("id", id);
    setCallHistory((prev) => prev.filter((c) => c.id !== id));
  };

  // Terminal outcome (declined / timed out / cancelled elsewhere) — takes
  // priority over the hub since leaveCall() has already run by the time
  // this is set (see useCallOutcome's onRemoteEnded above).
  if (outcome) {
    return (
      <>
        <CallOutcomeScreen
          outcome={outcome}
          partnerName={partnerName || "Partner"}
          onCallAgain={() => { dismissOutcome(); startCall(callMode); }}
          onDismiss={dismissOutcome}
        />
        {callPermissionSheet}
      </>
    );
  }

  // Explicit error state — correct primary action (retry the same call
  // mode) and secondary action (back to the hub), instead of relying on
  // the small inline banner further down to be the only feedback.
  if (callState === "error") {
    return (
      <>
        <CallErrorScreen error={error} onRetry={() => startCall(callMode)} onBack={leaveCall} />
        {callPermissionSheet}
      </>
    );
  }

  // In-call UI — the entire visual layer (ringing/connecting/connected,
  // controls, self-preview, camera/route pickers, etc.) lives in the
  // shared <CallStage/> component so this page and Chat.tsx's CallOverlay
  // render byte-for-byte the same screen. See CallStage.tsx.
  // BUG FIX (call latency): this used to gate on callState alone, which
  // only becomes "joining" deep inside joinCall() — itself called only
  // after the create-and-token network call and the call_history insert
  // both complete. Including isStartingCall here means this whole screen
  // appears the instant the button is tapped, and the actual network
  // setup happens behind it instead of in front of it.
  if ((isStartingCall || isAcceptingCall || callState === "joined" || callState === "joining") && !isCallMinimized) {
    return (
      <>
        <CallStage
          isStartingCall={isStartingCall || isAcceptingCall}
          cancelStartingCall={cancelStartingCall}
          endCall={endCall}
          callMode={callMode}
          everConnected={everConnected}
          partnerAvatar={partnerAvatar}
          partnerName={partnerName}
          ringHint={ringHint}
          showLipReading={showLipReading}
          setShowLipReading={setShowLipReading}
        />
        {callPermissionSheet}
      </>
    );
  }
  return (
    <>
    {/* Fallback minimized-call banner — MinimizedCallBubble (mounted once
        in CallProvider, app-wide) now handles the common case: a video
        call minimized while accepting/joining/joined shows as a small
        draggable video PiP instead of this plain text pill, and it isn't
        tied to this one page. This banner only still fires for the
        narrow gap that bubble can't cover — isStartingCall (the
        page-local pre-join ringback, before callState even leaves
        "idle"), which doesn't live in shared CallContext. The `!(...)`
        clause is the exact negation of MinimizedCallBubble's own gate, so
        the two are mutually exclusive and never show at the same time
        for the same call. */}
    <AnimatePresence>
      {(isStartingCall || isAcceptingCall || callState === "joined" || callState === "joining") && isCallMinimized
        && !(isAcceptingCall || callState === "joining" || callState === "joined") && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
          onClick={() => { hapticSelection(); setIsCallMinimized(false); }}
          className="fixed left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-full glass-sheet shadow-lg"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
        >
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground">{partnerName || "Call"} · {formatDuration(callDuration)}</span>
          <span
            role="button" tabIndex={0} aria-label="End call"
            onClick={(e) => { e.stopPropagation(); hapticHeavy(); if (isAcceptingCall) cancelAcceptingCall(); else if (callState === "idle") cancelStartingCall(); else endCall(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); if (isAcceptingCall) cancelAcceptingCall(); else if (callState === "idle") cancelStartingCall(); else endCall(); } }}
            className="h-6 w-6 rounded-full bg-destructive flex items-center justify-center shrink-0">
            <PhoneOff className="h-3 w-3 text-call-stage-foreground" aria-hidden="true" />
          </span>
        </motion.button>
      )}
    </AnimatePresence>
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Calls" subtitle="Stay connected" />

      <div className="px-5 space-y-6" style={{ paddingBottom: bottomInset }}>
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="glass-subtle flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl">
          <span className={`h-1.5 w-1.5 rounded-full ${quality.dot}`} />
          <p className="text-[12px] text-muted-foreground flex-1">
            {quality.label} connection · {quality.resolution}
          </p>
          <Wifi className={`h-3.5 w-3.5 ${quality.color}`} aria-hidden="true" />
        </div>

        <div className="flex gap-3">
          <button onClick={() => { hapticMedium(); startCall("voice"); }} disabled={isStartingCall}
            aria-label="Start voice call"
            className="glass-subtle flex-1 rounded-2xl p-5 flex flex-col items-center gap-3 active:scale-[0.98] transition-transform disabled:opacity-50">
            <div className="h-14 w-14 rounded-full bg-primary flex items-center justify-center">
              <Phone className="h-6 w-6 text-primary-foreground" aria-hidden="true" />
            </div>
            <span className="text-sm font-medium">{isStartingCall ? "Starting..." : "Voice Call"}</span>
          </button>
          <button onClick={() => { hapticMedium(); startCall("video"); }} disabled={isStartingCall}
            aria-label="Start video call"
            className="glass-subtle flex-1 rounded-2xl p-5 flex flex-col items-center gap-3 active:scale-[0.98] transition-transform disabled:opacity-50">
            <div className="h-14 w-14 rounded-full bg-primary flex items-center justify-center">
              <Video className="h-6 w-6 text-primary-foreground" aria-hidden="true" />
            </div>
            <span className="text-sm font-medium">{isStartingCall ? "Starting..." : "Video Call"}</span>
          </button>
        </div>

        <div>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Recent</h2>
          {historyLoading && callHistory.length === 0 ? (
            <CallHistorySkeleton />
          ) : callHistory.length === 0 ? (
            // Phase 2.5, section 18: "if there are no calls, create a
            // beautiful minimal empty state" — was a single centered gray
            // sentence. Kept genuinely minimal (no illustration/card),
            // just a quiet icon + two-line message consistent with the
            // rest of the page's restraint.
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Phone className="h-5 w-5 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">No calls yet</p>
              <p className="text-xs text-muted-foreground/60">Start your first call above</p>
            </div>
          ) : (
            <div>
              {callHistory.map((call, i) => {
                const direction = call.caller_id === user?.id ? "outgoing" : "incoming";
                const outcome = classifyCallOutcome(call);
                return (
                  <CallHistoryRow key={call.id} call={call} index={i} outcome={outcome}
                    direction={direction} onDelete={deleteCallRecord}
                    partnerAvatar={partnerAvatar} partnerName={partnerName}
                    isLast={i === callHistory.length - 1} />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
    {callPermissionSheet}
    </>
  );
};

export default Calls;
