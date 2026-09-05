import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, animate as animateValue } from "framer-motion";
import { Maximize2, PhoneOff } from "lucide-react";
import { useCall } from "@/contexts/CallContext";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { hapticLight, hapticHeavy } from "@/lib/haptics";
import { resumeCameraConsumers } from "@/lib/cameraBus";

// MinimizedCallBubble — WhatsApp-style small/large call-screen switching.
//
// Before this: tapping "minimize" on CallStage swapped the full-screen call
// UI for a plain text pill (name + duration + end button), duplicated
// separately in both Chat.tsx and Calls.tsx, with no video in it at all and
// nothing shown on any OTHER page (Gallery, Settings, Map, …) even though
// the call itself — and CallContext's shared Daily call object — was still
// very much alive there too.
//
// This replaces both page-local pills with ONE small draggable floating
// video thumbnail — the actual WhatsApp behaviour: the partner's live video
// keeps playing in a small corner bubble you can drag anywhere on screen,
// tap to pop back to the full CallStage, and it now works from every page
// since it's mounted once here in CallProvider (same pattern
// IncomingCallOverlay already uses for the same "must work app-wide"
// reason). Voice calls have no video track to preview, so they still show
// as a compact pill — just now draggable and app-wide too, not reinvented,
// only the video call case actually changes shape.
const MinimizedCallBubble = () => {
  const {
    isCallMinimized, setIsCallMinimized, callState, isAcceptingCall, cancelAcceptingCall,
    activeCallType, isVideoOn, isScreenSharing, remoteVideoRef, callDuration,
    leaveCall, activeCallId, setActiveCallId, reattachRemoteVideo,
  } = useCall();
  const { user } = useAuth();

  // Same gate the two page-local pills used to use (isAcceptingCall ||
  // joining || joined) — minus each page's own page-local `isStartingCall`
  // pre-join ringback flag, which isn't available here since it never
  // lived in shared context. Practically this only skips the bubble for
  // the brief window between tapping the call button and Daily's own
  // join() actually starting — CallStage itself is still on screen for
  // that window on whichever page started the call, so nothing is lost,
  // it just isn't minimizable to a global bubble in that specific instant.
  const callActive = isAcceptingCall || callState === "joining" || callState === "joined";
  const show = isCallMinimized && callActive;
  const isVoiceCall = activeCallType === "voice";

  // Partner name/avatar aren't in CallContext (each page fetches its own
  // copy locally) — fetched once here instead of lifting that into shared
  // state for what's otherwise a page-local concern everywhere else.
  const [partnerName, setPartnerName] = useState("");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (!show || !user) return;
    let cancelled = false;
    (async () => {
      const { data: me } = await supabase.from("profiles").select("partner_id").eq("user_id", user.id).single();
      if (cancelled || !me?.partner_id) return;
      const { data: partner } = await supabase.from("profiles").select("display_name,avatar_url").eq("user_id", me.partner_id).single();
      if (cancelled || !partner) return;
      setPartnerName(partner.display_name || "Partner");
      setPartnerAvatar(partner.avatar_url || null);
    })();
    return () => { cancelled = true; };
  }, [show, user]);

  // Drag + snap-to-corner — same spring feel as CallStage's own
  // self-preview drag, just bounded to the whole viewport instead of
  // CallStage's internal safe-area box, since this now floats over
  // whichever page happens to be on screen.
  const boundsRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleX = useMotionValue(0);
  const bubbleY = useMotionValue(0);
  const snapToCorner = useCallback(() => {
    const el = bubbleRef.current, b = boundsRef.current;
    if (!el || !b) return;
    const bRect = b.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const isRight = (eRect.left + eRect.width / 2) > (bRect.left + bRect.width / 2);
    const isBottom = (eRect.top + eRect.height / 2) > (bRect.top + bRect.height / 2);
    const targetLeft = isRight ? (bRect.right - eRect.width) : bRect.left;
    const targetTop = isBottom ? (bRect.bottom - eRect.height) : bRect.top;
    animateValue(bubbleX, bubbleX.get() + (targetLeft - eRect.left), { type: "spring", stiffness: 500, damping: 34 });
    animateValue(bubbleY, bubbleY.get() + (targetTop - eRect.top), { type: "spring", stiffness: 500, damping: 34 });
  }, [bubbleX, bubbleY]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Same "close this call out" sequence as Chat.tsx/Calls.tsx's own
  // endCall — reproduced here rather than imported since both of those are
  // page-local closures, but everything they actually touch (activeCallId,
  // callDuration, leaveCall) is already shared via CallContext, so this
  // stays byte-for-byte equivalent regardless of which page started the
  // call this bubble is currently showing.
  const handleEnd = useCallback(async () => {
    hapticHeavy();
    if (isAcceptingCall) { cancelAcceptingCall(); return; }
    if (activeCallId && user) {
      await supabase.from("call_history").update({
        status: "completed", duration_seconds: callDuration, ended_at: new Date().toISOString(),
      } as any).eq("id", activeCallId).eq("status", "in_progress");
      setActiveCallId(null);
    }
    leaveCall();
    resumeCameraConsumers("call-end");
  }, [isAcceptingCall, cancelAcceptingCall, activeCallId, user, callDuration, setActiveCallId, leaveCall]);

  const expand = useCallback(() => { hapticLight(); setIsCallMinimized(false); }, [setIsCallMinimized]);

  return (
    <>
      {/* Full-viewport drag bounds, safe-area padded — invisible, just a
          rect for dragConstraints to measure against. */}
      <div ref={boundsRef} className="fixed pointer-events-none z-[89]" style={{
        top: "calc(env(safe-area-inset-top, 0px) + 8px)",
        right: "calc(env(safe-area-inset-right, 0px) + 8px)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
        left: "calc(env(safe-area-inset-left, 0px) + 8px)",
      }} />

      <AnimatePresence>
        {show && !isVoiceCall && (
          <motion.div
            key="video-bubble"
            ref={bubbleRef}
            drag dragConstraints={boundsRef} dragElastic={0.06} dragMomentum={false}
            onDragEnd={snapToCorner} whileDrag={{ scale: 1.05 }}
            initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
            style={{
              x: bubbleX, y: bubbleY,
              top: "calc(env(safe-area-inset-top, 0px) + 8px)",
              right: "calc(env(safe-area-inset-right, 0px) + 8px)",
            }}
            onClick={expand}
            className="fixed w-24 h-32 rounded-[20px] overflow-hidden shadow-xl ring-1 ring-foreground/10 z-[90] cursor-grab active:cursor-grabbing bg-call-stage"
          >
            {isVideoOn && !isScreenSharing ? (
              <video ref={remoteVideoRef} autoPlay playsInline muted={false} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-accent/30">
                {partnerAvatar
                  ? <img loading="lazy" decoding="async" src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                  : <span className="text-2xl font-serif text-call-stage-foreground/80">{(partnerName || "P").charAt(0).toUpperCase()}</span>}
              </div>
            )}

            {/* Bottom gradient + duration, same idea as WhatsApp's own PiP label. */}
            <div className="absolute inset-x-0 bottom-0 pt-4 pb-1.5 px-1.5 bg-gradient-to-t from-black/70 to-transparent pointer-events-none">
              <p className="text-[10px] text-white/90 font-medium text-center truncate">{formatDuration(callDuration)}</p>
            </div>

            {/* Tap target for "back to full screen" — visually a small
                expand glyph so the bubble doesn't read as JUST a video
                loop with no obvious affordance. Sits on top of the drag
                area; stopPropagation on pointerdown/touchstart keeps a
                fast tap from being swallowed as a near-zero-distance drag
                start, same fix CallStage's own camera-flip button needed. */}
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); expand(); }}
              aria-label="Expand call"
              className="absolute top-1 left-1 h-5 w-5 rounded-full bg-black/50 backdrop-blur flex items-center justify-center">
              <Maximize2 className="h-2.5 w-2.5 text-white" aria-hidden="true" />
            </button>

            <button
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); void handleEnd(); }}
              aria-label="End call"
              className="absolute top-1 right-1 h-5 w-5 rounded-full bg-destructive flex items-center justify-center">
              <PhoneOff className="h-2.5 w-2.5 text-destructive-foreground" aria-hidden="true" />
            </button>
          </motion.div>
        )}

        {/* Voice calls: no video to preview, so this stays the compact
            pill the old per-page banners used — just app-wide now, and
            draggable for consistency with the video bubble above. */}
        {show && isVoiceCall && (
          <motion.div
            key="voice-pill"
            ref={bubbleRef}
            drag dragConstraints={boundsRef} dragElastic={0.06} dragMomentum={false}
            onDragEnd={snapToCorner} whileDrag={{ scale: 1.03 }}
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
            style={{ x: bubbleX, y: bubbleY, top: "calc(env(safe-area-inset-top, 0px) + 10px)", left: "50%", marginLeft: -84 }}
            onClick={expand}
            className="fixed z-[90] flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-full glass-sheet shadow-lg cursor-grab active:cursor-grabbing w-[168px]"
          >
            <span className="h-2 w-2 rounded-full bg-success animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground truncate flex-1">
              {partnerName || "Call"} · {formatDuration(callDuration)}
            </span>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); void handleEnd(); }}
              aria-label="End call"
              className="h-6 w-6 rounded-full bg-destructive flex items-center justify-center shrink-0">
              <PhoneOff className="h-3 w-3 text-destructive-foreground" aria-hidden="true" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default MinimizedCallBubble;
