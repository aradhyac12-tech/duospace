import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2, BookOpen, Feather, Search, Heart, X } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticNotification } from "@/lib/haptics";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

interface ShayariItem {
  id: string;
  user_id: string;
  title: string | null;
  content: string;
  is_favorite: boolean;
  delete_requested_by: string | null;
  created_at: string;
}

const Shayari = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [shayaris, setShayaris] = useState<ShayariItem[]>([]);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newShayari, setNewShayari] = useState({ title: "", content: "" });
  const [profiles, setProfiles] = useState<Record<string, { name: string; avatar: string | null }>>({});
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    const load = async () => {
      // B9 Fix: get partner ID first, then filter shayaris to this couple only
      const { data: profileData } = await supabase.from("profiles")
        .select("partner_id").eq("user_id", user.id).single();
      const pid = profileData?.partner_id || null;
      setPartnerId(pid);

      const creatorIds = pid ? [user.id, pid] : [user.id];
      const { data } = await supabase
        .from("shayaris")
        .select("id,user_id,title,content,is_favorite,delete_requested_by,created_at")
        .in("user_id", creatorIds)
        .order("created_at", { ascending: false }) as any;
      if (data) setShayaris(data);

      // Only fetch profiles for this couple
      const profileIds = pid ? [user.id, pid] : [user.id];
      const { data: p } = await supabase.from("profiles")
        .select("user_id, display_name, pet_name, avatar_url")
        .in("user_id", profileIds);
      if (p) {
        const map: Record<string, { name: string; avatar: string | null }> = {};
        (p as any[]).forEach((prof) => {
          map[prof.user_id] = { name: prof.pet_name || prof.display_name, avatar: prof.avatar_url };
        });
        setProfiles(map);
      }
    };
    load();

    const channel = supabase
      .channel("shayaris-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "shayaris" }, (payload) => {
        const newItem = payload.new as ShayariItem;
        // Only process shayaris from this couple — use partnerId state
        if (newItem.user_id !== user.id && newItem.user_id !== partnerId) return;
        if (newItem.user_id !== user.id) {
          hapticNotification("success");
          toast({ title: "✨ New Shayari!", description: `${profiles[newItem.user_id]?.name || "Your partner"} added a new shayari` });
        }
        setShayaris((prev) => {
          if (prev.some(s => s.id === newItem.id)) return prev;
          return [newItem, ...prev];
        });
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "shayaris" }, (payload) => {
        setShayaris((prev) => prev.filter((s) => s.id !== (payload.old as any).id));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "shayaris" }, (payload) => {
        const updated = payload.new as ShayariItem;
        setShayaris((prev) => prev.map((s) => s.id === updated.id ? updated : s));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, partnerId, toast]);

  const filtered = useMemo(() => {
    let list = shayaris;
    if (tab === "favorites") list = list.filter((s) => s.is_favorite);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.content.toLowerCase().includes(q) || (s.title && s.title.toLowerCase().includes(q)));
    }
    return list;
  }, [shayaris, tab, search]);

  const addShayari = async () => {
    if (!user || !newShayari.content.trim()) return;
    hapticLight();
    const { error } = await supabase.from("shayaris").insert({
      user_id: user.id,
      title: newShayari.title.trim() || null,
      content: newShayari.content.trim(),
    } as any);
    if (error) {
      toast({ title: "Couldn't add shayari", description: error.message, variant: "destructive" });
    } else {
      setShowAddDialog(false);
      setNewShayari({ title: "", content: "" });
      toast({ title: "Shayari added ✨" });
    }
  };

  const toggleFavorite = async (s: ShayariItem) => {
    hapticLight();
    await supabase.from("shayaris").update({ is_favorite: !s.is_favorite } as any).eq("id", s.id);
    setShayaris((prev) => prev.map((item) => item.id === s.id ? { ...item, is_favorite: !item.is_favorite } : item));
  };

  const requestDelete = async (id: string) => {
    if (!user) return;
    hapticLight();
    const shayari = shayaris.find((s) => s.id === id);
    if (!shayari) return;

    if (shayari.delete_requested_by && shayari.delete_requested_by !== user.id) {
      // Both partners agreed — delete
      await supabase.from("shayaris").delete().eq("id", id);
      toast({ title: "Shayari deleted" });
    } else if (shayari.delete_requested_by === user.id) {
      // Cancel own request
      await supabase.from("shayaris").update({ delete_requested_by: null } as any).eq("id", id);
      setShayaris((prev) => prev.map((s) => s.id === id ? { ...s, delete_requested_by: null } : s));
      toast({ title: "Delete request cancelled" });
    } else {
      // First request
      await supabase.from("shayaris").update({ delete_requested_by: user.id } as any).eq("id", id);
      setShayaris((prev) => prev.map((s) => s.id === id ? { ...s, delete_requested_by: user.id } : s));
      toast({ title: "Delete requested", description: "Your partner needs to approve the deletion" });
    }
    setShowDeleteConfirm(null);
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Shayari" subtitle="Words from the heart">
        <button onClick={() => { hapticLight(); setShowAddDialog(true); }}
          className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center">
          <Plus className="h-5 w-5 text-foreground" />
        </button>
      </PageHeader>

      <div className="px-5 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shayaris..." className="pl-9 h-9 rounded-xl bg-card text-sm" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="w-full bg-muted/50 rounded-xl h-8">
            <TabsTrigger value="all" className="flex-1 rounded-lg text-xs">All</TabsTrigger>
            <TabsTrigger value="favorites" className="flex-1 rounded-lg text-xs gap-1">
              <Heart className="h-3 w-3" /> Favorites
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {filtered.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <div className="h-16 w-16 rounded-2xl bg-accent flex items-center justify-center mx-auto">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              {tab === "favorites" ? "No favorites yet" : search ? "No matches" : "No shayaris yet. Write your first!"}
            </p>
            {!search && tab === "all" && (
              <Button onClick={() => setShowAddDialog(true)} variant="outline" className="rounded-xl gap-2">
                <Feather className="h-4 w-4" /> Write a Shayari
              </Button>
            )}
          </div>
        ) : (
          <AnimatePresence>
            {filtered.map((shayari, i) => {
              const author = profiles[shayari.user_id];
              const pendingDelete = !!shayari.delete_requested_by;
              const myDeleteReq = shayari.delete_requested_by === user?.id;
              const partnerDeleteReq = pendingDelete && !myDeleteReq;
              return (
                <motion.div key={shayari.id}
                  initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -80 }} transition={{ delay: i * 0.03 }}
                  className={`relative bg-card rounded-2xl border p-5 shadow-sm ${pendingDelete ? "border-destructive/30" : "border-border"}`}>
                  <div className="absolute top-3 left-4 text-4xl text-muted-foreground/10 font-serif leading-none select-none">"</div>

                  {shayari.title && (
                    <p className="text-xs font-semibold text-primary mb-2 uppercase tracking-wider">{shayari.title}</p>
                  )}
                  <p className="text-[15px] leading-relaxed whitespace-pre-line text-foreground/90 italic pl-3">{shayari.content}</p>

                  {pendingDelete && (
                    <div className="mt-2 px-3 py-1.5 rounded-lg bg-destructive/10 text-[10px] text-destructive">
                      {myDeleteReq ? "⏳ Waiting for partner to approve deletion" : "⚠️ Partner wants to delete this — tap 🗑️ to approve"}
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/40">
                    <div className="flex items-center gap-2">
                      {author?.avatar ? (
                        <img src={author.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                      ) : (
                        <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                          <span className="text-[9px] font-semibold text-muted-foreground">{(author?.name || "?").charAt(0).toUpperCase()}</span>
                        </div>
                      )}
                      <span className="text-[11px] text-muted-foreground">{author?.name || "Unknown"} · {formatDate(shayari.created_at)}</span>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => toggleFavorite(shayari)}
                        className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors">
                        <Heart className={`h-3.5 w-3.5 ${shayari.is_favorite ? "fill-primary text-primary" : "text-muted-foreground"}`} />
                      </button>
                      <button onClick={() => setShowDeleteConfirm(shayari.id)}
                        className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Add dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Feather className="h-5 w-5" /> Write a Shayari</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Title (optional)</label>
              <Input value={newShayari.title} onChange={(e) => setNewShayari({ ...newShayari, title: e.target.value })}
                placeholder="e.g. Mohabbat" className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Shayari *</label>
              <Textarea value={newShayari.content} onChange={(e) => setNewShayari({ ...newShayari, content: e.target.value })}
                placeholder="Write your shayari here..." className="rounded-xl min-h-[120px] resize-none" rows={5} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={addShayari} disabled={!newShayari.content.trim()} className="rounded-xl bg-foreground text-background w-full">
              Add Shayari
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!showDeleteConfirm} onOpenChange={() => setShowDeleteConfirm(null)}>
        <DialogContent className="rounded-2xl max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-base">
              {shayaris.find((s) => s.id === showDeleteConfirm)?.delete_requested_by
                ? "Approve deletion?"
                : "Request deletion?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {shayaris.find((s) => s.id === showDeleteConfirm)?.delete_requested_by
              ? "Your partner already requested this. Approving will permanently delete it."
              : "Both partners must agree to delete a shayari. Your partner will need to approve."}
          </p>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setShowDeleteConfirm(null)} className="flex-1 rounded-xl">Cancel</Button>
            <Button onClick={() => showDeleteConfirm && requestDelete(showDeleteConfirm)}
              className="flex-1 rounded-xl bg-destructive text-destructive-foreground">
              {shayaris.find((s) => s.id === showDeleteConfirm)?.delete_requested_by ? "Approve Delete" : "Request Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default Shayari;
