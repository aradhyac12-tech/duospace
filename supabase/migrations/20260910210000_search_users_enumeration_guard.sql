-- SECURITY FIX (P1 — Phase 4 adversarial audit, "search/user enumeration"):
-- public.search_users(search_term text) (current definition:
-- 20260708090100_becb578d-...sql), while correctly SECURITY DEFINER with
-- EXECUTE revoked from public/anon and granted only to authenticated, has
-- two real gaps once you stop trusting the frontend (this audit's whole
-- premise — the frontend's own debounce/rate-limit, if any, is not a
-- security boundary):
--
-- 1. NO MINIMUM SEARCH TERM LENGTH. The username predicate is
--    `p.username ILIKE '%' || search_term || '%'` — an empty search_term
--    becomes `ILIKE '%%'`, which matches every single profile with a
--    username set. `supabase.rpc('search_users', { search_term: '' })`
--    called repeatedly (LIMIT 20 per call, no offset/pagination in the
--    function itself, but nothing stops looping this against different
--    single/short substrings) lets any authenticated user enumerate the
--    entire username space in the app, 20 at a time.
--
-- 2. consume_rate_limit(_user_id, _bucket, _max, _window_seconds)
--    (20260511081322_c574ba37-...sql) already exists for exactly this
--    purpose — deliberately service_role-only EXECUTE so it's only ever
--    invoked FROM WITHIN another SECURITY DEFINER function, never called
--    directly by a client — but search_users, being a plain `LANGUAGE sql`
--    function, never actually called it. The infrastructure existed and
--    was simply never wired in, same class of gap as
--    get_partner_daily_key's hardening script sitting outside the
--    migration chain: a fix that exists somewhere in the codebase but
--    never actually took effect.
--
-- FIX: convert to `plpgsql` (needed to short-circuit and to call
-- consume_rate_limit, which a pure SQL function can't meaningfully branch
-- on), require search_term to be either at least 3 characters (for the
-- username substring search) or a plausible phone number (kept as an
-- exact match, unchanged — already not enumerable by substring), and
-- consume one rate-limit token per call (20 searches per 60 seconds per
-- user) before running the query at all. A SECURITY DEFINER function's
-- internal calls run with the DEFINER's own privileges regardless of the
-- invoking role's grants, so search_users (owned by the same privileged
-- role as every other SECURITY DEFINER function here) can call
-- service_role-only consume_rate_limit even though the authenticated
-- caller of search_users itself cannot call consume_rate_limit directly —
-- this is the same composition pattern the codebase already establishes
-- consume_rate_limit for, just not yet applied here.
--
-- Fully backward compatible for every legitimate caller: real searches in
-- this app (Onboarding.tsx, PartnerSettings.tsx) are always a partner's
-- actual username or phone number, never an empty string or a 1-2
-- character probe, and nobody legitimately calls this more than a
-- handful of times a minute.

CREATE OR REPLACE FUNCTION public.search_users(search_term text)
RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := trim(coalesce(search_term, ''));
  v_is_phone_like boolean := v_term ~ '^[0-9+][0-9+\-\s()]{4,}$';
BEGIN
  -- Enumeration guard: a substring search needs enough characters that
  -- "match everyone" isn't achievable; an exact phone-number match is
  -- already not enumerable by substring, so it only needs a plausible
  -- minimum length rather than the same 3-char floor.
  IF (v_is_phone_like AND length(v_term) < 5) OR (NOT v_is_phone_like AND length(v_term) < 3) THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.consume_rate_limit(auth.uid(), 'search_users', 20, 60) THEN
    RAISE EXCEPTION 'Too many searches — please wait a moment and try again.';
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.display_name, p.username, p.avatar_url
  FROM public.profiles p
  WHERE (p.username ILIKE '%' || v_term || '%' OR p.phone_number = v_term)
    AND p.user_id != auth.uid()
  LIMIT 20;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_users(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;
