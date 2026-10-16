-- ============================================================================
-- Stop sharing == start the 14-day unlink. Irreversible.
-- ============================================================================
-- Product decision (Aradhya, 2026-10-03): "Stop sharing" is no longer a
-- reversible privacy toggle. Pressing it (a) stops everything I share with my
-- partner immediately (unchanged) AND (b) starts the 14-day scheduled unlink
-- from 20261002120000_scheduled_unilateral_unlink.sql. Once started it cannot
-- be cancelled by anyone, and sharing cannot be resumed while the countdown
-- is running. After the unlink executes the pairing is over, and the person
-- can resume sharing (for a future partner) because there is no one left to
-- resume it with.
--
-- Changes:
--   * stop_sharing()            also calls schedule_unlink() when linked.
--   * cancel_scheduled_unlink() now always refuses (IRREVERSIBLE).
--   * resume_sharing()          refuses while the caller's countdown is live.
--   * scheduled_unlinks_guard() forbids status -> 'cancelled' for good, so a
--                               future grant/policy mistake can't reopen it.
-- Unchanged: the consent-based request_unlink / respond_unlink flow (both
-- agree -> immediate unlink) still works and still voids any countdown.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stop_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_stopped timestamptz;
  v_unlink  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  -- Flip the switch FIRST so no concurrent write can land after the cleanup.
  INSERT INTO public.sharing_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT stopped_at INTO v_stopped FROM public.sharing_state WHERE user_id = v_uid;

  DELETE FROM public.locations WHERE user_id = v_uid;

  UPDATE public.profiles
     SET battery_level = NULL,
         battery_charging = NULL,
         ringer_mode = NULL,
         device_status_updated_at = NULL
   WHERE user_id = v_uid;

  UPDATE public.relationship_shares
     SET revoked_at = now()
   WHERE owner_id = v_uid AND revoked_at IS NULL;

  -- Start the 14-day unlink (idempotent; keeps the original date if already
  -- counting down; executes immediately for a one-sided pairing; NOT_LINKED
  -- when solo, in which case there is simply nothing to unlink).
  v_unlink := public.schedule_unlink();

  RETURN jsonb_build_object(
    'status', 'stopped',
    'stopped_at', v_stopped,
    'unlink', v_unlink
  );
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_sharing() TO authenticated;

-- Nobody can cancel a scheduled unlink: not the requester, not the partner.
CREATE OR REPLACE FUNCTION public.cancel_scheduled_unlink(p_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('error', 'IRREVERSIBLE');
$$;
REVOKE ALL ON FUNCTION public.cancel_scheduled_unlink(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_scheduled_unlink(uuid) TO authenticated;

-- Resume is blocked while my own countdown is live. Once the unlink has run
-- (row is 'executed'/'void') there is no pairing left, so resuming is allowed.
CREATE OR REPLACE FUNCTION public.resume_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;
  IF EXISTS (SELECT 1 FROM public.scheduled_unlinks
              WHERE requester_id = v_uid AND status = 'scheduled') THEN
    RETURN jsonb_build_object('error', 'IRREVERSIBLE');
  END IF;
  DELETE FROM public.sharing_state WHERE user_id = v_uid;
  RETURN jsonb_build_object('status', 'sharing');
END;
$$;
REVOKE ALL ON FUNCTION public.resume_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resume_sharing() TO authenticated;

-- Defence in depth: 'cancelled' is no longer a reachable state.
CREATE OR REPLACE FUNCTION public.scheduled_unlinks_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.execute_at IS DISTINCT FROM OLD.execute_at THEN
    RAISE EXCEPTION 'scheduled_unlinks: identity and dates are immutable';
  END IF;
  IF OLD.status <> 'scheduled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'scheduled_unlinks: a finished schedule cannot be reopened';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'scheduled_unlinks: an unlink cannot be cancelled';
  END IF;
  RETURN NEW;
END;
$$;
