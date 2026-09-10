import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";
import { hapticHeavy } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Every security-relevant action in Settings routes through this dialog
 * instead of rolling its own confirm prompt. It always surfaces the four
 * things the redesign spec requires before anything happens:
 *   - what will happen
 *   - what data is affected
 *   - whether it's reversible
 *   - whether authentication is required
 *
 * `onConfirm` may be async — the dialog stays open, shows a spinner, and
 * disables both buttons while it runs, so a slow network can't be
 * double-tapped into firing twice. Closing (via Cancel, backdrop, or Esc)
 * is blocked while pending, since backing out mid-request would leave the
 * user unsure whether the action went through.
 */
export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  whatHappens: string;
  dataAffected: string;
  reversible: boolean;
  reversibleNote?: string;
  authRequired: boolean;
  authNote?: string;
  destructive?: boolean;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

const ConfirmActionDialog = ({
  open, onOpenChange, title, whatHappens, dataAffected, reversible, reversibleNote,
  authRequired, authNote, destructive = true, confirmLabel, onConfirm,
}: ConfirmActionDialogProps) => {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    if (pending) return; // guards against duplicate taps while the request is in flight
    setPending(true);
    hapticHeavy();
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (pending) return; onOpenChange(v); }}>
      <DialogContent
        className="rounded-2xl max-w-[360px]"
        onInteractOutside={(e) => { if (pending) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (pending) e.preventDefault(); }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            {destructive
              ? <AlertTriangle className="h-4.5 w-4.5 text-destructive shrink-0" />
              : <ShieldCheck className="h-4.5 w-4.5 text-primary shrink-0" />}
            <DialogTitle className="text-base">{title}</DialogTitle>
          </div>
          <DialogDescription className="sr-only">{whatHappens}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-sm text-foreground leading-relaxed">{whatHappens}</p>

          <dl className="space-y-2 rounded-xl bg-muted/40 p-3">
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">Data affected</dt>
              <dd className="text-foreground/90">{dataAffected}</dd>
            </div>
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">Reversible</dt>
              <dd className={cn(reversible ? "text-foreground/90" : "text-destructive font-medium")}>
                {reversible ? "Yes" : "No"}{reversibleNote ? ` — ${reversibleNote}` : ""}
              </dd>
            </div>
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">Authentication</dt>
              <dd className="text-foreground/90">
                {authRequired ? (authNote || "Required") : "Not required"}
              </dd>
            </div>
          </dl>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-xl"
            disabled={pending}
            onClick={() => { onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            className={cn(
              "flex-1 rounded-xl",
              destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
            disabled={pending}
            onClick={handleConfirm}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : (confirmLabel || title)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ConfirmActionDialog;
