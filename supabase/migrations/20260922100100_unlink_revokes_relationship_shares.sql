-- Phase 2A follow-up: unlinking must end relationship-reflection sharing in
-- the same transaction as the unlink itself (see relationship_shares.sql's
-- revoke_relationship_shares_between()). CREATE OR REPLACE on top of
-- 20260921110300's apply_unlink — everything else in that function is
-- unchanged, this only adds the one call.
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
END;
$$;
REVOKE ALL ON FUNCTION private.apply_unlink(uuid, uuid) FROM PUBLIC, anon, authenticated;
