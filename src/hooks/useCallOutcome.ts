import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { CallOutcome } from "@/lib/callUiState";

interface UseCallOutcomeArgs {
  /** The call_history row id for this device's current outgoing call, or
   *  null when there isn't one. */
  currentCallId: string | null;
  /** Whether this call session has ever had a second participant join.
   *  Once true, a status change is the normal end-of-call path (handled
   *  by the existing endCall()/participant-left flow) — this hook only
   *  cares about the pre-connect window. */
  everConnected: boolean;
  /** Called when a remote-driven outcome is detected, so the caller can
   *  run its own existing leaveCall()/cleanup. This hook never calls
   *  leaveCall() itself. */
  onRemoteEnded: () => void;
}

/**
 * CONFIRMED BUG (found while building the Phase 4 explicit-state call UI,
 * not a pre-existing TODO): the caller side had no realtime listener on
 * its own outgoing call_history row. When the receiver declined, let the
 * 30s ring timer lapse, or the row was cancelled from another
 * signed-in session, the caller's screen just kept showing "Ringing…"
 * indefinitely — no feedback that anything had happened on the other end,
 * with no way out but a manual hang-up. Every other terminal-state
 * requirement in this pass (declined/missed/cancelled) depends on the
 * caller actually finding out, so this is the minimum fix needed to
 * render those states at all.
 *
 * Scope, deliberately narrow: this hook only *reads* call_history via
 * Realtime and calls the existing `leaveCall()` through the caller's own
 * `onRemoteEnded`. It does not add, change, or call any Supabase RPC, and
 * it does not touch Daily.co lifecycle, push/VoIP, CallKit, or FCM code —
 * decline_call/cancel_call/claim_call and their triggers are unmodified.
 */
export function useCallOutcome({ currentCallId, everConnected, onRemoteEnded }: UseCallOutcomeArgs) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const everConnectedRef = useRef(everConnected);
  useEffect(() => { everConnectedRef.current = everConnected; }, [everConnected]);
  const onRemoteEndedRef = useRef(onRemoteEnded);
  useEffect(() => { onRemoteEndedRef.current = onRemoteEnded; }, [onRemoteEnded]);

  useEffect(() => {
    if (!currentCallId) return;
    const channel = supabase
      .channel(`call-outcome-${currentCallId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "call_history",
        filter: `id=eq.${currentCallId}`,
      }, (payload) => {
        if (everConnectedRef.current) return; // normal end-of-call path owns this once connected
        const row = payload.new as { status?: string };
        if (row.status === "missed") {
          setOutcome({ type: "no-answer" });
          onRemoteEndedRef.current();
        } else if (row.status === "cancelled") {
          setOutcome({ type: "cancelled-elsewhere" });
          onRemoteEndedRef.current();
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentCallId]);

  const reportFailure = useCallback((message: string) => setOutcome({ type: "failed", message }), []);
  const dismissOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, dismissOutcome, reportFailure };
}
