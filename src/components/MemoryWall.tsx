import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, ImageIcon, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

interface Memory {
  id: string;
  creator_id: string;
  caption: string | null;
  image_url: string | null;
  created_at: string;
}

interface MemoryWallProps {
  partnerId: string | null;
}

const MemoryWall = ({ partnerId }: MemoryWallProps) => {
  const { user } = useAuth();
  const [memories, setMemories]         = useState<Memory[]>([]);
  const [showAdd, setShowAdd]           = useState(false);
  const [caption, setCaption]           = useState("");
  const [uploading, setUploading]       = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [preview, setPreview]           = useState<string | null>(null);
  const [viewMemory, setViewMemory]     = useState<Memory | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    if (!user) return;
    const creatorIds = partnerId ? [user.id, partnerId] : [user.id];
    const { data } = await supabase
      .from("memories").select("id,creator_id,image_url,caption,created_at")
      .in("creator_id", creatorIds)
      .order("created_at", { ascending: false }).limit(50);
    if (data) setMemories(data);
  };

  useEffect(() => { load(); }, [user, partnerId]);

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
            setMemories(prev => [m, ...prev]);
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
    let imageUrl: string | null = null;
    if (selectedImage) {
      const path = `${user.id}/${Date.now()}_${selectedImage.name || "memory.jpg"}`;
      const { data } = await supabase.storage.from("memories").upload(path, selectedImage, { contentType: selectedImage.type || "image/jpeg" });
      if (data) {
        const { data: urlData } = supabase.storage.from("memories").getPublicUrl(path);
        imageUrl = urlData.publicUrl;
      }
    }
    const { data } = await supabase.from("memories")
      .insert({ creator_id: user.id, caption: caption || null, image_url: imageUrl })
      .select().single();
    if (data) setMemories(prev => [data as Memory, ...prev]);
    setCaption(""); setSelectedImage(null); setPreview(null);
    setShowAdd(false); setUploading(false);
  };

  const deleteMemory = async (id: string) => {
    await supabase.from("memories").delete().eq("id", id);
    setMemories(prev => prev.filter(m => m.id !== id));
    setViewMemory(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Memory Wall</p>
        <button onClick={() => setShowAdd(true)}
          className="h-7 w-7 rounded-full bg-accent flex items-center justify-center active:scale-95 transition-transform">
          <Plus className="h-3.5 w-3.5 text-foreground" />
        </button>
      </div>

      {memories.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-xs">No memories yet — add your first! 📸</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {memories.map((m) => (
            <button key={m.id} onClick={() => setViewMemory(m)}
              className="aspect-square rounded-xl overflow-hidden bg-muted relative active:scale-95 transition-transform">
              {m.image_url ? (
                <img src={m.image_url} alt={m.caption || ""} className="w-full h-full object-cover" />
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
                <img src={preview} alt="" className="w-full rounded-xl object-cover max-h-48" />
                <button onClick={() => { setSelectedImage(null); setPreview(null); }}
                  className="absolute top-2 right-2 h-6 w-6 bg-background/80 rounded-full flex items-center justify-center">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()}
                className="w-full h-24 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
                <ImageIcon className="h-5 w-5" />
                <span className="text-xs">Add photo</span>
              </button>
            )}
            <Input value={caption} onChange={e => setCaption(e.target.value)}
              placeholder="Add a caption..." className="h-9 rounded-xl text-sm" />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
          </div>
          <DialogFooter>
            <Button onClick={addMemory} disabled={uploading || (!selectedImage && !caption.trim())}
              className="w-full rounded-full bg-foreground text-background h-9 text-sm">
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
                <img src={viewMemory.image_url} alt={viewMemory.caption || ""} className="w-full max-h-64 object-cover" />
              )}
              <div className="p-4 space-y-3">
                {viewMemory.caption && <p className="text-sm text-foreground">{viewMemory.caption}</p>}
                <p className="text-[10px] text-muted-foreground">
                  {new Date(viewMemory.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                </p>
                {viewMemory.creator_id === user?.id && (
                  <button onClick={() => deleteMemory(viewMemory.id)}
                    className="flex items-center gap-1.5 text-destructive text-xs">
                    <Trash2 className="h-3.5 w-3.5" /> Delete memory
                  </button>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MemoryWall;
