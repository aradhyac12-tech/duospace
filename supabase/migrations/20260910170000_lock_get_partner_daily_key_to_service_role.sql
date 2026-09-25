-- SECURITY FIX (P0 — Phase 4 adversarial audit): this migration folds
-- scripts/sql/harden_partner_daily_key.sql into the actual migration chain.
-- That file existed and was almost certainly applied by hand to the live
-- database (supabase/functions/daily-call/index.ts's own resolveKey() doc
-- comment already assumes/documents the fixed behavior), but was never
-- represented as a migration — so `supabase db reset` / any fresh database
-- built purely from supabase/migrations/*.sql would silently recreate the
-- ORIGINAL vulnerable function (20260711115507_eec84dc1-...sql) and be
-- exploitable again. This is exactly the "migration-policy regression"
-- class of risk: the fix existed, but only outside the chain of record.
--
-- FINDING (as originally created)
-- public.get_partner_daily_key(_user_id uuid) is SECURITY DEFINER (reads
-- another user's private user_secrets row by design, bypassing that
-- table's "Users manage own secrets" RLS policy via the function owner's
-- privileges) and, because CREATE FUNCTION grants EXECUTE to PUBLIC by
-- Postgres default and nothing in that original migration revoked it, was
-- callable by both `anon` and `authenticated`. The function took the
-- target user id as a raw parameter and never compared it to auth.uid().
-- Net effect: `supabase.rpc('get_partner_daily_key', { _user_id: '<any
-- user id>' })` — reachable directly over the PostgREST API, no special
-- privilege needed beyond an ordinary (or even anonymous) session — would
-- return a complete stranger's partner's plaintext Daily.co API key: a
-- real, billable third-party credential belonging to another couple
-- entirely unrelated to the caller.
--
-- FIX
-- 1. The function no longer trusts its argument on its own: the lookup is
--    anchored to COALESCE(auth.uid(), _user_id) — i.e. whenever there's a
--    real caller identity (auth.uid() IS NOT NULL), that identity wins and
--    _user_id is ignored for authorization purposes; the parameter is only
--    still consulted when there is no caller identity at all, which after
--    step 2 can only happen when the caller is service_role (auth.uid() is
--    NULL in a service-role session, since it carries no user JWT).
-- 2. EXECUTE is revoked from PUBLIC, anon, and authenticated, and granted
--    only to service_role. Combined with step 1: the only way to reach this
--    function at all is as service_role, and the only identity it will
--    resolve for is the identity service_role explicitly passes in — which
--    is exactly supabase/functions/daily-call/index.ts's resolveKey(),
--    called only after that edge function has independently verified the
--    caller's JWT itself (see that file's own request handler). A browser
--    can never call this function directly — there is no grant path left
--    that reaches it from a user session.
--
-- No data is destroyed, no column is dropped, and this is CREATE OR
-- REPLACE against the same signature already established in
-- 20260711115507_eec84dc1-3126-4a3e-8a57-c9e2f943beec.sql — no historical
-- migration file is modified, this only supersedes the function body/
-- grants going forward, exactly like 20260910140000's equivalent fix for
-- get_partner_id did.

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
