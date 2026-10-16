-- Safe, auditable way to grant complimentary access (ADMIN/FOUNDER/BETA)
-- WITHOUT hard-coded emails anywhere in the app — per the monetization
-- spec's explicit "never `if (email === ...) premium = true`" rule.
--
-- Bootstrap problem: the very first ADMIN has to come from somewhere, since
-- this function itself requires an existing ADMIN to call it. That first
-- grant is done once, directly, by a human with direct database access
-- (project owner via the Supabase dashboard/SQL editor). Every grant after
-- that can go through this RPC.
CREATE OR REPLACE FUNCTION public.grant_entitlement(
  _target_user_id uuid,
  _plan public.entitlement_plan,
  _note text DEFAULT NULL
)
RETURNS public.entitlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _result public.entitlements;
  _source text;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF public.get_effective_entitlement(_caller) <> 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin can grant entitlements';
  END IF;

  IF _plan NOT IN ('ADMIN', 'FOUNDER', 'BETA') THEN
    RAISE EXCEPTION 'grant_entitlement may only be used for ADMIN, FOUNDER or BETA — paid plans must come from verified purchases';
  END IF;

  _source := CASE _plan
    WHEN 'ADMIN' THEN 'admin_grant'
    WHEN 'FOUNDER' THEN 'founder_grant'
    ELSE 'beta_grant'
  END;

  INSERT INTO public.entitlements (user_id, plan, status, source, granted_by, expires_at, metadata)
  VALUES (_target_user_id, _plan, 'active', _source, _caller, NULL, jsonb_build_object('note', _note))
  RETURNING * INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_entitlement(uuid, public.entitlement_plan, text) FROM public;
REVOKE ALL ON FUNCTION public.grant_entitlement(uuid, public.entitlement_plan, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.grant_entitlement(uuid, public.entitlement_plan, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_entitlement(_entitlement_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_effective_entitlement(auth.uid()) <> 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin can revoke entitlements';
  END IF;

  UPDATE public.entitlements SET status = 'revoked' WHERE id = _entitlement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_entitlement(uuid) FROM public;
REVOKE ALL ON FUNCTION public.revoke_entitlement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_entitlement(uuid) TO authenticated;

CREATE OR REPLACE VIEW public.admin_entitlements_view AS
SELECT e.*, p.username
FROM public.entitlements e
JOIN public.profiles p ON p.user_id = e.user_id
WHERE public.get_effective_entitlement(auth.uid()) = 'ADMIN';

GRANT SELECT ON public.admin_entitlements_view TO authenticated;
