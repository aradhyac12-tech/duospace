import { Capacitor } from "@capacitor/core";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import { stashIncomingStage } from "@/lib/callLatency";
import type { SignalingMessage } from "@/lib/signalingEngine/types";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { startIncomingRingtone, stopRingtoneLoop } from "@/lib/sounds";
import { getActiveSoundPrefs } from "@/lib/notificationSoundPrefs";
import { startCallVibration, stopCallVibration } from "@/lib/haptics";
import type { reduceCallMachine } from "@/lib/callStateMachine";
import { consumeAutoAccept } from "@/lib/nativeCallActionBridge";
import { isNativeIncomingRinging, stopNativeIncomingRinging } from "@/lib/nativeIncomingCall";
import { useToast } from "@/hooks/use-toast";
import type { useCallSignalingBridge } from "@/lib/signalingEngine/callSignalingBridge";

interface IncomingCall {
  id: string;
  caller_id: string;
  call_type: string;
  room_url: string;  // Fix #4: full URL stored here now
  callerName: string;
  callerAvatar: string | null;
}

interface IncomingCallOverlayProps {
  // Fix #4: passes full room URL, not just room name. Also passes callId
  // now (item 11 — multi-device claim) so the accept handler can call
  // claim_call() before joining, to atomically win the race against any
  // other device that also received this call's push.
  onAccept: (callId: string, roomUrl: string, callType: string) => void;
  onDecline: (callId: string) => void;
  /**
   * Race-safety layer (see src/lib/callStateMachine.ts). Optional + defaults
   * to a no-op so this component still works standalone (e.g. in tests) —
   * CallContext.tsx (the only real render site) always passes its shared
   * dispatcher, the same one acceptIncomingCall/startCall dispatch into, so
   * this device's whole call lifecycle — ring, accept, connect, end —
   * lands on one machine instead of the overlay tracking its own separate
   * notion of "is a call ringing" via local state only.
   */
  dispatchCallEvent?: (event: Parameters<typeof reduceCallMachine>[1]) => unknown;
  /** REMEDIATION (calling phase 3) — see callSignalingBridge.ts's own doc
   *  comment. Both optional + default to no-ops so this component still
   *  works standalone (tests, or before CallContext.tsx passes them).
   *  `activeProvider` gates the inbound CALL_CANCELLED listener below —
   *  never subscribes for "daily" (that provider's cancel detection is
   *  Realtime-only, unchanged). */
  signalingBridge?: ReturnType<typeof useCallSignalingBridge>;
  activeProvider?: "self_hosted";
}

const noopDispatch: NonNullable<IncomingCallOverlayProps["dispatchCallEvent"]> = () => undefined;

// Remember which calls this device has already answered / declined / seen end,
// so nothing (a duplicate realtime INSERT, the cold-start poll, our OWN claim
// echoing back as a call_history UPDATE) can ever re-ring or re-show them.
// Small cap: only the last few calls matter, this must not grow forever.
const HANDLED_CALLS_CAP = 20;
/** Self-hosted only: how long after a call_history INSERT reaches this
 *  device over Realtime we wait for the WebSocket CALL_OFFER before ringing
 *  from the Realtime row anyway (recovery for a lost offer frame). */
const RECOVERY_RING_DELAY_MS = 2000;

const IncomingCallOverlay = ({ onAccept, onDecline, dispatchCallEvent = noopDispatch, signalingBridge, activeProvider }: IncomingCallOverlayProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const userId = user?.id ?? null;
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  // ONE-SURFACE FIX: on a native build the OS already shows the single
  // WhatsApp-style call notification (Android CallStyle / iOS CallKit) and
  // plays the ringtone. The in-app full-screen ringing overlay on top of
  // that was the "call notification spam". While the OS owns the ring, this
  // component keeps all its call logic (cancel / missed / auto-accept) but
  // renders nothing and plays nothing. It only falls back to its own
  // screen + ringtone if the native ringer never started, or when the
  // person taps the notification body to open the app.
  const [nativeOwnsUi, setNativeOwnsUi] = useState(false);

  // ROOT-CAUSE FIX ("can't pick up / keeps vibrating / accept does nothing /
  // lags"): the subscribe + cold-start-poll effect below used to depend on
  // `hydrateIncomingCall`, which depended on `onAccept` and `dispatchCallEvent`
  // — and `onAccept` (CallContext's acceptIncomingCall) was a NEW function
  // every CallProvider render, which happens constantly during a call. So the
  // effect re-ran over and over: it dropped and re-created both realtime
  // channels, stopped the ringtone/vibration in its cleanup, and its
  // cold-start poll then found the same call still 'in_progress' and
  // re-hydrated it — restarting the ringtone/vibration (each restart also
  // leaked a vibration interval, see haptics.ts) and re-opening the incoming
  // screen AFTER the person had already tapped Accept. Tapping Accept again
  // on that re-opened screen was then a no-op (CallContext's accept lock was
  // held), and its 30s auto-decline later fired a stray "Call declined" toast
  // in the middle of the connected call.
  //
  // Everything the effects need is now read through refs, so the effects
  // depend only on the user id and run once per login.
  const onAcceptRef = useRef(onAccept);
  const onDeclineRef = useRef(onDecline);
  const dispatchRef = useRef(dispatchCallEvent);
  const userIdRef = useRef(userId);
  const activeProviderRef = useRef(activeProvider);
  const signalingBridgeRef = useRef(signalingBridge);
  onAcceptRef.current = onAccept;
  onDeclineRef.current = onDecline;
  dispatchRef.current = dispatchCallEvent;
  userIdRef.current = userId;
  activeProviderRef.current = activeProvider;
  signalingBridgeRef.current = signalingBridge;

  // Mirrors `incomingCall` synchronously (state alone updates on the next
  // render — too late for a second tap / a racing realtime event).
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const handledCallIdsRef = useRef<string[]>([]);

  const isHandled = useCallback((id: string) => handledCallIdsRef.current.includes(id), []);
  const markHandled = useCallback((id: string) => {
    const list = handledCallIdsRef.current;
    if (list.includes(id)) return;
    list.push(id);
    if (list.length > HANDLED_CALLS_CAP) list.splice(0, list.length - HANDLED_CALLS_CAP);
  }, []);

  const showCall = useCallback((call: IncomingCall | null) => {
    incomingCallRef.current = call;
    setIncomingCall(call);
  }, []);

  /** Stops EVERY ringing surface for a call: the in-app ringtone + haptics AND
   *  the native (Android) ringtone/vibration/notification, which the FCM push
   *  starts independently of this component. Idempotent. */
  const silenceRinging = useCallback((callId?: string) => {
    stopCallVibration();
    stopRingtoneLoop();
    void stopNativeIncomingRinging(callId);
  }, []);

  const handleAccept = useCallback(async () => {
    const call = incomingCallRef.current;
    if (!call) return; // already answered/dismissed — e.g. a double tap
    // Claim this call for THIS device before anything async, so nothing below
    // (or a re-run of the cold-start poll) can ring/show it again.
    markHandled(call.id);
    silenceRinging(call.id);
    showCall(null);
    // PHASE 4: CALL_ACCEPTED is NOT sent from here any more. It used to be
    // fired (fire-and-forget) BEFORE claim_call ran, so a caller could be
    // told "accepted" for a call this device then failed to claim. The
    // accept signal now goes out from CallContext.acceptIncomingCallImpl
    // AFTER claim_call has been won, with a typed result the flow acts on.
    // This used to be `if (!incomingCall?.room_url) return;` BEFORE stopping
    // anything — a silent dead button: Accept did nothing at all and the
    // phone kept ringing. Now the screen always responds; if the room URL
    // wasn't on the row we were handed, look it up once, and if it's truly
    // missing say so instead of doing nothing.
    let roomUrl = call.room_url;
    // Self-hosted: joinCall() takes the call id, not a URL (the room is
    // derived server-side from it) — there is nothing to look up.
    if (!roomUrl && activeProviderRef.current === "self_hosted") roomUrl = call.id;
    if (!roomUrl) {
      try {
        const { data } = await supabase.from("call_history").select("room_name").eq("id", call.id).maybeSingle();
        roomUrl = (data as { room_name?: string | null } | null)?.room_name ?? "";
      } catch { /* handled just below */ }
    }
    if (!roomUrl) {
      dispatchRef.current({ type: "CANCELLED", source: "accept-missing-room" });
      toast({ title: "Couldn't answer the call", description: "The call isn't ready yet. Ask them to call again.", variant: "destructive" });
      return;
    }
    // ACCEPT_TAPPED isn't dispatched here — acceptIncomingCall
    // (CallContext.tsx) dispatches its own INCOMING_CALL + ACCEPT_TAPPED
    // pair the instant it runs, immediately after this call returns. The
    // INCOMING_CALL dispatch it does is a harmless re-seed (see
    // hydrateIncomingCall below, which already dispatched INCOMING_CALL at
    // ring-time) — CallContext's own RESET-if-not-IDLE guard at the top of
    // its accept flow makes it self-healing either way, so this component
    // doesn't need to coordinate the exact sequencing with it.
    void onAcceptRef.current(call.id, roomUrl, call.call_type);
  }, [markHandled, silenceRinging, showCall, toast]);

  // `reason` is "timeout" for the 30s auto-decline and anything else (a tap,
  // Escape, or a click event passed straight through from onClick) for a
  // deliberate decline.
  const handleDecline = useCallback(async (reasonArg?: unknown) => {
    const call = incomingCallRef.current;
    if (!call) return; // already answered/dismissed — e.g. 30s timeout racing a tap
    markHandled(call.id);
    silenceRinging(call.id);
    showCall(null);
    dispatchRef.current({ type: "DECLINED", source: "decline-button-or-timeout" });
    // decline_call() (not a raw update) — atomic CAS, only transitions to
    // 'missed' while the call is still genuinely unclaimed. Prevents the
    // 30s auto-decline timeout from racing a near-simultaneous answer on
    // another device and stomping a connecting/connected call to 'missed'
    // (see 20260808150000_call_hardening.sql for the full race writeup).
    let declined = true; // unknown (RPC threw) is treated as "try to tell the caller"
    try {
      const { data } = await supabase.rpc("decline_call" as any, { _call_id: call.id });
      declined = data !== false;
    } catch { /* best-effort — the ring-expiry sweep closes it out otherwise */ }
    // PHASE 4: authoritative state FIRST (above), THEN tell the caller over
    // the signaling layer so its ringing stops immediately. If decline_call
    // returned false the call was already claimed/ended elsewhere — telling
    // the caller "rejected" would be wrong, so nothing is sent. A failed or
    // timed-out send is retried in the background by the signaling client
    // (and the caller's Realtime recovery path still sees the DB change).
    if (declined && activeProviderRef.current === "self_hosted") {
      void signalingBridgeRef.current?.reject(call.id, reasonArg === "timeout" ? "timeout" : "user");
    }
    onDeclineRef.current(call.id);
  }, [markHandled, silenceRinging, showCall]);

  // RING-LAG FIX: this used to `await` two Supabase round trips (caller's
  // profile row + our own pet_name row, via Promise.all) BEFORE starting
  // the ringtone/vibration or even showing the overlay. The realtime
  // INSERT this is called from (or the cold-start poll below) already
  // fires close to instantly, but the phone would then sit silent for
  // however long those two queries took — exactly the "I called and
  // nothing happens for a beat" lag, just on the *receiver's* side. Now
  // the ring/vibrate/overlay fire the instant we know a call exists, with
  // a "Partner" placeholder name; the profile fetch runs after, purely to
  // fill in the real name/avatar once it lands, and never delays or
  // restarts the ringing that's already going.
  //
  // Stable identity (no deps) on purpose — see the ROOT-CAUSE note above.
  //
  // PHASE 4: `source` says HOW this device learned of the call. For a
  // self-hosted call the ring is meant to arrive over the WebSocket
  // ("signaling"); "realtime-recovery-*" / "cold-start-poll" are the
  // labelled recovery paths (socket down / offer lost / app opened from a
  // push). `session_id` (call_history.session_id, present on rows) lets a
  // recovered call still accept/reject over the socket.
  const hydrateIncomingCall = useCallback((
    call: { id: string; caller_id: string; call_type: string; room_name: string; provider?: string | null; session_id?: string | null },
    source: string = "realtime-or-cold-start-poll",
  ) => {
    // Already answered/declined/ended on this device, or already ringing:
    // never restart the ringtone/vibration or re-open the screen.
    if (isHandled(call.id)) return;
    if (incomingCallRef.current?.id === call.id) return;
    const selfHosted = call.provider === "self_hosted" && activeProviderRef.current === "self_hosted";
    if (selfHosted) {
      stashIncomingStage(call.id, "invite_received");
      stashIncomingStage(call.id, "incoming_call");
      if (source !== "signaling" && call.session_id) {
        // Learned of the call WITHOUT a socket offer: teach the signaling
        // client about it (before anything can accept it — including the
        // native auto-accept replay just below) so accept/reject still
        // travel over the socket.
        signalingBridgeRef.current?.registerIncoming({
          callId: call.id, sessionId: call.session_id, peerId: call.caller_id,
          callType: call.call_type === "voice" ? "voice" : "video",
        });
      }
    }

    // ALREADY-ANSWERED FIX: the native OS call UI (or a cold-start replay
    // of it — see src/lib/nativeCallActionBridge.ts) already reported this
    // exact call as accepted before this ever got the chance to render.
    // Skip the ring/vibrate/answer-UI entirely and accept straight away —
    // making the person tap Accept again for a call they already picked
    // up is exactly the "stuck" feeling this fixes.
    if (consumeAutoAccept(call.id)) {
      markHandled(call.id);
      silenceRinging(call.id);
      dispatchRef.current({
        type: "INCOMING_CALL", callId: call.id,
        callType: call.call_type === "voice" ? "voice" : "video",
        source: "native-auto-accept-replay",
      });
      void onAcceptRef.current(call.id, call.room_name, call.call_type);
      return;
    }
    const ringInApp = () => {
      startCallVibration();
      // The ringtone the user picked (Settings > Notifications), not a fixed
      // beep. Yields to the OS if it is already ringing the same tone natively.
      startIncomingRingtone(getActiveSoundPrefs().callRingtone, isNativeIncomingRinging);
    };
    if (Capacitor.isNativePlatform()) {
      setNativeOwnsUi(true);
      // The FCM/VoIP push and this realtime event race each other; give the
      // native ringer a few seconds to start before deciding it didn't.
      void (async () => {
        for (const wait of [0, 1500, 1500]) {
          if (wait) await new Promise(r => setTimeout(r, wait));
          if (incomingCallRef.current?.id !== call.id) return; // answered/ended meanwhile
          if (await isNativeIncomingRinging() === true) return; // OS owns it
        }
        if (incomingCallRef.current?.id !== call.id) return;
        setNativeOwnsUi(false); // fallback: native path never started
        ringInApp();
      })();
    } else {
      ringInApp();
    }
    dispatchRef.current({
      type: "INCOMING_CALL", callId: call.id,
      callType: call.call_type === "voice" ? "voice" : "video",
      source,
    });

    showCall({
      id: call.id,
      caller_id: call.caller_id,
      call_type: call.call_type,
      // Fix #4: room_name now stores the full the call engine URL. Self-hosted:
      // the id itself (the room is derived from it, see livekitAuthz.ts).
      room_url: selfHosted ? call.id : call.room_name,
      callerName: "Partner",
      callerAvatar: null,
    });
    if (selfHosted) {
      stashIncomingStage(call.id, "ringing_displayed");
      // Tell the caller "ringing on their device" (telemetry/ack only).
      void signalingBridgeRef.current?.ringing(call.id);
    }

    const myId = userIdRef.current;
    Promise.all([
      supabase.from("profiles").select("display_name, avatar_url").eq("user_id", call.caller_id).single(),
      myId ? supabase.from("profiles").select("pet_name").eq("user_id", myId).single() : Promise.resolve({ data: null as { pet_name: string | null } | null }),
    ]).then(([{ data: profile }, { data: mine }]) => {
      const name = mine?.pet_name || profile?.display_name;
      if (!name && !profile?.avatar_url) return;
      // Guard against a decline/timeout/hangup that already cleared this
      // call (or a newer call replacing it) while the fetch was in flight.
      const prev = incomingCallRef.current;
      if (prev?.id !== call.id) return;
      showCall({ ...prev, callerName: name || prev.callerName, callerAvatar: profile?.avatar_url || prev.callerAvatar });
    }).catch(() => {});
  }, [isHandled, markHandled, silenceRinging, showCall]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    // Channel names carry the user id so a fast sign-out/sign-in (or a dev
    // hot-reload) can never get handed a still-subscribed channel of the same
    // name — supabase-js throws if `.on()` is added after `.subscribe()`.
    const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
    const channel = supabase
      .channel(`incoming-calls:${userId}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${userId}`,
      }, (payload) => {
        const call = payload.new as any;
        if (call.status !== "in_progress") return;
        // PHASE 4: for a SELF-HOSTED call this Realtime INSERT is the
        // RECOVERY path, not the ring. The ring is the WebSocket CALL_OFFER
        // (handled by the signaling listener below). Ring from here only if
        // the socket isn't ready (so a callee whose socket is down still
        // hears the call) or the offer hasn't shown up shortly after the
        // row appeared (lost frame). The call engine rings from here immediately, as
        // before.
        if (call.provider === "self_hosted" && activeProviderRef.current === "self_hosted") {
          const bridge = signalingBridgeRef.current;
          if (!bridge?.isReady()) { hydrateIncomingCall(call, "realtime-recovery-socket-down"); return; }
          const timer = setTimeout(() => {
            recoveryTimers.delete(timer);
            if (isHandled(call.id) || incomingCallRef.current?.id === call.id) return;
            hydrateIncomingCall(call, "realtime-recovery-no-offer");
          }, RECOVERY_RING_DELAY_MS);
          recoveryTimers.add(timer);
          return;
        }
        hydrateIncomingCall(call);
      })
      .subscribe();

    const cancelChannel = supabase
      .channel(`call-cancel:${userId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${userId}`,
      }, (payload) => {
        const call = payload.new as any;
        // Dismiss on a terminal status, OR when another device has
        // claimed the call (claim_call() sets claimed_by without
        // necessarily changing status — see item 11/multi-device in
        // docs/IOS_NATIVE_SETUP.md).
        const ended = call.status === "completed" || call.status === "missed" || call.status === "cancelled" || call.status === "failed";
        if (!ended && !call.claimed_by) return;
        // THIS device answered/declined it: the UPDATE is just our own claim/
        // status change echoing back. It used to be treated as "someone else
        // took it" and dispatched MISSED into the state machine mid-accept.
        if (isHandled(call.id)) return;
        // Whatever the overlay is doing, make sure the NATIVE ringing for this
        // call is off — the caller hanging up while the app was open (or the
        // overlay never having shown) used to leave the phone vibrating until
        // the 45s native timeout. callId-guarded natively; harmless if idle.
        void stopNativeIncomingRinging(call.id);
        if (incomingCallRef.current?.id !== call.id) {
          // Self-hosted: a pending recovery ring for a call that already
          // ended/was claimed must never fire afterwards.
          if (activeProviderRef.current === "self_hosted") markHandled(call.id);
          return;
        }
        markHandled(call.id);
        stopCallVibration();
        stopRingtoneLoop();
        showCall(null);
        // 'cancelled' = caller backed out before we answered; anything
        // else reaching here (another device's claim, or the call
        // ending without this device ever answering it) is a miss from
        // THIS device's specific point of view, whatever the DB's own
        // terminal status ends up being.
        dispatchRef.current({
          type: call.status === "cancelled" ? "CANCELLED" : "MISSED",
          source: call.claimed_by ? "claimed-elsewhere" : `realtime-${call.status}`,
        });
      })
      .subscribe();

    // Push-notification cold start: if the user opened the app from an
    // incoming-call notification (full-screen intent or a tap), the
    // call_history INSERT already happened before this component — and its
    // realtime subscription above — ever mounted, so the INSERT handler
    // above would never fire for it. Check directly for a still-ringing
    // call addressed to this user so the answer UI still appears. The
    // 45s window matches the notification's own auto-timeout. Runs ONCE per
    // login now (hydrateIncomingCall itself ignores anything already handled
    // or already ringing, so even a stray second run is harmless).
    (async () => {
      const cutoff = new Date(Date.now() - 45_000).toISOString();
      const { data: activeCall } = await supabase
        .from("call_history")
        .select("id, caller_id, call_type, room_name, status, started_at, claimed_by, provider, session_id")
        .eq("receiver_id", userId)
        .eq("status", "in_progress")
        .gte("started_at", cutoff)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !activeCall) return;
      // Already picked up (by this or another device): not ringing any more.
      if ((activeCall as any).claimed_by) return;
      hydrateIncomingCall(activeCall as any, "cold-start-poll");
    })();

    return () => {
      cancelled = true;
      recoveryTimers.forEach((t) => clearTimeout(t));
      recoveryTimers.clear();
      supabase.removeChannel(channel);
      supabase.removeChannel(cancelChannel);
      stopCallVibration();
      stopRingtoneLoop();
    };
  }, [userId, hydrateIncomingCall, isHandled, markHandled, showCall]);

  // PHASE 4: the WebSocket signaling layer is the RING and the control
  // channel for self-hosted calls. CALL_OFFER shows the (existing,
  // unchanged) incoming-call UI; CALL_CANCELLED / CALL_TIMEOUT dismiss it.
  // The client (CallSignalingClient) has already discarded anything for an
  // unknown call, the wrong session, the wrong sender or an illegal state
  // before it reaches here. The call engine never enters this effect.
  useEffect(() => {
    if (!userId || activeProvider !== "self_hosted" || !signalingBridge) return;
    signalingBridge.prewarm();

    const dismiss = (callId: string, eventType: "CANCELLED" | "MISSED", source: string) => {
      if (isHandled(callId)) return;
      void stopNativeIncomingRinging(callId);
      if (incomingCallRef.current?.id !== callId) { markHandled(callId); return; }
      markHandled(callId);
      stopCallVibration();
      stopRingtoneLoop();
      showCall(null);
      dispatchRef.current({ type: eventType, source });
    };

    const onOffer = (message: SignalingMessage) => {
      // 1-4: sender / recipient / callId / sessionId. (Shape + session
      // binding were already enforced by the client; re-check the parts
      // that would make ringing wrong if the wire were lying.)
      if (message.recipientId !== userIdRef.current || message.senderId === userIdRef.current) return;
      if (!message.sessionId) return;
      const ttl = message.payload?.ringTtlMs;
      if (typeof ttl === "number" && ttl <= 0) return; // ring window already over
      if (isHandled(message.callId)) return;
      hydrateIncomingCall({
        id: message.callId, caller_id: message.senderId, room_name: message.callId,
        call_type: message.payload?.callType === "voice" ? "voice" : "video",
        provider: "self_hosted", session_id: message.sessionId,
      }, "signaling");
      // 5. Verify against persistence in the BACKGROUND — the ring is not
      // delayed by a database round trip, but it can only ever be taken
      // back, never invented: if the row isn't the call the wire claimed,
      // stand down.
      void (async () => {
        try {
          const { data } = await supabase.from("call_history")
            .select("status, claimed_by, caller_id, provider, session_id")
            .eq("id", message.callId).maybeSingle();
          const row = data as { status: string; claimed_by: string | null; caller_id: string; provider: string | null; session_id: string | null } | null;
          const valid = !!row && row.status === "in_progress" && !row.claimed_by && row.caller_id === message.senderId
            && row.provider === "self_hosted" && (!row.session_id || row.session_id === message.sessionId);
          if (!valid) dismiss(message.callId, "CANCELLED", "signaling-offer-failed-verification");
        } catch { /* can't verify right now: keep ringing; accept's claim_call is the real gate */ }
      })();
    };

    const unsubscribe = signalingBridge.onMessage((message) => {
      if (message.type === "CALL_OFFER") { onOffer(message); return; }
      if (message.type === "CALL_CANCELLED") dismiss(message.callId, "CANCELLED", "signaling-cancelled");
      else if (message.type === "CALL_TIMEOUT") dismiss(message.callId, "MISSED", "signaling-timeout");
    });
    return unsubscribe;
  }, [userId, activeProvider, signalingBridge, isHandled, markHandled, showCall, hydrateIncomingCall]);

  // ALREADY-ANSWERED FIX, other half: covers the opposite ordering from
  // hydrateIncomingCall's own consumeAutoAccept check above — this call was
  // already ringing/visible in-app when the native accept action arrived
  // (e.g. a Bluetooth/CarPlay button, or CallKit's lock-screen UI, tapped
  // while the app happened to already be foregrounded). Live event rather
  // than a poll — see nativeCallActionBridge.ts's requestAutoAccept call
  // sites for where this is dispatched from.
  //
  // (The accept used to be invoked from INSIDE a setState updater here, which
  // React may run twice — e.g. StrictMode — so it could double-accept. It now
  // reads the ref and runs exactly once.)
  useEffect(() => {
    const onAutoAccept = (event: Event) => {
      const detail = (event as CustomEvent).detail as { callId?: string } | undefined;
      if (!detail?.callId) return;
      const call = incomingCallRef.current;
      if (!call || call.id !== detail.callId) return;
      markHandled(call.id);
      silenceRinging(call.id);
      showCall(null);
      void onAcceptRef.current(call.id, call.room_url, call.call_type);
    };
    window.addEventListener("duospace-call-auto-accept", onAutoAccept);
    return () => window.removeEventListener("duospace-call-auto-accept", onAutoAccept);
  }, [markHandled, silenceRinging, showCall]);

  // Tapping the call notification's body (not Answer/Decline) opens the app:
  // show the in-app answer screen then, without adding a second ringtone —
  // the native ringer is still playing.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent).detail?.callId as string | undefined;
      if (!id || incomingCallRef.current?.id === id) setNativeOwnsUi(false);
    };
    window.addEventListener("duospace-call-reveal", onReveal);
    return () => window.removeEventListener("duospace-call-reveal", onReveal);
  }, []);

  // Auto-dismiss after 30s. Keyed on the call's id, not the whole object —
  // the caller-name hydration above replaces the object once the profile
  // fetch lands, and that must not restart the countdown.
  const ringingCallId = incomingCall?.id ?? null;
  useEffect(() => {
    if (!ringingCallId) return;
    // TIMEOUT FIX: 45s matches the FCM/APNs ring timeout and the cold-start
    // poll window. 30s was clipping legitimate answers on slow devices or
    // when the user takes a moment to decide.
    // (PHASE 4: "timeout" tells the caller this reject was the auto-decline.)
    const timeout = setTimeout(() => { void handleDecline("timeout"); }, 45000);
    return () => clearTimeout(timeout);
  }, [ringingCallId, handleDecline]);

  // A11y: keyboard support — Escape declines, Enter accepts.
  useEffect(() => {
    if (!ringingCallId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); void handleDecline(); }
      else if (e.key === "Enter") { e.preventDefault(); void handleAccept(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ringingCallId, handleAccept, handleDecline]);

  return (
    <AnimatePresence>
      {/* Phase 2.5, section 19: was a bare opacity fade (default 300ms) —
          spec asks for a quick, physical transition INTO the incoming
          screen (target 200-280ms). Subtle scale-up reads as the screen
          arriving rather than materializing.
          BUG FIX: this comment used to sit *inside* the `incomingCall && ( ... )`
          parens, directly before `<motion.div>` with no operator between
          them — two adjacent expressions with nothing joining them, which
          is invalid syntax (not valid JS/TSX at all, not just a lint
          issue). That's a hard build break: any bundler (Vite/esbuild,
          tsc, Babel) fails to parse this file, so the whole module — and
          everything that imports it, i.e. `CallContext.tsx`, which wraps
          every protected route in the app — fails to build. This is very
          likely the actual root cause behind "partner can't pick up,
          hang up, or go back": the incoming-call screen (and possibly the
          call feature entirely, depending on how the build tooling
          handled the failure) was never actually shippable in this
          state. Moved the comment to be a proper sibling JSX comment
          before the conditional instead of living inside the expression. */}
      {incomingCall && !nativeOwnsUi && (
        <motion.div
          initial={{ opacity: 0, scale: 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="incoming-call-title"
          aria-describedby="incoming-call-desc"
          data-swipe-nav-ignore
          className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-call-stage safe-top safe-bottom">
          <div className="flex-1 flex flex-col items-center justify-center gap-6">
            <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
              className="h-28 w-28 rounded-full bg-call-stage-foreground/10 flex items-center justify-center overflow-hidden ring-1 ring-call-stage-foreground/10 shadow-[0_8px_32px_-8px_hsl(0_0%_0%/0.4)]">
              {incomingCall.callerAvatar ? (
                <img loading="lazy" decoding="async" src={incomingCall.callerAvatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-4xl font-semibold text-call-stage-foreground/60" aria-hidden="true">
                  {incomingCall.callerName.charAt(0).toUpperCase()}
                </span>
              )}
            </motion.div>
            <div className="text-center">
              <h2 id="incoming-call-title" className="text-2xl font-semibold text-call-stage-foreground tracking-tight">{incomingCall.callerName}</h2>
              <p id="incoming-call-desc" className="text-sm text-call-stage-foreground/50 mt-1 flex items-center gap-1.5 justify-center">
                {incomingCall.call_type === "video"
                  ? <><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>Incoming video call</>
                  : <><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.85 3.47 2 2 0 0 1 3.84 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.41a16 16 0 0 0 6.61 6.59l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Incoming voice call</>}
              </p>
            </div>
            <div className="relative" aria-hidden="true">
              <motion.div animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                transition={{ repeat: Infinity, duration: 1.5, ease: "easeOut" }}
                className="absolute inset-0 rounded-full border-2 border-call-stage-foreground/20"
                style={{ width: 60, height: 60, margin: "auto" }} />
            </div>
          </div>

          <div className="pb-16 flex items-center gap-16">
            <div className="flex flex-col items-center gap-2">
              <motion.button whileTap={{ scale: 0.9 }} onClick={handleDecline}
                aria-label={`Decline ${incomingCall.call_type} call from ${incomingCall.callerName}`}
                autoFocus
                className="h-16 w-16 rounded-full bg-destructive flex items-center justify-center shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-call-stage-foreground">
                <PhoneOff className="h-7 w-7 text-call-stage-foreground" aria-hidden="true" />
              </motion.button>
              <span className="text-xs text-call-stage-foreground/50" aria-hidden="true">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <motion.button whileTap={{ scale: 0.9 }} animate={{ scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 1.2 }} onClick={handleAccept}
                aria-label={`Accept ${incomingCall.call_type} call from ${incomingCall.callerName}`}
                className="h-16 w-16 rounded-full bg-success flex items-center justify-center shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-call-stage-foreground">
                {incomingCall.call_type === "video" ? (
                  <Video className="h-7 w-7 text-call-stage-foreground" aria-hidden="true" />
                ) : (
                  <Phone className="h-7 w-7 text-call-stage-foreground" aria-hidden="true" />
                )}
              </motion.button>
              <span className="text-xs text-call-stage-foreground/50" aria-hidden="true">Accept</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default IncomingCallOverlay;
