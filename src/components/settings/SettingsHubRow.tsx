import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsHubRowProps {
  icon: LucideIcon;
  label: string;
  summary: string;
  onClick: () => void;
  badge?: number;
  tone?: "default" | "warning";
}

/**
 * One row on the Settings hub = one section, collapsed to its essential
 * status line. Tapping navigates to a dedicated subview (full page) or
 * opens a sheet, per the caller. This is what replaces the old
 * always-expanded SectionShell accordion — the hub itself never shows
 * form controls, only "what's true right now" + a way in.
 */
const SettingsHubRow = ({ icon: Icon, label, summary, onClick, badge, tone = "default" }: SettingsHubRowProps) => (
  <button
    onClick={() => { onClick(); }}
    className="w-full flex items-center gap-3 bg-card rounded-2xl border border-border/60 px-4 py-3.5 active:scale-[0.98] transition-transform text-left"
  >
    <span className={cn(
      "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
      tone === "warning" ? "bg-warning/15" : "bg-accent/15"
    )}>
      <Icon className={cn("h-[18px] w-[18px]", tone === "warning" ? "text-warning" : "text-accent")} aria-hidden="true" />
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="block text-[11px] text-muted-foreground truncate">{summary}</span>
    </span>
    {typeof badge === "number" && badge > 0 && (
      <span className="h-5 min-w-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
        {badge}
      </span>
    )}
    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
  </button>
);

export default SettingsHubRow;
