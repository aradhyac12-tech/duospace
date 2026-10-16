/** Reflection "Insights" list: rate / share / withdraw saved insights. Extracted from pages/Reflection.tsx. */
import { tr } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { Check, Share2, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { hapticNotification } from "@/lib/haptics";
import type { AIInsight } from "@/lib/ai/types";
import {
  correctInsight, previewInsight, withHash, confirmShare, revokeShare, buildProductionRelationshipDeps,
  type ShareRow, type SharePreview,
} from "@/lib/relationship";
import { EvidenceLine, SharePreviewDialog, friendlyError } from "./reflectionShared";

export default function InsightsTab({ userId, storeCtx, insights, sharedByMe, partnerId, onChanged, onSharesChanged, toast }: any) {
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [sharing, setSharing] = useState(false);
  const [correcting, setCorrecting] = useState<AIInsight | null>(null);

  const deps = useMemo(() => buildProductionRelationshipDeps(), []);

  const openShare = (insight: AIInsight) => withHash(previewInsight(insight)).then(setPreview);
  const confirm = async (insight: AIInsight) => {
    if (!preview) return;
    setSharing(true);
    try {
      await confirmShare(userId, preview, { gate: deps.gate, store: storeCtx });
      hapticNotification();
      toast({ title: tr("p1.rel.shared") });
      setPreview(null);
      await onSharesChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.share"), description: friendlyError(err), variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const doCorrect = async (verdict: "CORRECT" | "PARTLY_ACCURATE" | "NOT_ACCURATE" | "NOT_RELEVANT") => {
    if (!correcting) return;
    try {
      await correctInsight(userId, { insightId: correcting.id, verdict }, { backend: deps.backend, now: deps.now });
      setCorrecting(null);
      await onChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.feedback"), description: friendlyError(err), variant: "destructive" });
    }
  };

  const revoke = async (shareId: string) => {
    try {
      await revokeShare(userId, shareId, { store: storeCtx });
      toast({ title: tr("p1.rel.sharingStopped") });
      await onSharesChanged();
    } catch (err) {
      toast({ title: tr("p1.rel.err.withdraw"), description: friendlyError(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {insights.length === 0 && (
        <p className="text-[12px] text-muted-foreground text-center py-6">
          {tr("p1.rel.insights.empty")}
        </p>
      )}
      {insights.map((insight: AIInsight) => (
        <div key={insight.id} className="rounded-2xl bg-card border border-border/60 p-4 space-y-2">
          <EvidenceLine insight={insight} />
          <p className="text-sm text-foreground leading-relaxed">{insight.observation}</p>
          {insight.possibleExplanations.length > 0 && (
            <ul className="space-y-1">
              {insight.possibleExplanations.map((e, idx) => (
                <li key={idx} className="text-[12px] text-muted-foreground flex gap-1.5"><ArrowRight className="h-3 w-3 mt-0.5 shrink-0" />{e}</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground/80 italic">{insight.uncertainty}</p>
          {insight.suggestedAction && <p className="text-[12px] text-foreground/80">{insight.suggestedAction}</p>}
          {insight.evidence && insight.evidence.length > 0 && (
            <p className="text-[10px] text-muted-foreground/60">Based on: {insight.evidence.join("; ")}</p>
          )}
          {insight.correction && (
            <p className="text-[10px] text-accent flex items-center gap-1"><Check className="h-3 w-3" /> You marked this {insight.correction.verdict.toLowerCase().replace("_", " ")}</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button onClick={() => setCorrecting(insight)} className="text-[11px] text-muted-foreground">{tr("p1.rel.rate")}</button>
            {partnerId && (
              <button onClick={() => openShare(insight)} className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                <Share2 className="h-3.5 w-3.5" /> {tr("p1.rel.share")}
              </button>
            )}
          </div>
        </div>
      ))}

      {sharedByMe.filter((s: ShareRow) => !s.revokedAt).length > 0 && (
        <div className="pt-2 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {tr("p1.rel.sharedWithPartner")}</p>
          {sharedByMe.filter((s: ShareRow) => !s.revokedAt).map((s: ShareRow) => (
            <div key={s.id} className="rounded-xl bg-muted/30 border border-border/40 px-3.5 py-2.5 flex items-center justify-between gap-2">
              <span className="text-[12px] text-foreground">{s.kind === "INSIGHT" ? "An insight" : s.kind === "EXPECTATION" ? "An expectation" : "A values answer"}</span>
              <button onClick={() => revoke(s.id)} className="text-[11px] text-destructive shrink-0">{tr("p1.rel.withdraw")}</button>
            </div>
          ))}
        </div>
      )}

      <SharePreviewDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={() => confirm(preview as any)} sharing={sharing} />

      <Dialog open={!!correcting} onOpenChange={(o) => !o && setCorrecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("p1.rel.acc.title")}</DialogTitle>
            <DialogDescription>{tr("p1.rel.acc.body")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            <Button variant="outline" onClick={() => doCorrect("CORRECT")}>{tr("p1.rel.acc.correct")}</Button>
            <Button variant="outline" onClick={() => doCorrect("PARTLY_ACCURATE")}>{tr("p1.rel.acc.partly")}</Button>
            <Button variant="outline" onClick={() => doCorrect("NOT_ACCURATE")}>{tr("p1.rel.acc.not")}</Button>
            <Button variant="outline" onClick={() => doCorrect("NOT_RELEVANT")}>{tr("p1.rel.notRelevant")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
