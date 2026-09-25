-- ============================================================
-- P1 FIX (Phase 8D — RLS Security Matrix sweep)
--
-- FINDING: 20260308232746_...sql explicitly fixed a
-- "infinite recursion detected in policy for relation profiles"
-- problem by introducing get_partner_id(uuid) as a STABLE
-- SECURITY DEFINER function (which bypasses RLS for its own internal
-- SELECT, breaking the cycle) and rewriting the profiles SELECT
-- policy to call it instead of subquerying public.profiles inline.
--
-- Two later migrations — 20260707054831_...sql and
-- 20260708090100_...sql — both dropped and recreated "Users can view
-- partner profiles" using an inline self-referencing subquery again:
--
--   USING (auth.uid() = user_id
--          OR user_id = (SELECT p.partner_id FROM public.profiles p
--                         WHERE p.user_id = auth.uid()))
--
-- A subquery against public.profiles inside a policy defined ON
-- public.profiles re-applies the same RLS policy to the inner query
-- (it is NOT SECURITY DEFINER, so it runs as the calling role, RLS
-- and all) — the exact shape 20260308232746 was written to eliminate.
-- Whether this currently throws "infinite recursion detected in
-- policy for relation 'profiles'" in the live database, or merely
-- degrades performance without erroring, cannot be determined
-- without a live Postgres connection — Postgres's handling of this
-- pattern is version/planner-dependent, which is exactly why the
-- project's own history already treats it as unsafe. Given profiles
-- is read on effectively every partner-data code path, this is
-- treated as P1 rather than deferred.
--
-- get_partner_id() was never dropped by any later migration, so it's
-- safe to route back through it.
-- ============================================================

DROP POLICY IF EXISTS "Users can view partner profiles" ON public.profiles;
CREATE POLICY "Users can view partner profiles" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = public.get_partner_id(auth.uid()));

-- ============================================================
-- REQUIRES LIVE ENVIRONMENT to fully close out: confirm this was
-- actually erroring or degraded in production (check Postgres logs /
-- slow query log for "infinite recursion" on public.profiles, or for
-- unusually expensive profiles SELECT plans), and confirm this fix
-- resolves it. See docs/RLS_SECURITY_MATRIX.md.
-- ============================================================
