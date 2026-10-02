import { useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { useFinishUnlink } from "@/hooks/useUnlinkRequests";
import { useScheduledUnlink } from "@/hooks/useScheduledUnlink";

/**
 * App-wide half of the delayed unlink (mounted once in AppLayout beside
 * UnlinkRequestHost). It has no UI of its own: mounting it is what makes a due
 * schedule complete on time (the hook asks the server to finish anything due on
 * open / foreground), and what wraps up THIS device when a schedule finishes —
 * including one that finished while the app was closed.
 */
const ScheduledUnlinkHost = () => {
  const { toast } = useToast();
  const finishUnlink = useFinishUnlink();

  const onExecuted = useCallback(() => {
    toast({ title: "Unlinked", description: "The scheduled unlink has taken effect — you're no longer linked." });
    finishUnlink();
  }, [toast, finishUnlink]);

  useScheduledUnlink({ scope: "host", onExecuted });
  return null;
};

export default ScheduledUnlinkHost;
