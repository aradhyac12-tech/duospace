/** Shared helpers for the Reflection page and its extracted tabs. */
import { tr } from "@/lib/i18n";
import { Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { describeProvenance } from "@/lib/ai/provenance";
import type { AIInsight } from "@/lib/ai/types";
import { RelationshipError, type SharePreview } from "@/lib/relationship";

export function friendlyError(err: unknown): string {
  if (err instanceof RelationshipError) return err.message;
  return tr("p1.rel.err.generic");
}

export const EvidenceLine = ({ insight }: { insight: AIInsight }) => {
  const prov = describeProvenance(insight.source);
  return <p className="text-[10px] text-muted-foreground/70 italic">{prov.label}</p>;
};

/** The "show exactly what will be shared" confirmation dialog — used by all three item types. */
export const SharePreviewDialog = ({
  preview, onCancel, onConfirm, sharing,
}: { preview: SharePreview | null; onCancel: () => void; onConfirm: () => void; sharing: boolean }) => (
  <Dialog open={!!preview} onOpenChange={(o) => !o && onCancel()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{tr("p1.rel.shareDlg.title")}</DialogTitle>
        <DialogDescription>{tr("p1.rel.shareDlg.body")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2 py-2">
        {preview?.lines.map((l) => (
          <div key={l.label} className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l.label}</p>
            <p className="text-sm text-foreground">{l.value}</p>
          </div>
        ))}
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onCancel} disabled={sharing}>{tr("p1.rel.cancel")}</Button>
        <Button onClick={onConfirm} disabled={sharing}>
          {sharing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Share2 className="h-4 w-4 mr-2" />}
          {tr("p1.rel.shareThis")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

