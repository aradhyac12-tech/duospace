/**
 * Phase 3M Stage 3 — qualitative compatibility overview (16 dimensions).
 * States only: no score, no percentage, no ranking, no colour-coded verdict.
 * The explanation is optional cloud AI; it can only word the deterministic result.
 */
import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CLOUD_AI_DISCLOSURE } from "@/lib/ai/cloud/gatewayClient";
import { computeCompatibility, explainCompatibility, type CompatibilityState } from "@/lib/relationship/compatibility";
import { CATEGORY_LABEL } from "@/lib/relationship/types";
import type { DyadicComparison } from "@/lib/relationship/dyadic";

const STATE_TEXT: Record<CompatibilityState, string> = {
  ALIGNED: "Aligned",
  DIFFERENT: "Different — worth talking about",
  DISCOVERING: "Still discovering",
  INSUFFICIENT_DATA: "Not enough information yet",
};

export default function CompatibilityOverview({ comparisons }: { comparisons: DyadicComparison[] }) {
  const result = useMemo(() => computeCompatibility(comparisons), [comparisons]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (result.basis === "NONE") return null;

  const explain = async () => {
    setBusy(true); setMsg(null);
    const r = await explainCompatibility(comparisons);
    setBusy(false);
    if (r.ok) setText(r.basis === "ONE_PARTNER" ? `Based on what you've shared: ${r.headline}` : r.headline);
    else { setText(null); setMsg((r as { message: string }).message); }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Overview by area</h3>
        <p className="text-[11px] text-muted-foreground">
          {result.basis === "ONE_PARTNER" ? "Based on what you've shared so far. " : ""}No score — a difference never means incompatible.
        </p>
      </div>
      <ul className="space-y-1.5">
        {result.dimensions.map((d) => (
          <li key={d.category} className="flex justify-between gap-3 text-xs">
            <span>{CATEGORY_LABEL[d.category]}</span>
            <span className="text-muted-foreground text-right">{STATE_TEXT[d.state]}</span>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="outline" className="w-full" onClick={explain} disabled={busy}>
        <Sparkles className="h-3.5 w-3.5 mr-2" />{busy ? "Working…" : "Explain this in words"}
      </Button>
      <p className="text-[11px] text-muted-foreground">{CLOUD_AI_DISCLOSURE}</p>
      {text && <p className="text-sm rounded-xl bg-muted/40 p-3">{text}</p>}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
