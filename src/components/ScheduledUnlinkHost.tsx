import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/appClient";
import { useFinishUnlink } from "@/hooks/useUnlinkRequests";
import { useScheduledUnlink } from "@/hooks/useScheduledUnlink";
import { useSharingState } from "@/hooks/useSharingState";
import { describeCountdown, describeScheduleError, formatExecuteDate, SCHEDULED_UNLINK_DAYS } from "@/lib/scheduledUnlink";
import { requireOnline } from "@/lib/offlineGuard";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";

const SEEN_KEY = "duo-seen-unlink-notices";
const hasSeen = (id: string) => {
  try { return (JSON.parse(localStorage.getItem(SEEN_KEY) || "[]") as string[]).includes(id); } catch { return false; }
};
const markSeen = (id: string) => {
  try {
    const l: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    if (!l.includes(id)) l.push(id);
    localStorage.setItem(SEEN_KEY, JSON.stringify(l.slice(-20)));
  } catch { /* storage unavailable: dialog may show again, harmless */ }
};

/**
 * App-wide half of the delayed unlink (mounted once in AppLayout).
 *
 *  - Completes a due schedule on time and wraps up THIS device when it finishes.
 *  - When the PARTNER has stopped sharing (which also starts the 14-day unlink),
 *    shows this person ONE prompt with exactly two choices:
 *      "Okay"          -> just acknowledge; nothing changes for me.
 *      "Stop sharing"  -> the single "stop sharing + start unlink" action
 *                         (same RPC as everywhere else, behind re-auth).
 */
const ScheduledUnlinkHost = () => {
  const { toast } = useToast();
  const { user } = useAuth();
  const finishUnlink = useFinishUnlink();
  const { stopSharing } = useSharingState();

  const onExecuted = useCallback(() => {
    toast({ title: "Unlinked", description: "The scheduled unlink has taken effect — you're no longer linked." });
    finishUnlink();
  }, [toast, finishUnlink]);

  const { mine, theirs } = useScheduledUnlink({ scope: "host", onExecuted });

  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [partnerName, setPartnerName] = useState("Your partner");

  useEffect(() => {
    if (!theirs || !user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("profiles").select("display_name").eq("user_id", theirs.requester_id).maybeSingle();
      if (!cancelled && data?.display_name) setPartnerName(data.display_name);
    })();
    return () => { cancelled = true; };
  }, [theirs?.id, theirs?.requester_id, user]);

  // Only when I haven't already stopped sharing myself.
  const showNotice = !!theirs && !mine && dismissedId !== theirs.id && !hasSeen(theirs.id);

  const okay = () => { if (theirs) { markSeen(theirs.id); setDismissedId(theirs.id); } };

  const stopMine = async (): Promise<boolean> => {
    if (!requireOnline("Stopping sharing")) return false;
    const res = await stopSharing();
    if (res.error) {
      toast({
        title: "Couldn't stop sharing",
        description: res.error === "NETWORK" ? "Check your connection and try again." : describeScheduleError(res.error),
        variant: "destructive",
      });
      return false;
    }
    if (theirs) markSeen(theirs.id);
    const unlink = (res as any).unlink as { status?: string } | undefined;
    if (unlink?.status === "executed") { finishUnlink(); return true; }
    toast({ title: "Sharing stopped", description: "You stopped sharing. The unlink is already counting down." });
    return true;
  };

  return (
    <>
      <Dialog open={showNotice && !confirmOpen} onOpenChange={(o) => { if (!o) okay(); }}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              <DialogTitle className="text-base">{partnerName} stopped sharing</DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              Your partner stopped sharing and started the unlink.
            </DialogDescription>
          </DialogHeader>
          {theirs && (
            <p className="text-sm text-foreground leading-relaxed">
              {partnerName} stopped sharing and started unlinking. You'll be unlinked {describeCountdown(theirs.execute_at)} (on {formatExecuteDate(theirs.execute_at)}). It doesn't need your approval and can't be cancelled.
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={okay}>Okay</Button>
            <Button
              className="flex-1 rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setConfirmOpen(true)}
            >
              Stop sharing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Stop sharing?"
        whatHappens={`Right away, ${partnerName} stops receiving your live location and device status, and your shared reflections are withdrawn. The unlink is already counting down, so this doesn't add any waiting.`}
        approvalNote="No approval needed."
        dataAffected="Your location and battery status disappear from their Map. Chat history stays on both accounts; only the active link ends."
        reversible={false}
        reversibleNote={`this cannot be undone. The ${SCHEDULED_UNLINK_DAYS}-day unlink is one process, started by ${partnerName}.`}
        authRequired={true}
        authNote="Required: confirm your password (or an emailed code) first"
        confirmLabel="Stop sharing"
        onConfirm={stopMine}
      />
    </>
  );
};

export default ScheduledUnlinkHost;
