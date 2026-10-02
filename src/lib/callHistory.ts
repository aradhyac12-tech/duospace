import { supabase } from "@/integrations/supabase/appClient";
import { logWarn } from "@/lib/telemetry";

/**
 * Marks call_history.connected_at the instant a call actually connects
 * (remote audio confirmed playing — the same moment reportCallNowConnected()
 * already fires for native CallKit/Telecom; call this alongside it, never
 * instead of it).
 *
 * WHY THIS EXISTS: see supabase/migrations/
 * 20260927120000_expire_abandoned_connected_calls.sql's incident writeup.
 * In short — a call that was claimed (answered) but then never actually
 * connected (app killed/backgrounded/crashed/permanently offline between
 * claim and connect) used to stay call_history.status='in_progress'
 * forever: every finalization path for that window lives on the client,
 * and expire_stale_calls()'s existing sweep deliberately leaves claimed
 * rows alone (a real long call must not be swept). Without a server-side
 * marker for "this row really did connect", the sweep has no way to tell a
 * legitimately hours-long call apart from one stuck on "Calling…" for
 * hours because its client died. This is that marker; the sweep uses it,
 * not the client, to decide.
 *
 * Best-effort by design, like every other post-connect side channel in this
 * codebase (reportCallNowConnected included): a failure here must never
 * block or fail the call itself, which is already connected by the time
 * this runs. Idempotent server-side (WHERE connected_at IS NULL), so a
 * duplicate call from a retried code path is harmless.
 */
export async function markCallConnected(callId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("mark_call_connected" as never, { _call_id: callId } as never);
    if (error) logWarn("call.history.mark_connected_failed", String(error));
  } catch (err) {
    logWarn("call.history.mark_connected_exception", String(err));
  }
}
