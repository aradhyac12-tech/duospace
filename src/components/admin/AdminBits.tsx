import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, ChevronLeft, ChevronRight, Link2, Link2Off, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { LinkState } from "@/lib/admin/adminApi";

export const PAGE_SIZE = 25;

const PLAN_LABEL: Record<string, string> = {
  FREE: "Free", PLUS_INDIVIDUAL: "Plus", PLUS_COUPLE: "Plus (couple)", PRO_INDIVIDUAL: "Pro", PRO_COUPLE: "Pro (couple)",
  LIFETIME: "Lifetime", FOUNDER: "Founder", BETA: "Beta", ADMIN: "Admin",
};
export const planLabel = (p: string) => PLAN_LABEL[p] ?? p;

export const PlanBadge = ({ plan }: { plan: string }) => (
  <span
    className={cn(
      "text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0",
      plan === "FREE" ? "bg-muted text-muted-foreground" : "bg-accent/15 text-accent",
    )}
  >
    {planLabel(plan)}
  </span>
);

export const LinkBadge = ({ state }: { state: LinkState }) => {
  const map = {
    mutual: { Icon: Link2, text: "Connected", cls: "text-emerald-500 bg-emerald-500/10" },
    one_way: { Icon: Unlink, text: "One-way link", cls: "text-amber-500 bg-amber-500/10" },
    solo: { Icon: Link2Off, text: "No partner", cls: "text-muted-foreground bg-muted" },
  }[state];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 shrink-0", map.cls)}>
      <map.Icon className="h-3 w-3" aria-hidden="true" />
      {map.text}
    </span>
  );
};

export const StatCard = ({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) => (
  <div className="bg-card rounded-2xl border border-border/60 p-3.5">
    <p className="text-[11px] text-muted-foreground">{label}</p>
    <p className="text-2xl font-semibold text-foreground tabular-nums mt-0.5">{value}</p>
    {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
  </div>
);

export const Chips = <T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) => (
  <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-5 px-5 pb-1">
    {options.map((o) => (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        className={cn(
          "shrink-0 text-xs rounded-full px-3 py-1.5 border transition-colors",
          value === o.value ? "bg-accent text-accent-foreground border-accent" : "bg-card text-muted-foreground border-border/60",
        )}
      >
        {o.label}
      </button>
    ))}
  </div>
);

export const Pager = ({
  page, total, onPage, loading,
}: { page: number; total: number; onPage: (p: number) => void; loading?: boolean }) => {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="flex items-center justify-between pt-1">
      <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="h-4 w-4" /> Prev
      </Button>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        Page {page + 1} of {pages} · {total}
      </span>
      <Button size="sm" variant="outline" disabled={page + 1 >= pages || loading} onClick={() => onPage(page + 1)}>
        Next <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
};

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground text-center py-8">{children}</p>
);

export const Spinner = () => (
  <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
);

/** Debounced value (for search boxes). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Loads a list through an admin RPC and keeps the latest request authoritative
 * (a slow earlier response can never overwrite a newer one).
 */
export function useAdminList<T>(load: () => Promise<T[]>, deps: unknown[]) {
  const { toast } = useToast();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const data = await load();
      if (mine === seq.current) setRows(data ?? []);
    } catch (e) {
      if (mine === seq.current) {
        toast({ title: "Couldn't load", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { void reload(); }, [reload]);
  return { rows, loading, reload, setRows };
}
