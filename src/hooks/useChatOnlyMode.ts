import { useId } from "react";
import { useSharingState } from "@/hooks/useSharingState";
import { useScheduledUnlink } from "@/hooks/useScheduledUnlink";

/**
 * Chat-only mode: true from the moment either person presses "Stop sharing"
 * (which also starts the irreversible 14-day unlink) until the unlink runs.
 *
 * While true: calls are off, the stopper's photos are hidden from the other
 * person, and /urgent + /important are disabled. Text chat keeps working.
 *
 * The DATABASE is the enforcer (call_history insert trigger, message-flag
 * trigger, gallery/storage RLS). This hook only lets the UI say so up front
 * instead of failing after a tap. A partner's stopped state is private to
 * them, but their scheduled unlink is visible to both sides (`theirs`), which
 * is what flips this on for the person who didn't press the button.
 */
export function useChatOnlyMode(): boolean {
  const { stopped } = useSharingState();
  // Unique per hook instance: Chat and Calls both mount this at once, and a
  // shared realtime topic would make the second .on() hit an already
  // subscribed channel.
  const instanceId = useId();
  const { mine, theirs } = useScheduledUnlink({ scope: `chat-only-${instanceId}` });
  return stopped || !!mine || !!theirs;
}
