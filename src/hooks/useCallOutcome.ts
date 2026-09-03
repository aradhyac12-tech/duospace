import { useCallback, useEffect, useId, useRef, useState } from "react";
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

  // BUG FIX (DS-UNKNOWN-001, "cannot add postgres_changes callbacks ...
  // after subscribe()"): currentCallId comes from CallContext's
  // activeCallId, which is shared app-wide — but this hook is called
  // independently from both Chat.tsx and Calls.tsx, and neither page
  // unmounts while the other is active (tab-based nav). During a call
  // that means TWO hook instances both build the topic
  // `call-outcome-${currentCallId}` from the same id. supabase-js's
  // realtime client keys channels by topic string and returns the
  // existing channel object if one with that topic is already
  // registered, rather than creating a second one — so the instance that
  // runs second calls `.on()` on a channel the first instance already
  // called `.subscribe()` on, which throws exactly this error and takes
  // down the page's ErrorBoundary. Suffixing the topic with a per-mount
  // instance id (useId(), stable for the life of this component instance)
  // gives each hook instance its own channel object while every instance
  // still filters on the same `id=eq.${currentCallId}` row, so both pages
  // keep getting the same updates.
  const instanceId = useId();

  useEffect(() => {
    if (!currentCallId) return;
    const channel = supabase
      .channel(`call-outcome-${currentCallId}-${instanceId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "call_history",
        filter: `id=eq.${currentCallId}`,
      }, (payload) => {
        if (everConnectedRef.current) return; // normal end-of-call path owns this once connected
        // DECLINED vs NO-ANSWER (honest distinction): both land as status
        // 'missed', but an explicit receiver decline also stamps
        // declined_at (migration 20260824_call_declined_marker.sql). When
        // the column isn't present on the row yet — pre-migration rows, or
        // the migration not yet applied to the live project — we fall back
        // to "no-answer", which was the previous (and still truthful)
        // message. We never claim a decline we can't confirm.
        const row = payload.new as { status?: string; declined_at?: string | null };
        if (row.status === "missed") {
          setOutcome(row.declined_at ? { type: "declined" } : { type: "no-answer" });
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
  // Local no-answer safety net: the server expires rings after ~30s and
  // normally delivers the 'missed' status over realtime, but if that event
  // is lost (dropped websocket, backgrounded socket) the caller must still
  // get the honest "didn't answer" terminal screen instead of ringing
  // forever. This lets the caller's own safety timer produce exactly that
  // outcome without pretending to know a decline happened.
  const reportNoAnswer = useCallback(() => setOutcome({ type: "no-answer" }), []);
  const dismissOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, dismissOutcome, reportFailure, reportNoAnswer };
}
