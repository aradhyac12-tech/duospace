-- Entitlement + AI-quota database tests. Run with the Supabase SQL editor or
--   psql "$DATABASE_URL" -f supabase/tests/entitlement_matrix.sql
-- Everything happens in one transaction that is ALWAYS rolled back (the final
-- RAISE), so it is safe against a real database. Passing prints
-- "ALL ENTITLEMENT TESTS PASSED"; a failure raises the failing case.
DO $t$
DECLARE
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  r jsonb; i int;
BEGIN
  INSERT INTO auth.users (id, aud, role, email) VALUES
    (a,'authenticated','authenticated','t-a@test.invalid'),(b,'authenticated','authenticated','t-b@test.invalid'),
    (c,'authenticated','authenticated','t-c@test.invalid'),(d,'authenticated','authenticated','t-d@test.invalid');
  INSERT INTO public.profiles (user_id, display_name) SELECT x, 'x' FROM unnest(ARRAY[a,b,c,d]) x ON CONFLICT (user_id) DO NOTHING;
  SET LOCAL session_replication_role = replica;

  UPDATE public.profiles SET partner_id=b WHERE user_id=a; UPDATE public.profiles SET partner_id=a WHERE user_id=b;
  ASSERT public._compute_entitlement_plan(a)='FREE' AND public._compute_entitlement_plan(b)='FREE', 'FREE/FREE';

  INSERT INTO public.entitlements(user_id,plan,status,source) VALUES (a,'PLUS_INDIVIDUAL','active','test');
  ASSERT public._compute_entitlement_plan(a)='PLUS_INDIVIDUAL' AND public._compute_entitlement_plan(b)='FREE', 'PLUS individual is not shared';
  UPDATE public.entitlements SET plan='PLUS_COUPLE' WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(b)='PLUS_COUPLE', 'PLUS couple shares PLUS with mutual partner';
  UPDATE public.entitlements SET plan='PRO_INDIVIDUAL' WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(b)='FREE', 'PRO individual is not shared';
  UPDATE public.entitlements SET plan='PRO_COUPLE' WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(b)='PRO_COUPLE', 'PRO couple shares PRO';

  UPDATE public.profiles SET partner_id=NULL WHERE user_id IN (a,b);
  ASSERT public._compute_entitlement_plan(b)='FREE' AND public._compute_entitlement_plan(a)='PRO_COUPLE', 'unlink removes inherited, payer keeps';
  UPDATE public.profiles SET partner_id=b WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(b)='FREE', 'one-sided link inherits nothing';

  UPDATE public.profiles SET partner_id=NULL WHERE user_id=a;
  UPDATE public.profiles SET partner_id=c WHERE user_id=a; UPDATE public.profiles SET partner_id=a WHERE user_id=c;
  ASSERT public._compute_entitlement_plan(c)='PRO_COUPLE' AND public._compute_entitlement_plan(b)='FREE', 'relink gives NEW partner the level';

  UPDATE public.entitlements SET plan='PLUS_COUPLE' WHERE user_id=a;
  INSERT INTO public.entitlements(user_id,plan,status,source) VALUES (c,'PRO_INDIVIDUAL','active','test');
  ASSERT public._compute_entitlement_plan(c)='PRO_INDIVIDUAL', 'own PRO beats partner PLUS_COUPLE';
  UPDATE public.entitlements SET plan='PRO_COUPLE' WHERE user_id=a;
  UPDATE public.entitlements SET plan='PLUS_INDIVIDUAL' WHERE user_id=c;
  ASSERT public._compute_entitlement_plan(c)='PRO_COUPLE', 'own PLUS is raised to partner PRO_COUPLE';
  UPDATE public.profiles SET partner_id=NULL WHERE user_id IN (a,c);
  ASSERT public._compute_entitlement_plan(c)='PLUS_INDIVIDUAL', 'unlink keeps independent plan';

  UPDATE public.profiles SET partner_id=d WHERE user_id=a; UPDATE public.profiles SET partner_id=a WHERE user_id=d;
  UPDATE public.entitlements SET expires_at=now()-interval '1 day' WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(d)='FREE', 'expired payer shares nothing';
  UPDATE public.entitlements SET expires_at=NULL, status='cancelled' WHERE user_id=a;
  ASSERT public._compute_entitlement_plan(d)='FREE', 'cancelled payer shares nothing';
  UPDATE public.entitlements SET status='active' WHERE user_id=a;

  UPDATE public.profiles SET partner_id=NULL WHERE user_id IN (a,d);
  INSERT INTO public.entitlements(user_id,plan,status,source) VALUES (d,'BETA','active','test'),(d,'PLUS_INDIVIDUAL','active','test');
  ASSERT public._compute_entitlement_plan(d)='BETA', 'BETA (PRO-equivalent) outranks PLUS';

  -- quotas
  PERFORM set_config('request.jwt.claim.sub', b::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', b)::text, true);
  FOR i IN 1..5 LOOP r := public.consume_ai_quota('AI_STANDARD'); END LOOP;
  ASSERT (r->>'allowed')::boolean AND (r->>'remaining')::int = 0, 'FREE 5th ok';
  r := public.consume_ai_quota('AI_STANDARD');
  ASSERT NOT (r->>'allowed')::boolean AND r->>'reason'='quota_exceeded', 'FREE 6th denied';
  r := public.consume_ai_quota('AI_DEEP');
  ASSERT r->>'reason'='not_in_plan', 'FREE has no deep analyses';
  BEGIN PERFORM public.consume_ai_quota('AI_STANDARD', -5); ASSERT false, 'negative cost accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN PERFORM public.consume_ai_quota('AI_STANDARD', 2147483647); ASSERT false, 'overflow cost accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN PERFORM public.consume_ai_quota('AI_HACK'); ASSERT false, 'bad bucket accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;

  PERFORM set_config('request.jwt.claim.sub', d::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', d)::text, true);
  r := public.consume_ai_quota('AI_STANDARD');
  ASSERT (r->>'allowed')::boolean AND r->>'level'='PRO', "another account's exhausted quota does not affect mine";
  DELETE FROM public.entitlements WHERE user_id=d AND plan='BETA';
  FOR i IN 1..50 LOOP r := public.consume_ai_quota('AI_STANDARD'); END LOOP;
  ASSERT NOT (r->>'allowed')::boolean, 'PLUS quota (50/day) is enforced';
  r := public.consume_ai_quota('AI_DEEP');
  ASSERT (r->>'allowed')::boolean AND (r->>'limit')::int = 5, 'PLUS has 5 deep/month';

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  ASSERT NOT (public.consume_ai_quota('AI_STANDARD')->>'allowed')::boolean, 'unauthenticated denied';
  ASSERT NOT has_function_privilege('anon','public.consume_ai_quota(text,integer)','EXECUTE'), 'anon must not execute';
  ASSERT NOT has_function_privilege('authenticated','public._compute_entitlement_plan(uuid)','EXECUTE'), 'resolver is not client-callable';

  RAISE EXCEPTION 'ALL ENTITLEMENT TESTS PASSED (rolled back)';
END $t$;
