import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Trash2, Loader2, FileArchive, Code2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { hapticSelection, hapticWarning } from "@/lib/haptics";
import {
  deleteLibraryItem,
  getLibraryItem,
  listLibrary,
  type LibraryItem,
  type LibraryItemFull,
} from "@/lib/surpriseLibrary";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface SurpriseLibraryPanelProps {
  onClose: () => void;
  /** Called with the full item (bodies included) when the person taps Use. */
  onUse: (item: LibraryItemFull) => void;
  /** Library row the editor is currently linked to, if any. */
  activeId?: string | null;
  /** Bump to make an open panel reload (e.g. after a save elsewhere). */
  refreshKey?: number;
}

const fmtSize = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;

const SOURCE_LABEL: Record<string, string> = {
  zip: "Zip", html: "HTML", css: "CSS", js: "JS", files: "Files", manual: "Editor",
};

/**
 * The owner-only "saved uploads" list. Rows come from
 * public.surprise_library (RLS: owner only — nothing here is ever visible
 * to the partner). The list query never loads code bodies; a body is pulled
 * only for the one row being used.
 */
const SurpriseLibraryPanel = ({ onClose, onUse, activeId, refreshKey = 0 }: SurpriseLibraryPanelProps) => {
  const { toast } = useToast();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [usingId, setUsingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listLibrary());
    } catch (err) {
      setItems([]);
      toast({ title: "Couldn't load your library", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const use = async (item: LibraryItem) => {
    hapticSelection();
    setUsingId(item.id);
    try {
      onUse(await getLibraryItem(item.id));
    } catch (err) {
      hapticWarning();
      toast({ title: "Couldn't open that item", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setUsingId(null);
    }
  };

  const confirmDelete = async () => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (!item) return;
    hapticWarning();
    try {
      await deleteLibraryItem(item.id);
      toast({ title: "Removed from library" });
      void load();
    } catch (err) {
      toast({ title: "Couldn't delete", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 bg-background flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Surprise library"
    >
      <div className="safe-top px-4 pt-3 pb-2 flex items-center justify-between border-b border-border/30">
        <div>
          <p className="text-sm font-medium">Your library</p>
          <p className="text-[10px] text-muted-foreground">Saved uploads — private, never sent to your partner</p>
        </div>
        <button onClick={onClose} aria-label="Close library" className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
          <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}>
        {loading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />
          </div>
        )}
        {!loading && items?.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-10">
            Nothing saved yet. Import a zip or HTML/CSS/JS files, or tap “Save to library” in the editor.
          </p>
        )}
        {items?.map((item) => (
          <div key={item.id} className="bg-card rounded-2xl border border-border/60 p-3 flex items-center gap-3">
            <div className="h-9 w-9 shrink-0 rounded-xl bg-accent/50 flex items-center justify-center">
              {item.source_type === "zip"
                ? <FileArchive className="h-4 w-4 text-foreground" aria-hidden="true" />
                : <Code2 className="h-4 w-4 text-foreground" aria-hidden="true" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {item.title}
                {item.id === activeId && <span className="ml-2 text-[10px] font-normal text-primary">open in editor</span>}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {SOURCE_LABEL[item.source_type] ?? item.source_type}
                {item.source_name ? ` · ${item.source_name}` : ""}
                {` · ${fmtSize(item.byte_size)}`}
                {item.asset_count ? ` · ${item.asset_count} media` : ""}
                {` · ${new Date(item.updated_at).toLocaleDateString()}`}
              </p>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => use(item)}
                disabled={usingId === item.id}
                className="h-10 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1 disabled:opacity-60"
              >
                {usingId === item.id && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Use
              </button>
              <button
                onClick={() => { hapticWarning(); setPendingDelete(item); }}
                aria-label={`Delete ${item.title} from library`}
                className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from your library?</AlertDialogTitle>
            <AlertDialogDescription>
              This only deletes the saved copy. Surprises you've already sent aren't affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
};

export default SurpriseLibraryPanel;
