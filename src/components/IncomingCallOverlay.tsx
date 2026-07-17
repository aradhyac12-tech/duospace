import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { playCallSound } from "@/lib/sounds";
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
  // Fix #4: passes full room URL, not just room name
  onAccept: (roomUrl: string, callType: string) => void;
  onDecline: (callId: string) => void;
}

const IncomingCallOverlay = ({ onAccept, onDecline }: IncomingCallOverlayProps) => {
  const { user } = useAuth();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);

  const handleAccept = useCallback(() => {
    if (!incomingCall?.room_url) return;
    stopCallVibration();
    onAccept(incomingCall.room_url, incomingCall.call_type);
    setIncomingCall(null);
  }, [incomingCall, onAccept]);

  const handleDecline = useCallback(async () => {
    if (!incomingCall) return;
    stopCallVibration();
    await supabase
      .from("call_history")
      .update({ status: "missed", ended_at: new Date().toISOString() } as any)
      .eq("id", incomingCall.id);
    onDecline(incomingCall.id);
    setIncomingCall(null);
  }, [incomingCall, onDecline]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("incoming-calls")
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${user.id}`,
      }, async (payload) => {
        const call = payload.new as any;
        if (call.status !== "in_progress") return;

        const { data: profile } = await supabase
          .from("profiles").select("display_name, avatar_url, pet_name")
          .eq("user_id", call.caller_id).single();

        startCallVibration();
        playCallSound();

        setIncomingCall({
          id: call.id,
          caller_id: call.caller_id,
          call_type: call.call_type,
          // Fix #4: room_name now stores the full Daily.co URL
          room_url: call.room_name,
          callerName: profile?.pet_name || profile?.display_name || "Partner",
          callerAvatar: profile?.avatar_url || null,
        });
      })
      .subscribe();

    const cancelChannel = supabase
      .channel("call-cancel")
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "call_history",
        filter: `receiver_id=eq.${user.id}`,
      }, (payload) => {
        const call = payload.new as any;
        if (call.status === "completed" || call.status === "missed" || call.status === "cancelled") {
          setIncomingCall((prev) => {
            if (prev?.id === call.id) { stopCallVibration(); return null; }
            return prev;
          });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(cancelChannel);
      stopCallVibration();
    };
  }, [user]);

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
      {incomingCall && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="incoming-call-title"
          aria-describedby="incoming-call-desc"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-foreground/95 backdrop-blur-xl safe-top safe-bottom">
          <div className="flex-1 flex flex-col items-center justify-center gap-6">
            <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
              className="h-28 w-28 rounded-full bg-background/10 flex items-center justify-center overflow-hidden">
              {incomingCall.callerAvatar ? (
                <img src={incomingCall.callerAvatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-4xl font-semibold text-background/60" aria-hidden="true">
                  {incomingCall.callerName.charAt(0).toUpperCase()}
                </span>
              )}
            </motion.div>
            <div className="text-center">
              <h2 id="incoming-call-title" className="text-2xl font-semibold text-background tracking-tight">{incomingCall.callerName}</h2>
              <p id="incoming-call-desc" className="text-sm text-background/50 mt-1">
                Incoming {incomingCall.call_type === "video" ? "video" : "voice"} call...
              </p>
            </div>
            <div className="relative" aria-hidden="true">
              <motion.div animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                transition={{ repeat: Infinity, duration: 1.5, ease: "easeOut" }}
                className="absolute inset-0 rounded-full border-2 border-background/20"
                style={{ width: 60, height: 60, margin: "auto" }} />
            </div>
          </div>

          <div className="pb-16 flex items-center gap-16">
            <div className="flex flex-col items-center gap-2">
              <motion.button whileTap={{ scale: 0.9 }} onClick={handleDecline}
                aria-label={`Decline ${incomingCall.call_type} call from ${incomingCall.callerName}`}
                autoFocus
                className="h-16 w-16 rounded-full bg-destructive flex items-center justify-center shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background">
                <PhoneOff className="h-7 w-7 text-background" aria-hidden="true" />
              </motion.button>
              <span className="text-xs text-background/50" aria-hidden="true">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <motion.button whileTap={{ scale: 0.9 }} animate={{ scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 1.2 }} onClick={handleAccept}
                aria-label={`Accept ${incomingCall.call_type} call from ${incomingCall.callerName}`}
                className="h-16 w-16 rounded-full bg-green-500 flex items-center justify-center shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background">
                {incomingCall.call_type === "video" ? (
                  <Video className="h-7 w-7 text-background" aria-hidden="true" />
                ) : (
                  <Phone className="h-7 w-7 text-background" aria-hidden="true" />
                )}
              </motion.button>
              <span className="text-xs text-background/50" aria-hidden="true">Accept</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default IncomingCallOverlay;
