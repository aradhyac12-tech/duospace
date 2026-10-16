import { motion, useMotionValue, useTransform, animate, usePresence, type PanInfo } from "framer-motion";
import { X, Download, Share2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import { hapticMedium, hapticLight } from "@/lib/haptics";
import { useSetImmersive } from "@/hooks/useImmersiveMode";
import { EASE_SMOOTH } from "@/lib/motion";
import { toast } from "@/hooks/use-toast";
import { downloadToDevice } from "@/lib/downloadToDevice";
import { usePinchZoomPan } from "@/hooks/usePinchZoomPan";
import { useBackHandler } from "@/hooks/useBackHandler";

interface PhotoViewerProps {
  src: string;
  /** Phase 2.5, section 13: shared with the tapped MessageBubble thumbnail
   *  via the same `photo-${id}` layoutId — see the doc comment there. Now
   *  lives on the drag/scale wrapper (see below) rather than the <img>
   *  itself, since the <img> is driven by direct transform writes from
   *  usePinchZoomPan and shouldn't also be under Framer Motion's control. */
  photoId?: string;
  onClose: () => void;
}

const PhotoViewer = ({ src, photoId, onClose }: PhotoViewerProps) => {
  const [saving, setSaving] = useState(false);
  // BUG FIX (part of this same session): handleShare previously reused
  // `saving` — meaning tapping Share would visibly disable/dim the SAVE
  // button (disabled={saving}) while sharing was in flight, even though
  // no save was happening. Separate state so each button only reflects
  // its own action.
  const [sharing, setSharing] = useState(false);
  // This component is only ever mounted while open (the caller conditionally
  // renders it, there's no separate isOpen prop) — so registering as
  // immersive is unconditional here; unmounting clears it automatically.
  // See useDockVisibility.ts for why the dock needs this at all.
  useSetImmersive("photo-viewer", true);
  // Hardware/gesture back closes the viewer instead of leaving the chat.
  useBackHandler(true, () => { onClose(); });

  // Real two-finger pinch-zoom + pan + double-tap-zoom, same battle-tested
  // gesture math as Gallery's viewer (see usePinchZoomPan's own header for
  // why it writes transforms straight to the DOM instead of through React
  // state — that's what keeps this smooth/lag-free on a real phone). Was
  // previously just `touchAction: "pinch-zoom"` — a hint to the browser
  // that didn't reliably produce an actual zoom inside a Capacitor WebView.
  const { containerRef, imgRef, isZoomed, isPinching, onPointerDown, onPointerMove, onPointerUp, onImageTap } = usePinchZoomPan(src);

  // ── Pull-to-close ──────────────────────────────────────────────────────
  // dragY is a motion value (no re-render per pointermove). Everything that
  // reacts to the pull — photo scale, backdrop, top bar — is derived from it
  // so they all track the finger on the same frame.
  const dragY = useMotionValue(0);
  // Drag follows the finger 1:1 (no rubber-band resistance, no momentum
  // coasting); on release we decide ourselves: spring home or fly off.
  const photoScale = useTransform(dragY, [-320, 0, 320], [0.78, 1, 0.78]);
  const photoRadius = useTransform(dragY, [-120, 0, 120], [24, 0, 24], { clamp: true });
  // The black backdrop fades to fully transparent as you pull, so the chat
  // shows through underneath — it feels like lifting the photo off the page.
  const dragFade = useTransform(dragY, [-300, 0, 300], [0, 1, 0]);
  // `enter` drives the open/close fade independently of the drag.
  const enter = useMotionValue(0);
  const backdropOpacity = useTransform([enter, dragFade], ([e, d]) => (e as number) * (d as number));
  // Controls fade out quickly as soon as the pull begins.
  const chromeFade = useTransform(dragY, [-70, 0, 70], [0, 1, 0]);
  const chromeOpacity = useTransform([enter, chromeFade], ([e, d]) => (e as number) * (d as number));

  const [dismissing, setDismissing] = useState(false);
  const flyingOff = useRef(false);
  const pastThreshold = useRef(false);

  const DISMISS_DISTANCE = 100;
  const DISMISS_VELOCITY = 600;

  // Open: fade the backdrop in.
  useEffect(() => {
    const c = animate(enter, 1, { duration: 0.22, ease: "easeOut" });
    return () => c.stop();
  }, [enter]);

  // Close (from X, back button, backdrop tap, or after a fly-off): hold the
  // element mounted until the shared-element return to the thumbnail has
  // finished, fading the backdrop out alongside it. Without this the black
  // layer popped away instantly while the photo was still travelling back.
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    if (isPresent) return;
    const duration = flyingOff.current ? 0.12 : 0.26;
    const c = animate(enter, 0, { duration, ease: "easeOut", onComplete: safeToRemove });
    return () => c.stop();
  }, [isPresent, enter, safeToRemove]);

  // One light tick the moment the pull crosses the "will close" line, and
  // another if you drag back under it — so you can feel the commit point.
  useEffect(() => {
    return dragY.on("change", (y) => {
      const over = Math.abs(y) > DISMISS_DISTANCE;
      if (over !== pastThreshold.current) {
        pastThreshold.current = over;
        hapticLight();
      }
    });
  }, [dragY]);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const y = dragY.get();
    // Distance OR a decisive flick, but the flick must agree with the
    // direction of the pull (an accidental up-flick while dragging down
    // slightly shouldn't close).
    const flick = Math.abs(info.velocity.y) > DISMISS_VELOCITY && Math.sign(info.velocity.y) === Math.sign(y || info.velocity.y);
    const shouldClose = Math.abs(y) > DISMISS_DISTANCE || flick;

    if (!shouldClose) {
      // Cancelled: settle back with a soft spring, carrying the release
      // velocity so it doesn't feel like a hard snap.
      animate(dragY, 0, { type: "spring", stiffness: 420, damping: 34, velocity: info.velocity.y });
      return;
    }

    // Closing: continue in the direction of travel, off screen, with the
    // finger's own velocity so the motion is continuous rather than a new
    // animation starting from rest. The shared-element layoutId is released
    // so the thumbnail doesn't try to "fly in" from off screen afterwards.
    flyingOff.current = true;
    setDismissing(true);
    hapticMedium();
    const direction = (y !== 0 ? Math.sign(y) : Math.sign(info.velocity.y)) || 1;
    const target = direction * (typeof window !== "undefined" ? window.innerHeight : 800);
    animate(dragY, target, {
      type: "spring",
      stiffness: 260,
      damping: 32,
      velocity: info.velocity.y,
      restDelta: 8,
      restSpeed: 40,
      onComplete: onClose,
    });
  };

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    // Saves the actual image onto the device (never opens the storage URL).
    const r = await downloadToDevice(src, `duospace_${Date.now()}`);
    toast("error" in r
      ? { title: "Couldn't save photo", description: r.error, variant: "destructive" }
      : { title: "Photo saved", description: r.where });
    setSaving(false);
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // BUG FIX: this previously called navigator.share({ url: src }) —
    // `src` is a SIGNED URL into the private "chat-files" Supabase bucket
    // (short-lived auth token in the query string, resolved specifically
    // for the current viewer — see resolveSignedUrl in Chat.tsx). Two
    // separate problems: (1) the raw Web Share API is inconsistently
    // supported inside a Capacitor Android/iOS WebView and can throw
    // outright rather than open a share sheet — "unable to share" is
    // exactly what that looks like to the user; (2) even when it DID
    // work, sharing a bare url means the receiving app (WhatsApp, Files,
    // Save to Photos...) gets a link string, not the actual photo — most
    // share targets expect a real file for media, and this signed URL
    // would likely be expired by the time anything tried to fetch it
    // anyway. Fixed the same way native save already works around this
    // (see handleSave above): fetch the bytes once, write them to a local
    // cache file, and hand @capacitor/share a real local file:// path.
    setSharing(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const { Share } = await import("@capacitor/share");
        const response = await fetch(src);
        const blob = await response.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const fileName = `duospace_share_${Date.now()}.jpg`;
        const written = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
        await Share.share({ url: written.uri, dialogTitle: "Share photo" });
      } else if (navigator.share) {
        // Web: fetch+share as an actual File where the browser supports
        // the Level 2 `files` share member — falls through to the plain
        // url share (still legitimate on web, where it's the visitor's
        // own authenticated session opening the link, not a third party)
        // if the browser can't do file shares or rejects this one.
        try {
          const response = await fetch(src);
          const blob = await response.blob();
          const file = new File([blob], `duospace_${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file] });
          } else {
            await navigator.share({ url: src });
          }
        } catch {
          /* user cancelled the share sheet — not an error */
        }
      } else {
        await downloadToDevice(src, `duospace_${Date.now()}`);
      }
    } catch (err) {
      // Genuine failure (not a cancel) — surfacing via the same
      // Fall back to saving the file itself — never to opening the raw
      // storage URL in a browser.
      await downloadToDevice(src, `duospace_${Date.now()}`);
    }
    setSharing(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      onClick={() => { if (!dismissing) onClose(); }}
      // BUG FIX: AppLayout's swipe-nav gesture (Chat <-> Calls) listens on
      // touchstart/touchend anywhere inside the page, including this
      // overlay. data-swipe-nav-ignore is useSwipeNav's opt-out hook.
      data-swipe-nav-ignore
    >
      {/* Backdrop: its own layer so it can fade with the pull and with
          open/close without touching the photo's transforms. */}
      <motion.div className="absolute inset-0 bg-black" style={{ opacity: backdropOpacity }} aria-hidden="true" />

      {/* Top bar */}
      <motion.div style={{ opacity: chromeOpacity }} className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-12 pb-3 safe-top bg-gradient-to-b from-black/60 to-transparent ${dismissing ? "pointer-events-none" : ""}`}>
        <button onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close"
          className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
          <X className="h-4 w-4 text-white" aria-hidden="true" />
        </button>
        <div className="flex items-center gap-2">
          <button onClick={(e) => { hapticMedium(); handleShare(e); }} disabled={sharing} aria-label="Share"
            className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center disabled:opacity-50">
            <Share2 className="h-4 w-4 text-white" aria-hidden="true" />
          </button>
          <button onClick={(e) => { hapticMedium(); handleSave(e); }} disabled={saving} aria-label="Save to device"
            className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center disabled:opacity-50">
            <Download className="h-4 w-4 text-white" aria-hidden="true" />
          </button>
        </div>
      </motion.div>

      {/* Image — real pinch-zoom + pan (usePinchZoomPan) plus a live,
          WhatsApp-style pull-down-to-dismiss on the wrapper below. Shares a
          layoutId with the tapped thumbnail (when one was supplied) so this
          expands FROM the thumbnail's actual on-screen rect rather than
          fading in as an unrelated fullscreen image. */}
      <div ref={containerRef} className="relative flex-1 flex items-center justify-center overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* BUG FIX (pull-down-to-dismiss lag): layoutId's FLIP projection
            and a live `drag` gesture fight over the same transform when put
            on one motion.div — Framer has to reconcile the layout
            animation's own transform writes against the drag's per-frame
            writes to `y`, which is exactly what showed up as stutter/lag
            while pulling down. Split them: this outer motion.div owns ONLY
            the shared-element layoutId/layout transition (the thumbnail ->
            fullscreen morph), untouched by drag. The inner motion.div below
            owns ONLY the live drag-to-dismiss (y/scale), with no layoutId —
            so the two transform writers never collide. */}
        <motion.div
          layoutId={photoId && !dismissing ? `photo-${photoId}` : undefined}
          transition={{ layout: { duration: 0.28, ease: EASE_SMOOTH } }}
          className="w-full h-full flex items-center justify-center"
        >
          <motion.div
            // Disarmed entirely during a real pinch or while zoomed in — a
            // single finger should pan the zoomed photo (handled by
            // usePinchZoomPan's own pointer handlers), not drag the whole
            // viewer toward dismissal. Same gating signal Gallery's viewer
            // uses for the identical reason.
            drag={!dismissing && !isPinching && !isZoomed ? "y" : false}
            dragMomentum={false}
            dragElastic={1}
            dragDirectionLock
            style={{ y: dragY, scale: photoScale, borderRadius: photoRadius, willChange: "transform" }}
            onDragEnd={handleDragEnd}
            className="w-full h-full flex items-center justify-center"
          >
            <img
              ref={imgRef}
              src={src}
              alt=""
              onClick={onImageTap}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              // touch-action: none — full manual control of pinch/pan, same
              // reasoning as Gallery's viewer: partial native-pinch-plus-our-
              // own-gesture is what caused the original snap-back/flicker bug
              // there. No CSS transition here either — this updates every
              // pointermove during an active gesture, and animating a value
              // that's already changing every frame just adds lag.
              className="max-w-full max-h-full object-contain select-none"
              style={{ touchAction: "none" }}
              draggable={false}
            />
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
};

export default PhotoViewer;
