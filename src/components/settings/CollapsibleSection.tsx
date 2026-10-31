import { ReactNode, useCallback, useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import storage from "@/lib/storage";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "duo-appearance-sections";

/**
 * Open/closed state that survives leaving the page — someone who collapses
 * the wallpaper list once shouldn't have to collapse it on every visit.
 * Stored as one small JSON map so adding a section never adds a new key.
 */
export function usePersistedOpen(id: string, defaultOpen: boolean) {
  const [open, setOpenState] = useState<boolean>(() => {
    const saved = storage.getJSON<Record<string, boolean>>(STORAGE_KEY, {});
    return typeof saved[id] === "boolean" ? saved[id] : defaultOpen;
  });
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    const saved = storage.getJSON<Record<string, boolean>>(STORAGE_KEY, {});
    storage.setJSON(STORAGE_KEY, { ...saved, [id]: next });
  }, [id]);
  return [open, setOpen] as const;
}

interface CollapsibleSectionProps {
  /** Stable id — used as the persistence key. */
  id: string;
  title: string;
  icon?: ReactNode;
  /** One-line status shown under the title (e.g. the current selection). */
  summary?: ReactNode;
  /** Small visual of the current selection, always visible in the header —
   *  so a collapsed section still shows what's applied. */
  preview?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Card with a full-width header button that expands/collapses its body.
 * Height-animates (skipped under prefers-reduced-motion), exposes
 * aria-expanded/aria-controls, and keeps a big touch target.
 */
export const CollapsibleSection = ({
  id, title, icon, summary, preview, defaultOpen = true, children,
}: CollapsibleSectionProps) => {
  const [open, setOpen] = usePersistedOpen(id, defaultOpen);
  const reduceMotion = useReducedMotion();
  const panelId = `${useId()}-panel`;

  return (
    <section className="bg-card rounded-2xl border border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => { hapticLight(); setOpen(!open); }}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full min-h-[64px] flex items-center gap-3 px-4 py-3 text-left transition-colors active:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {icon && (
          <span className="h-9 w-9 shrink-0 rounded-xl bg-muted/60 flex items-center justify-center text-foreground/80" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium leading-tight">{title}</span>
          {summary && (
            <span className="block text-[11px] text-muted-foreground mt-0.5 truncate">{summary}</span>
          )}
        </span>
        {preview && <span className="shrink-0" aria-hidden="true">{preview}</span>}
        <span className="shrink-0 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{open ? "Hide" : "Show"}</span>
          <span className={cn(
            "h-7 w-7 rounded-full bg-muted/60 flex items-center justify-center transition-transform duration-200",
            open && "rotate-180",
          )}>
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </span>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            role="region"
            aria-label={title}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

export default CollapsibleSection;
