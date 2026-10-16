-- Step 2 of 2: PLUS/PRO level model, explicit precedence resolver, server-
-- authoritative AI quotas, and the two Pro catalog rows.

-- ---------------------------------------------------------------- levels --
CREATE OR REPLACE FUNCTION public.plan_level(_plan public.entitlement_plan)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _plan
    WHEN 'ADMIN'           THEN 'ADMIN'
    WHEN 'FOUNDER'         THEN 'PRO'
    WHEN 'LIFETIME'        THEN 'PRO'
    WHEN 'BETA'            THEN 'PRO'   -- default PRO-equivalent for current beta users
    WHEN 'PRO_INDIVIDUAL'  THEN 'PRO'
    WHEN 'PRO_COUPLE'      THEN 'PRO'
    WHEN 'PLUS_INDIVIDUAL' THEN 'PLUS'
    WHEN 'PLUS_COUPLE'     THEN 'PLUS'
    ELSE 'FREE'
  END
$$;

-- Explicit precedence (higher wins). BETA is PRO-equivalent, so it sits above
-- any PLUS plan but below a real PRO purchase.
CREATE OR REPLACE FUNCTION public.plan_rank(_plan public.entitlement_plan)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _plan
    WHEN 'ADMIN'           THEN 100
    WHEN 'FOUNDER'         THEN 90
    WHEN 'LIFETIME'        THEN 80
    WHEN 'PRO_COUPLE'      THEN 70
    WHEN 'PRO_INDIVIDUAL'  THEN 60
    WHEN 'BETA'            THEN 55
    WHEN 'PLUS_COUPLE'     THEN 50
    WHEN 'PLUS_INDIVIDUAL' THEN 40
    ELSE 0
  END
$$;

-- --------------------------------------------------------------- resolver --
-- Live, never copied: own active entitlement vs. what the CURRENT, MUTUALLY
-- linked partner shares (PLUS_COUPLE / PRO_COUPLE at that level; ADMIN ->
-- FOUNDER). The strongest applicable one wins; nobody is ever downgraded by
-- their partner's lower plan.
CREATE OR REPLACE FUNCTION public._compute_entitlement_plan(_user_id uuid)
RETURNS public.entitlement_plan
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _own public.entitlement_plan;
  _partner uuid;
  _inherited public.entitlement_plan;
BEGIN
  SELECT plan INTO _own
  FROM public.entitlements
  WHERE user_id = _user_id AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY public.plan_rank(plan) DESC
  LIMIT 1;

  SELECT partner_id INTO _partner FROM public.profiles WHERE user_id = _user_id;

  IF _partner IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _partner AND partner_id = _user_id) THEN
    SELECT CASE plan WHEN 'ADMIN' THEN 'FOUNDER'::public.entitlement_plan ELSE plan END
    INTO _inherited
    FROM public.entitlements
    WHERE user_id = _partner
      AND plan IN ('ADMIN', 'PLUS_COUPLE', 'PRO_COUPLE')
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY public.plan_rank(plan) DESC
    LIMIT 1;
  END IF;

  IF _own IS NULL AND _inherited IS NULL THEN RETURN 'FREE'; END IF;
  IF _own IS NULL THEN RETURN _inherited; END IF;
  IF _inherited IS NULL THEN RETURN _own; END IF;
  RETURN CASE WHEN public.plan_rank(_inherited) > public.plan_rank(_own) THEN _inherited ELSE _own END;
END;
$$;
REVOKE ALL ON FUNCTION public._compute_entitlement_plan(uuid) FROM public, anon, authenticated;

-- ------------------------------------------------------------- catalogue --
INSERT INTO public.commercial_products (plan, billing_period, base_price_minor, base_currency, google_product_id, active)
VALUES
  ('PRO_INDIVIDUAL', 'monthly', 29900, 'INR', 'duospace_pro_individual_monthly', true),
  ('PRO_COUPLE',     'monthly', 39900, 'INR', 'duospace_pro_couple_monthly',     true)
ON CONFLICT (plan, billing_period) DO NOTHING;

-- ----------------------------------------------------------- AI quotas ----
CREATE TABLE IF NOT EXISTS public.plan_quota_config (
  level       text NOT NULL CHECK (level IN ('FREE','PLUS','PRO','ADMIN')),
  bucket      text NOT NULL CHECK (bucket IN ('AI_STANDARD','AI_DEEP')),
  period      text NOT NULL CHECK (period IN ('day','month')),
  quota_limit integer CHECK (quota_limit IS NULL OR quota_limit >= 0),  -- NULL = uncapped (ADMIN only)
  PRIMARY KEY (level, bucket)
);
ALTER TABLE public.plan_quota_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.plan_quota_config FROM anon, authenticated;
GRANT ALL ON TABLE public.plan_quota_config TO service_role;

-- Initial values only — edit these rows to retune without a rebuild.
INSERT INTO public.plan_quota_config (level, bucket, period, quota_limit) VALUES
  ('FREE',  'AI_STANDARD', 'day',   5),
  ('FREE',  'AI_DEEP',     'month', 0),
  ('PLUS',  'AI_STANDARD', 'day',   50),
  ('PLUS',  'AI_DEEP',     'month', 5),
  ('PRO',   'AI_STANDARD', 'day',   150),
  ('PRO',   'AI_DEEP',     'month', 30),
  ('ADMIN', 'AI_STANDARD', 'day',   NULL),
  ('ADMIN', 'AI_DEEP',     'month', NULL)
ON CONFLICT (level, bucket) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ai_quota_usage (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket       text NOT NULL CHECK (bucket IN ('AI_STANDARD','AI_DEEP')),
  period_start timestamptz NOT NULL,
  used         integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, bucket, period_start)
);
ALTER TABLE public.ai_quota_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_quota_usage FROM anon, authenticated;
GRANT ALL ON TABLE public.ai_quota_usage TO service_role;

-- Shared body: _consume=false only reads. Always keyed on auth.uid(); there is
-- no user-id parameter, so nobody can spend or read another account's quota.
CREATE OR REPLACE FUNCTION public._ai_quota(_bucket text, _cost integer, _consume boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _plan public.entitlement_plan;
  _level text;
  _cfg public.plan_quota_config;
  _start timestamptz;
  _reset timestamptz;
  _used integer;
BEGIN
  IF _uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'reset_at', NULL, 'reason', 'not_authenticated');
  END IF;
  IF _bucket NOT IN ('AI_STANDARD', 'AI_DEEP') THEN RAISE EXCEPTION 'invalid bucket'; END IF;
  IF _cost IS NULL OR _cost < 1 OR _cost > 10 THEN RAISE EXCEPTION 'invalid cost'; END IF;

  _plan  := public._compute_entitlement_plan(_uid);
  _level := public.plan_level(_plan);

  SELECT * INTO _cfg FROM public.plan_quota_config WHERE level = _level AND bucket = _bucket;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'reset_at', NULL, 'reason', 'no_quota_configured', 'level', _level);
  END IF;

  -- Daily window resets at midnight India time; monthly on the 1st.
  IF _cfg.period = 'day' THEN
    _start := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
    _reset := _start + interval '1 day';
  ELSE
    _start := date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
    _reset := _start + interval '1 month';
  END IF;

  IF _cfg.quota_limit IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'remaining', NULL, 'reset_at', _reset, 'reason', 'ok', 'level', _level, 'limit', NULL);
  END IF;

  IF _cfg.quota_limit = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'reset_at', _reset, 'reason', 'not_in_plan', 'level', _level, 'limit', 0);
  END IF;

  IF NOT _consume THEN
    SELECT COALESCE(SUM(used), 0) INTO _used FROM public.ai_quota_usage
    WHERE user_id = _uid AND bucket = _bucket AND period_start = _start;
    RETURN jsonb_build_object('allowed', _used + _cost <= _cfg.quota_limit,
      'remaining', GREATEST(_cfg.quota_limit - _used, 0), 'reset_at', _reset,
      'reason', CASE WHEN _used + _cost <= _cfg.quota_limit THEN 'ok' ELSE 'quota_exceeded' END,
      'level', _level, 'limit', _cfg.quota_limit);
  END IF;

  IF _cost > _cfg.quota_limit THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', _cfg.quota_limit, 'reset_at', _reset, 'reason', 'quota_exceeded', 'level', _level, 'limit', _cfg.quota_limit);
  END IF;

  -- Atomic check-and-spend: the row lock serialises concurrent callers (two
  -- devices, racing requests) and the WHERE clause refuses any overshoot.
  INSERT INTO public.ai_quota_usage AS u (user_id, bucket, period_start, used)
  VALUES (_uid, _bucket, _start, _cost)
  ON CONFLICT (user_id, bucket, period_start)
  DO UPDATE SET used = u.used + _cost
  WHERE u.used + _cost <= _cfg.quota_limit
  RETURNING u.used INTO _used;

  IF _used IS NULL THEN
    SELECT used INTO _used FROM public.ai_quota_usage
    WHERE user_id = _uid AND bucket = _bucket AND period_start = _start;
    RETURN jsonb_build_object('allowed', false, 'remaining', GREATEST(_cfg.quota_limit - COALESCE(_used, 0), 0),
      'reset_at', _reset, 'reason', 'quota_exceeded', 'level', _level, 'limit', _cfg.quota_limit);
  END IF;

  RETURN jsonb_build_object('allowed', true, 'remaining', _cfg.quota_limit - _used, 'reset_at', _reset,
    'reason', 'ok', 'level', _level, 'limit', _cfg.quota_limit);
END;
$$;
REVOKE ALL ON FUNCTION public._ai_quota(text, integer, boolean) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_ai_quota(_bucket text, _cost integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._ai_quota(_bucket, _cost, true)
$$;
CREATE OR REPLACE FUNCTION public.get_ai_quota_status(_bucket text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._ai_quota(_bucket, 1, false)
$$;
REVOKE ALL ON FUNCTION public.consume_ai_quota(text, integer) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_ai_quota_status(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(text) TO authenticated;
