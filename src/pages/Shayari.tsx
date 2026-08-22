import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2, BookOpen, Feather, Search, Heart, X } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
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
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";

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
  const { capture } = useErrorManager("Shayari");
  const [searchParams, setSearchParams] = useSearchParams();
  const [shayaris, setShayaris] = useState<ShayariItem[]>([]);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newShayari, setNewShayari] = useState({ title: "", content: "" });
  const [profiles, setProfiles] = useState<Record<string, { name: string; avatar: string | null }>>({});
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  // Loading vs empty need to be distinguishable states — otherwise a slow
  // network briefly (and on error, permanently) shows "No shayaris yet"
  // even when there actually are some, which reads as data loss.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<DuoSpaceErrorPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Deep link: /shayari?id=<id> highlights and scrolls to one entry —
  // supports a future notification/share-link target even though nothing
  // sends that payload yet (see docs/RELATIONSHIP_FEATURE_QA.md's deep-link
  // section for the honest gap note on the push-notification side).
  const deepLinkId = searchParams.get("id");
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // B9 Fix: get partner ID first, then filter shayaris to this couple only
        const { data: profileData, error: profileErr } = await supabase.from("profiles")
          .select("partner_id").eq("user_id", user.id).single();
        if (profileErr) throw profileErr;
        const pid = profileData?.partner_id || null;
        if (cancelled) return;
        setPartnerId(pid);

        const creatorIds = pid ? [user.id, pid] : [user.id];
        const { data, error } = await supabase
          .from("shayaris")
          .select("id,user_id,title,content,is_favorite,delete_requested_by,created_at")
          .in("user_id", creatorIds)
          .order("created_at", { ascending: false }) as any;
        if (error) throw error;
        if (cancelled) return;
        if (data) setShayaris(data);

        // Only fetch profiles for this couple
        const profileIds = pid ? [user.id, pid] : [user.id];
        const { data: p, error: pErr } = await supabase.from("profiles")
          .select("user_id, display_name, pet_name, avatar_url")
          .in("user_id", profileIds);
        if (pErr) throw pErr;
        if (cancelled) return;
        if (p) {
          const map: Record<string, { name: string; avatar: string | null }> = {};
          (p as any[]).forEach((prof) => {
            map[prof.user_id] = { name: prof.pet_name || prof.display_name, avatar: prof.avatar_url };
          });
          setProfiles(map);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(capture("DS-SHAYARI-001", { component: "Shayari", action: "load", cause: err }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user, capture, reloadTick]);

  // Scroll the deep-linked shayari into view once it's loaded.
  useEffect(() => {
    if (!deepLinkId || loading || !highlightRef.current) return;
    highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [deepLinkId, loading, shayaris]);

  useEffect(() => {
    if (!user) return;

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
      capture("DS-SHAYARI-002", { component: "AddShayariDialog", action: "insert", cause: error });
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
        <button onClick={() => { hapticLight(); setShowAddDialog(true); }} aria-label="Add shayari"
          className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center">
          <Plus className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
        </button>
      </PageHeader>

      <div className="px-5 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shayaris..." className="pl-9 h-9 rounded-xl bg-card text-sm" />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2">
              <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
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

        {loading ? (
          // Loading skeleton — quote-card shaped, distinct from the empty
          // state below, so a slow fetch never briefly reads as "you have
          // no shayaris."
          <div className="space-y-3" aria-busy="true" aria-label="Loading shayaris">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-2xl border border-border p-5 space-y-3">
                <Shimmer className="h-3 w-24" />
                <Shimmer className="h-3.5 w-full" />
                <Shimmer className="h-3.5 w-5/6" />
                <Shimmer className="h-3.5 w-3/4" />
                <div className="flex items-center justify-between pt-2">
                  <Shimmer className="h-5 w-28" />
                  <Shimmer className="h-5 w-12" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="flex justify-center py-8">
            <ErrorCard
              error={loadError}
              onRetry={() => setReloadTick((t) => t + 1)}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <div className="h-16 w-16 rounded-2xl bg-accent flex items-center justify-center mx-auto">
              <BookOpen className="h-8 w-8 text-accent-foreground/70" />
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
              const isDeepLinkTarget = shayari.id === deepLinkId;
              return (
                <motion.div key={shayari.id}
                  ref={isDeepLinkTarget ? highlightRef : undefined}
                  initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -80 }} transition={{ delay: i * 0.03 }}
                  className={`relative bg-card rounded-2xl border p-5 shadow-sm transition-colors ${
                    pendingDelete ? "border-destructive/30" : isDeepLinkTarget ? "border-accent" : "border-border"
                  }`}>
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
                    <div className="flex gap-1.5">
                      <button onClick={() => { hapticLight(); toggleFavorite(shayari); }} aria-label={shayari.is_favorite ? "Remove from favorites" : "Add to favorites"}
                        className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-150 active:scale-90">
                        <Heart className={`h-3.5 w-3.5 ${shayari.is_favorite ? "fill-primary text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                      </button>
                      <button onClick={() => { hapticLight(); setShowDeleteConfirm(shayari.id); }} aria-label="Delete shayari"
                        className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive transition-all duration-150 active:scale-90">
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
            <Button onClick={addShayari} disabled={!newShayari.content.trim()} className="rounded-xl bg-primary text-primary-foreground w-full">
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
