import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Video, Wifi, PhoneOff } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import { pauseCameraConsumers, resumeCameraConsumers } from "@/lib/cameraBus";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { hapticMedium, hapticHeavy, hapticSelection } from "@/lib/haptics";
import { withTimeout } from "@/lib/withTimeout";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { fromGumError, invalidateNativeMicGrantCache } from "@/lib/mediaPermissions";
import { classifyCallError } from "@/lib/callErrors";
import { useCallOutcome } from "@/hooks/useCallOutcome";
import { deriveCallUiState } from "@/lib/callUiState";
import CallOutcomeScreen from "@/components/calls/CallOutcomeScreen";
import CallStage from "@/components/calls/CallStage";
import CallHistoryRow from "@/components/calls/CallHistoryRow";
import CallErrorScreen from "@/components/calls/CallErrorScreen";
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

// A Daily.co join permission failure doesn't say which device it was — but
// we usually know enough to guess accurately: a voice call never opens the
// camera at all, so any permission failure there has to be the mic; a video
// call's failure could be either, so fall back to sniffing the raw error
// text before defaulting to "camera" (Daily requests camera first for video
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
  // Tracks whether *this* call session has ever had a second participant
  // join, so "no one else is here" can be told apart between "still
  // ringing" and "they left" — see src/lib/callUiState.ts.
  const [everConnected, setEverConnected] = useState(false);
  // Honest ringing-stage hint (e.g. "their phone is on silent") — set once
  // per ring from the partner's device-status sync, cleared when the ring
  // ends; see the effect near useCallOutcome below.
  const [ringHint, setRingHint] = useState<string | null>(null);

  const {
    joinCall, leaveCall, callState,
    networkQuality: callNetworkQuality, participantCount, error, callError,
    callDuration, autoAudioFallback,
    activeCallId: currentCallId, setActiveCallId: setCurrentCallId, isAcceptingCall, cancelAcceptingCall,
    setActiveCallType, isCallMinimized, setIsCallMinimized,
  } = useCall();

  useEffect(() => {
    if (participantCount > 1) setEverConnected(true);
  }, [participantCount]);

  const { ensure: ensureCallMedia, report: reportCallMediaFailure, permissionSheet: callPermissionSheet } = useMediaPermission();

  const callUiState = deriveCallUiState({
    callState, isStartingCall, participantCount, everConnected,
    networkQuality: callNetworkQuality,
  });

  // A permission failure that surfaces through Daily's own join attempt
  // never throws back to startCall()'s try/catch — useDailyCall absorbs
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
    leaveCall();
    resumeCameraConsumers("call-remote-ended");
    setCurrentCallId(null);
    setIsStartingCall(false);
  }, [leaveCall, setCurrentCallId]);
  const { outcome, dismissOutcome, reportNoAnswer } = useCallOutcome({
    currentCallId,
    everConnected,
    onRemoteEnded: finishUnansweredCall,
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

  // Load partner + call history
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: profile } = await supabase.from("profiles").select("partner_id, pet_name").eq("user_id", user.id).single();
      if (profile?.partner_id) {
        setPartnerId(profile.partner_id);
        // Name for the ringing/outcome/partner-left screens below — this
        // page previously had no notion of the partner's display name at
        // all (only their id), so those states could only ever say
        // "Partner" generically.
        const { data: pp } = await supabase.from("profiles")
          .select("display_name, avatar_url").eq("user_id", profile.partner_id).single();
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
      if (history) setCallHistory(history as CallRecord[]);
    };
    load();
  }, [user]);

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
  // dead-end toast the person had no way to act on. Camera is still left
  // for Daily.co to request at join time, unchanged — probing it here
  // would race cameraBus/PeekGuard for the camera before
  // pauseCameraConsumers() below has a chance to hand it over cleanly. A
  // camera-permission failure surfaced later by joinCall() itself is
  // caught in startCall()'s catch block and routed through the same
  // sheet via reportCallMediaFailure.
  const requestMediaPermission = useCallback(async (mode: "video" | "voice") => {
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
    // a second tap could race a second joinCall() and trip Daily's
    // "Duplicate DailyIframe instances are not allowed" error.
    if (isStartingCall) return;
    // The call session is now shared app-wide (see CallContext) so a call
    // started from the Chat page stays alive if the person navigates here
    // — check for that too, not just this page's own isStartingCall flag,
    // otherwise tapping "Call" here while already on a call elsewhere would
    // silently waste a room-creation request that joinCall() then has to
    // discard via its own re-entrancy guard.
    if (callState === "joining" || callState === "joined") {
      toast({ title: "Already on a call", description: "End the current call before starting a new one." });
      return;
    }

    // INSTANT FEEDBACK (WhatsApp-style): the full-screen calling UI is
    // gated on isStartingCall, so it must come up IMMEDIATELY — before
    // permission probing and any network round trips — with its honest
    // "Connecting…" stage. The old order (permissions first, state last)
    // left the button showing "Starting…" for the entire camera warm-up,
    // which is exactly the "I tap and nothing happens" lag.
    setIsStartingCall(true);
    callCancelledRef.current = false;
    setEverConnected(false);
    dismissOutcome();
    setCallMode(mode);
    setActiveCallType(mode);

    // STUCK-FOREVER SAFETY NET: everything from here down to joinCall() is
    // the "pre-join" phase — busy check, permission prompt, room creation,
    // call_history insert. Individually most of these are already bounded
    // (invokeEdgeFunction has its own 25s timeout; the busy check now has
    // one below too), but this is a last-resort backstop for anything that
    // isn't — a hang here has NO other watchdog protecting it, unlike the
    // join phase itself (see useDailyCall.ts's join watchdog). Without
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
    const busyCheckPromise = partnerId
      ? withTimeout(
          supabase.rpc("is_partner_on_call" as never, { p_partner_id: partnerId } as never),
          8_000, "Partner busy check",
        ).catch(() => ({ data: null as boolean | null }))
      : Promise.resolve({ data: null as boolean | null });
    const roomPromise = invokeEdgeFunction<{ name: string; url: string; token: string }>("daily-call", {
      body: { action: "create-and-token", roomName: `duo-${user.id.slice(0, 8)}-${Date.now()}` },
      timeoutMs: 25_000,
    });
    // Prevents an unhandled-rejection warning while we're still awaiting
    // the busy check / permission below — the real error (if any) is
    // still surfaced when roomPromise is actually awaited further down.
    roomPromise.catch(() => {});
    const permissionPromise = requestMediaPermission(mode);
    // Best-effort cleanup for every early-bailout path below: deletes the
    // room we may have already created concurrently instead of leaving it
    // orphaned on Daily's side.
    const discardRoom = () => {
      roomPromise.then((d) => {
        invokeEdgeFunction("daily-call", { body: { action: "delete-room", roomName: d.name } }).catch(() => {});
      }).catch(() => {});
    };

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
      return;
    }
    // From here on, roomPromise (25s timeout) and joinCall()'s own join
    // watchdog (useDailyCall.ts, 25s) between them cover the rest of the
    // path to "joined" — the pre-join watchdog's job (guarding the
    // otherwise-unbounded busy-check/permission window above) is done.
    clearTimeout(preJoinWatchdog);
    // Hand the camera to the call: stop PeekGuard / MoodDetector / face
    // enrollment streams so Daily.co can claim the device cleanly.
    pauseCameraConsumers("call-start");
    try {
      // BUG FIX (call latency): this used to be two fully sequential
      // invokeEdgeFunction round trips ("create-room" then "get-token",
      // only starting the second after the first fully resolved) before
      // joinCall() could even begin. "create-and-token" does both Daily
      // API calls back-to-back on the server, so the client only pays for
      // one round trip's worth of network + Supabase Functions overhead
      // instead of two. It's now also started at the very top of this
      // function (see roomPromise above) instead of only after
      // permissions resolve, so by the time we get here it has often
      // already finished.
      // CONNECT-RELIABILITY FIX: create-and-token performs TWO Daily REST
      // calls plus key-resolution DB reads server-side; on a cold-started
      // edge function that legitimately takes longer than the 15s default
      // and surfaced as "unable to connect". 25s covers the cold path
      // without hanging the UI (the join watchdog below this stack is 25s
      // from ITS OWN later start point, so the two don't compound).
      const data = await roomPromise;

      if (callCancelledRef.current) {
        // Cancelled while the network setup above was in flight — don't
        // join a call the person already backed out of. Best-effort clean
        // up the room we just created rather than leaving it orphaned.
        invokeEdgeFunction("daily-call", { body: { action: "delete-room", roomName: data.name } }).catch(() => {});
        return;
      }

      // Save call to history — Fix #4: store full room URL so receiver can join.
      // BUG FIX (call latency): this DB insert doesn't need to finish
      // before joinCall() starts — nothing about actually joining the
      // Daily room depends on the call_history row existing yet, only
      // endCall() (much later) does. Kicking it off without awaiting and
      // only awaiting the result *after* joinCall() lets its round trip
      // overlap with the (much longer) WebRTC join instead of adding to
      // the critical path in front of it.
      callStartTimeRef.current = new Date();
      const insertPromise = supabase.from("call_history").insert({
        caller_id: user.id,
        receiver_id: partnerId,
        call_type: mode,
        call_direction: "outgoing",
        status: "in_progress",
        room_name: data.url,  // Fix #4: full URL, not just name
        started_at: new Date().toISOString(),
      } as never).select().single();

      await joinCall(data.url, data.token, mode === "voice"); // CALL-02 FIX: videoOff flag
      const { data: callRecord } = await insertPromise;
      // Cancellation flow (item 9) — same reasoning as Chat.tsx's startCall:
      // cancelStartingCall() may have already run while the insert/join
      // above were in flight, before it had a row id to act on. Mark the
      // row 'cancelled' here instead of leaving a stale 'in_progress' row
      // ringing the recipient — this is what fires the VoIP "cancel" push
      // (notify_voip_on_call_end trigger) to end CallKit ringing elsewhere.
      if (callCancelledRef.current) {
        if (callRecord) {
          await supabase.rpc("cancel_call" as any, { _call_id: (callRecord as { id: string }).id });
        }
        return;
      }
      if (callRecord) setCurrentCallId((callRecord as { id: string }).id);

      // Camera enumeration for the switch-camera picker now happens inside
      // <CallStage/> itself once the call is joined — see its own effect.
      toast({ title: mode === "video" ? "Video call started 📹" : "Voice call started 📞" });
    } catch (err: unknown) {
      // Restore other camera consumers if the call failed to start.
      resumeCameraConsumers("call-start-failed");
      // Camera permission is only requested by Daily.co itself once
      // joinCall() actually opens the room (see requestMediaPermission's
      // comment above), so a denial surfaces here rather than up front.
      // Route it through the same recovery sheet the mic check uses,
      // instead of a dead-end toast, when that's what actually happened.
      if (classifyCallError(err).code === "PERMISSION_DENIED") {
        const kind = permissionKindForCallFailure(mode, extractErrorMessage(err));
        if (kind === "microphone") invalidateNativeMicGrantCache();
        reportCallMediaFailure(fromGumError(kind, err), () => startCall(mode));
      } else {
        toast({ title: "Call failed", description: extractErrorMessage(err), variant: "destructive" });
      }
    }
    setIsStartingCall(false);
  };

  const endCall = async () => {
    // Update call history with duration
    if (currentCallId && user) {
      const duration = callDuration;
      // State-machine fix (item 1) — same reasoning as Chat.tsx's endCall:
      // only transition a still-'in_progress' call to 'completed', never
      // clobber a terminal state (cancelled/missed) set elsewhere.
      await supabase.from("call_history").update({
        status: "completed",
        duration_seconds: duration,
        ended_at: new Date().toISOString(),
      } as never).eq("id", currentCallId).eq("status", "in_progress");

      // Refresh history
      const { data: history } = await supabase
        .from("call_history")
        .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,declined_at,created_at")
        .or(`caller_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order("started_at", { ascending: false })
        .limit(50);
      if (history) setCallHistory(history as CallRecord[]);
      setCurrentCallId(null);
    }
    leaveCall();
    // Allow PeekGuard / MoodDetector etc. to reopen the camera.
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
    leaveCall(); // safe no-op if joinCall() hasn't created a call object yet
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
    {/* Minimized-call banner — mirrors Chat.tsx's own; isCallMinimized is
        shared via CallContext so a minimize triggered from either call
        screen shows this instead of Calls.tsx's normal list, without
        needing to lift partner-name/duration into context. */}
    <AnimatePresence>
      {(isStartingCall || isAcceptingCall || callState === "joined" || callState === "joining") && isCallMinimized && (
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
          {callHistory.length === 0 ? (
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
                const isMissed = call.status === "missed" || (call.duration_seconds === 0 && call.status === "completed");
                // declined_at only ever gets set alongside status === "missed"
                // (see claim_call/cancel_call, migration
                // 20260824_call_declined_marker.sql), so this is already
                // implied by isMissed — spelled out anyway for clarity.
                const isDeclined = isMissed && !!call.declined_at;
                return (
                  <CallHistoryRow key={call.id} call={call} index={i} isMissed={isMissed}
                    isDeclined={isDeclined}
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
