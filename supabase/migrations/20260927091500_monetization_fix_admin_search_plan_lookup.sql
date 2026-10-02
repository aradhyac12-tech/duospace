CREATE OR REPLACE FUNCTION public._compute_entitlement_plan(_user_id uuid)
RETURNS public.entitlement_plan
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _own_plan public.entitlement_plan;
  _partner_id uuid;
  _partner_plan public.entitlement_plan;
BEGIN
  SELECT plan INTO _own_plan
  FROM public.entitlements
  WHERE user_id = _user_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY
    CASE plan
      WHEN 'ADMIN' THEN 1 WHEN 'FOUNDER' THEN 2 WHEN 'LIFETIME' THEN 3
      WHEN 'PLUS_COUPLE' THEN 4 WHEN 'PLUS_INDIVIDUAL' THEN 5 WHEN 'BETA' THEN 6
      ELSE 9
    END
  LIMIT 1;

  IF _own_plan IS NOT NULL THEN
    RETURN _own_plan;
  END IF;

  SELECT partner_id INTO _partner_id FROM public.profiles WHERE user_id = _user_id;

  IF _partner_id IS NOT NULL THEN
    SELECT plan INTO _partner_plan
    FROM public.entitlements
    WHERE user_id = _partner_id AND plan = 'PLUS_COUPLE' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

    IF _partner_plan IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _partner_id AND partner_id = _user_id) THEN
        RETURN 'PLUS_COUPLE';
      END IF;
    END IF;
  END IF;

  RETURN 'FREE';
END;
$$;

REVOKE ALL ON FUNCTION public._compute_entitlement_plan(uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_effective_entitlement(_user_id uuid)
RETURNS public.entitlement_plan
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN
    RETURN 'FREE';
  END IF;
  RETURN public._compute_entitlement_plan(_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_effective_entitlement(uuid) FROM public;
REVOKE ALL ON FUNCTION public.get_effective_entitlement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_effective_entitlement(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_search_accounts(_query text)
RETURNS TABLE (user_id uuid, username text, email text, current_plan public.entitlement_plan)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_effective_entitlement(auth.uid()) <> 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin can search accounts';
  END IF;

  IF length(trim(_query)) < 3 THEN
    RAISE EXCEPTION 'query must be at least 3 characters';
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.username, u.email::text, public._compute_entitlement_plan(p.user_id)
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.user_id
  WHERE u.email ILIKE '%' || _query || '%' OR p.username ILIKE '%' || _query || '%'
  LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search_accounts(text) FROM public;
REVOKE ALL ON FUNCTION public.admin_search_accounts(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_search_accounts(text) TO authenticated;
