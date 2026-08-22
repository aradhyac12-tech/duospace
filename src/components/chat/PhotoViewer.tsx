import { motion } from "framer-motion";
import { X, Download, Share2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useState } from "react";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { useSetImmersive } from "@/hooks/useImmersiveMode";
import { EASE_SMOOTH } from "@/lib/motion";

interface PhotoViewerProps {
  src: string;
  /** Phase 2.5, section 13: shared with the tapped MessageBubble thumbnail
   *  via the same `photo-${id}` layoutId — see the doc comment there. */
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

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // Native: save to Documents via Capacitor Filesystem
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const response = await fetch(src);
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(",")[1];
          await Filesystem.writeFile({
            path: `duospace_${Date.now()}.jpg`,
            data: base64,
            directory: Directory.Documents,
          });
        };
        reader.readAsDataURL(blob);
      } else {
        // Web: download via <a>
        const response = await fetch(src);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `duospace_${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      window.open(src, "_blank");
    }
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
        await navigator.clipboard.writeText(src);
      }
    } catch (err) {
      // Genuine failure (not a cancel) — surfacing via the same
      // window.open fallback handleSave already uses for its own catch,
      // so the person still has SOME way to get to the photo.
      window.open(src, "_blank");
    }
    setSharing(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
      onClick={() => { hapticLight(); onClose(); }}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-12 pb-3 safe-top bg-gradient-to-b from-black/60 to-transparent">
        <button onClick={(e) => { e.stopPropagation(); hapticLight(); onClose(); }} aria-label="Close"
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

      {/* Image — pinch-zoom on mobile. Shares a layoutId with the tapped
          thumbnail (when one was supplied) so this expands FROM the
          thumbnail's actual on-screen rect rather than fading in as an
          unrelated fullscreen image. Falls back to a plain img (no
          layoutId) for callers that don't have a message id — e.g. any
          future non-chat caller — so this stays optional, not required. */}
      <div className="flex-1 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <motion.img
          layoutId={photoId ? `photo-${photoId}` : undefined}
          src={src}
          alt=""
          className="max-w-full max-h-full object-contain"
          style={{ touchAction: "pinch-zoom" }}
          // Spec range for a shared-element/morph transition is 220-320ms —
          // the `layout` sub-key is what actually governs the FLIP
          // animation between the thumbnail's rect and this fullscreen one.
          transition={{ layout: { duration: 0.28, ease: EASE_SMOOTH } }}
        />
      </div>
    </motion.div>
  );
};

export default PhotoViewer;
