-- SECURITY FIX (P1 — Phase 4 adversarial audit):
-- public.is_partner_on_call(p_partner_id uuid), created in
-- 20260824_call_declined_marker.sql, is SECURITY DEFINER (bypasses
-- call_history's RLS by design — the whole point is to check a call
-- involving whichever id is passed in) with EXECUTE granted to
-- `authenticated`, but never validated that p_partner_id was actually the
-- caller's own partner. It only ever checked "is ANY user with this id
-- currently a participant in an in_progress call" — an arbitrary
-- user-status oracle. Any authenticated user could call
-- `supabase.rpc('is_partner_on_call', { p_partner_id: '<any user id>' })`
-- and learn whether a complete stranger was on a call right now, with zero
-- relationship requirement.
--
-- The one bit of information this function was designed to leak (per its
-- own doc comment in 20260824_call_declined_marker.sql — "whether the
-- partner is a participant... and nothing else") was only ever supposed to
-- be leaked about the caller's OWN actual partner, exactly the same
-- authority gap 20260910140000_lock_get_partner_id_to_self.sql already
-- fixed for get_partner_id and this migration's sibling fixes for
-- get_partner_daily_key: the function must establish the relationship
-- itself from auth.uid(), never trust the caller-supplied id as proof of
-- that relationship.
--
-- FIX: require p_partner_id to actually equal the caller's own
-- profiles.partner_id before evaluating anything about call_history at
-- all. An unrelated/arbitrary id now short-circuits straight to false —
-- same "return nothing instead of leaking" behavior get_partner_id's fix
-- established, and the exact "must not leak" outcome required for the
-- "arbitrary UUID" and "unrelated user" test cases.
--
-- Every legitimate call site (src/pages/Calls.tsx's own busy pre-check,
-- the only caller in the app) already passes
-- `is_partner_on_call(partnerId)` where partnerId came from this same
-- device's own profile fetch — i.e. already the caller's real partner —
-- so this is fully backward compatible; only a direct RPC call with
-- someone else's id is affected, and it now returns false instead of
-- leaking.
--
-- Forward-only: CREATE OR REPLACE against the signature already
-- established in 20260824_call_declined_marker.sql; that migration file
-- itself is not modified.

CREATE OR REPLACE FUNCTION public.is_partner_on_call(p_partner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.partner_id = p_partner_id
    )
    AND EXISTS (
      SELECT 1 FROM public.call_history c
      WHERE c.status = 'in_progress'
        AND c.started_at > now() - interval '2 hours'
        AND (c.caller_id = p_partner_id OR c.receiver_id = p_partner_id)
    );
$$;

REVOKE ALL ON FUNCTION public.is_partner_on_call(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_partner_on_call(uuid) TO authenticated;
