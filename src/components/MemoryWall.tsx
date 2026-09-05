import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, ImageIcon, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignedUrl, resolveSignedUrls } from "@/lib/signedStorageUrl";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { hapticMedium, hapticWarning, hapticError } from "@/lib/haptics";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";

interface Memory {
  id: string;
  creator_id: string;
  caption: string | null;
  image_url: string | null;
  created_at: string;
}

interface MemoryWallProps {
  partnerId: string | null;
  /** Deep-link target — /us?memory=<id> opens this memory once it's loaded. */
  focusMemoryId?: string | null;
}

const MemoryWall = ({ partnerId, focusMemoryId }: MemoryWallProps) => {
  const { user } = useAuth();
  const { capture } = useErrorManager("MemoryWall");
  const [memories, setMemories]         = useState<Memory[]>([]);
  const [showAdd, setShowAdd]           = useState(false);
  const [caption, setCaption]           = useState("");
  const [uploading, setUploading]       = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [preview, setPreview]           = useState<string | null>(null);
  const [viewMemory, setViewMemory]     = useState<Memory | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Memory | null>(null);
  const [deleting, setDeleting]         = useState(false);
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState<DuoSpaceErrorPayload | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const consumedFocusRef = useRef<string | null>(null);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const creatorIds = partnerId ? [user.id, partnerId] : [user.id];
      const { data, error } = await supabase
        .from("memories").select("id,creator_id,image_url,caption,created_at")
        .in("creator_id", creatorIds)
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      if (data) setMemories(await resolveSignedUrls("memories", data as Memory[], "image_url"));
    } catch (err) {
      setLoadError(capture("DS-US-005", { component: "MemoryWall", action: "load", cause: err }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [user, partnerId]);

  // Deep link: open the requested memory once it's in the loaded list.
  useEffect(() => {
    if (!focusMemoryId || loading || consumedFocusRef.current === focusMemoryId) return;
    const target = memories.find((m) => m.id === focusMemoryId);
    if (target) {
      consumedFocusRef.current = focusMemoryId;
      setViewMemory(target);
    }
  }, [focusMemoryId, loading, memories]);

  // FIX: realtime subscription so partner's new memories appear instantly
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`memories-rt-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "memories" }, (payload) => {
        if (payload.eventType === "INSERT") {
          const m = payload.new as Memory;
          const ids = partnerId ? [user.id, partnerId] : [user.id];
          if (ids.includes(m.creator_id)) {
            resolveSignedUrl("memories", m.image_url ?? "").then((signedUrl) => {
              setMemories(prev => [{ ...m, image_url: m.image_url ? signedUrl : m.image_url }, ...prev]);
            });
          }
        } else if (payload.eventType === "DELETE") {
          setMemories(prev => prev.filter(m => m.id !== (payload.old as any).id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, partnerId]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedImage(file);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const addMemory = async () => {
    if (!user || (!selectedImage && !caption.trim())) return;
    setUploading(true);
    try {
      let imageUrl: string | null = null;
      if (selectedImage) {
        const path = `${user.id}/${Date.now()}_${selectedImage.name || "memory.jpg"}`;
        const { data, error: uploadErr } = await supabase.storage.from("memories").upload(path, selectedImage, { contentType: selectedImage.type || "image/jpeg" });
        if (uploadErr) throw uploadErr;
        if (data) {
          const { data: urlData } = supabase.storage.from("memories").getPublicUrl(path);
          imageUrl = urlData.publicUrl;
        }
      }
      const { data, error } = await supabase.from("memories")
        .insert({ creator_id: user.id, caption: caption || null, image_url: imageUrl })
        .select().single();
      if (error) throw error;
      if (data) {
        const created = data as Memory;
        const displayItem = created.image_url
          ? { ...created, image_url: await resolveSignedUrl("memories", created.image_url) }
          : created;
        setMemories(prev => [displayItem, ...prev]);
      }
      setCaption(""); setSelectedImage(null); setPreview(null);
      setShowAdd(false);
    } catch (err) {
      capture("DS-US-006", { component: "AddMemoryDialog", action: "save", cause: err });
      hapticError();
    } finally {
      setUploading(false);
    }
  };

  const deleteMemory = async (memory: Memory) => {
    setDeleting(true);
    const { error } = await supabase.from("memories").delete().eq("id", memory.id);
    setDeleting(false);
    if (error) {
      capture("DS-US-005", { component: "MemoryWall", action: "delete", cause: error });
      hapticError();
      return;
    }
    setMemories(prev => prev.filter(m => m.id !== memory.id));
    setViewMemory(null);
    setConfirmDelete(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Memory Wall</p>
        <button onClick={() => { setShowAdd(true); }} aria-label="Add memory"
          className="h-9 w-9 rounded-full bg-accent flex items-center justify-center active:scale-95 transition-transform">
          <Plus className="h-4 w-4 text-accent-foreground" aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-1.5" aria-busy="true" aria-label="Loading memories">
          {Array.from({ length: 6 }).map((_, i) => (
            <Shimmer key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        <div className="flex justify-center py-4">
          <ErrorCard error={loadError} onRetry={load} className="max-w-full" />
        </div>
      ) : memories.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-xs">No memories yet — add your first! 📸</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {memories.map((m) => (
            <button key={m.id} onClick={() => { setViewMemory(m); }}
              className="aspect-square rounded-xl overflow-hidden bg-muted relative active:scale-95 transition-transform">
              {m.image_url ? (
                <img loading="lazy" decoding="async" src={m.image_url} alt={m.caption || ""} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center p-2">
                  <p className="text-[10px] text-muted-foreground text-center leading-tight line-clamp-4">{m.caption}</p>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Add memory dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="rounded-2xl max-w-[320px]">
          <DialogHeader><DialogTitle className="text-base">Add Memory</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {preview ? (
              <div className="relative">
                <img loading="lazy" decoding="async" src={preview} alt="" className="w-full rounded-xl object-cover max-h-48" />
                <button onClick={() => { setSelectedImage(null); setPreview(null); }} aria-label="Remove selected photo"
                  className="absolute top-2 right-2 h-6 w-6 bg-background/80 rounded-full flex items-center justify-center">
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button onClick={() => { fileRef.current?.click(); }}
                className="w-full h-24 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-accent hover:border-accent/40 transition-colors">
                <ImageIcon className="h-5 w-5" />
                <span className="text-xs">Add photo</span>
              </button>
            )}
            <Input value={caption} onChange={e => setCaption(e.target.value)}
              placeholder="Add a caption..." className="h-9 rounded-xl text-sm" />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
          </div>
          <DialogFooter>
            <Button onClick={() => { hapticMedium(); addMemory(); }} disabled={uploading || (!selectedImage && !caption.trim())}
              className="w-full rounded-full bg-primary text-primary-foreground h-9 text-sm">
              {uploading ? "Saving..." : "Save Memory"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View memory dialog */}
      <AnimatePresence>
        {viewMemory && (
          <Dialog open={!!viewMemory} onOpenChange={() => setViewMemory(null)}>
            <DialogContent className="rounded-2xl max-w-[340px] p-0 overflow-hidden">
              {viewMemory.image_url && (
                <img loading="lazy" decoding="async" src={viewMemory.image_url} alt={viewMemory.caption || ""} className="w-full max-h-64 object-cover" />
              )}
              <div className="p-4 space-y-3">
                {viewMemory.caption && <p className="text-sm text-foreground">{viewMemory.caption}</p>}
                <p className="text-[10px] text-muted-foreground">
                  {new Date(viewMemory.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                </p>
                {viewMemory.creator_id === user?.id && (
                  <button onClick={() => { hapticWarning(); setConfirmDelete(viewMemory); }}
                    className="flex items-center gap-1.5 text-destructive text-xs">
                    <Trash2 className="h-3.5 w-3.5" /> Delete memory
                  </button>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>

      {/* Delete confirmation — unified destructive-action pattern */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent className="rounded-2xl max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete this memory?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.caption ? `"${confirmDelete.caption}" ` : ""}This will be removed for both of you. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => { hapticError(); if (confirmDelete) deleteMemory(confirmDelete); }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default MemoryWall;
