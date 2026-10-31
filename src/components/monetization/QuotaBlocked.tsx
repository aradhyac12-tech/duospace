import { useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AiQuotaResult } from "@/hooks/useAiQuota";

/** Shown when the server refuses an AI action. Never used for safety content. */
export default function QuotaBlocked({ quota, onNavigate }: { quota: AiQuotaResult; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const resets = quota.reset_at ? new Date(quota.reset_at) : null;
  const when = resets ? resets.toLocaleString(undefined, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }) : null;
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2" role="status">
      <div className="flex items-center gap-2">
        <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">
          {quota.reason === "not_in_plan" ? "Not included in your plan" : "You've used today's AI helper actions"}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {when && quota.reason !== "not_in_plan" ? `They reset on ${when}. ` : ""}
        Plus and Pro include more.
      </p>
      <Button size="sm" className="w-full" onClick={() => { onNavigate?.(); navigate("/settings/plus"); }}>
        See plans
      </Button>
    </div>
  );
}
