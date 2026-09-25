import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useUnlinkRequests, useFinishUnlink } from "@/hooks/useUnlinkRequests";
import { consumeUnlinkNotice, describeUnlinkError, type UnlinkRequest } from "@/lib/partnerUnlink";
import { hapticHeavy, hapticMedium } from "@/lib/haptics";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

/**
 * App-wide half of the two-sided unlink flow (mounted once in AppLayout, so it
 * works on whatever screen the person happens to be on when the ask arrives):
 *
 *  - RECEIVER: shows the "Allow / Keep us linked" dialog when the partner asks
 *    to unlink. Nothing changes on the receiver's account until they tap Allow.
 *    Closing the dialog (X / tap outside) means "decide later" — the ask stays
 *    open and is also listed on the Partner screen.
 *  - REQUESTER: toasts the answer. When the partner approved, wraps up locally
 *    (clear cached partner + reload); when they declined, says so plainly.
 *
 * The dialog closes itself on every successful answer — including a failed
 * answer that turns out to be stale (expired/already handled), so it can't get
 * stuck on screen showing a request that no longer exists.
 */
const UnlinkRequestHost = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const finishUnlink = useFinishUnlink();

  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"allow" | "keep" | null>(null);
  const [requesterName, setRequesterName] = useState("Your partner");

  // The reload that follows an unlink wipes any toast, so it leaves a note.
  useEffect(() => {
    if (consumeUnlinkNotice()) {
      toast({ title: "Unlinked", description: "You and your partner are no longer linked." });
    }
  }, [toast]);

  const onOutgoingResolved = useCallback((req: UnlinkRequest) => {
    if (req.status === "approved") {
      toast({ title: "Unlinked", description: "Your partner approved — you're no longer linked." });
      finishUnlink();
    } else if (req.status === "declined") {
      toast({
        title: "Unlink request declined",
        description: "Your partner wants to stay linked, so nothing has changed.",
      });
    }
  }, [toast, finishUnlink]);

  const { incoming, respond } = useUnlinkRequests({ scope: "host", onOutgoingResolved });

  // Oldest open ask that hasn't been put off this session.
  const current = incoming
    .filter((r) => !dismissed.has(r.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] ?? null;

  // Who is asking — for the dialog copy. Falls back to "Your partner".
  useEffect(() => {
    if (!current || !user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", current.requester_id)
        .maybeSingle();
      if (!cancelled && data?.display_name) setRequesterName(data.display_name);
    })();
    return () => { cancelled = true; };
  }, [current?.id, current?.requester_id, user]);

  const answer = async (approve: boolean) => {
    if (!current || busy) return;
    setBusy(approve ? "allow" : "keep");
    if (approve) hapticHeavy(); else hapticMedium();
    const res = await respond(current.id, approve);
    setBusy(null);

    if (res.error === "NETWORK") {
      // Transport failure: leave the dialog up so they can simply tap again.
      toast({
        title: "Couldn't send your answer",
        description: "Check your connection and try again.",
        variant: "destructive",
      });
      return;
    }

    // From here on the request is settled one way or another, so the dialog
    // must go: hide it for this session in every branch.
    setDismissed((prev) => new Set(prev).add(current.id));

    if (res.error) {
      toast({ title: "Couldn't complete that", description: describeUnlinkError(res.error), variant: "destructive" });
      return;
    }
    if (res.status === "approved") {
      finishUnlink();
      return;
    }
    toast({ title: "Kept linked", description: `${requesterName} has been told you'd rather stay linked.` });
  };

  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        // X / tap-outside / Esc = "decide later". Not while an answer is in flight.
        if (!open && current && !busy) setDismissed((prev) => new Set(prev).add(current.id));
      }}
    >
      <DialogContent
        className="rounded-2xl max-w-[360px]"
        onInteractOutside={(e) => { if (busy) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4.5 w-4.5 text-destructive shrink-0" />
            <DialogTitle className="text-base">{requesterName} wants to unlink</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Approve or decline the request to unlink your accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-sm text-foreground leading-relaxed">
            {requesterName} asked to end your link. It only happens if you allow it — until then you're still linked and nothing has changed.
          </p>
          <dl className="space-y-2 rounded-xl bg-muted/40 p-3">
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">If you allow</dt>
              <dd className="text-foreground/90">You'll both be unlinked right away.</dd>
            </div>
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">Data affected</dt>
              <dd className="text-foreground/90">Chat history, photos, and shared content are kept on both accounts — only the active link is removed.</dd>
            </div>
            <div className="flex gap-2 text-[11px]">
              <dt className="w-24 shrink-0 font-medium text-muted-foreground">Reversible</dt>
              <dd className="text-foreground/90">Yes — reconnect anytime with a new invite or request.</dd>
            </div>
          </dl>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-xl"
            disabled={!!busy}
            onClick={() => answer(false)}
          >
            {busy === "keep" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Keep us linked"}
          </Button>
          <Button
            className="flex-1 rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!!busy}
            onClick={() => answer(true)}
          >
            {busy === "allow" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Allow unlink"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default UnlinkRequestHost;
