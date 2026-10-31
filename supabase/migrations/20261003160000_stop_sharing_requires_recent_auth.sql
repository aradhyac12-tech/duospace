-- ============================================================================
-- "Stop sharing & unlink" requires a RECENT sign-in (owner decision 2026-10-03)
-- ============================================================================
-- The app asks for the password (or an emailed code) before this action, but a
-- UI prompt alone can be skipped by anyone holding a logged-in session (a
-- borrowed or stolen phone calling the RPC directly). So the database checks
-- too: the JWT's `amr` claim lists how and WHEN the session authenticated; if
-- the most recent entry is older than 5 minutes the call is refused with
-- REAUTH_REQUIRED and nothing changes. Password re-entry and email-code
-- verification both create a fresh session, which refreshes that timestamp.
-- Fails closed: a token with no readable amr timestamp is refused.
-- ============================================================================

CREATE OR REPLACE FUNCTION private.has_recent_auth(_max_age_seconds integer DEFAULT 300)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT max((e->>'timestamp')::bigint)
       FROM jsonb_array_elements(COALESCE(auth.jwt()->'amr', '[]'::jsonb)) e
      WHERE (e->>'timestamp') ~ '^[0-9]+$')
    >= extract(epoch FROM now())::bigint - _max_age_seconds,
    false)
$$;
REVOKE ALL ON FUNCTION private.has_recent_auth(integer) FROM PUBLIC, anon, authenticated;

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

  -- Before ANY side effect.
  IF NOT private.has_recent_auth(300) THEN
    RETURN jsonb_build_object('error', 'REAUTH_REQUIRED');
  END IF;

  INSERT INTO public.sharing_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT stopped_at INTO v_stopped FROM public.sharing_state WHERE user_id = v_uid;

  DELETE FROM public.locations WHERE user_id = v_uid;

  UPDATE public.profiles
     SET battery_level = NULL, battery_charging = NULL,
         ringer_mode = NULL, device_status_updated_at = NULL
   WHERE user_id = v_uid;

  UPDATE public.relationship_shares
     SET revoked_at = now()
   WHERE owner_id = v_uid AND revoked_at IS NULL;

  BEGIN
    UPDATE public.call_history
       SET status = 'cancelled'
     WHERE status = 'in_progress' AND (caller_id = v_uid OR receiver_id = v_uid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stop_sharing: could not end live calls: %', SQLERRM;
  END;

  v_unlink := private.schedule_unlink_core();

  IF v_unlink->>'status' = 'executed' OR v_unlink->>'error' = 'NOT_LINKED' THEN
    DELETE FROM public.sharing_state WHERE user_id = v_uid;
  END IF;

  RETURN jsonb_build_object('status', 'stopped', 'stopped_at', v_stopped, 'unlink', v_unlink);
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_sharing() TO authenticated;
