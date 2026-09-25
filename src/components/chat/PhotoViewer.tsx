import { motion, useMotionValue, useTransform, animate, type PanInfo } from "framer-motion";
import { X, Download, Share2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useState } from "react";
import { hapticMedium } from "@/lib/haptics";
import { useSetImmersive } from "@/hooks/useImmersiveMode";
import { EASE_SMOOTH } from "@/lib/motion";
import { toast } from "@/hooks/use-toast";
import { downloadToDevice } from "@/lib/downloadToDevice";
import { usePinchZoomPan } from "@/hooks/usePinchZoomPan";

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

  // Real two-finger pinch-zoom + pan + double-tap-zoom, same battle-tested
  // gesture math as Gallery's viewer (see usePinchZoomPan's own header for
  // why it writes transforms straight to the DOM instead of through React
  // state — that's what keeps this smooth/lag-free on a real phone). Was
  // previously just `touchAction: "pinch-zoom"` — a hint to the browser
  // that didn't reliably produce an actual zoom inside a Capacitor WebView.
  const { containerRef, imgRef, isZoomed, isPinching, onPointerDown, onPointerMove, onPointerUp, onImageTap } = usePinchZoomPan(src);

  // Live pull-down-to-dismiss (WhatsApp-style): dragY is a Framer Motion
  // value, not React state, so the backdrop fade and the photo's own
  // scale-down track the finger continuously via Framer's own rAF loop —
  // no re-render per pointermove, which is what keeps a fast flick-to-
  // dismiss smooth instead of stepping/lagging behind the finger.
  const dragY = useMotionValue(0);
  const backdropOpacity = useTransform(dragY, [-240, 0, 240], [0.25, 1, 0.25]);
  const photoScale = useTransform(dragY, [-240, 0, 240], [0.85, 1, 0.85]);

  // BUG FIX ("spring like comes and feels like the photo will not minimize
  // but after a second it minimises"): dragConstraints={top:0,bottom:0}
  // below means Framer's OWN release handling always tries to spring the
  // value back to 0 — that kicks in the instant the finger lifts, before
  // our onDragEnd callback's onClose() has even caused React to unmount
  // anything. So on a real dismiss the photo visibly sprang back toward
  // center first (looking like it refused to close) and only actually
  // disappeared once that spring settled and the state update caught up a
  // beat later. Fix: once we've decided the gesture passed the dismiss
  // threshold, stop treating it as a "return to center" drag at all — take
  // the motion value over ourselves and animate it the rest of the way OFF
  // screen, in the same direction the finger was already moving, and only
  // unmount when that finishes. `dismissing` also disarms `drag` below so
  // Framer's constraint logic never gets a chance to fight it.
  const [dismissing, setDismissing] = useState(false);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // Distance OR velocity dismisses — a quick short flick reads the same
    // as WhatsApp's own gesture, not just a slow long drag.
    const passedThreshold = Math.abs(info.offset.y) > 120 || Math.abs(info.velocity.y) > 800;
    if (!passedThreshold) return; // didn't pass — let the elastic constraint spring it back to center, that IS the "cancelled" feel
    setDismissing(true);
    const direction = info.offset.y < 0 ? -1 : 1;
    const target = direction * (typeof window !== "undefined" ? window.innerHeight : 800);
    const remaining = Math.abs(target - dragY.get());
    // Scales with how far it already has to travel so a near-the-edge flick
    // finishes fast and a threshold-just-cleared drag still looks snappy —
    // capped well under a second either way (this used to effectively take
    // "a second" because it was really two animations stacked: Framer's
    // spring-back, THEN the unmount).
    const duration = Math.min(0.22, Math.max(0.12, remaining / 2400));
    animate(dragY, target, { type: "tween", ease: "easeIn", duration, onComplete: onClose });
  };

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    // Saves the actual image onto the device (never opens the storage URL).
    const r = await downloadToDevice(src, `duospace_${Date.now()}`);
    toast(r.ok
      ? { title: "Photo saved", description: r.where }
      : { title: "Couldn't save photo", description: r.error, variant: "destructive" });
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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{ opacity: backdropOpacity }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
      onClick={() => { onClose(); }}
      // BUG FIX: AppLayout's swipe-nav gesture (Chat <-> Calls) listens on
      // touchstart/touchend anywhere inside the page, including this
      // overlay — it has no idea a fullscreen photo is open on top. A
      // right-swipe here (e.g. to pan/dismiss the photo) was bubbling up
      // and getting read as "swipe right = go to Calls" underneath.
      // data-swipe-nav-ignore is useSwipeNav's own opt-out hook (it checks
      // target.closest on every touchstart), so this fully fenced the
      // photo viewer off from tab navigation without touching AppLayout.
      data-swipe-nav-ignore
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-12 pb-3 safe-top bg-gradient-to-b from-black/60 to-transparent">
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
      </div>

      {/* Image — real pinch-zoom + pan (usePinchZoomPan) plus a live,
          WhatsApp-style pull-down-to-dismiss on the wrapper below. Shares a
          layoutId with the tapped thumbnail (when one was supplied) so this
          expands FROM the thumbnail's actual on-screen rect rather than
          fading in as an unrelated fullscreen image. */}
      <div ref={containerRef} className="flex-1 flex items-center justify-center overflow-hidden" onClick={(e) => e.stopPropagation()}>
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
          layoutId={photoId ? `photo-${photoId}` : undefined}
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
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.6}
            style={{ y: dragY, scale: photoScale }}
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
    </motion.div>
  );
};

export default PhotoViewer;
