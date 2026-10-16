import { useEffect } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { UpdateBody } from "./UpdateBody";

const PROMPT_PHASES = new Set([
  "available",
  "confirm_cellular",
  "downloading",
  "waiting_wifi",
  "ready",
  "installing",
  "needs_permission",
  "handoff",
  "error",
]);

/**
 * Global "update available" notification for admin-published releases.
 * Optional updates show as a bottom sheet ("Later" hides it for 24 h; a
 * download keeps running with the system progress notification, and the sheet
 * returns when the file is ready to install). Mandatory updates block the app
 * with a full-screen overlay until installed; an admin lifts that at any time
 * by unpublishing the release.
 */
const UpdatePrompt = () => {
  const u = useAppUpdate();
  const { phase, undismiss } = u;

  // Bring the prompt back when the user's attention is needed again.
  useEffect(() => {
    if (phase === "ready" || phase === "needs_permission") undismiss();
  }, [phase, undismiss]);

  const r = u.release;
  if (!u.supported || !r || !PROMPT_PHASES.has(phase)) return null;

  if (r.mandatory) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Required update"
        className="fixed inset-0 z-[1250] flex items-end bg-background/95 backdrop-blur-sm"
      >
        <div className="glass-sheet w-full safe-bottom p-6">
          <UpdateBody />
        </div>
      </div>
    );
  }

  return (
    <Sheet
      open={!u.dismissed}
      onOpenChange={(open) => {
        if (!open) void u.dismiss();
      }}
    >
      <SheetContent side="bottom" className="rounded-t-3xl">
        <SheetTitle className="sr-only">App update</SheetTitle>
        <SheetDescription className="sr-only">A new version of DuoSpace is available.</SheetDescription>
        <UpdateBody onLater={() => void u.dismiss()} />
      </SheetContent>
    </Sheet>
  );
};

export default UpdatePrompt;
