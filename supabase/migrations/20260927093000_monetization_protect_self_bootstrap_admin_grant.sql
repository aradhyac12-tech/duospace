CREATE OR REPLACE FUNCTION public.revoke_entitlement(_entitlement_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.entitlements;
BEGIN
  IF auth.uid() IS NULL OR public.get_effective_entitlement(auth.uid()) <> 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin can revoke entitlements';
  END IF;

  SELECT * INTO _row FROM public.entitlements WHERE id = _entitlement_id;
  IF _row IS NULL THEN
    RAISE EXCEPTION 'entitlement not found';
  END IF;

  IF _row.source = 'admin_grant' AND _row.granted_by = _row.user_id THEN
    RAISE EXCEPTION 'cannot revoke a self-granted admin bootstrap entitlement';
  END IF;

  UPDATE public.entitlements SET status = 'revoked' WHERE id = _entitlement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_entitlement(uuid) FROM public;
REVOKE ALL ON FUNCTION public.revoke_entitlement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_entitlement(uuid) TO authenticated;
