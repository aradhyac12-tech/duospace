import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, ImageIcon, Lock, Unlock, Eye, EyeOff, Trash2, Camera, Play, Download, Share2, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import CameraWithFilters from "@/components/CameraWithFilters";
import { Capacitor } from "@capacitor/core";
import storage from "@/lib/storage";
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

// NO compression — upload original file as-is per user requirement
const MediaThumbnail = ({ item, onClick }: { item: GalleryItem; onClick: () => void }) => {
  if (item.file_type === "video") {
    return (
      <div className="w-full h-full relative cursor-pointer" onClick={onClick}>
        <video src={item.file_url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
        <div className="absolute inset-0 flex items-center justify-center bg-black/10">
          <div className="h-9 w-9 rounded-full bg-black/60 flex items-center justify-center">
            <Play className="h-4 w-4 text-white ml-0.5" />
          </div>
        </div>
      </div>
    );
  }
  return <img src={item.file_url} alt="" loading="lazy" className="w-full h-full object-cover cursor-pointer" onClick={onClick} />;
};

// Full-screen viewer with download + share
const MediaViewer = ({
  item,
  onClose,
  onSaveToGallery,
  isOwner,
}: {
  item: GalleryItem | null;
  onClose: () => void;
  onSaveToGallery?: (item: GalleryItem) => void;
  isOwner: boolean;
}) => {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

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
    if (navigator.share) {
      try {
        await navigator.share({ url: item.file_url, title: "Shared from DuoSpace" });
      } catch { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText(item.file_url);
      toast({ title: "Link copied" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black flex flex-col"
      onClick={onClose}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-3 safe-top absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
          <X className="h-4 w-4 text-white" />
        </button>
        <div className="flex items-center gap-2">
          {/* Save to gallery (receiver side) */}
          {!isOwner && onSaveToGallery && (
            <button onClick={(e) => { e.stopPropagation(); onSaveToGallery(item); }}
              className="h-9 px-3 rounded-full bg-white/20 flex items-center gap-1.5 backdrop-blur-sm">
              <Plus className="h-4 w-4 text-white" />
              <span className="text-xs text-white font-medium">Save</span>
            </button>
          )}
          {/* Share */}
          <button onClick={handleShare}
            className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
            <Share2 className="h-4 w-4 text-white" />
          </button>
          {/* Download */}
          <button onClick={handleDownload} disabled={downloading}
            className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm disabled:opacity-50">
            <Download className="h-4 w-4 text-white" />
          </button>
        </div>
      </div>

      {/* Media */}
      <div className="flex-1 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
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
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [viewItem, setViewItem] = useState<GalleryItem | null>(null);
  const [viewItemIsOwner, setViewItemIsOwner] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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
    const myList = (mine || []) as GalleryItem[];
    setMyItems(myList);

    if (pid) {
      const { data: partner } = await supabase.from("gallery_items").select("id,owner_id,file_url,file_type,is_shared,created_at")
        .eq("owner_id", pid).order("created_at", { ascending: false });
      const partnerList = (partner || []) as GalleryItem[];
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
    const channel = supabase
      .channel(`gallery-rt-${[user.id, partnerId].sort().join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "gallery_items" }, (payload) => {
        const newItem = payload.new as GalleryItem;
        if (newItem.owner_id === partnerId) {
          setPartnerItems(prev => {
            const updated = [newItem, ...prev];
            rebuildShared(myItemsRef.current, updated);
            return updated;
          });
          if (newItem.is_shared) {
            toast({ title: `${partnerNameRef.current} added a photo 📸` });
          }
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "gallery_items" }, (payload) => {
        const updated = payload.new as GalleryItem;
        if (updated.owner_id === user.id) {
          setMyItems(prev => {
            const list = prev.map(i => i.id === updated.id ? updated : i);
            rebuildShared(list, partnerItemsRef.current);
            return list;
          });
        } else {
          setPartnerItems(prev => {
            const list = prev.map(i => i.id === updated.id ? updated : i);
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
    return () => { supabase.removeChannel(channel); };
  }, [user, partnerId, rebuildShared, toast]);

  // Upload WITHOUT any compression — original quality preserved
  const saveToGallery = async (file: File | Blob, isVideo = false, originalName?: string) => {
    if (!user) return;

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

    // Show upload progress for large files
    setUploadProgress(0);

    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from("gallery")
      .upload(path, file, { contentType, upsert: false });

    setUploadProgress(100);

    if (uploadErr || !uploadData) {
      toast({ title: "Upload failed", description: uploadErr?.message, variant: "destructive" });
      return null;
    }

    const { data: urlData } = supabase.storage.from("gallery").getPublicUrl(path);
    const { data: item } = await supabase.from("gallery_items").insert({
      owner_id: user.id,
      file_url: urlData.publicUrl,
      file_type: isVideo ? "video" : "image",
      is_shared: myGalleryShared, // auto-share if gallery sharing is on
    } as any).select().single();

    if (item) {
      setMyItems(prev => {
        const updated = [item as GalleryItem, ...prev];
        rebuildShared(updated, partnerItems);
        return updated;
      });
    }
    return item as GalleryItem | null;
  };

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !user) return;
    // No size limit — Supabase storage bucket is unlimited
    setUploading(true);
    for (const file of files) {
      const isVideo = file.type.startsWith("video/");
      const result = await saveToGallery(file, isVideo, file.name);
      if (result) toast({ title: isVideo ? "Video added! 🎬" : "Photo added! 📸" });
    }
    setUploading(false);
    e.target.value = "";
  };

  const handleCameraCapture = async (blob: Blob) => {
    setShowCamera(false);
    setUploading(true);
    await saveToGallery(blob, false, `camera_${Date.now()}.jpg`);
    toast({ title: "Photo added! 📸" });
    setUploading(false);
  };

  // Save partner's photo to own gallery
  const savePartnerPhotoToMyGallery = async (item: GalleryItem) => {
    if (!user) return;
    // Fetch the blob then re-upload under user's own folder
    try {
      const response = await fetch(item.file_url);
      const blob = await response.blob();
      const isVideo = item.file_type === "video";
      await saveToGallery(blob, isVideo, `saved_${Date.now()}.${isVideo ? "mp4" : "jpg"}`);
      toast({ title: "Saved to your gallery ✓" });
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
    if (viewItem?.id === id) setViewItem(null);
    setShowDeleteDialog(null);
    toast({ title: "Deleted" });
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
  }: {
    items: GalleryItem[];
    showActions?: boolean;
    isPartnerGrid?: boolean;
  }) => (
    <div className="grid grid-cols-3 gap-0.5">
      {items.length === 0 ? (
        <div className="col-span-3 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {isPartnerGrid ? `${partnerName}'s photos will appear here` : "No photos yet"}
          </p>
        </div>
      ) : (
        items.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="aspect-square overflow-hidden relative group bg-muted"
          >
            <MediaThumbnail
              item={item}
              onClick={() => {
                setViewItem(item);
                setViewItemIsOwner(item.owner_id === user?.id);
              }}
            />
            {showActions && (
              <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); toggleShare(item.id, item.is_shared); }}
                  className="h-7 w-7 rounded-full bg-black/60 flex items-center justify-center"
                >
                  {item.is_shared
                    ? <Eye className="h-3.5 w-3.5 text-white" />
                    : <EyeOff className="h-3.5 w-3.5 text-white" />}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDeleteDialog(item.id); }}
                  className="h-7 w-7 rounded-full bg-black/60 flex items-center justify-center"
                >
                  <Trash2 className="h-3.5 w-3.5 text-white" />
                </button>
              </div>
            )}
            {/* Shared indicator */}
            {item.is_shared && showActions && (
              <div className="absolute bottom-1 left-1 h-5 w-5 rounded-full bg-primary/90 flex items-center justify-center">
                <Eye className="h-3 w-3 text-white" />
              </div>
            )}
            {/* Video duration indicator */}
            {item.file_type === "video" && (
              <div className="absolute bottom-1 right-1">
                <Play className="h-3.5 w-3.5 text-white drop-shadow" />
              </div>
            )}
          </motion.div>
        ))
      )}
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Gallery" subtitle="Our moments">
        <div className="flex gap-2 items-center">
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
            onClick={() => setShowShareDialog(true)}
            className={`h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium transition-colors ${
              myGalleryShared ? "bg-primary/15 text-primary" : "bg-accent text-foreground"
            }`}
          >
            {myGalleryShared ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {myGalleryShared ? "Shared" : "Private"}
          </button>
          <button
            onClick={() => setShowCamera(true)}
            className="h-9 w-9 rounded-xl bg-foreground flex items-center justify-center"
          >
            <Camera className="h-4 w-4 text-background" />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center disabled:opacity-50"
          >
            {uploading
              ? <span className="text-[10px] font-bold text-foreground">{uploadProgress}%</span>
              : <Plus className="h-5 w-5 text-foreground" />}
          </button>
        </div>
      </PageHeader>

      {/* Media visibility banner */}
      {!mediaVisibility && (
        <div className="mx-4 mb-3 bg-muted/60 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-xs text-muted-foreground">Media hidden — photos won't auto-load in chat</p>
          <button onClick={() => setAndSaveMediaVisibility(true)} className="ml-auto text-xs text-primary font-medium">Show</button>
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
            <button onClick={() => setShowShareDialog(true)}>
              {myGalleryShared
                ? <Unlock className="h-4 w-4 text-primary" />
                : <Lock className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
          <GalleryGrid items={myItems} showActions />
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

      {/* Full-screen viewer */}
      <AnimatePresence>
        {viewItem && (
          <MediaViewer
            item={viewItem}
            onClose={() => setViewItem(null)}
            isOwner={viewItemIsOwner}
            onSaveToGallery={!viewItemIsOwner ? savePartnerPhotoToMyGallery : undefined}
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
            <AlertDialogAction onClick={toggleGallerySharing} className="rounded-xl">
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
              onClick={() => showDeleteDialog && deleteItem(showDeleteDialog)}
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
    </motion.div>
  );
};

export default Gallery;
