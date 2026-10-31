-- ============================================================================
-- ONE action: "Stop sharing and unlink" (owner decision 2026-10-03)
-- ============================================================================
-- There is exactly one way to start ending a pairing, and it is also the only
-- way to stop sharing: public.stop_sharing(). It stops everything shared AND
-- starts the irreversible 14-day unlink. Therefore:
--   * public.schedule_unlink() no longer starts a countdown on its own; it
--     now just calls stop_sharing() (same single implementation), so an old
--     client can't start an unlink while still sharing.
--   * public.request_unlink() (the old ask-your-partner-to-approve flow) is
--     retired. It returns USE_STOP_SHARING. respond_unlink / cancel_unlink are
--     left alone so any request already pending can still be answered.
--   * private.apply_unlink() clears sharing_state for both people, so no one
--     is left restricted once a pairing has ended by any route.
-- ============================================================================

-- 1. Move the countdown logic out of the public API (client can't call it).
ALTER FUNCTION public.schedule_unlink() SET SCHEMA private;
ALTER FUNCTION private.schedule_unlink() RENAME TO schedule_unlink_core;
REVOKE ALL ON FUNCTION private.schedule_unlink_core() FROM PUBLIC, anon, authenticated;

-- 2. stop_sharing() = stop sharing + start the unlink (single implementation).
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

-- 3. schedule_unlink() is now an alias: it cannot unlink without stopping sharing.
CREATE OR REPLACE FUNCTION public.schedule_unlink()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb := public.stop_sharing();
BEGIN
  RETURN COALESCE(v_res->'unlink', v_res);
END;
$$;
REVOKE ALL ON FUNCTION public.schedule_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_unlink() TO authenticated;

-- 4. Retire the ask-for-approval unlink.
CREATE OR REPLACE FUNCTION public.request_unlink()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('error', 'USE_STOP_SHARING');
$$;
REVOKE ALL ON FUNCTION public.request_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_unlink() TO authenticated;

-- 5. Any route that ends a pairing clears both people's restriction.
CREATE OR REPLACE FUNCTION private.apply_unlink(_a uuid, _b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.profiles WHERE user_id IN (_a, _b) ORDER BY user_id FOR UPDATE;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _a AND partner_id = _b;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _b AND partner_id = _a;
  DELETE FROM public.partner_requests
    WHERE status = 'accepted'
      AND ((sender_id = _a AND receiver_id = _b) OR (sender_id = _b AND receiver_id = _a));
  PERFORM public.revoke_relationship_shares_between(_a, _b);
  UPDATE public.scheduled_unlinks
     SET status = 'void', resolved_at = now()
   WHERE status = 'scheduled'
     AND ((requester_id = _a AND partner_id = _b) OR (requester_id = _b AND partner_id = _a));
  DELETE FROM public.sharing_state WHERE user_id IN (_a, _b);
END;
$$;
REVOKE ALL ON FUNCTION private.apply_unlink(uuid, uuid) FROM PUBLIC, anon, authenticated;
