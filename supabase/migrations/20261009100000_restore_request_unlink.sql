-- ============================================================================
-- Two ways to unlink (owner decision 2026-10-09)
-- ============================================================================
--   1. REQUEST UNLINK  — public.request_unlink(): asks the partner. Nothing
--      changes until they Allow (respond_unlink); then both are unlinked at once.
--   2. STOP SHARING & UNLINK IN 14 DAYS — public.stop_sharing(): no approval,
--      irreversible, for when the partner isn't agreeing. Unchanged.
-- 20261003150000 had retired request_unlink() (it returned USE_STOP_SHARING).
-- This restores the original behaviour from 20260920150000. respond_unlink /
-- cancel_unlink were never removed. private.apply_unlink already voids any
-- running countdown and clears sharing_state for both people.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_unlink()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_partner  uuid;
  v_partners_partner uuid;
  v_open     public.unlink_requests%ROWTYPE;
  v_crossed  public.unlink_requests%ROWTYPE;
  v_new_id   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;

  -- Serialise against anything else touching this pairing, then re-read.
  PERFORM 1 FROM public.profiles WHERE user_id IN (v_uid, v_partner) ORDER BY user_id FOR UPDATE;
  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;
  SELECT partner_id INTO v_partners_partner FROM public.profiles WHERE user_id = v_partner;

  -- One-sided pairing (the other profile no longer points back at us, or is
  -- gone): there is no one whose consent matters. Clear our dangling link.
  IF v_partners_partner IS DISTINCT FROM v_uid THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_uid AND partner_id = v_partner;
    UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
      WHERE status = 'pending' AND requester_id = v_uid;
    RETURN jsonb_build_object('status', 'approved', 'reason', 'ONE_SIDED');
  END IF;

  -- Retire this caller's stale asks so the one-open-request index can't
  -- block a fresh one.
  UPDATE public.unlink_requests SET status = 'expired', responded_at = now()
    WHERE status = 'pending' AND expires_at <= now()
      AND (requester_id = v_uid OR requester_id = v_partner);

  -- Partner already asked to unlink from us -> both want out. Finish now.
  SELECT * INTO v_crossed FROM public.unlink_requests
    WHERE requester_id = v_partner AND partner_id = v_uid AND status = 'pending'
    FOR UPDATE;
  IF FOUND THEN
    PERFORM private.apply_unlink(v_uid, v_partner);
    UPDATE public.unlink_requests SET status = 'approved', responded_at = now() WHERE id = v_crossed.id;
    UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
      WHERE status = 'pending' AND requester_id = v_uid;
    RETURN jsonb_build_object('status', 'approved', 'reason', 'BOTH_REQUESTED');
  END IF;

  -- Already asked -> idempotent.
  SELECT * INTO v_open FROM public.unlink_requests
    WHERE requester_id = v_uid AND partner_id = v_partner AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'pending', 'request_id', v_open.id, 'expires_at', v_open.expires_at);
  END IF;

  -- A pending row aimed at someone else (old partner) can't apply anymore.
  UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
    WHERE status = 'pending' AND requester_id = v_uid;

  INSERT INTO public.unlink_requests (requester_id, partner_id)
    VALUES (v_uid, v_partner)
    RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'status', 'pending',
    'request_id', v_new_id,
    'expires_at', (SELECT expires_at FROM public.unlink_requests WHERE id = v_new_id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.request_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_unlink() TO authenticated;
