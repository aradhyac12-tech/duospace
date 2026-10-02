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
  SELECT p.user_id, p.username, u.email::text, public.get_effective_entitlement(p.user_id)
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.user_id
  WHERE u.email ILIKE '%' || _query || '%' OR p.username ILIKE '%' || _query || '%'
  LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search_accounts(text) FROM public;
REVOKE ALL ON FUNCTION public.admin_search_accounts(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_search_accounts(text) TO authenticated;
