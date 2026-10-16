-- ============================================================================
-- Calling engine reliability pass (follow-up to 20260808150000_call_hardening.sql)
-- Item 14 (database/Supabase audit): "Ensure call expiration is server-safe."
--
-- GAP FOUND: claim_call() already refuses to hand a claim to anyone once
-- call_history.expires_at has passed (the 40s ring window set by
-- set_call_expiry()) — a genuinely dead call can never be answered late.
-- But nothing ever flips that row's `status` itself to 'missed' once it
-- expires unclaimed. The client's own 30s auto-decline timer
-- (IncomingCallOverlay.tsx) normally calls decline_call() first and closes
-- it out — but that only runs if the receiving app is actually alive and
-- foregrounded to run the timer. If the app is killed, backgrounded past
-- the OS's JS-timer throttling, or the notification is swiped away without
-- ever tapping Decline, no client is left to make that call, and the row
-- sits at status='in_progress' forever — a "ringing" call_history entry
-- that never resolves, and (per src/contexts/CallContext.tsx's own
-- "left for the ring-expiry sweep to close out later" comments, plural,
-- which assume this already exists) a row a stale-claim-loss path can also
-- leave behind. This migration is that sweep, closing the gap those
-- comments assumed was already covered.
--
-- Same atomic-CAS shape as decline_call() (20260808150000_call_hardening.sql)
-- so it can't race a claim that lands in the same instant: the UPDATE's own
-- WHERE clause is the guard, not a prior SELECT.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.expire_stale_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.call_history
  SET status = 'missed', ended_at = now()
  WHERE status = 'in_progress'
    AND claimed_by IS NULL
    AND expires_at IS NOT NULL
    AND expires_at <= now();
END;
$$;
REVOKE ALL ON FUNCTION public.expire_stale_calls() FROM public;
-- service_role only (pg_cron below) — this is a maintenance sweep, not a
-- client-callable RPC; no authenticated GRANT, unlike claim_call/decline_call.
GRANT EXECUTE ON FUNCTION public.expire_stale_calls() TO service_role;

-- Best-effort schedule, same guarded pattern as
-- 20260501205802_...'s delete-expired-messages sweep — if pg_cron isn't
-- installed in a given environment this silently no-ops rather than
-- failing the migration; expires_at-guarded reads elsewhere (claim_call)
-- remain correct either way, this only affects how promptly the row's
-- *status* itself catches up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'expire-stale-calls';

    PERFORM cron.schedule(
      'expire-stale-calls',
      '* * * * *',
      $cron$SELECT public.expire_stale_calls();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; skipping expire-stale-calls schedule.';
END $$;
