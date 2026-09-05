import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, ImageIcon, Lock, Unlock, Eye, EyeOff, Trash2, Camera, Play, Download, Share2, X, RotateCcw, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight, LayoutGrid, Grid3x3, CheckSquare, Square, Heart, SlidersHorizontal } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignedUrl, resolveSignedUrls } from "@/lib/signedStorageUrl";
import { resumableUpload } from "@/lib/resumableUpload";
import { useAuth } from "@/hooks/useAuth";
import { useMediaPermission } from "@/components/PermissionDeniedSheet";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import CameraWithFilters from "@/components/CameraWithFilters";
import { Capacitor } from "@capacitor/core";
import storage from "@/lib/storage";
import { hapticLight, hapticMedium, hapticWarning, hapticError } from "@/lib/haptics";
import { useGroic } from "@/contexts/GroicContext";
import { isToday, isYesterday, format } from "date-fns";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FolderPlus, Images } from "lucide-react";

interface GalleryItem {
  id: string;
  file_url: string;
  file_type: string;
  owner_id: string;
  is_shared: boolean;
  is_favorite: boolean;
  created_at: string;
  file_name?: string;
}

interface GalleryAlbum {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}

/** One in-flight/failed/finished item in the upload queue — replaces the
 *  old single shared `uploading` boolean + fake 0→100 progress jump.
 *  Supabase's storage.upload() doesn't expose byte-level progress on this
 *  client, so rather than fake a percentage this tracks real per-file
 *  status (queued/uploading/done/error) and keeps the original file
 *  around so a failed item can be retried without re-picking it. */
interface UploadQueueItem {
  id: string;
  name: string;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  isVideo: boolean;
  file: File | Blob;
  errorMessage?: string;
  // Real byte-level progress (0-100) — only ever set from resumableUpload's
  // onProgress callback for large files. Left undefined for small files
  // uploaded via the plain path, since supabase-js's storage.upload() gives
  // no byte progress and this UI must never show a fake percentage
  // (Phase 8F requirement, Final Release Audit).
  progress?: number;
}

// Phase 8F (Final Release Audit): threshold above which uploads go through
// the resumable/chunked path instead of a single-shot upload. 6MB matches
// Supabase's general guidance for when resumable/TUS-style upload starts to
// meaningfully help — below this, a single request completes fast enough
// on most connections that chunking overhead (a DB tracking row + an extra
// edge function round trip) isn't worth it; above it, a flaky mobile
// connection is much more likely to drop mid-upload and losing the whole
// file (rather than just the last unfinished chunk) becomes a real cost.
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;

// BUG FIX: see src/lib/signedStorageUrl.ts — the "gallery" bucket is private
// (correctly — Gallery has a Private/Shared visibility toggle), but uploads
// were stored via getPublicUrl(), which 403s against a private bucket. Every
// photo rendered as a broken image as a result.
async function resolveGalleryUrl(rawUrl: string): Promise<string> {
  return resolveSignedUrl("gallery", rawUrl);
}

/** PERF FIX (Phase 1 #5): drives the "load next page near the bottom of
 *  the grid" trigger for the Mine/Partner tabs. A plain native
 *  IntersectionObserver (no new dependency) watching a 1px sentinel div
 *  rendered after the grid; fires `onReach` once per intersection so a
 *  fast scroll-past doesn't queue up duplicate page fetches (loadMore*
 *  itself is also re-entrancy-guarded via loadingMore* as a second line
 *  of defense). */
function useLoadMoreSentinel(onReach: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onReach();
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onReach, enabled]);
  return ref;
}

async function resolveGalleryItems(items: GalleryItem[]): Promise<GalleryItem[]> {
  return resolveSignedUrls("gallery", items, "file_url");
}

/**
 * "Our Moments" date grouping (Phase 5 Part 8) — Today / Yesterday /
 * "August 2026" — a pure display transform over whatever's already in
 * `items` (already sorted newest-first by rebuildShared/loadGallery), not
 * a new data model. Groups stay in the incoming item order, so this is
 * safe to call on any of the three existing tabs (shared/mine/theirs)
 * without changing what data each tab shows — only how it's headed.
 */
interface DateGroup { label: string; items: GalleryItem[] }
function groupByDate(items: GalleryItem[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const item of items) {
    const d = new Date(item.created_at);
    const label = isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, "MMMM yyyy");
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

// NO compression — upload original file as-is per user requirement
const MediaThumbnail = memo(({ item, onClick, selectionMode, selected }: {
  item: GalleryItem; onClick: (item: GalleryItem) => void; selectionMode?: boolean; selected?: boolean;
}) => {
  if (item.file_type === "video") {
    return (
      <div className={`w-full h-full relative cursor-pointer active:scale-95 transition-transform duration-100 ${selected ? "ring-2 ring-inset ring-primary" : ""}`} onClick={() => { onClick(item); }}>
        <video src={item.file_url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
        {!selectionMode && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="h-9 w-9 rounded-full bg-black/60 flex items-center justify-center">
              <Play className="h-4 w-4 text-white ml-0.5" />
            </div>
          </div>
        )}
        {selectionMode && (
          <div className="absolute top-1.5 left-1.5 h-5 w-5 rounded-full bg-black/50 flex items-center justify-center">
            {selected ? <CheckSquare className="h-3.5 w-3.5 text-primary-foreground fill-primary" /> : <Square className="h-3.5 w-3.5 text-white/80" />}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`w-full h-full relative ${selected ? "ring-2 ring-inset ring-primary" : ""}`}>
      <img src={item.file_url} alt="" loading="lazy" decoding="async"
        className="w-full h-full object-cover cursor-pointer active:scale-95 transition-transform duration-100"
        onClick={() => { onClick(item); }} />
      {selectionMode && (
        <div className="absolute top-1.5 left-1.5 h-5 w-5 rounded-full bg-black/50 flex items-center justify-center pointer-events-none">
          {selected ? <CheckSquare className="h-3.5 w-3.5 text-primary-foreground fill-primary" /> : <Square className="h-3.5 w-3.5 text-white/80" />}
        </div>
      )}
    </div>
  );
});
MediaThumbnail.displayName = "MediaThumbnail";

// Full-screen viewer with download + share + prev/next navigation
const MediaViewer = ({
  item,
  onClose,
  onSaveToGallery,
  isOwner,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onToggleFavorite,
}: {
  item: GalleryItem | null;
  onClose: () => void;
  onSaveToGallery?: (item: GalleryItem) => void;
  isOwner: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onToggleFavorite?: (item: GalleryItem) => void;
}) => {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  // ROOT-CAUSE FIX ("laggy/flickering photos" — confirmed via screen
  // recording of an actual pinch gesture): the previous approach used TWO
  // independent, uncoordinated zoom systems on the same element at once —
  // `touch-action: pinch-zoom` (telling the BROWSER to handle pinch
  // natively, as a viewport-level zoom, chrome and all) layered underneath
  // Framer Motion's own `drag` gesture recognizer, gated only by the
  // discrete double-tap `zoomed` boolean. A real two-finger pinch never
  // touches that boolean at all — it's a continuous native browser gesture
  // — so `drag={true}` stayed fully armed for the ENTIRE pinch. Framer
  // Motion's pointer listeners and the browser's native pinch-zoom were
  // both reading the same two touch points at once, and because this
  // motion.div's `dragConstraints` pin it to (0,0) on every axis, the
  // instant fingers lifted (or Motion's own gesture settled) it sprang the
  // element back to its constrained position — which is exactly what a
  // native browser pinch-zoom reads as "the underlying content moved
  // under me," and resets its own zoom in response. That's the
  // snap-back/flicker on camera: two systems fighting over one gesture,
  // each one's resolution knocking the other back to its rest state.
  //
  // Fixed by taking full manual control instead of leaning on native+
  // partial: a real two-pointer pinch state machine below (distance ->
  // scale, midpoint -> pan), touch-action set to "none" so the browser
  // never engages its own competing zoom, and Framer Motion's drag now
  // gated on a CONTINUOUS signal (isPinching || scale > 1) instead of the
  // old discrete double-tap flag — so it's actually disarmed for the
  // entire duration of a real pinch, not just when a double-tap happened
  // to already toggle a boolean.
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isPinching, setIsPinching] = useState(false);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const imgElRef = useRef<HTMLImageElement>(null);
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; scale: number; midX: number; midY: number; tx: number; ty: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTapRef = useRef(0);

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Keeps a zoomed image from being panned out into empty space. Bounds are
  // deliberately approximate (based on the container's own box, since an
  // object-contain image roughly fills it at scale 1) rather than pixel-
  // exact — good enough to stop the image drifting away, not worth the
  // fragility of measuring the post-transform rendered box mid-gesture.
  const clampTranslate = (s: number, tx: number, ty: number) => {
    const rect = mediaContainerRef.current?.getBoundingClientRect();
    if (!rect || s <= 1) return { x: 0, y: 0 };
    const maxX = (rect.width * (s - 1)) / 2;
    const maxY = (rect.height * (s - 1)) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, tx)), y: Math.max(-maxY, Math.min(maxY, ty)) };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size === 2) {
      panStart.current = null; // a second finger landed mid-pan — hand off to pinch
      const [a, b] = Array.from(activePointers.current.values());
      const mid = midpoint(a, b);
      pinchStart.current = { dist: dist(a, b), scale, midX: mid.x, midY: mid.y, tx: translate.x, ty: translate.y };
      setIsPinching(true);
    } else if (activePointers.current.size === 1 && scale > 1) {
      const [p] = Array.from(activePointers.current.values());
      panStart.current = { x: p.x, y: p.y, tx: translate.x, ty: translate.y };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size === 2 && pinchStart.current) {
      const [a, b] = Array.from(activePointers.current.values());
      const newDist = dist(a, b);
      const mid = midpoint(a, b);
      const nextScale = Math.min(4, Math.max(1, pinchStart.current.scale * (newDist / pinchStart.current.dist)));
      const next = clampTranslate(
        nextScale,
        pinchStart.current.tx + (mid.x - pinchStart.current.midX),
        pinchStart.current.ty + (mid.y - pinchStart.current.midY),
      );
      setScale(nextScale);
      setTranslate(next);
    } else if (activePointers.current.size === 1 && panStart.current) {
      const [p] = Array.from(activePointers.current.values());
      setTranslate(clampTranslate(scale, panStart.current.tx + (p.x - panStart.current.x), panStart.current.ty + (p.y - panStart.current.y)));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) {
      pinchStart.current = null;
      setIsPinching(false);
      // A pinch that ends barely above 1x reads as an accidental/settling
      // gesture, not an intentional zoom — snap fully back rather than
      // leaving the image in an awkward almost-zoomed state.
      if (scale < 1.05) { setScale(1); setTranslate({ x: 0, y: 0 }); }
    }
    if (activePointers.current.size === 1) {
      const [p] = Array.from(activePointers.current.values());
      panStart.current = scale > 1 ? { x: p.x, y: p.y, tx: translate.x, ty: translate.y } : null;
    } else if (activePointers.current.size === 0) {
      panStart.current = null;
    }
  };

  // Double-tap-to-zoom: zooms centered on the tap point (standard
  // translate = (center - tapPoint) * (scale - 1) formula) rather than the
  // old CSS transform-origin approach — unified onto the same numeric
  // translate/scale state the pinch handlers above use, instead of two
  // different mechanisms for reaching the same visual result.
  const handleImageTap = (e: React.MouseEvent<HTMLImageElement>) => {
    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < 300;
    lastTapRef.current = now;
    if (!isDoubleTap) return;
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const targetScale = 2.5;
    setScale(targetScale);
    setTranslate(clampTranslate(targetScale, (cx - e.clientX) * (targetScale - 1), (cy - e.clientY) * (targetScale - 1)));
  };

  // Reset zoom/pan state whenever the viewer moves to a different item —
  // otherwise swiping to the next photo while zoomed in would carry the
  // zoomed transform over onto unrelated media.
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setIsPinching(false);
    activePointers.current.clear();
    pinchStart.current = null;
    panStart.current = null;
  }, [item?.id]);

  // Music/video interruption (Part 11/35): Gallery previously never
  // touched Groic at all, so a video's autoplay could play underneath
  // whatever the person already had going in Music. Pauses once (if
  // music was playing) the first time a video starts within this viewer
  // session; resumes once when the whole viewer closes. Deliberately
  // NOT re-paused/resumed on every swipe between videos — repeatedly
  // calling toggle() per item would need to track state through async
  // updates it can't reliably observe here, so this scopes the pause to
  // "a video is being viewed at all" rather than "this exact item."
  //
  // toggleMusic is read through a ref, kept fresh every render, because
  // GroicContext's toggle() closes over `isPlaying` (see its own [isPlaying]
  // dep) — a toggle reference captured once in a mount-only effect would
  // go stale the moment isPlaying changes (i.e. the instant we pause),
  // and calling that stale closure back in the unmount cleanup would
  // pause again instead of resuming.
  const { isPlaying: musicPlaying, toggle: toggleMusic } = useGroic();
  const toggleMusicRef = useRef(toggleMusic);
  useEffect(() => { toggleMusicRef.current = toggleMusic; }, [toggleMusic]);
  const musicPausedByUsRef = useRef(false);
  useEffect(() => {
    if (item?.file_type === "video" && musicPlaying && !musicPausedByUsRef.current) {
      musicPausedByUsRef.current = true;
      toggleMusicRef.current();
    }
  }, [item?.id, item?.file_type, musicPlaying]);
  useEffect(() => {
    return () => {
      if (musicPausedByUsRef.current) toggleMusicRef.current();
    };
  }, []);

  // Keyboard nav — left/right to move between items, Escape to close.
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onPrev?.();
      else if (e.key === "ArrowRight" && hasNext) onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onPrev, onNext, hasPrev, hasNext, onClose]);

  if (!item) return null;

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // Fix #Bug8: Directory.Documents saves to private app storage — invisible in
        // the Photos/Gallery app. Use Directory.External + DCIM/ path so the file
        // appears in the device Camera Roll on both Android and iOS.
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const response = await fetch(item.file_url);
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(",")[1];
          const ext = item.file_type === "video" ? "mp4" : "jpg";
          const fileName = `DCIM/duospace_${Date.now()}.${ext}`;
          await Filesystem.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.External,
            recursive: true,
          });
          toast({ title: "Saved to Camera Roll ✓" });
        };
        reader.readAsDataURL(blob);
      } else {
        // Web: trigger browser download
        const response = await fetch(item.file_url);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ext = item.file_type === "video" ? "mp4" : "jpg";
        a.download = item.file_name || `duospace_${Date.now()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast({ title: "Downloaded ✓" });
      }
    } catch (err: unknown) {
      // Fallback: open in new tab
      window.open(item.file_url, "_blank");
      toast({ title: "Opened in browser" });
    }
    setDownloading(false);
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // BUG FIX: same root cause as PhotoViewer.tsx's handleShare (see the
    // detailed comment there) — navigator.share({url}) on a private,
    // short-lived signed Supabase URL is unreliable inside a Capacitor
    // WebView and doesn't actually hand the receiving app a usable file.
    // Same fix: download the bytes once, write to a local cache file,
    // hand @capacitor/share (native) or a real File object via the Web
    // Share API Level 2 `files` member (web) a file the OS can actually
    // pass along — not a link into a bucket the recipient can't reach.
    setSharing(true);
    try {
      const ext = item.file_type === "video" ? "mp4" : "jpg";
      if (Capacitor.isNativePlatform()) {
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const { Share } = await import("@capacitor/share");
        const response = await fetch(item.file_url);
        const blob = await response.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const fileName = item.file_name || `duospace_share_${Date.now()}.${ext}`;
        const written = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
        await Share.share({ url: written.uri, dialogTitle: "Share from DuoSpace" });
      } else if (navigator.share) {
        try {
          const response = await fetch(item.file_url);
          const blob = await response.blob();
          const file = new File([blob], item.file_name || `duospace_${Date.now()}.${ext}`, {
            type: blob.type || (item.file_type === "video" ? "video/mp4" : "image/jpeg"),
          });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: "Shared from DuoSpace" });
          } else {
            await navigator.share({ url: item.file_url, title: "Shared from DuoSpace" });
          }
        } catch { /* user cancelled */ }
      } else {
        await navigator.clipboard.writeText(item.file_url);
        toast({ title: "Link copied" });
      }
    } catch {
      // Genuine failure (not a cancel) — same fallback handleDownload's
      // own catch above uses, so there's still a way to reach the file.
      window.open(item.file_url, "_blank");
      toast({ title: "Opened in browser" });
    }
    setSharing(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black flex flex-col safe-bottom"
      onClick={() => { onClose(); }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-3 safe-top absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close"
          className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
          <X className="h-4 w-4 text-white" aria-hidden="true" />
        </button>
        <div className="flex items-center gap-2">
          {/* Save to gallery (receiver side) */}
          {!isOwner && onSaveToGallery && (
            <button onClick={(e) => { e.stopPropagation(); hapticMedium(); onSaveToGallery(item); }}
              className="h-9 px-3 rounded-full bg-white/20 flex items-center gap-1.5 backdrop-blur-sm">
              <Plus className="h-4 w-4 text-white" />
              <span className="text-xs text-white font-medium">Save</span>
            </button>
          )}
          {/* Shared couple favorite — same action/handler as the grid
              tile's heart, just reachable from the full-screen viewer too
              (Part 9: "Favorite where supported"). */}
          {onToggleFavorite && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite(item); }}
              aria-label={item.is_favorite ? "Remove from favorites" : "Add to favorites"}
              className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm"
            >
              <Heart className={`h-4 w-4 ${item.is_favorite ? "fill-red-500 text-red-500" : "text-white"}`} aria-hidden="true" />
            </button>
          )}
          {/* Share */}
          <button onClick={(e) => { hapticMedium(); handleShare(e); }} disabled={sharing} aria-label="Share"
            className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm disabled:opacity-50">
            <Share2 className="h-4 w-4 text-white" aria-hidden="true" />
          </button>
          {/* Download */}
          <button onClick={(e) => { hapticMedium(); handleDownload(e); }} disabled={downloading} aria-label="Download"
            className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm disabled:opacity-50">
            <Download className="h-4 w-4 text-white" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Media */}
      <div ref={mediaContainerRef} className="flex-1 flex items-center justify-center relative" onClick={(e) => e.stopPropagation()}>
        {hasPrev && (
          <button onClick={(e) => { e.stopPropagation(); onPrev?.(); }} aria-label="Previous"
            className="absolute left-2 z-10 h-11 w-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
            <ChevronLeft className="h-5 w-5 text-white" aria-hidden="true" />
          </button>
        )}
        {hasNext && (
          <button onClick={(e) => { e.stopPropagation(); onNext?.(); }} aria-label="Next"
            className="absolute right-2 z-10 h-11 w-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
            <ChevronRight className="h-5 w-5 text-white" aria-hidden="true" />
          </button>
        )}
        <motion.div
          key={item.id}
          // Gated on the CONTINUOUS isPinching/scale signal now, not the
          // old discrete double-tap boolean — see this component's
          // top-of-file ROOT-CAUSE FIX comment. Disarmed for the entire
          // duration of a real pinch, and while already zoomed in (so a
          // single finger pans the image via the pointer handlers below
          // instead of Motion reading it as a swipe).
          drag={!isPinching && scale <= 1}
          dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
          dragElastic={0.2}
          onDragEnd={(_, info) => {
            // Vertical swipe (Part 10: "swipe down to dismiss") takes
            // priority when it's the dominant axis of the gesture — a
            // mostly-vertical drag dismisses; a mostly-horizontal one
            // navigates prev/next, same threshold logic as before.
            if (Math.abs(info.offset.y) > Math.abs(info.offset.x) && info.offset.y > 100) {
              onClose();
              return;
            }
            if (info.offset.x < -80 && hasNext) { onNext?.(); }
            else if (info.offset.x > 80 && hasPrev) { onPrev?.(); }
          }}
          className="w-full h-full flex items-center justify-center"
        >
          {item.file_type === "video" ? (
            <video
              src={item.file_url}
              controls
              autoPlay
              playsInline
              className="max-w-full max-h-full"
            />
          ) : (
            <img
              ref={imgElRef}
              src={item.file_url}
              alt=""
              onClick={handleImageTap}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              // touch-action: none — full manual control, not partial
              // native-zoom-plus-our-own-drag (see top-of-file comment for
              // why that combination was the actual bug). No CSS
              // transition on transform: this updates every pointermove
              // during an active gesture, and animating a value that's
              // already changing every frame just adds lag on top of the
              // conflict that was there before — the double-tap path gets
              // its own smoothness for free from React batching the jump
              // between two states, not from a CSS transition fighting a
              // live gesture the rest of the time.
              className="max-w-full max-h-full object-contain select-none"
              style={{ touchAction: "none", transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})` }}
            />
          )}
        </motion.div>
      </div>
    </motion.div>
  );
};

const Gallery = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [myItems, setMyItems] = useState<GalleryItem[]>([]);
  const [sharedItems, setSharedItems] = useState<GalleryItem[]>([]);
  const [partnerItems, setPartnerItems] = useState<GalleryItem[]>([]);
  // PERF FIX (Phase 1 #5): gallery pagination. Both owner streams used to
  // be fetched in full (no .range()/.limit()) — fine for a handful of
  // photos, unbounded and slow/memory-heavy for a couple with thousands.
  // Each stream now loads GALLERY_PAGE_SIZE at a time using a stable
  // (created_at, id) keyset cursor (not offset pagination, which skips/
  // repeats rows when new items are inserted between pages — a couple
  // actively adding photos while scrolling is the common case here, not
  // an edge case). `hasMore*` gates the load-more sentinel per tab;
  // `loadingMore*` guards against duplicate concurrent page fetches from
  // a fast-scrolling observer trigger.
  const [hasMoreMine, setHasMoreMine] = useState(true);
  const [hasMorePartner, setHasMorePartner] = useState(true);
  const [loadingMoreMine, setLoadingMoreMine] = useState(false);
  const [loadingMorePartner, setLoadingMorePartner] = useState(false);
  const [myGalleryShared, setMyGalleryShared] = useState(false);
  // Media visibility toggle — when off, media in chat won't auto-load
  const [mediaVisibility, setMediaVisibility] = useState(true);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState("Partner");
  const [showShareDialog, setShowShareDialog] = useState(false);
  // BUG FIX (buttons rendering off-screen): the header used to hold five
  // inline controls (density toggle, a full Switch-based visibility pill,
  // a text+icon Private/Shared button, Camera, Upload) inside PageHeader's
  // `justify-between` row, which never wraps. On a 375px-wide phone that
  // row alone measured ~299px, and combined with the back button + "Our
  // moments" title on the left, the total exceeded the ~335px actually
  // available — Camera/Upload were rendering partially or fully past the
  // right edge of the screen, not just visually cramped. Grid density,
  // media visibility, and the private/shared toggle are all view/status
  // *settings*, not the two primary create actions (Camera, Upload) users
  // reach for most — grouping them into one sheet (below) both fixes the
  // overflow and reads as more deliberate IA than five loose icons.
  const [showGalleryOptions, setShowGalleryOptions] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState<string | null>(null);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [viewList, setViewList] = useState<GalleryItem[]>([]);
  const [viewIndex, setViewIndex] = useState(0);
  const [viewItemIsOwner, setViewItemIsOwner] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [gridDensity, setGridDensity] = useState<"comfortable" | "compact">(() =>
    (storage.get("duo-gallery-density") as "comfortable" | "compact") || "comfortable");
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  // Albums (Part 19). albumItemIds maps album id -> ordered list of
  // gallery_item ids in it; kept separate from `albums` itself so a
  // realtime item-add/remove doesn't need to touch album metadata rows.
  const [albums, setAlbums] = useState<GalleryAlbum[]>([]);
  const [albumItemIds, setAlbumItemIds] = useState<Record<string, string[]>>({});
  const [viewingAlbumId, setViewingAlbumId] = useState<string | null>(null);
  const [showCreateAlbum, setShowCreateAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { ensure: ensureMedia, permissionSheet } = useMediaPermission();

  const uploading = uploadQueue.some(q => q.status === "uploading" || q.status === "queued" || q.status === "processing");
  const viewItem = viewList[viewIndex] ?? null;

  // Album detail resolves item ids -> full GalleryItem objects (with
  // already-resolved signed file_url) from whichever of myItems/
  // partnerItems actually holds them — an album can contain either
  // partner's photos. myItems/partnerItems are themselves already
  // RLS-filtered to only what this user can see, so no extra visibility
  // check is needed here on top of that.
  const allKnownItems = useMemo(() => {
    const map = new Map<string, GalleryItem>();
    for (const i of myItems) map.set(i.id, i);
    for (const i of partnerItems) map.set(i.id, i);
    return map;
  }, [myItems, partnerItems]);
  const viewingAlbum = albums.find(a => a.id === viewingAlbumId) ?? null;
  const viewingAlbumItems = viewingAlbumId
    ? (albumItemIds[viewingAlbumId] || []).map(id => allKnownItems.get(id)).filter((i): i is GalleryItem => !!i)
    : [];

  const setDensity = (d: "comfortable" | "compact") => {
    setGridDensity(d);
    storage.set("duo-gallery-density", d);
  };

  const toggleSelectionMode = () => {
    hapticLight();
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelected = useCallback((id: string) => {
    hapticLight();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Load media visibility from localStorage
  useEffect(() => {
    const stored = storage.get("duo-media-visibility");
    if (stored !== null) setMediaVisibility(stored === "true");
  }, []);

  const setAndSaveMediaVisibility = (val: boolean) => {
    setMediaVisibility(val);
    storage.set("duo-media-visibility", String(val));
  };

  const rebuildShared = useCallback((mine: GalleryItem[], partner: GalleryItem[]) => {
    const all = [
      ...mine.filter(i => i.is_shared),
      ...partner.filter(i => i.is_shared),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setSharedItems(all);
  }, []);

  const GALLERY_PAGE_SIZE = 40;
  const GALLERY_SELECT = "id,owner_id,file_url,file_type,is_shared,is_favorite,created_at";

  /** Keyset ("seek") pagination page — same ordering as the original
   *  unbounded query (created_at desc), with `id` as a tiebreaker so rows
   *  sharing an identical created_at timestamp (same millisecond batch
   *  upload) still get a total order and can't be skipped or repeated
   *  across pages. `cursor` is the last row of the previous page; omit it
   *  for the first page. */
  const fetchGalleryPage = async (
    ownerId: string,
    cursor?: Pick<GalleryItem, "created_at" | "id">,
  ): Promise<GalleryItem[]> => {
    let query = supabase.from("gallery_items").select(GALLERY_SELECT)
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(GALLERY_PAGE_SIZE);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
      );
    }
    const { data } = await query;
    return (data || []) as GalleryItem[];
  };

  const loadGallery = useCallback(async (uid: string, pid: string | null) => {
    const mine = await fetchGalleryPage(uid);
    const myList = await resolveGalleryItems(mine);
    setMyItems(myList);
    setHasMoreMine(mine.length === GALLERY_PAGE_SIZE);

    if (pid) {
      const partner = await fetchGalleryPage(pid);
      const partnerList = await resolveGalleryItems(partner);
      setPartnerItems(partnerList);
      setHasMorePartner(partner.length === GALLERY_PAGE_SIZE);
      rebuildShared(myList, partnerList);
    } else {
      setHasMorePartner(false);
    }
  }, [rebuildShared]);

  /** Loads the next page for "mine" or "theirs" and appends it — never
   *  replaces what's already loaded, so scroll position and any in-flight
   *  selection/viewer state over earlier items stay valid. De-dupes
   *  against ids already present in case a realtime INSERT prepended a
   *  row that the next page's query would also legitimately return
   *  (its created_at now sorts after the cursor either way, so this is
   *  a defensive dedupe rather than an expected common path). */
  const loadMoreMine = useCallback(async () => {
    if (loadingMoreMine || !hasMoreMine || !user) return;
    setLoadingMoreMine(true);
    try {
      const last = myItemsRef.current[myItemsRef.current.length - 1];
      if (!last) { setHasMoreMine(false); return; }
      const page = await fetchGalleryPage(user.id, last);
      setHasMoreMine(page.length === GALLERY_PAGE_SIZE);
      if (page.length === 0) return;
      const resolved = await resolveGalleryItems(page);
      setMyItems(prev => {
        const seen = new Set(prev.map(i => i.id));
        const next = [...prev, ...resolved.filter(i => !seen.has(i.id))];
        rebuildShared(next, partnerItemsRef.current);
        return next;
      });
    } finally {
      setLoadingMoreMine(false);
    }
  }, [loadingMoreMine, hasMoreMine, user, rebuildShared]);

  const loadMorePartner = useCallback(async () => {
    if (loadingMorePartner || !hasMorePartner || !partnerId) return;
    setLoadingMorePartner(true);
    try {
      const last = partnerItemsRef.current[partnerItemsRef.current.length - 1];
      if (!last) { setHasMorePartner(false); return; }
      const page = await fetchGalleryPage(partnerId, last);
      setHasMorePartner(page.length === GALLERY_PAGE_SIZE);
      if (page.length === 0) return;
      const resolved = await resolveGalleryItems(page);
      setPartnerItems(prev => {
        const seen = new Set(prev.map(i => i.id));
        const next = [...prev, ...resolved.filter(i => !seen.has(i.id))];
        rebuildShared(myItemsRef.current, next);
        return next;
      });
    } finally {
      setLoadingMorePartner(false);
    }
  }, [loadingMorePartner, hasMorePartner, partnerId, rebuildShared]);

  const mineSentinelRef = useLoadMoreSentinel(loadMoreMine, hasMoreMine);
  const partnerSentinelRef = useLoadMoreSentinel(loadMorePartner, hasMorePartner);

  // Albums (Part 19). RLS on both tables already scopes results to the
  // couple, so this is a plain unfiltered select — no need to pass/repeat
  // the owner_id/partner_id logic loadGallery does, the database enforces
  // it either way. Kept as a single refetch-everything function rather
  // than granular per-row patching (unlike gallery_items' realtime
  // handler) — deliberately simpler: album membership changes are
  // low-frequency compared to photo uploads, and correctness here matters
  // more than shaving a refetch.
  const loadAlbums = useCallback(async () => {
    const { data: albumRows } = await supabase.from("gallery_albums")
      .select("id,owner_id,name,created_at").order("created_at", { ascending: false });
    setAlbums((albumRows || []) as GalleryAlbum[]);

    const { data: itemRows } = await supabase.from("gallery_album_items")
      .select("album_id,gallery_item_id").order("created_at", { ascending: true });
    const grouped: Record<string, string[]> = {};
    for (const row of (itemRows || []) as { album_id: string; gallery_item_id: string }[]) {
      (grouped[row.album_id] ||= []).push(row.gallery_item_id);
    }
    setAlbumItemIds(grouped);
  }, []);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: profile } = await supabase.from("profiles")
        .select("partner_id, gallery_shared, pet_name").eq("user_id", user.id).single();
      if (profile) {
        const pid = profile.partner_id;
        setPartnerId(pid);
        setMyGalleryShared(profile.gallery_shared);
        if (pid) {
          const { data: pp } = await supabase.from("profiles")
            .select("display_name").eq("user_id", pid).single();
          if (pp) setPartnerName(profile.pet_name || pp.display_name || "Partner");
        }
        await loadGallery(user.id, pid);
        await loadAlbums();
      }
    };
    load();
  }, [user, loadGallery, loadAlbums]);

  // Albums realtime — refetch-on-change (see loadAlbums' own comment for
  // why this is simpler than gallery_items' per-row patching). One
  // channel for both tables since they always change together from the
  // UI's perspective (an album's item list is meaningless without the
  // album row, and vice versa for this app's purposes).
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("gallery-albums-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "gallery_albums" }, () => { loadAlbums(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "gallery_album_items" }, () => { loadAlbums(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, loadAlbums]);

  // Use refs inside realtime callback to avoid stale closures + channel churn
  const myItemsRef = useRef<GalleryItem[]>([]);
  const partnerItemsRef = useRef<GalleryItem[]>([]);
  const partnerNameRef = useRef(partnerName);
  useEffect(() => { myItemsRef.current = myItems; }, [myItems]);
  useEffect(() => { partnerItemsRef.current = partnerItems; }, [partnerItems]);
  useEffect(() => { partnerNameRef.current = partnerName; }, [partnerName]);

  // Realtime — auto-add partner photos; channel created once per partnerId
  useEffect(() => {
    if (!user || !partnerId) return;
    // BUG FIX (UI_REDESIGN_BUG_REGISTER BUG-04): the INSERT handler below
    // resolves a signed URL asynchronously, then calls setPartnerItems in
    // its .then(). If the effect tears down (partner/user change, or the
    // page unmounts) while that fetch is still in flight, the stale
    // .then() would otherwise fire against a defunct subscription. React
    // itself no-ops a state update after unmount, but this ref also
    // covers the "effect re-ran for a new partnerId" case, which React's
    // unmount safety doesn't — same mountedRef-guard pattern already used
    // in useDailyCall.ts.
    let cancelled = false;
    const channel = supabase
      .channel(`gallery-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "gallery_items" }, (payload) => {
        const rawItem = payload.new as GalleryItem;
        if (rawItem.owner_id === partnerId) {
          resolveGalleryUrl(rawItem.file_url).then((signedUrl) => {
            if (cancelled) return;
            const newItem = { ...rawItem, file_url: signedUrl };
            setPartnerItems(prev => {
              const updated = [newItem, ...prev];
              rebuildShared(myItemsRef.current, updated);
              return updated;
            });
            if (newItem.is_shared) {
              toast({ title: `${partnerNameRef.current} added a photo 📸` });
            }
          });
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "gallery_items" }, (payload) => {
        const updated = payload.new as GalleryItem;
        if (updated.owner_id === user.id) {
          setMyItems(prev => {
            const list = prev.map(i => i.id === updated.id ? { ...updated, file_url: i.file_url } : i);
            rebuildShared(list, partnerItemsRef.current);
            return list;
          });
        } else {
          setPartnerItems(prev => {
            const list = prev.map(i => i.id === updated.id ? { ...updated, file_url: i.file_url } : i);
            rebuildShared(myItemsRef.current, list);
            return list;
          });
        }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "gallery_items" }, (payload) => {
        const id = (payload.old as any).id;
        setMyItems(prev => prev.filter(i => i.id !== id));
        setPartnerItems(prev => prev.filter(i => i.id !== id));
        setSharedItems(prev => prev.filter(i => i.id !== id));
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [user, partnerId, rebuildShared, toast]);

  // Upload WITHOUT any compression — original quality preserved. Returns a
  // result object instead of toasting on failure directly, so the queue
  // processor below can show a retryable per-item error state instead of
  // a toast that's easy to miss in a multi-file batch.
  //
  // Phase 8F (Final Release Audit): files at or above
  // RESUMABLE_UPLOAD_THRESHOLD_BYTES now go through the chunked/resumable
  // path (src/lib/resumableUpload.ts) instead of a single-shot
  // storage.upload() — see that file's header comment for the RLS chunk-path
  // fix that made this safe to wire in. onUploadProgress is only ever
  // called from the resumable path with real byte counts; the plain path
  // below it gives supabase-js no byte-level progress, so it's left
  // unwired there rather than faked.
  const saveToGallery = async (
    file: File | Blob, isVideo = false, originalName?: string,
    onUploadProgress?: (uploaded: number, total: number) => void,
  ): Promise<{ item: GalleryItem | null; error?: string }> => {
    if (!user) return { item: null, error: "Not signed in" };

    // Determine extension from original file
    let ext = "jpg";
    if (file instanceof File) {
      ext = file.name.split(".").pop()?.toLowerCase() || (isVideo ? "mp4" : "jpg");
    } else if (isVideo) {
      ext = "mp4";
    }
    const fileName = originalName || `${Date.now()}.${ext}`;
    // COLLISION FIX (same class as Chat's chunk-upload fix): batch-selecting
    // several photos runs saveToGallery back-to-back, and Date.now() has
    // millisecond resolution — two files processed within the same
    // millisecond shared ONE objectPath, so the second write clobbered or
    // conflicted with the first. UUIDs make every upload's path unique.
    const path = `${user.id}/${crypto.randomUUID()}_${fileName}`;
    const contentType = file instanceof File ? file.type : (isVideo ? "video/mp4" : "image/jpeg");

    let publicUrl: string;
    if (file.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
      try {
        const result = await resumableUpload({
          bucket: "gallery",
          objectPath: path,
          file,
          contentType,
          onProgress: onUploadProgress,
        });
        publicUrl = result.pseudoPublicUrl;
      } catch (e) {
        return { item: null, error: e instanceof Error ? e.message : "Upload failed" };
      }
    } else {
      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from("gallery")
        .upload(path, file, { contentType, upsert: false });
      if (uploadErr || !uploadData) {
        return { item: null, error: uploadErr?.message || "Upload failed" };
      }
      publicUrl = supabase.storage.from("gallery").getPublicUrl(path).data.publicUrl;
    }

    const { data: item, error: insertErr } = await supabase.from("gallery_items").insert({
      owner_id: user.id,
      file_url: publicUrl,
      file_type: isVideo ? "video" : "image",
      is_shared: myGalleryShared, // auto-share if gallery sharing is on
    } as any).select().single();

    if (insertErr || !item) {
      return { item: null, error: insertErr?.message || "Couldn't save to gallery" };
    }

    const displayItem = { ...(item as GalleryItem), file_url: await resolveGalleryUrl((item as GalleryItem).file_url) };
    setMyItems(prev => {
      const updated = [displayItem, ...prev];
      rebuildShared(updated, partnerItems);
      return updated;
    });
    return { item: displayItem };
  };

  // Runs one queued upload and updates its status in place. Successful
  // items auto-clear from the strip after a moment; failed ones stay
  // (with a retry affordance) until the person acts on them or leaves
  // the page.
  const processQueueItem = async (qId: string, file: File | Blob, isVideo: boolean, name: string) => {
    setUploadQueue(prev => prev.map(q => q.id === qId ? { ...q, status: "uploading", progress: undefined } : q));
    const isResumable = file.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES;
    const { item, error } = await saveToGallery(file, isVideo, name, isResumable ? (uploaded, total) => {
      const pct = Math.round((uploaded / total) * 100);
      // Chunks finished uploading but the reassembly edge function call is
      // still in flight — real state, not fake progress: byte upload really
      // is done, finalize really is a distinct remaining step.
      setUploadQueue(prev => prev.map(q => q.id === qId
        ? { ...q, status: pct >= 100 ? "processing" : "uploading", progress: pct }
        : q));
    } : undefined);
    if (item) {
      setUploadQueue(prev => prev.map(q => q.id === qId ? { ...q, status: "done", progress: undefined } : q));
      setTimeout(() => setUploadQueue(prev => prev.filter(q => q.id !== qId)), 2500);
    } else {
      setUploadQueue(prev => prev.map(q => q.id === qId ? { ...q, status: "error", errorMessage: error, progress: undefined } : q));
    }
  };

  const retryUpload = (qId: string) => {
    const item = uploadQueue.find(q => q.id === qId);
    if (!item) return;
    processQueueItem(qId, item.file, item.isVideo, item.name);
  };

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !user) return;
    // No size limit — Supabase storage bucket is unlimited
    const queued: UploadQueueItem[] = files.map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      status: "queued",
      isVideo: file.type.startsWith("video/"),
      file,
    }));
    setUploadQueue(prev => [...prev, ...queued]);
    e.target.value = "";
    for (const q of queued) {
      await processQueueItem(q.id, q.file, q.isVideo, q.name);
    }
  };

  const handleCameraCapture = async (blob: Blob) => {
    setShowCamera(false);
    const qId = `${Date.now()}-cam`;
    setUploadQueue(prev => [...prev, { id: qId, name: "Camera photo", status: "queued", isVideo: false, file: blob }]);
    await processQueueItem(qId, blob, false, `camera_${Date.now()}.jpg`);
  };

  // Save partner's photo to own gallery
  const savePartnerPhotoToMyGallery = async (item: GalleryItem) => {
    if (!user) return;
    // Fetch the blob then re-upload under user's own folder
    try {
      const response = await fetch(item.file_url);
      const blob = await response.blob();
      const isVideo = item.file_type === "video";
      const { item: saved, error } = await saveToGallery(blob, isVideo, `saved_${Date.now()}.${isVideo ? "mp4" : "jpg"}`);
      if (saved) toast({ title: "Saved to your gallery ✓" });
      else toast({ title: "Couldn't save", description: error, variant: "destructive" });
    } catch {
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };

  const toggleShare = async (itemId: string, currentlyShared: boolean) => {
    await supabase.from("gallery_items").update({ is_shared: !currentlyShared }).eq("id", itemId);
    setMyItems(prev => {
      const updated = prev.map(i => i.id === itemId ? { ...i, is_shared: !currentlyShared } : i);
      rebuildShared(updated, partnerItems);
      return updated;
    });
    toast({ title: currentlyShared ? "Hidden from partner" : "Shared with partner 💕" });
  };

  // Shared couple favorites (Part 20) — unlike toggleShare, this can be
  // called on ANY item visible in any of the three tabs (mine/shared/
  // theirs), not just the caller's own uploads, so it branches on which
  // local array actually owns the row rather than assuming `myItems`.
  // The RLS policy backing this (see the gallery_items migration) only
  // allows a non-owner update to touch is_favorite — everything else on
  // the row is still owner-locked — so this optimistic update mirrors
  // exactly what the database will actually allow.
  const toggleFavorite = async (item: GalleryItem) => {
    hapticLight();
    const next = !item.is_favorite;
    const { error } = await supabase.from("gallery_items").update({ is_favorite: next }).eq("id", item.id);
    if (error) {
      toast({ title: "Couldn't update favorite", variant: "destructive" });
      return;
    }
    if (item.owner_id === user?.id) {
      setMyItems(prev => {
        const updated = prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i);
        rebuildShared(updated, partnerItemsRef.current);
        return updated;
      });
    } else {
      setPartnerItems(prev => {
        const updated = prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i);
        rebuildShared(myItemsRef.current, updated);
        return updated;
      });
    }
    // viewList is its own snapshot taken at the moment the viewer opened
    // (see the GalleryGrid onClick handler) — it isn't derived from
    // myItems/partnerItems/sharedItems, so without this the heart inside
    // an already-open full-screen viewer wouldn't visually update until
    // the viewer was closed and reopened.
    setViewList(prev => prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i));
  };

  // Albums (Part 19). Realtime (loadAlbums, subscribed above) is what
  // actually reflects these changes back into `albums`/`albumItemIds` for
  // both partners, including the caller — none of these functions touch
  // that state directly, so a create/add/remove feels instant locally
  // only because Supabase's own realtime round-trip is fast, not because
  // of an optimistic update. Simpler and avoids the two ever disagreeing.
  const createAlbum = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || !user) return;
    setCreatingAlbum(true);
    const { error } = await supabase.from("gallery_albums").insert({ owner_id: user.id, name: trimmed });
    setCreatingAlbum(false);
    if (error) {
      toast({ title: "Couldn't create album", variant: "destructive" });
      return;
    }
    hapticMedium();
    setNewAlbumName("");
    setShowCreateAlbum(false);
  };

  const deleteAlbum = async (albumId: string) => {
    hapticWarning();
    const { error } = await supabase.from("gallery_albums").delete().eq("id", albumId);
    if (error) {
      toast({ title: "Couldn't delete album", variant: "destructive" });
      return;
    }
    if (viewingAlbumId === albumId) setViewingAlbumId(null);
  };

  const addItemsToAlbum = async (albumId: string, itemIds: string[]) => {
    if (!user || itemIds.length === 0) return;
    const rows = itemIds.map(gallery_item_id => ({ album_id: albumId, gallery_item_id, added_by: user.id }));
    // Duplicates (an item already in the album) are expected and harmless
    // — the UNIQUE(album_id, gallery_item_id) constraint rejects them
    // per-row; ignoreDuplicates keeps that from failing the whole batch.
    const { error } = await supabase.from("gallery_album_items").upsert(rows, {
      onConflict: "album_id,gallery_item_id",
      ignoreDuplicates: true,
    });
    if (error) {
      toast({ title: "Couldn't add to album", variant: "destructive" });
      return;
    }
    hapticMedium();
    toast({ title: `Added to album 📁` });
  };

  const removeItemFromAlbum = async (albumId: string, itemId: string) => {
    hapticLight();
    await supabase.from("gallery_album_items").delete().eq("album_id", albumId).eq("gallery_item_id", itemId);
  };

  const deleteItem = async (id: string) => {
    await supabase.from("gallery_items").delete().eq("id", id);
    setMyItems(prev => prev.filter(i => i.id !== id));
    setSharedItems(prev => prev.filter(i => i.id !== id));
    if (viewItem?.id === id) setViewList([]);
    setShowDeleteDialog(null);
    toast({ title: "Deleted" });
  };

  const deleteSelected = async () => {
    hapticWarning();
    const ids = Array.from(selectedIds);
    await supabase.from("gallery_items").delete().in("id", ids);
    setMyItems(prev => prev.filter(i => !selectedIds.has(i.id)));
    setSharedItems(prev => prev.filter(i => !selectedIds.has(i.id)));
    setShowBulkDeleteDialog(false);
    setSelectedIds(new Set());
    setSelectionMode(false);
    toast({ title: `${ids.length} item${ids.length === 1 ? "" : "s"} deleted` });
  };

  const toggleGallerySharing = async () => {
    if (!user) return;
    const newVal = !myGalleryShared;
    await supabase.from("profiles").update({ gallery_shared: newVal }).eq("user_id", user.id);
    setMyGalleryShared(newVal);
    setShowShareDialog(false);
    toast({ title: newVal ? "Gallery shared with partner 💕" : "Gallery is now private" });
  };

  const GalleryGrid = ({
    items,
    showActions = false,
    isPartnerGrid = false,
    allowSelection = false,
    albumId,
  }: {
    items: GalleryItem[];
    showActions?: boolean;
    isPartnerGrid?: boolean;
    allowSelection?: boolean;
    albumId?: string;
  }) => {
    // "Our Moments" date grouping — Today / Yesterday / "August 2026",
    // kept visually subtle per the brief (a small label, not a heavy
    // section divider) and layered over the existing per-tab item list
    // rather than replacing the Shared/Mine/Theirs structure.
    // Memoized so search/selection-mode/upload-progress re-renders of this
    // screen don't redo the full O(n) date-grouping walk every time.
    // Hook is called unconditionally, above the early return below, per
    // rules-of-hooks (items.length can vary render-to-render).
    const groups = useMemo(() => groupByDate(items), [items]);

    // Stable across renders (identity only changes when a real dep
    // changes) so MediaThumbnail's memo() actually bails out instead of
    // re-rendering every tile whenever this screen re-renders for an
    // unrelated reason (e.g. upload-progress ticking).
    const handleThumbnailClick = useCallback((clicked: GalleryItem) => {
      if (allowSelection && selectionMode) {
        toggleSelected(clicked.id);
        return;
      }
      setViewList(items);
      setViewIndex(items.findIndex(i => i.id === clicked.id));
      setViewItemIsOwner(clicked.owner_id === user?.id);
    }, [allowSelection, selectionMode, items, user?.id, toggleSelected]);

    if (items.length === 0) {
      return (
        <div className="py-16 text-center px-8">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
            <ImageIcon className="h-7 w-7 text-muted-foreground/40" />
          </div>
          <p className="text-sm text-muted-foreground mb-1">
            {isPartnerGrid ? `${partnerName}'s photos will appear here` : "No photos yet"}
          </p>
          {!isPartnerGrid && (
            <>
              <p className="text-xs text-muted-foreground/70 mb-4">Your shared memories will appear here</p>
              <button
                onClick={() => { fileRef.current?.click(); }}
                className="h-9 px-4 rounded-xl bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add your first memory
              </button>
            </>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="text-[11px] font-medium text-muted-foreground/80 mb-1.5 px-0.5">{group.label}</p>
            <div className={`grid gap-0.5 ${gridDensity === "compact" ? "grid-cols-4" : "grid-cols-3"}`}>
              {group.items.map((item) => {
                const isSelected = selectedIds.has(item.id);
                return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="aspect-square overflow-hidden relative group bg-muted"
                >
                  <MediaThumbnail
                    item={item}
                    selectionMode={allowSelection && selectionMode}
                    selected={isSelected}
                    onClick={handleThumbnailClick}
                  />
                  {/* Shared couple favorite — visible on every tab
                      (mine/shared/theirs), not gated behind showActions,
                      since favoriting is a couple-wide action either
                      partner can take on anything they can see. */}
                  {!selectionMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(item); }}
                      aria-label={item.is_favorite ? "Remove from favorites" : "Add to favorites"}
                      className="absolute top-1 left-1 h-8 w-8 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity"
                      style={item.is_favorite ? { opacity: 1 } : undefined}
                    >
                      <Heart
                        className={`h-3.5 w-3.5 ${item.is_favorite ? "fill-red-500 text-red-500" : "text-white"}`}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                  {/* Remove from album — only rendered inside an album's
                      detail view (albumId set), independent of showActions
                      since removing from an album isn't the same action as
                      deleting the photo or toggling its share state.
                      HARDENING: both this and the showActions group below
                      render at the identical `top-1 right-1` slot. They
                      don't currently collide in practice — every call site
                      passes albumId XOR showActions, never both — but that
                      was implicit rather than enforced, so a future call
                      site passing both would silently stack two button
                      groups on top of each other in one tile corner. The
                      explicit `!showActions` here makes that impossible
                      rather than merely unobserved. */}
                  {albumId && !showActions && !selectionMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItemFromAlbum(albumId, item.id); }}
                      aria-label="Remove from album"
                      className="absolute top-1 right-1 h-8 w-8 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity"
                    >
                      <X className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                    </button>
                  )}
                  {showActions && !selectionMode && (
                    <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); hapticLight(); toggleShare(item.id, item.is_shared); }}
                        aria-label={item.is_shared ? "Shared with partner — tap to make private" : "Private — tap to share with partner"}
                        className="h-8 w-8 rounded-full bg-black/60 flex items-center justify-center"
                      >
                        {item.is_shared
                          ? <Eye className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                          : <EyeOff className="h-3.5 w-3.5 text-white" aria-hidden="true" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); hapticWarning(); setShowDeleteDialog(item.id); }}
                        aria-label="Delete item"
                        className="h-8 w-8 rounded-full bg-black/60 flex items-center justify-center"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  {/* Shared indicator */}
                  {item.is_shared && showActions && !selectionMode && (
                    <div className="absolute bottom-1 left-1 h-5 w-5 rounded-full bg-primary/90 flex items-center justify-center">
                      <Eye className="h-3 w-3 text-white" />
                    </div>
                  )}
                  {/* Video duration indicator */}
                  {item.file_type === "video" && !selectionMode && (
                    <div className="absolute bottom-1 right-1">
                      <Play className="h-3.5 w-3.5 text-white drop-shadow" />
                    </div>
                  )}
                </motion.div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 safe-top" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Gallery" subtitle="Our moments">
        <div className="flex gap-2 items-center">
          {/* Grid density, media visibility, and Private/Shared now live in
              the sheet below (see the showGalleryOptions state comment) —
              this row is just the two actions people actually reach for
              most, so it comfortably fits on a phone-width screen even
              with the back button and title already taking space. */}
          <button
            onClick={() => { setShowGalleryOptions(true); }}
            aria-label="Gallery view & sharing settings"
            className="h-9 w-9 rounded-xl bg-muted/60 flex items-center justify-center relative"
          >
            <SlidersHorizontal className="h-4 w-4 text-foreground" aria-hidden="true" />
            {/* Small dot so "private" and "media hidden" — the two states
                someone would actually want to notice — stay visible at a
                glance without needing all five controls inline. */}
            {(!myGalleryShared || !mediaVisibility) && (
              <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
          </button>
          <button
            onClick={() => { setShowCamera(true); }}
            aria-label="Take photo"
            className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center"
          >
            <Camera className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
          </button>
          <button
            onClick={async () => { if (await ensureMedia("photos", () => fileRef.current?.click())) fileRef.current?.click(); }}
            aria-label="Upload photo"
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Plus className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
          </button>
        </div>
      </PageHeader>

      {/* Gallery view & sharing settings — grid density, media visibility,
          and the Private/Shared toggle, pulled out of the header (see the
          showGalleryOptions state comment above) into one place with real
          labels instead of guessable icons. Row styling matches the
          settings-page list pattern used across src/pages/settings/*
          (icon + label/description + control) rather than inventing a new
          one here. */}
      <Sheet open={showGalleryOptions} onOpenChange={setShowGalleryOptions}>
        <SheetContent side="bottom" className="rounded-t-2xl safe-bottom">
          <SheetHeader>
            <SheetTitle>Gallery settings</SheetTitle>
          </SheetHeader>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 mt-4 mb-2">
            <div className="flex items-center gap-3 px-4 py-3">
              {gridDensity === "comfortable" ? <Grid3x3 className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" /> : <LayoutGrid className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Compact grid</p>
                <p className="text-[11px] text-muted-foreground">More photos per row</p>
              </div>
              <Switch
                checked={gridDensity === "compact"}
                onCheckedChange={(v) => { hapticLight(); setDensity(v ? "compact" : "comfortable"); }}
              />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              {mediaVisibility ? <Eye className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" /> : <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Show media in chat</p>
                <p className="text-[11px] text-muted-foreground">Photos and videos auto-load in Chat</p>
              </div>
              <Switch
                checked={mediaVisibility}
                onCheckedChange={(v) => {
                  setAndSaveMediaVisibility(v);
                  toast({ title: v ? "Media visible 👁️" : "Media hidden 🙈" });
                }}
              />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              {myGalleryShared ? <Unlock className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" /> : <Lock className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Share "Mine" with {partnerName}</p>
                <p className="text-[11px] text-muted-foreground">{myGalleryShared ? "Visible to them" : "Private — only you can see"}</p>
              </div>
              <Switch
                checked={myGalleryShared}
                onCheckedChange={() => { setShowGalleryOptions(false); setShowShareDialog(true); }}
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Upload queue — real per-file status instead of one shared fake
          progress bar; failed items get a retry button instead of just
          a toast that's easy to miss. */}
      <AnimatePresence>
        {uploadQueue.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="mx-4 mb-3 overflow-hidden">
            <div className="flex gap-2 overflow-x-auto pb-1" role="status" aria-live="polite">
              {uploadQueue.map(q => (
                <div key={q.id} className="shrink-0 w-16 flex flex-col items-center gap-1">
                  <div className="h-16 w-16 rounded-xl bg-muted overflow-hidden relative flex items-center justify-center">
                    {q.status === "uploading" || q.status === "queued" || q.status === "processing" ? (
                      <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" aria-hidden="true" />
                    ) : q.status === "done" ? (
                      <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
                    ) : (
                      <button onClick={() => { retryUpload(q.id); }} aria-label={`Retry upload of ${q.name}`}
                        className="flex flex-col items-center gap-0.5">
                        <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
                        <RotateCcw className="h-3 w-3 text-destructive" aria-hidden="true" />
                      </button>
                    )}
                    {/* Real byte-level progress only — undefined for the plain
                        upload path, so no bar renders there (Phase 8F: never
                        show fake progress). */}
                    {typeof q.progress === "number" && q.status === "uploading" && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/10">
                        <div className="h-full bg-primary" style={{ width: `${q.progress}%` }} />
                      </div>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground truncate w-full text-center">
                    {q.status === "error" ? "Failed — tap to retry"
                      : q.status === "done" ? "Done"
                      : q.status === "processing" ? "Processing…"
                      : typeof q.progress === "number" ? `Uploading ${q.progress}%`
                      : "Uploading…"}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Media visibility banner */}
      {!mediaVisibility && (
        <div className="mx-4 mb-3 bg-muted/60 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-xs text-muted-foreground">Media hidden — photos won't auto-load in chat</p>
          <button onClick={() => { setAndSaveMediaVisibility(true); }} className="ml-auto text-xs text-primary font-medium">Show</button>
        </div>
      )}

      {/* Albums (Part 19) — either the album strip + create affordance, or,
          when an album is open, a dedicated detail view in its place. Kept
          as a simple conditional swap rather than a fourth Tabs value —
          an album is a cross-cutting view over items from either partner,
          not a peer of Shared/Mine/Theirs. */}
      {viewingAlbumId && viewingAlbum ? (
        <div className="px-4 mb-3">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => { setViewingAlbumId(null); }} aria-label="Back to Gallery"
              className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <p className="text-sm font-medium truncate flex-1">{viewingAlbum.name}</p>
            <button onClick={() => deleteAlbum(viewingAlbum.id)} aria-label="Delete album"
              className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
              <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
            </button>
          </div>
          <GalleryGrid items={viewingAlbumItems} albumId={viewingAlbum.id} />
        </div>
      ) : (
        <div className="px-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Albums</p>
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-1">
            {albums.map((album) => {
              const firstItemId = (albumItemIds[album.id] || [])[0];
              const cover = firstItemId ? allKnownItems.get(firstItemId) : undefined;
              return (
                <button
                  key={album.id}
                  onClick={() => { setViewingAlbumId(album.id); }}
                  className="shrink-0 w-20 text-left"
                >
                  <div className="h-20 w-20 rounded-xl bg-muted overflow-hidden flex items-center justify-center">
                    {cover ? (
                      <img loading="lazy" decoding="async" src={cover.file_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Images className="h-5 w-5 text-muted-foreground/40" aria-hidden="true" />
                    )}
                  </div>
                  <p className="text-xs mt-1 truncate">{album.name}</p>
                  <p className="text-[10px] text-muted-foreground">{(albumItemIds[album.id] || []).length}</p>
                </button>
              );
            })}
            <button
              onClick={() => { setShowCreateAlbum(true); }}
              className="shrink-0 w-20 h-20 rounded-xl border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground"
            >
              <FolderPlus className="h-5 w-5" aria-hidden="true" />
              <span className="text-[10px]">New</span>
            </button>
          </div>
        </div>
      )}

      {!viewingAlbumId && (
      <Tabs defaultValue="shared" className="px-0">
        <div className="px-4">
          <TabsList className="w-full bg-muted/50 rounded-xl">
            <TabsTrigger value="shared" className="flex-1 rounded-lg text-xs">
              Shared {sharedItems.length > 0 && <span className="ml-1 text-[9px] opacity-60">{sharedItems.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="mine" className="flex-1 rounded-lg text-xs">
              Mine {myItems.length > 0 && <span className="ml-1 text-[9px] opacity-60">{myItems.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="theirs" className="flex-1 rounded-lg text-xs">
              {partnerName.split(" ")[0]} {partnerItems.length > 0 && <span className="ml-1 text-[9px] opacity-60">{partnerItems.length}</span>}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="shared" className="mt-3">
          <GalleryGrid items={sharedItems} />
        </TabsContent>

        <TabsContent value="mine" className="mt-3">
          <div className="flex items-center justify-between mb-2 px-4">
            <p className="text-xs text-muted-foreground">
              {myGalleryShared ? `Visible to ${partnerName}` : "Private — only you can see"}
            </p>
            <div className="flex items-center gap-3">
              {myItems.length > 0 && (
                <button onClick={toggleSelectionMode} className="text-xs text-primary font-medium">
                  {selectionMode ? "Cancel" : "Select"}
                </button>
              )}
              <button onClick={() => { setShowShareDialog(true); }} aria-label={myGalleryShared ? "Gallery shared — tap to change" : "Gallery private — tap to change"}>
                {myGalleryShared
                  ? <Unlock className="h-4 w-4 text-primary" aria-hidden="true" />
                  : <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              </button>
            </div>
          </div>
          <GalleryGrid items={myItems} showActions allowSelection />
          {/* PERF FIX (Phase 1 #5): 1px trigger for the next page of "mine";
              invisible, doesn't touch grid layout/appearance. */}
          <div ref={mineSentinelRef} aria-hidden="true" className="h-px" />
        </TabsContent>

        <TabsContent value="theirs" className="mt-3">
          {!partnerId ? (
            <div className="py-16 text-center px-8">
              <Lock className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Link with a partner in Settings first</p>
            </div>
          ) : (
            <>
              <GalleryGrid items={partnerItems} isPartnerGrid />
              <div ref={partnerSentinelRef} aria-hidden="true" className="h-px" />
            </>
          )}
        </TabsContent>
      </Tabs>
      )}

      {/* Selection-mode bulk action bar */}
      <AnimatePresence>
        {selectionMode && selectedIds.size > 0 && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
            // BUG FIX (buttons colliding with the floating dock): this used
            // to be `bottom-20` (a flat 80px, unaware of safe-area) plus a
            // `safe-bottom` class that only padded the box's *content*, not
            // its position. The floating dock (visible on /gallery — it's
            // not in DOCK_HIDDEN_PAGES) sits at
            // `env(safe-area-inset-bottom) + 14px` through `+ 70px`; on any
            // phone with a home indicator (effectively all current iPhones,
            // most Android with gesture nav) that overlapped this bar's own
            // [80px, ~130px] range directly — "Add to Album"/"Delete" were
            // rendering behind/through the dock rather than above it. Same
            // fix as MapView.tsx's bottom row and GroicMiniPlayer's dock
            // clearance: derive the offset from the shared --dock-reserve
            // token instead of a magic number, so it tracks correctly if
            // the dock's own height/gap are ever retuned.
            style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-reserve) + 6px)" }}
            className="fixed left-4 right-4 z-30 bg-foreground text-background rounded-2xl px-4 py-3 flex items-center justify-between shadow-lg">
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={() => { setShowAlbumPicker(true); }}
                className="h-9 px-4 rounded-xl bg-background/20 text-xs font-medium flex items-center gap-1.5">
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                Add to Album
              </button>
              <button onClick={() => { hapticWarning(); setShowBulkDeleteDialog(true); }}
                className="h-9 px-4 rounded-xl bg-destructive text-destructive-foreground text-xs font-medium flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen viewer */}
      <AnimatePresence>
        {viewItem && (
          <MediaViewer
            item={viewItem}
            onClose={() => setViewList([])}
            isOwner={viewItemIsOwner}
            onSaveToGallery={!viewItemIsOwner ? savePartnerPhotoToMyGallery : undefined}
            hasPrev={viewIndex > 0}
            hasNext={viewIndex < viewList.length - 1}
            onPrev={() => setViewIndex(i => Math.max(0, i - 1))}
            onNext={() => setViewIndex(i => Math.min(viewList.length - 1, i + 1))}
            onToggleFavorite={toggleFavorite}
          />
        )}
      </AnimatePresence>

      {showCamera && (
        <CameraWithFilters
          onClose={() => setShowCamera(false)}
          onCapture={(blob) => handleCameraCapture(blob)}
        />
      )}

      {/* Gallery sharing dialog */}
      <AlertDialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {myGalleryShared ? "Make gallery private?" : "Share your gallery?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {myGalleryShared
                ? `${partnerName} will no longer see your photos.`
                : `${partnerName} will be able to see all your gallery photos. New uploads will be shared automatically.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { hapticMedium(); toggleGallerySharing(); }} className="rounded-xl">
              {myGalleryShared ? "Make Private" : "Share Gallery"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog open={!!showDeleteDialog} onOpenChange={() => setShowDeleteDialog(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { hapticError(); if (showDeleteDialog) deleteItem(showDeleteDialog); }}
              className="rounded-xl bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete dialog */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} item{selectedIds.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteSelected}
              className="rounded-xl bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden file input — multiple files, no capture attribute so it uses picker */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={uploadFile}
      />

      {/* Create album */}
      <Sheet open={showCreateAlbum} onOpenChange={setShowCreateAlbum}>
        <SheetContent side="bottom" className="rounded-t-2xl safe-bottom">
          <SheetHeader>
            <SheetTitle>New album</SheetTitle>
          </SheetHeader>
          <div className="py-4 space-y-3">
            <Input
              autoFocus
              value={newAlbumName}
              onChange={(e) => setNewAlbumName(e.target.value)}
              placeholder="Album name"
              maxLength={80}
              onKeyDown={(e) => { if (e.key === "Enter") createAlbum(newAlbumName); }}
            />
            <button
              onClick={() => createAlbum(newAlbumName)}
              disabled={!newAlbumName.trim() || creatingAlbum}
              className="w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {creatingAlbum ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create album"}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Add selected items to an album */}
      <Sheet open={showAlbumPicker} onOpenChange={setShowAlbumPicker}>
        <SheetContent side="bottom" className="rounded-t-2xl safe-bottom max-h-[70vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Add {selectedIds.size} to album</SheetTitle>
          </SheetHeader>
          <div className="py-3 space-y-1.5">
            {albums.length === 0 && (
              <p className="text-sm text-muted-foreground px-1 py-2">No albums yet — create one to get started.</p>
            )}
            {albums.map((album) => (
              <button
                key={album.id}
                onClick={async () => {
                  await addItemsToAlbum(album.id, Array.from(selectedIds));
                  setShowAlbumPicker(false);
                  setSelectionMode(false);
                  setSelectedIds(new Set());
                }}
                className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl active:bg-muted/60 text-left"
              >
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Images className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm truncate">{album.name}</p>
                  <p className="text-xs text-muted-foreground">{(albumItemIds[album.id] || []).length} items</p>
                </div>
              </button>
            ))}
            <button
              onClick={() => { setShowAlbumPicker(false); setShowCreateAlbum(true); }}
              className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl active:bg-muted/60 text-left text-primary"
            >
              <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Plus className="h-4 w-4" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium">New album</p>
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {permissionSheet}
    </motion.div>
  );
};

export default Gallery;
