-- Stabilization phase — P0 secret-exposure fix.
-- RUN THIS IN THE SUPABASE SQL EDITOR (this project uses an external Supabase
-- project, so scripts/sql/*.sql are applied manually — same as the other files
-- in this folder).
--
-- FINDING
-- `public.get_partner_daily_key(_user_id uuid)` is SECURITY DEFINER and, by
-- Postgres default, EXECUTE is granted to PUBLIC. It takes the target user id
-- as a *parameter* and never compares it to auth.uid(). Any authenticated
-- client could therefore call
--     supabase.rpc('get_partner_daily_key', { _user_id: '<any user id>' })
-- and read that stranger's partner's plaintext Daily.co API key — a
-- third-party billable credential belonging to another couple.
--
-- FIX
-- 1. The function no longer trusts its argument: the lookup is anchored to the
--    caller identity whenever one exists. The parameter is kept so the
--    existing call signature still works from the service-role context, where
--    auth.uid() is NULL.
-- 2. EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to
--    service_role, so the key can only be resolved inside the `daily-call`
--    edge function (server side) and never in a browser.
--
-- No data is destroyed and no column is dropped.

CREATE OR REPLACE FUNCTION public.get_partner_daily_key(_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT us.daily_api_key
  FROM public.profiles p
  JOIN public.user_secrets us ON us.user_id = p.partner_id
  WHERE p.user_id = COALESCE(auth.uid(), _user_id)
    AND us.daily_api_key IS NOT NULL
    AND us.daily_provides_calls = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_partner_daily_key(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_partner_daily_key(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_partner_daily_key(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_daily_key(UUID) TO service_role;
