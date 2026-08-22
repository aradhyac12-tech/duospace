import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, ImageIcon, Lock, Unlock, Eye, EyeOff, Trash2, Camera, Play, Download, Share2, X, RotateCcw, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight, LayoutGrid, Grid3x3, CheckSquare, Square } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback } from "react";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface GalleryItem {
  id: string;
  file_url: string;
  file_type: string;
  owner_id: string;
  is_shared: boolean;
  created_at: string;
  file_name?: string;
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

async function resolveGalleryItems(items: GalleryItem[]): Promise<GalleryItem[]> {
  return resolveSignedUrls("gallery", items, "file_url");
}

// NO compression — upload original file as-is per user requirement
const MediaThumbnail = ({ item, onClick, selectionMode, selected }: {
  item: GalleryItem; onClick: () => void; selectionMode?: boolean; selected?: boolean;
}) => {
  if (item.file_type === "video") {
    return (
      <div className={`w-full h-full relative cursor-pointer active:scale-95 transition-transform duration-100 ${selected ? "ring-2 ring-inset ring-primary" : ""}`} onClick={() => { hapticLight(); onClick(); }}>
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
        onClick={() => { hapticLight(); onClick(); }} />
      {selectionMode && (
        <div className="absolute top-1.5 left-1.5 h-5 w-5 rounded-full bg-black/50 flex items-center justify-center pointer-events-none">
          {selected ? <CheckSquare className="h-3.5 w-3.5 text-primary-foreground fill-primary" /> : <Square className="h-3.5 w-3.5 text-white/80" />}
        </div>
      )}
    </div>
  );
};

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
}: {
  item: GalleryItem | null;
  onClose: () => void;
  onSaveToGallery?: (item: GalleryItem) => void;
  isOwner: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}) => {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);

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
      onClick={() => { hapticLight(); onClose(); }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-3 safe-top absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={(e) => { e.stopPropagation(); hapticLight(); onClose(); }} aria-label="Close"
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
      <div className="flex-1 flex items-center justify-center relative" onClick={(e) => e.stopPropagation()}>
        {hasPrev && (
          <button onClick={(e) => { e.stopPropagation(); hapticLight(); onPrev?.(); }} aria-label="Previous"
            className="absolute left-2 z-10 h-11 w-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
            <ChevronLeft className="h-5 w-5 text-white" aria-hidden="true" />
          </button>
        )}
        {hasNext && (
          <button onClick={(e) => { e.stopPropagation(); hapticLight(); onNext?.(); }} aria-label="Next"
            className="absolute right-2 z-10 h-11 w-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
            <ChevronRight className="h-5 w-5 text-white" aria-hidden="true" />
          </button>
        )}
        <motion.div
          key={item.id}
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.2}
          onDragEnd={(_, info) => {
            if (info.offset.x < -80 && hasNext) { hapticLight(); onNext?.(); }
            else if (info.offset.x > 80 && hasPrev) { hapticLight(); onPrev?.(); }
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
              src={item.file_url}
              alt=""
              className="max-w-full max-h-full object-contain"
              style={{ touchAction: "pinch-zoom" }}
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
  const [myGalleryShared, setMyGalleryShared] = useState(false);
  // Media visibility toggle — when off, media in chat won't auto-load
  const [mediaVisibility, setMediaVisibility] = useState(true);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState("Partner");
  const [showShareDialog, setShowShareDialog] = useState(false);
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
  const fileRef = useRef<HTMLInputElement>(null);
  const { ensure: ensureMedia, permissionSheet } = useMediaPermission();

  const uploading = uploadQueue.some(q => q.status === "uploading" || q.status === "queued" || q.status === "processing");
  const viewItem = viewList[viewIndex] ?? null;

  const setDensity = (d: "comfortable" | "compact") => {
    setGridDensity(d);
    storage.set("duo-gallery-density", d);
  };

  const toggleSelectionMode = () => {
    hapticLight();
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    hapticLight();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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

  const loadGallery = useCallback(async (uid: string, pid: string | null) => {
    const { data: mine } = await supabase.from("gallery_items").select("id,owner_id,file_url,file_type,is_shared,created_at")
      .eq("owner_id", uid).order("created_at", { ascending: false });
    const myList = await resolveGalleryItems((mine || []) as GalleryItem[]);
    setMyItems(myList);

    if (pid) {
      const { data: partner } = await supabase.from("gallery_items").select("id,owner_id,file_url,file_type,is_shared,created_at")
        .eq("owner_id", pid).order("created_at", { ascending: false });
      const partnerList = await resolveGalleryItems((partner || []) as GalleryItem[]);
      setPartnerItems(partnerList);
      rebuildShared(myList, partnerList);
    }
  }, [rebuildShared]);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: profile } = await supabase.from("profiles")
        .select("partner_id, gallery_shared").eq("user_id", user.id).single();
      if (profile) {
        const pid = profile.partner_id;
        setPartnerId(pid);
        setMyGalleryShared(profile.gallery_shared);
        if (pid) {
          const { data: pp } = await supabase.from("profiles")
            .select("display_name, pet_name").eq("user_id", pid).single();
          if (pp) setPartnerName(pp.pet_name || pp.display_name || "Partner");
        }
        await loadGallery(user.id, pid);
      }
    };
    load();
  }, [user, loadGallery]);

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
    const path = `${user.id}/${Date.now()}_${fileName}`;
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
  }: {
    items: GalleryItem[];
    showActions?: boolean;
    isPartnerGrid?: boolean;
    allowSelection?: boolean;
  }) => (
    <div className={`grid gap-0.5 ${gridDensity === "compact" ? "grid-cols-4" : "grid-cols-3"}`}>
      {items.length === 0 ? (
        <div className="col-span-4 py-16 text-center px-8">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
            <ImageIcon className="h-7 w-7 text-muted-foreground/40" />
          </div>
          <p className="text-sm text-muted-foreground mb-1">
            {isPartnerGrid ? `${partnerName}'s photos will appear here` : "No photos yet"}
          </p>
          {!isPartnerGrid && (
            <>
              <p className="text-xs text-muted-foreground/70 mb-4">Add your first memory together</p>
              <button
                onClick={() => { hapticLight(); fileRef.current?.click(); }}
                className="h-9 px-4 rounded-xl bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add photos
              </button>
            </>
          )}
        </div>
      ) : (
        items.map((item) => {
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
              onClick={() => {
                if (allowSelection && selectionMode) {
                  toggleSelected(item.id);
                  return;
                }
                setViewList(items);
                setViewIndex(items.findIndex(i => i.id === item.id));
                setViewItemIsOwner(item.owner_id === user?.id);
              }}
            />
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
        })
      )}
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 safe-top" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Gallery" subtitle="Our moments">
        <div className="flex gap-2 items-center">
          {/* Grid density toggle */}
          <button
            onClick={() => { hapticLight(); setDensity(gridDensity === "comfortable" ? "compact" : "comfortable"); }}
            aria-label={gridDensity === "comfortable" ? "Switch to compact grid" : "Switch to comfortable grid"}
            className="h-9 w-9 rounded-xl bg-muted/60 flex items-center justify-center"
          >
            {gridDensity === "comfortable" ? <Grid3x3 className="h-4 w-4 text-foreground" aria-hidden="true" /> : <LayoutGrid className="h-4 w-4 text-foreground" aria-hidden="true" />}
          </button>
          {/* Media visibility toggle */}
          <div className="flex items-center gap-1.5 bg-muted/60 rounded-xl px-2.5 py-1.5">
            {mediaVisibility
              ? <Eye className="h-3.5 w-3.5 text-foreground" />
              : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
            <Switch
              checked={mediaVisibility}
              onCheckedChange={(v) => {
                setAndSaveMediaVisibility(v);
                toast({ title: v ? "Media visible 👁️" : "Media hidden 🙈" });
              }}
              className="scale-75"
            />
          </div>
          <button
            onClick={() => { hapticLight(); setShowShareDialog(true); }}
            className={`h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium transition-colors ${
              myGalleryShared ? "bg-primary/15 text-primary" : "bg-accent text-accent-foreground"
            }`}
          >
            {myGalleryShared ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {myGalleryShared ? "Shared" : "Private"}
          </button>
          <button
            onClick={() => { hapticLight(); setShowCamera(true); }}
            aria-label="Take photo"
            className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center"
          >
            <Camera className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
          </button>
          <button
            onClick={async () => { hapticLight(); if (await ensureMedia("photos", () => fileRef.current?.click())) fileRef.current?.click(); }}
            aria-label="Upload photo"
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Plus className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
          </button>
        </div>
      </PageHeader>

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
                      <button onClick={() => { hapticLight(); retryUpload(q.id); }} aria-label={`Retry upload of ${q.name}`}
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
          <button onClick={() => { hapticLight(); setAndSaveMediaVisibility(true); }} className="ml-auto text-xs text-primary font-medium">Show</button>
        </div>
      )}

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
              <button onClick={() => { hapticLight(); setShowShareDialog(true); }} aria-label={myGalleryShared ? "Gallery shared — tap to change" : "Gallery private — tap to change"}>
                {myGalleryShared
                  ? <Unlock className="h-4 w-4 text-primary" aria-hidden="true" />
                  : <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              </button>
            </div>
          </div>
          <GalleryGrid items={myItems} showActions allowSelection />
        </TabsContent>

        <TabsContent value="theirs" className="mt-3">
          {!partnerId ? (
            <div className="py-16 text-center px-8">
              <Lock className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Link with a partner in Settings first</p>
            </div>
          ) : (
            <GalleryGrid items={partnerItems} isPartnerGrid />
          )}
        </TabsContent>
      </Tabs>

      {/* Selection-mode bulk action bar */}
      <AnimatePresence>
        {selectionMode && selectedIds.size > 0 && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
            className="fixed bottom-20 left-4 right-4 z-30 bg-foreground text-background rounded-2xl px-4 py-3 flex items-center justify-between shadow-lg safe-bottom">
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            <button onClick={() => { hapticWarning(); setShowBulkDeleteDialog(true); }}
              className="h-9 px-4 rounded-xl bg-destructive text-destructive-foreground text-xs font-medium flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </button>
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
      {permissionSheet}
    </motion.div>
  );
};

export default Gallery;
