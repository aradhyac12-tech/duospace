-- Applied live 2026-09-21. Found by a live test: after an approved unlink the original sender of a
-- partner request could never send another one to the same person, because the stale ACCEPTED row
-- still occupied UNIQUE(sender_id, receiver_id). apply_unlink now removes accepted rows between the
-- pair (pending rows are untouched). Everything else is identical to 20260920150000.
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
END;
$$;
REVOKE ALL ON FUNCTION private.apply_unlink(uuid, uuid) FROM PUBLIC, anon, authenticated;
