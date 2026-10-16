-- KI-43: favorite + two-person delete on a PARTNER's shayari silently changed 0 rows
-- (UPDATE/DELETE RLS is owner-only). Product decision (autonomous): favorites stay one
-- shared flag per shayari; either partner may toggle it, request/cancel deletion, and the
-- OTHER partner approves. Done via narrow SECURITY DEFINER RPCs, owner-only RLS unchanged.

CREATE OR REPLACE FUNCTION public._shayari_can_act(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shayaris s
    WHERE s.id = _id
      AND auth.uid() IS NOT NULL
      AND (s.user_id = auth.uid() OR s.user_id = public.get_partner_id(auth.uid()))
  );
$$;

CREATE OR REPLACE FUNCTION public.shayari_set_favorite(_id uuid, _value boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._shayari_can_act(_id) THEN RAISE EXCEPTION 'NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  UPDATE public.shayaris SET is_favorite = _value WHERE id = _id;
  RETURN _value;
END $$;

-- _action: 'request' | 'cancel' | 'approve'. Returns 'requested' | 'cancelled' | 'deleted'.
CREATE OR REPLACE FUNCTION public.shayari_delete_action(_id uuid, _action text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _by uuid;
BEGIN
  IF NOT public._shayari_can_act(_id) THEN RAISE EXCEPTION 'NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  SELECT delete_requested_by INTO _by FROM public.shayaris WHERE id = _id FOR UPDATE;
  IF _action = 'request' THEN
    IF _by IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_REQUESTED'; END IF;
    UPDATE public.shayaris SET delete_requested_by = auth.uid() WHERE id = _id;
    RETURN 'requested';
  ELSIF _action = 'cancel' THEN
    IF _by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'NOT_REQUESTER'; END IF;
    UPDATE public.shayaris SET delete_requested_by = NULL WHERE id = _id;
    RETURN 'cancelled';
  ELSIF _action = 'approve' THEN
    IF _by IS NULL OR _by = auth.uid() THEN RAISE EXCEPTION 'NOTHING_TO_APPROVE'; END IF;
    DELETE FROM public.shayaris WHERE id = _id;
    RETURN 'deleted';
  END IF;
  RAISE EXCEPTION 'BAD_ACTION';
END $$;

REVOKE ALL ON FUNCTION public._shayari_can_act(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shayari_set_favorite(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shayari_delete_action(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shayari_set_favorite(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shayari_delete_action(uuid, text) TO authenticated;
