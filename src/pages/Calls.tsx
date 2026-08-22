import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence, useMotionValue, animate as animateValue } from "framer-motion";
import { Phone, Video, Wifi, Mic, MicOff, VideoIcon, VideoOff, PhoneOff, Monitor, MonitorOff, Captions, PictureInPicture2, Volume2, Headphones, Bluetooth, Ear } from "lucide-react";
import { useAudioRoute } from "@/hooks/useAudioRoute";
import type { AudioRoute } from "duospace-audio-route";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { useToast } from "@/hooks/use-toast";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { pauseCameraConsumers, resumeCameraConsumers } from "@/lib/cameraBus";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { extractErrorMessage } from "@/lib/errorMessage";
import { hapticLight, hapticMedium, hapticHeavy, hapticSelection, hapticWarning } from "@/lib/haptics";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { fromGumError } from "@/lib/mediaPermissions";
import { classifyCallError } from "@/lib/callErrors";
import { useCallOutcome } from "@/hooks/useCallOutcome";
import { deriveCallUiState } from "@/lib/callUiState";
import { snappySpring, standardTransition } from "@/lib/motion";
import CallOutcomeScreen from "@/components/calls/CallOutcomeScreen";
import { ReconnectingBanner, AudioFallbackBanner, PartnerLeftBanner } from "@/components/calls/CallStatusBanner";
import CallHistoryRow from "@/components/calls/CallHistoryRow";
import CallErrorScreen from "@/components/calls/CallErrorScreen";

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

const RouteIcon = ({ type }: { type?: AudioRoute["type"] }) => {
  const props = { className: "h-5 w-5 text-call-stage-foreground", "aria-hidden": true as const };
  switch (type) {
    case "speaker": return <Volume2 {...props} />;
    case "bluetooth": return <Bluetooth {...props} />;
    case "wired_headset": return <Headphones {...props} />;
    default: return <Ear {...props} />;
  }
};

const Calls = () => {
  const { user } = useAuth();
  const { toast } = useToast();
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

  const {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras,
    isAudioOn, isVideoOn, isScreenSharing, callState,
    localVideoRef, remoteVideoRef, screenShareRef,
    networkQuality: callNetworkQuality, participantCount, error, callError,
    callDuration, autoAudioFallback,
    activeCallId: currentCallId, setActiveCallId: setCurrentCallId, isAcceptingCall,
    activeCallType, setActiveCallType,
  } = useCall();

  // BUG FIX (production ReferenceError: "Cannot access 'isVoiceCall' before
  // initialization" — DS-UNKNOWN-001): these two used to be declared much
  // further down this component (right before the self-preview section),
  // but `resetControlsIdleTimer`'s useEffect dependency array below reads
  // `isVoiceCall` on every render, and `toggleControlsVisible` reads it too.
  // A function component's body runs top-to-bottom on *every* render, so a
  // `const` read before its own declaration line has executed is a genuine
  // temporal-dead-zone violation — not intermittent, not device-specific,
  // it threw on every single mount of this page. Moved up to right after
  // the values they depend on (`activeCallType`, `callMode`, `isVideoOn`)
  // become available, i.e. before anything else in this component reads
  // them. See the CallContext.activeCallType doc comment for why this
  // isn't just `callMode` (that's only ever correct for the caller's own
  // page — an accepting device needs `activeCallType` instead).
  const effectiveCallType = activeCallType ?? callMode;
  const isVoiceCall = effectiveCallType === "voice" && !isVideoOn;

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
      reportCallMediaFailure(fromGumError("camera", { name: "NotAllowedError", message: callError.detail }), () => startCall(callMode));
    }
  }, [callError, reportCallMediaFailure, callMode]);

  // CONFIRMED BUG FIX — see useCallOutcome.ts: the caller previously had no
  // way to find out the receiver declined/timed out/the call was cancelled
  // from another session, and just sat on "Ringing…" forever.
  const { outcome, dismissOutcome } = useCallOutcome({
    currentCallId,
    everConnected,
    onRemoteEnded: () => {
      leaveCall();
      resumeCameraConsumers("call-remote-ended");
      setCurrentCallId(null);
      setIsStartingCall(false);
    },
  });

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

  const [cameras,        setCameras]        = useState<{ deviceId: string; label: string }[]>([]);
  const [showCamPicker,  setShowCamPicker]  = useState(false);
  const [showRoutePicker, setShowRoutePicker] = useState(false);

  // Phase 2.5, section 21 ("video is the entire experience... when idle,
  // controls fade/compress away; when the user taps, controls appear
  // quickly"). Real gap: controls were previously permanently visible for
  // the whole call. Scoped to VIDEO calls only — a voice call's small
  // glass control group is already minimal per section 20 and doesn't
  // sit over content the user is trying to see. Any control interaction
  // (mute/camera/etc, not just a bare tap) also resets the idle timer, so
  // hiding never happens mid-interaction.
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetControlsIdleTimer = useCallback(() => {
    setControlsVisible(true);
    if (controlsIdleTimerRef.current) clearTimeout(controlsIdleTimerRef.current);
    controlsIdleTimerRef.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);
  useEffect(() => () => { if (controlsIdleTimerRef.current) clearTimeout(controlsIdleTimerRef.current); }, []);
  // Start the idle countdown once a video call actually connects (not
  // during ringing/connecting, where controls should stay visible/absent
  // as appropriate — those states render their own centered UI anyway).
  useEffect(() => {
    if (callUiState === "connected" && !isVoiceCall) resetControlsIdleTimer();
    else setControlsVisible(true);
  }, [callUiState, isVoiceCall, resetControlsIdleTimer]);
  const toggleControlsVisible = useCallback(() => {
    if (isVoiceCall) return;
    if (controlsVisible) {
      setControlsVisible(false);
      if (controlsIdleTimerRef.current) clearTimeout(controlsIdleTimerRef.current);
    } else {
      resetControlsIdleTimer();
    }
  }, [isVoiceCall, controlsVisible, resetControlsIdleTimer]);
  const audioRoute = useAudioRoute(callState === "joined" || callState === "joining");
  // Real browser Picture-in-Picture (not the custom draggable local self-view
  // box already in the call UI below). Pops the remote video into the
  // OS-level floating PiP window. Feature-detected: unsupported WebViews
  // just don't show the button rather than showing one that silently fails.
  const [pipSupported, setPipSupported] = useState(false);
  const [isPip, setIsPip] = useState(false);
  useEffect(() => {
    setPipSupported(typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled);
  }, []);
  const togglePip = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (remoteVideoRef.current) {
        await remoteVideoRef.current.requestPictureInPicture();
      }
    } catch {
      // Some platforms reject requestPictureInPicture despite reporting
      // support (e.g. no video track yet) — fail silently, button stays usable.
    }
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

  // Load partner + call history
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: profile } = await supabase.from("profiles").select("partner_id").eq("user_id", user.id).single();
      if (profile?.partner_id) {
        setPartnerId(profile.partner_id);
        // Name for the ringing/outcome/partner-left screens below — this
        // page previously had no notion of the partner's display name at
        // all (only their id), so those states could only ever say
        // "Partner" generically.
        const { data: pp } = await supabase.from("profiles")
          .select("display_name, pet_name, avatar_url").eq("user_id", profile.partner_id).single();
        if (pp) {
          setPartnerName(pp.pet_name || pp.display_name || "Partner");
          setPartnerAvatar(pp.avatar_url || null);
        }
      }

      const { data: history } = await supabase
        .from("call_history")
        .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
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

  // ─── Self-preview: draggable, edge-snapping, safe-area aware ────────────
  // Phase 2: previously a bare framer `drag` with no constraints and no
  // snapping — it could be dragged anywhere, including under a notch/home
  // indicator, and stayed wherever it was released. `dragBoundsRef` marks
  // out a safe-area-padded draggable region; on release the preview snaps
  // to whichever of the 4 corners of that region it's nearest to.
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
    hapticLight();
  }, [previewX, previewY]);

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

    // Request permissions first
    const hasPermission = await requestMediaPermission(mode);
    if (!hasPermission) return;

    setIsStartingCall(true);
    callCancelledRef.current = false;
    setEverConnected(false);
    dismissOutcome();
    setCallMode(mode);
    setActiveCallType(mode);
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
      // instead of two.
      const data = await invokeEdgeFunction<{ name: string; url: string; token: string }>("daily-call", {
        body: { action: "create-and-token", roomName: `duo-${user.id.slice(0, 8)}-${Date.now()}` },
      });

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

      // Load available cameras for picker (includes OTG/dongle cameras)
      const cams = await listCameras();
      setCameras(cams);
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
        reportCallMediaFailure(fromGumError("camera", err), () => startCall(mode));
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
        .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
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

  // In-call UI
  // BUG FIX (call latency): this used to gate on callState alone, which
  // only becomes "joining" deep inside joinCall() — itself called only
  // after the create-and-token network call and the call_history insert
  // both complete. The button just showed a "Starting..." label for that
  // entire stretch with no other feedback. Including isStartingCall here
  // means this whole screen (with its own "Connecting..." state below)
  // appears the instant the button is tapped, and the actual network
  // setup happens behind it instead of in front of it.
  if (isStartingCall || isAcceptingCall || callState === "joined" || callState === "joining") {
    return (
      <>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col flex-1 min-h-0 bg-call-stage relative">
        {/* Phase 2: invisible safe-area-padded region the self-preview is
            allowed to be dragged within — see snapPreviewToNearestCorner. */}
        <div ref={dragBoundsRef} className="absolute pointer-events-none" style={{
          top: "calc(env(safe-area-inset-top, 0px) + 8px)",
          right: "calc(env(safe-area-inset-right, 0px) + 8px)",
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 116px)",
          left: "calc(env(safe-area-inset-left, 0px) + 8px)",
        }} />

        <video ref={remoteVideoRef} autoPlay playsInline onClick={toggleControlsVisible}
          className={`absolute inset-0 w-full h-full object-cover ${(isScreenSharing || isVoiceCall) ? "hidden" : ""}`} />
        <video ref={screenShareRef} autoPlay playsInline onClick={toggleControlsVisible}
          className="absolute inset-0 w-full h-full object-contain bg-black" style={{ display: "none" }} />

        {/* Phase 2: minimal cinematic voice-call layout — partner avatar,
            name, duration, nothing else. The remote <video> element above
            stays mounted (Daily still needs it for the audio track) but is
            hidden via className, not unmounted, so nothing about the call
            connection itself changes — this is presentation only. If the
            caller or the partner turns their camera on mid-call, this
            layout steps aside automatically (isVoiceCall depends on
            isVideoOn) and the normal video view takes over. */}
        {/* Phase 2.5, section 23 (call state-transition continuity): these
            three blocks are mutually exclusive (driven by the single
            callUiState value) but were three independent conditionally-
            rendered divs with no animation at all — connecting → ringing
            → connected was a hard instant cut every time. Wrapped in one
            AnimatePresence with a shared key so a state change crossfades
            instead. Presentation only: callUiState's derivation (callUiState.ts)
            and the underlying call state machine are untouched — this only
            changes how the same three states are drawn. Uses the shared
            standardTransition token (220ms) — the "shared call transition"
            tier in lib/motion.ts's own comment, and within the brief's
            220-300ms target for this exact category. FAST > CINEMATIC per
            the brief: default (simultaneous) exit+enter, NOT mode="wait" —
            that would sequence a full fade-out then fade-in (~440ms total)
            instead of a true ~220ms crossfade; all three blocks are
            `absolute inset-0` so overlapping them mid-transition is exactly
            what a crossfade needs, not a bug to guard against. */}
        <AnimatePresence initial={false}>
          {isVoiceCall && (callUiState === "connected" || callUiState === "reconnecting") && (
            <motion.div key="voice-connected" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={standardTransition}
              className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
              <div className="relative">
                {callUiState === "connected" && (
                  <motion.span
                    className="absolute inset-0 rounded-full bg-primary/25"
                    animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                    transition={{ repeat: Infinity, duration: 1.8, ease: "easeOut" }}
                    aria-hidden="true"
                  />
                )}
                <span className="relative h-28 w-28 rounded-full overflow-hidden bg-call-stage-foreground/10 flex items-center justify-center">
                  {partnerAvatar
                    ? <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                    : <span className="text-3xl font-serif text-call-stage-foreground/90">{(partnerName || "P").charAt(0).toUpperCase()}</span>}
                </span>
              </div>
              <div className="text-center">
                <p className="text-xl font-serif text-call-stage-foreground">{partnerName || "Partner"}</p>
                <p className="text-sm text-call-stage-foreground/60 mt-1 font-mono tabular-nums" role="status" aria-live="polite">
                  {callUiState === "reconnecting" ? "Reconnecting…" : formatDuration(callDuration)}
                </p>
              </div>
            </motion.div>
          )}

          {callUiState === "ringing" && (
            <motion.div key="ringing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={standardTransition}
              className="absolute inset-0 flex items-center justify-center">
              <div className="text-center text-call-stage-foreground/80">
                <div className="relative h-20 w-20 mx-auto mb-4">
                  <motion.span
                    className="absolute inset-0 rounded-full bg-call-stage-foreground/15"
                    animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                    transition={{ repeat: Infinity, duration: 1.8, ease: "easeOut" }}
                    aria-hidden="true"
                  />
                  <div className="relative h-20 w-20 rounded-full bg-call-stage-foreground/10 flex items-center justify-center overflow-hidden">
                    {isVoiceCall && partnerAvatar
                      ? <img src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                      : <Phone className="h-8 w-8" />}
                  </div>
                </div>
                <p className="text-lg font-serif" role="status" aria-live="polite">Ringing…</p>
                <p className="text-sm opacity-60 mt-1">Waiting for {partnerName || "your partner"} to answer</p>
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

        {/* Phase 2: self-preview — smaller, frameless, edge-snapping, and
            simply not rendered at all for a pure voice call with the
            camera off (nothing to preview). Reappears automatically the
            instant either party's camera comes on. */}
        {(!isVoiceCall || isVideoOn) && (
          <motion.div
            ref={previewRef}
            drag
            dragConstraints={dragBoundsRef}
            dragElastic={0.06}
            dragMomentum={false}
            onDragEnd={snapPreviewToNearestCorner}
            whileDrag={{ scale: 1.05 }}
            style={{
              x: previewX, y: previewY,
              top: "calc(env(safe-area-inset-top, 0px) + 64px)",
              right: "calc(env(safe-area-inset-right, 0px) + 8px)",
            }}
            className="absolute w-20 h-28 rounded-[20px] overflow-hidden shadow-lg ring-1 ring-call-stage-foreground/15 z-10 cursor-grab active:cursor-grabbing"
          >
            <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            {!isVideoOn && (
              <div className="absolute inset-0 bg-call-stage/80 flex items-center justify-center">
                <VideoOff className="h-5 w-5 text-call-stage-foreground/60" />
              </div>
            )}
          </motion.div>
        )}

        {/* Phase 2.5, section 21: idle auto-hide + quick tap-to-reveal for
            the status row, matching the control layer below so both
            "float above the video" as one coherent layer rather than the
            status bar staying pinned while only controls hide. ~180ms
            reveal via snappySpring, ~150ms fade on hide — inside the
            spec's 160-200ms reveal target. */}
        <motion.div
          animate={{ opacity: controlsVisible ? 1 : 0, y: controlsVisible ? 0 : -8 }}
          transition={controlsVisible ? snappySpring : { duration: 0.15 }}
          style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
          className="absolute top-4 left-4 right-16 z-10 flex items-center gap-2">
          <div className="bg-call-stage-foreground/20 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-2">
            <Wifi className="h-3.5 w-3.5 text-call-stage-foreground" />
            <span className="text-xs text-call-stage-foreground font-medium">{quality.resolution}</span>
          </div>
          {!isVoiceCall && (
            <div className="bg-call-stage-foreground/20 backdrop-blur-md rounded-full px-3 py-1.5">
              <span className="text-xs text-call-stage-foreground font-medium font-mono">{formatDuration(callDuration)}</span>
            </div>
          )}
          {isScreenSharing && (
            <div className="bg-primary/80 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1.5">
              <Monitor className="h-3 w-3 text-call-stage-foreground" />
              <span className="text-[10px] text-call-stage-foreground font-medium">Sharing</span>
            </div>
          )}
          {/* Lip reading toggle */}
          <button
            onClick={() => { hapticLight(); setShowLipReading(v => !v); resetControlsIdleTimer(); }}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`ml-auto rounded-full px-3 py-1.5 flex items-center gap-1.5 backdrop-blur-md ${
              showLipReading ? "bg-success/85" : "bg-call-stage-foreground/20"
            }`}
          >
            <Captions className="h-3.5 w-3.5 text-call-stage-foreground" aria-hidden="true" />
            <span className="text-[10px] text-call-stage-foreground font-medium">Lip Read</span>
          </button>
        </motion.div>

        {/* Lip reading overlay */}
        <AnimatePresence>
          {showLipReading && callState === "joined" && (
            <LipReadingOverlay
              videoRef={remoteVideoRef}
              onClose={() => setShowLipReading(false)}
            />
          )}
        </AnimatePresence>

        <motion.div
          animate={{ opacity: controlsVisible ? 1 : 0, y: controlsVisible ? 0 : 16 }}
          transition={controlsVisible ? snappySpring : { duration: 0.15 }}
          style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
          className="absolute bottom-10 left-0 right-0 z-10 safe-bottom" role="toolbar" aria-label="Call controls">
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => { hapticMedium(); toggleAudio(); resetControlsIdleTimer(); }}
              aria-label={isAudioOn ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!isAudioOn}
              className={`rounded-full flex items-center justify-center transition-colors ${isAudioOn ? "bg-call-stage-foreground/20 backdrop-blur-md" : "bg-destructive"}`}
              style={{ width: 52, height: 52 }}>
              {isAudioOn ? <Mic className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" /> : <MicOff className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />}
            </button>
            {audioRoute.supported && (
              <button onClick={() => { hapticLight(); setShowRoutePicker(v => !v); resetControlsIdleTimer(); }}
                aria-label="Audio output"
                aria-haspopup="menu"
                aria-expanded={showRoutePicker}
                className="rounded-full flex items-center justify-center bg-call-stage-foreground/20 backdrop-blur-md"
                style={{ width: 52, height: 52 }}>
                <RouteIcon type={audioRoute.current?.type} />
              </button>
            )}
            <button onClick={() => { hapticMedium(); toggleVideo(); resetControlsIdleTimer(); }}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!isVideoOn}
              className={`rounded-full flex items-center justify-center transition-colors ${isVideoOn ? "bg-call-stage-foreground/20 backdrop-blur-md" : "bg-destructive"}`}
              style={{ width: 52, height: 52 }}>
              {isVideoOn ? <VideoIcon className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" /> : <VideoOff className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />}
            </button>
            <button onClick={() => { hapticMedium(); toggleScreenShare(); resetControlsIdleTimer(); }}
              aria-label={isScreenSharing ? "Stop screen share" : "Start screen share"}
              aria-pressed={isScreenSharing}
              className={`rounded-full flex items-center justify-center transition-colors ${isScreenSharing ? "bg-primary" : "bg-call-stage-foreground/20 backdrop-blur-md"}`}
              style={{ width: 52, height: 52 }}>
              {isScreenSharing ? <MonitorOff className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" /> : <Monitor className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />}
            </button>
            {/* CALL-03: Camera picker button — shows only when multiple cameras available */}
            {cameras.length > 1 && (
              <button onClick={() => { hapticLight(); setShowCamPicker(v => !v); resetControlsIdleTimer(); }}
                aria-label="Switch camera"
                aria-haspopup="menu"
                aria-expanded={showCamPicker}
                className="rounded-full flex items-center justify-center bg-call-stage-foreground/20 backdrop-blur-md"
                style={{ width: 52, height: 52 }}>
                <VideoIcon className="h-5 w-5 text-call-stage-foreground opacity-60" aria-hidden="true" />
              </button>
            )}
            {pipSupported && participantCount > 1 && (
              <button onClick={() => { hapticLight(); togglePip(); resetControlsIdleTimer(); }}
                aria-label={isPip ? "Exit picture-in-picture" : "Pop out to picture-in-picture"}
                aria-pressed={isPip}
                className={`rounded-full flex items-center justify-center backdrop-blur-md ${isPip ? "bg-primary" : "bg-call-stage-foreground/20"}`}
                style={{ width: 52, height: 52 }}>
                <PictureInPicture2 className="h-5 w-5 text-call-stage-foreground" aria-hidden="true" />
              </button>
            )}
            <button onClick={() => { hapticHeavy(); if (callState === "idle") cancelStartingCall(); else endCall(); }}
              aria-label="End call"
              className="h-16 w-16 rounded-full bg-destructive flex items-center justify-center shadow-lg">
              <PhoneOff className="h-7 w-7 text-call-stage-foreground" aria-hidden="true" />
            </button>
          </div>

          {/* CALL-03: Camera picker sheet */}
          {showCamPicker && cameras.length > 1 && (
            <div className="mx-4 mt-3 rounded-2xl overflow-hidden border border-white/10"
              style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(20px)" }}>
              <p className="text-[11px] text-white/50 px-4 pt-3 pb-1 uppercase tracking-wider">Select Camera</p>
              {cameras.map(cam => (
                <button key={cam.deviceId}
                  onClick={async () => { hapticSelection(); await switchCamera(cam.deviceId); setShowCamPicker(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 active:bg-white/10 text-left">
                  <VideoIcon className="h-4 w-4 text-white/50 shrink-0" />
                  <span className="text-sm text-white truncate">{cam.label}</span>
                </button>
              ))}
              <button onClick={() => { hapticLight(); setShowCamPicker(false); }}
                className="w-full text-center text-[11px] text-white/30 py-2.5 border-t border-white/10">
                Cancel
              </button>
            </div>
          )}

          {/* Audio route picker sheet */}
          {showRoutePicker && audioRoute.supported && (
            <div className="mx-4 mt-3 rounded-2xl overflow-hidden border border-white/10"
              style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(20px)" }}>
              <p className="text-[11px] text-white/50 px-4 pt-3 pb-1 uppercase tracking-wider">Audio Output</p>
              {audioRoute.routes.length === 0 ? (
                <p className="px-4 py-2.5 text-sm text-white/40">No routes found</p>
              ) : audioRoute.routes.map(route => (
                <button key={route.id}
                  onClick={async () => { hapticSelection(); await audioRoute.setRoute(route); setShowRoutePicker(false); }}
                  aria-pressed={audioRoute.current?.id === route.id}
                  className="w-full flex items-center gap-3 px-4 py-2.5 active:bg-white/10 text-left">
                  <RouteIcon type={route.type} />
                  <span className={`text-sm truncate ${audioRoute.current?.id === route.id ? "text-white font-medium" : "text-white/70"}`}>
                    {route.name}
                  </span>
                </button>
              ))}
              <button onClick={() => { hapticLight(); setShowRoutePicker(false); }}
                className="w-full text-center text-[11px] text-white/30 py-2.5 border-t border-white/10">
                Cancel
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
      {callPermissionSheet}
      </>
    );
  }
  return (
    <>
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Calls" subtitle="Stay connected" />

      <div className="px-5 space-y-6 pb-24">
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
                return (
                  <CallHistoryRow key={call.id} call={call} index={i} isMissed={isMissed}
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
