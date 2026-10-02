import { Lock } from "lucide-react";
import type { PlanLevel } from "@/lib/monetization/config";

export default function LockedBadge({ level = "PLUS" }: { level?: PlanLevel }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-background/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-foreground/80">
      <Lock className="h-2.5 w-2.5" aria-hidden="true" />
      {level === "PRO" ? "Pro" : "Plus"}
    </span>
  );
}
