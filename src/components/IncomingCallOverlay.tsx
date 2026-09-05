import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { startRingtoneLoop, stopRingtoneLoop } from "@/lib/sounds";
import { startCallVibration, stopCallVibration } from "@/lib/haptics";

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
}

const IncomingCallOverlay = ({ onAccept, onDecline }: IncomingCallOverlayProps) => {
  const { user } = useAuth();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);

  const handleAccept = useCallback(() => {
    if (!incomingCall?.room_url) return;
    stopCallVibration();
    stopRingtoneLoop();
    onAccept(incomingCall.id, incomingCall.room_url, incomingCall.call_type);
    setIncomingCall(null);
  }, [incomingCall, onAccept]);

  const handleDecline = useCallback(async () => {
    if (!incomingCall) return;
    stopCallVibration();
    stopRingtoneLoop();
    // decline_call() (not a raw update) — atomic CAS, only transitions to
    // 'missed' while the call is still genuinely unclaimed. Prevents the
    // 30s auto-decline timeout from racing a near-simultaneous answer on
    // another device and stomping a connecting/connected call to 'missed'
    // (see 20260808150000_call_hardening.sql for the full race writeup).
    await supabase.rpc("decline_call" as any, { _call_id: incomingCall.id });
    onDecline(incomingCall.id);
    setIncomingCall(null);
  }, [incomingCall, onDecline]);

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
  const hydrateIncomingCall = useCallback((call: { id: string; caller_id: string; call_type: string; room_name: string }) => {
    startCallVibration();
    startRingtoneLoop();

    setIncomingCall({
      id: call.id,
      caller_id: call.caller_id,
      call_type: call.call_type,
      // Fix #4: room_name now stores the full Daily.co URL
      room_url: call.room_name,
      callerName: "Partner",
      callerAvatar: null,
    });

    Promise.all([
      supabase.from("profiles").select("display_name, avatar_url").eq("user_id", call.caller_id).single(),
      user ? supabase.from("profiles").select("pet_name").eq("user_id", user.id).single() : Promise.resolve({ data: null as { pet_name: string | null } | null }),
    ]).then(([{ data: profile }, { data: mine }]) => {
      const name = mine?.pet_name || profile?.display_name;
      if (!name && !profile?.avatar_url) return;
      // Guard against a decline/timeout/hangup that already cleared this
      // call (or a newer call replacing it) while the fetch was in flight.
      setIncomingCall((prev) => (prev?.id === call.id ? { ...prev, callerName: name || prev.callerName, callerAvatar: profile?.avatar_url || prev.callerAvatar } : prev));
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("incoming-calls")
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${user.id}`,
      }, (payload) => {
        const call = payload.new as any;
        if (call.status !== "in_progress") return;
        hydrateIncomingCall(call);
      })
      .subscribe();

    const cancelChannel = supabase
      .channel("call-cancel")
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${user.id}`,
      }, (payload) => {
        const call = payload.new as any;
        // Dismiss on a terminal status, OR when another device has
        // claimed the call (claim_call() sets claimed_by without
        // necessarily changing status — see item 11/multi-device in
        // docs/IOS_NATIVE_SETUP.md). Safe even for the device that itself
        // just claimed: handleAccept() already cleared local state
        // synchronously before the claim RPC resolves, so this is a no-op
        // in that case, not a hang-up of an active call.
        if (call.status === "completed" || call.status === "missed" || call.status === "cancelled" || call.claimed_by) {
          setIncomingCall((prev) => {
            if (prev?.id === call.id) { stopCallVibration(); stopRingtoneLoop(); return null; }
            return prev;
          });
        }
      })
      .subscribe();

    // Push-notification cold start: if the user opened the app from an
    // incoming-call notification (full-screen intent or a tap), the
    // call_history INSERT already happened before this component — and its
    // realtime subscription above — ever mounted, so the INSERT handler
    // above would never fire for it. Check directly for a still-ringing
    // call addressed to this user so the answer UI still appears. The
    // 45s window matches the notification's own auto-timeout.
    (async () => {
      const cutoff = new Date(Date.now() - 45_000).toISOString();
      const { data: activeCall } = await supabase
        .from("call_history")
        .select("id, caller_id, call_type, room_name, status, started_at")
        .eq("receiver_id", user.id)
        .eq("status", "in_progress")
        .gte("started_at", cutoff)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activeCall) hydrateIncomingCall(activeCall as any);
    })();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(cancelChannel);
      stopCallVibration();
      stopRingtoneLoop();
    };
  }, [user, hydrateIncomingCall]);

  // Auto-dismiss after 30s
  useEffect(() => {
    if (!incomingCall) return;
    const timeout = setTimeout(() => handleDecline(), 30000);
    return () => clearTimeout(timeout);
  }, [incomingCall, handleDecline]);

  // A11y: keyboard support — Escape declines, Enter accepts.
  useEffect(() => {
    if (!incomingCall) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleDecline(); }
      else if (e.key === "Enter") { e.preventDefault(); handleAccept(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [incomingCall, handleAccept, handleDecline]);

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
      {incomingCall && (
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
          className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-call-stage/95 backdrop-blur-xl safe-top safe-bottom">
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
              <p id="incoming-call-desc" className="text-sm text-call-stage-foreground/50 mt-1">
                Incoming {incomingCall.call_type === "video" ? "video" : "voice"} call...
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
