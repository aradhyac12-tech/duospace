-- SECURITY FIX: public.get_partner_id(_user_id uuid) is SECURITY DEFINER
-- (runs with the privileges of its owner, bypassing RLS on public.profiles
-- to read partner_id) and has EXECUTE granted to the `authenticated` role.
-- It is used throughout this project's RLS policies as
-- `get_partner_id(auth.uid())` — every call site in the application code
-- and in every RLS policy passes the caller's own auth.uid(), never
-- anyone else's (verified: no call site in src/ or in any migration's
-- policy definitions passes anything other than auth.uid()).
--
-- The function itself, however, never validated that `_user_id` actually
-- equals auth.uid() — it took the parameter at face value and used its
-- SECURITY DEFINER privileges to look up ANY user's partner_id. Since
-- EXECUTE is granted to `authenticated`, any signed-in user could call
-- it directly as an RPC — `supabase.rpc('get_partner_id', { _user_id:
-- '<someone-else's-uuid>' })` — and learn who any other user's partner
-- is, bypassing whatever RLS would otherwise protect that linkage on
-- public.profiles. This is exactly the class of bug spec section 32
-- calls out for SECURITY DEFINER functions ("validate auth.uid()",
-- "minimize privileges") — the function was reachable with valid
-- auth but no ownership check.
--
-- Fix: validate `_user_id = auth.uid()` inside the function and return
-- NULL for anything else, instead of relying on callers to only ever
-- pass their own id. Fully backward compatible: every existing call
-- site (RLS policies, all of them `get_partner_id(auth.uid())`) keeps
-- working identically; only a direct RPC call passing someone else's id
-- is affected, and it now returns NULL instead of leaking.
--
-- Forward-only: this is CREATE OR REPLACE against the same signature
-- already established in supabase/migrations/
-- 20260708090100_becb578d-38f0-431e-b312-0e8bcd231c35.sql (the current
-- live definition — later migrations only call the function, none
-- redefine it), no historical migration file is modified.

CREATE OR REPLACE FUNCTION public.get_partner_id(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT partner_id FROM public.profiles WHERE user_id = _user_id AND _user_id = auth.uid() LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.get_partner_id(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_partner_id(uuid) TO authenticated, service_role;
