-- ============================================================================
-- Calling reliability follow-up to 20260910120000_expire_stale_calls_sweep.sql.
--
-- LIVE INCIDENT: a call_history row sat status='in_progress' for 1h40m+
-- (claimed_by IS NOT NULL i.e. answered, expires_at long past). The existing
-- sweep (expire_stale_calls()) only closes rows that were NEVER claimed, by
-- design — a legitimately connected call must run for hours without being
-- swept just because its 40s ring-window expires_at has passed.
--
-- THE GAP: once claim_call() succeeds, every remaining finalization path
-- (abandonClaimedCall / the accept watchdog / mid-call-drop cleanup) lives
-- on the CLIENT. If the receiving device's app is killed, backgrounded past
-- JS-timer throttling, crashes, or permanently loses network between
-- claiming and actually connecting, no client is left alive to ever close
-- the row — it stays 'in_progress' indefinitely, and nothing server-side
-- was watching for exactly this case.
--
-- THE FIX:
--   1. `connected_at` — a server-side marker set the instant a call really
--      connects (remote audio confirmed playing, mirroring
--      reportCallNowConnected()'s own trigger moment) via the new
--      mark_call_connected() RPC — see src/lib/callHistory.ts. Once set,
--      the sweep below always leaves the row alone; only client-side
--      hang-up (or the 24h absolute backstop) can end it from there.
--   2. The sweep additionally closes:
--      a) claimed_by IS NOT NULL AND connected_at IS NULL AND started_at
--         older than 5 minutes (far beyond every client-side join bound in
--         this codebase — the longest, the accept watchdog, is 60s): a real
--         attempt that never connected.
--      b) status='in_progress' AND connected_at IS NULL AND started_at
--         older than 5 minutes regardless of claimed_by — defense-in-depth
--         for any future path that reaches in_progress without claim_call.
--      c) ANY in_progress row older than 24 hours, connected or not — an
--         absolute last-resort backstop.
--
-- STATUS VALUE NOTE: this project's LIVE call_history guard is
-- enforce_call_history_update_rules() (see
-- 20260921110000_call_history_guard_session_id_reconcile.sql's own
-- writeup of this — the repo's enforce_call_history_transition() and the
-- live enforce_call_history_update_rules() are two different functions
-- that diverged; this migration was written against, and tested live
-- against, the latter). Its in_progress allow-list is
-- ('completed','missed','cancelled','seen') — 'failed' is NOT in it and
-- attempting it raises "illegal transition from in_progress to failed".
-- This sweep therefore closes abandoned rows as 'cancelled' (with
-- cancel_reason set for diagnostics — that column is explicitly
-- unguarded/descriptive, see 20260910200000's own doc comment), not
-- 'failed'.
-- ============================================================================

ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS connected_at timestamptz DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.mark_call_connected(_call_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.call_history
  SET connected_at = now()
  WHERE id = _call_id
    AND status = 'in_progress'
    AND connected_at IS NULL
    AND (caller_id = auth.uid() OR receiver_id = auth.uid());
END;
$$;
REVOKE ALL ON FUNCTION public.mark_call_connected(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_call_connected(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.expire_stale_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Original case: never claimed, ring window expired.
  UPDATE public.call_history
  SET status = 'missed', ended_at = now()
  WHERE status = 'in_progress'
    AND claimed_by IS NULL
    AND expires_at IS NOT NULL
    AND expires_at <= now();

  -- NEW: claimed (answered) but never actually connected, long past every
  -- client-side join bound — the exact shape of the live incident this
  -- migration was written for.
  UPDATE public.call_history
  SET status = 'cancelled', cancelled_at = now(), ended_at = now(),
      cancel_reason = 'server_sweep_abandoned_never_connected'
  WHERE status = 'in_progress'
    AND connected_at IS NULL
    AND started_at <= now() - interval '5 minutes';

  -- NEW: absolute backstop, connected or not.
  UPDATE public.call_history
  SET status = 'cancelled', cancelled_at = now(), ended_at = now(),
      cancel_reason = 'server_sweep_24h_backstop'
  WHERE status = 'in_progress'
    AND started_at <= now() - interval '24 hours';
END;
$$;

-- Sweep already runs every minute via pg_cron (see
-- 20260910120000_expire_stale_calls_sweep.sql) — CREATE OR REPLACE above
-- picks the new body up automatically, no re-scheduling needed here.
