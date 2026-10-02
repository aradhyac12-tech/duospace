/**
 * ErrorLogPanel — Developer Mode log viewer.
 *
 * Search, filter by category/severity, view per-code frequency stats and
 * recovery success stats, export the full log as JSON, and clear it.
 * Mount this somewhere behind a "Developer Mode" toggle (e.g. Settings).
 */
import { useMemo, useState } from "react";
import { Search, Download, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { errorManager } from "@/lib/errors/errorManager";
import { listCategories } from "@/lib/errors/registry";
import { getRecoveryStats } from "@/lib/errors/recovery";
import type { DuoSpaceErrorPayload, ErrorCategory, ErrorSeverity } from "@/lib/errors/types";
import { cn } from "@/lib/utils";

const SEVERITIES: Array<ErrorSeverity | "All"> = ["All", "INFO", "WARNING", "ERROR", "CRITICAL", "FATAL"];

export function ErrorLogPanel() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ErrorCategory | "All">("All");
  const [severity, setSeverity] = useState<ErrorSeverity | "All">("All");
  const [openId, setOpenId] = useState<string | null>(null);
  const [, forceRerender] = useState(0);
  const { toast } = useToast();

  const categories = useMemo<Array<ErrorCategory | "All">>(() => ["All", ...(listCategories() as ErrorCategory[])], []);

  const entries = useMemo<DuoSpaceErrorPayload[]>(() => {
    let list = errorManager.search(query);
    if (category !== "All") list = list.filter((e) => e.category === category);
    if (severity !== "All") list = list.filter((e) => e.severity === severity);
    return [...list].reverse(); // newest first
  }, [query, category, severity]);

  const frequency = useMemo(() => errorManager.getFrequencyStats().slice(0, 5), [entries]);
  const recovery = getRecoveryStats();

  const handleExport = async () => {
    const json = errorManager.exportLogsAsJson();
    try {
      await navigator.clipboard.writeText(json);
      toast({ description: "Copied error log JSON to clipboard." });
    } catch {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `duospace-error-log-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleClear = () => {
    errorManager.clear();
    forceRerender((n) => n + 1);
    toast({ description: "Error log cleared." });
  };

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code, title, screen…"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <Button size="sm" variant="outline" onClick={handleExport} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
        <Button size="sm" variant="outline" onClick={handleClear} className="gap-1.5">
          <Trash2 className="h-3.5 w-3.5" />
          Clear
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn(
              "text-[11px] px-2 py-1 rounded-full border",
              category === c ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            className={cn(
              "text-[11px] px-2 py-1 rounded-full border",
              severity === s ? "bg-secondary text-secondary-foreground border-secondary" : "text-muted-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="rounded-xl border p-3 text-xs space-y-1.5 bg-muted/20">
        <p className="font-medium text-foreground">Session stats</p>
        <p className="text-muted-foreground">
          Recovery attempts: {recovery.attempts} · Successful: {recovery.successes}
        </p>
        {frequency.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {frequency.map((f) => (
              <span key={f.code} className="font-mono px-1.5 py-0.5 rounded bg-background border text-[10px]">
                {f.code} × {f.count}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
        {entries.length === 0 && <p className="text-xs text-muted-foreground text-center py-6">No errors logged.</p>}
        {entries.map((e) => {
          const open = openId === e.id;
          return (
            <div key={e.id} className="rounded-lg border overflow-hidden">
              <button
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40"
                onClick={() => setOpenId(open ? null : e.id)}
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{e.title}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {e.code} · {e.category} · {e.severity}
                  </p>
                </div>
                {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
              </button>
              {open && (
                <pre className="px-3 pb-3 text-[10px] whitespace-pre-wrap break-all text-muted-foreground bg-muted/10">
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
