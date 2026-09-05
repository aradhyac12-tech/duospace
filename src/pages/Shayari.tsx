import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Trash2, BookOpen, Feather, Search, Heart, X, Download, Upload,
  Layers, FileText, Image as ImageIcon, Type, Loader2, ChevronRight, CheckCircle2,
} from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticNotification } from "@/lib/haptics";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";
import { saveOrShareFile } from "@/lib/fileExport";
import {
  formatShayariExport, serializeShayariCollection, parseImportFile,
  type ImportSourceFormat, type ShayariImportEntry,
} from "@/lib/shayariTransfer";
import { renderShayariCard, canvasToPngBase64, sanitizeFileFragment } from "@/lib/shayariCard";
import { buildShayariPdfBase64, buildShayariCardsZipBase64 } from "@/lib/shayariPdf";

type ExportFormat = "shayari" | "pdf" | "card" | "txt";

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
  const importFileRef = useRef<HTMLInputElement>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [cardBusyId, setCardBusyId] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<{
    entries: ShayariImportEntry[]; sourceFormat: ImportSourceFormat; fileName: string;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // B9 Fix: get partner ID first, then filter shayaris to this couple only
        const { data: profileData, error: profileErr } = await supabase.from("profiles")
          .select("partner_id,pet_name").eq("user_id", user.id).single();
        if (profileErr) throw profileErr;
        const pid = profileData?.partner_id || null;
        const myPetNameForPartner = profileData?.pet_name || null;
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
            const name = prof.user_id === pid ? (myPetNameForPartner || prof.display_name) : prof.display_name;
            map[prof.user_id] = { name, avatar: prof.avatar_url };
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

  // Shared shape used by every export format: everything the app actually
  // knows about each entry (title/content/favorite/date are real DB
  // columns; author is resolved from the profiles map for display).
  const exportSources = () =>
    filtered.map((s) => ({
      title: s.title,
      content: s.content,
      authorName: profiles[s.user_id]?.name || null,
      createdAt: s.created_at,
      isFavorite: s.is_favorite,
    }));

  const dateStamp = () => new Date().toISOString().slice(0, 10);

  const handleExport = async (format: ExportFormat) => {
    if (!filtered.length) {
      toast({ title: "Nothing to export", description: tab === "favorites" ? "No favorites yet" : "Write a shayari first" });
      return;
    }
    hapticLight();
    setExportingFormat(format);
    try {
      const sources = exportSources();
      const base = `duospace-shayari-${dateStamp()}`;

      if (format === "txt") {
        await saveOrShareFile({
          fileName: `${base}.txt`, data: formatShayariExport(sources),
          mimeType: "text/plain;charset=utf-8", dialogTitle: "Export Shayari",
        });
      } else if (format === "shayari") {
        await saveOrShareFile({
          fileName: `${base}.shayari`, data: serializeShayariCollection(sources),
          mimeType: "application/json;charset=utf-8", dialogTitle: "Export Shayari Collection",
        });
      } else if (format === "pdf") {
        const base64 = await buildShayariPdfBase64(sources);
        await saveOrShareFile({
          fileName: `${base}.pdf`, data: base64, isBase64: true,
          mimeType: "application/pdf", dialogTitle: "Export Shayari PDF",
        });
      } else if (format === "card") {
        const used = new Set<string>();
        const withNames = sources.map((s) => {
          let hint = sanitizeFileFragment(s.title || "shayari", "shayari");
          let n = 2;
          while (used.has(hint)) hint = `${sanitizeFileFragment(s.title || "shayari", "shayari")}-${n++}`;
          used.add(hint);
          return { ...s, fileNameHint: hint };
        });
        const base64 = await buildShayariCardsZipBase64(withNames);
        await saveOrShareFile({
          fileName: `${base}-cards.zip`, data: base64, isBase64: true,
          mimeType: "application/zip", dialogTitle: "Export Shayari Cards",
        });
      }
      toast({ title: "Exported ✨" });
      setShowExportDialog(false);
    } catch (err) {
      capture("DS-SHAYARI-003", { component: "Shayari", action: "export", cause: err, details: { format } });
      toast({ title: "Couldn't export", variant: "destructive" });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleShareCard = async (s: ShayariItem) => {
    hapticLight();
    setCardBusyId(s.id);
    try {
      const canvas = renderShayariCard({
        title: s.title, content: s.content, authorName: profiles[s.user_id]?.name || null,
        createdAt: s.created_at, isFavorite: s.is_favorite,
      });
      const base64 = canvasToPngBase64(canvas);
      await saveOrShareFile({
        fileName: `${sanitizeFileFragment(s.title || "shayari", "shayari")}.png`,
        data: base64, isBase64: true, mimeType: "image/png", dialogTitle: "Share Shayari",
      });
    } catch (err) {
      capture("DS-SHAYARI-005", { component: "Shayari", action: "shareCard", cause: err });
      toast({ title: "Couldn't create card", variant: "destructive" });
    } finally {
      setCardBusyId(null);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    hapticLight();
    try {
      const text = await file.text();
      const { entries, sourceFormat } = parseImportFile(file.name, text);
      setImportPreview({ entries, sourceFormat, fileName: file.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't read that file";
      toast({ title: "Couldn't import", description: message, variant: "destructive" });
    }
  };

  const confirmImport = async () => {
    if (!importPreview || !user) return;
    setImporting(true);
    try {
      const { error } = await supabase.from("shayaris").insert(
        importPreview.entries.map((p) => ({ user_id: user.id, title: p.title, content: p.content })) as any
      );
      if (error) throw error;
      setReloadTick((t) => t + 1);
      hapticNotification("success");
      toast({ title: `Imported ${importPreview.entries.length} shayari${importPreview.entries.length === 1 ? "" : "s"} ✨` });
      setImportPreview(null);
    } catch (err) {
      capture("DS-SHAYARI-004", { component: "Shayari", action: "import", cause: err });
      toast({ title: "Couldn't import", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const EXPORT_OPTIONS: { format: ExportFormat; icon: typeof Layers; label: string; description: string }[] = [
    { format: "shayari", icon: Layers, label: "DuoSpace Collection", description: ".shayari — full-fidelity backup, best for re-importing later" },
    { format: "pdf", icon: FileText, label: "Beautiful PDF", description: "Elegant printable keepsake, one shayari per page" },
    { format: "card", icon: ImageIcon, label: "Shayari Cards", description: ".png images (zipped) — ready to share" },
    { format: "txt", icon: Type, label: "Plain Text", description: ".txt — simple and universally readable" },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Shayari" subtitle="Words from the heart">
        <div className="flex gap-2 items-center">
          <button onClick={() => { importFileRef.current?.click(); }} aria-label="Import shayaris"
            className="h-9 w-9 rounded-xl bg-muted/60 flex items-center justify-center disabled:opacity-50">
            <Upload className="h-4 w-4 text-foreground" aria-hidden="true" />
          </button>
          <button onClick={() => { setShowExportDialog(true); }} aria-label="Export shayaris"
            className="h-9 w-9 rounded-xl bg-muted/60 flex items-center justify-center disabled:opacity-50">
            <Download className="h-4 w-4 text-foreground" aria-hidden="true" />
          </button>
          <button onClick={() => { setShowAddDialog(true); }} aria-label="Add shayari"
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center">
            <Plus className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
          </button>
        </div>
        <input ref={importFileRef} type="file" accept=".shayari,.json,.txt" className="hidden" onChange={handleFileSelected} />
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
                        <img loading="lazy" decoding="async" src={author.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                      ) : (
                        <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                          <span className="text-[9px] font-semibold text-muted-foreground">{(author?.name || "?").charAt(0).toUpperCase()}</span>
                        </div>
                      )}
                      <span className="text-[11px] text-muted-foreground">{author?.name || "Unknown"} · {formatDate(shayari.created_at)}</span>
                    </div>
                    <div className="flex gap-1.5">
                      <button onClick={() => handleShareCard(shayari)} disabled={cardBusyId === shayari.id} aria-label="Share as card"
                        className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground transition-all duration-150 active:scale-90 disabled:opacity-50">
                        {cardBusyId === shayari.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          : <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                      </button>
                      <button onClick={() => { toggleFavorite(shayari); }} aria-label={shayari.is_favorite ? "Remove from favorites" : "Add to favorites"}
                        className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-150 active:scale-90">
                        <Heart className={`h-3.5 w-3.5 ${shayari.is_favorite ? "fill-primary text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                      </button>
                      <button onClick={() => { setShowDeleteConfirm(shayari.id); }} aria-label="Delete shayari"
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

      {/* Export options */}
      <Dialog open={showExportDialog} onOpenChange={(o) => !exportingFormat && setShowExportDialog(o)}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Download className="h-5 w-5" /> Export Shayari</DialogTitle>
            <DialogDescription>
              {tab === "favorites" ? "Exporting your favorites" : "Exporting all your shayaris"}
              {search ? " (matching your search)" : ""} · {filtered.length} item{filtered.length === 1 ? "" : "s"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {EXPORT_OPTIONS.map(({ format, icon: Icon, label, description }) => (
              <button key={format} onClick={() => handleExport(format)} disabled={!!exportingFormat}
                className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-muted/40 text-left active:scale-[0.98] transition-transform disabled:opacity-50">
                <div className="h-10 w-10 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-[11px] text-muted-foreground">{description}</p>
                </div>
                {exportingFormat === format
                  ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-hidden="true" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Import preview — file is parsed and shown before anything touches the database */}
      <Dialog open={!!importPreview} onOpenChange={(o) => !o && !importing && setImportPreview(null)}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Import Shayari</DialogTitle>
            <DialogDescription>
              {importPreview?.sourceFormat === "shayari" && "DuoSpace Collection detected"}
              {importPreview?.sourceFormat === "json" && "JSON file detected"}
              {importPreview?.sourceFormat === "txt" && "Text file — shayaris detected automatically"}
              {" · "}{importPreview?.entries.length} found
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto space-y-1.5 -mx-1 px-1">
            {importPreview?.entries.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-muted/40">
                <CheckCircle2 className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {entry.title && <p className="text-xs font-medium truncate">{entry.title}</p>}
                  <p className="text-[11px] text-muted-foreground truncate">{entry.content.replace(/\n/g, " ")}</p>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setImportPreview(null)} disabled={importing} className="flex-1 rounded-xl">Cancel</Button>
            <Button onClick={confirmImport} disabled={importing} className="flex-1 rounded-xl bg-primary text-primary-foreground">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : `Import ${importPreview?.entries.length ?? ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default Shayari;
