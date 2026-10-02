-- Phase 3M Stage 1: server-side plumbing for the cloud AI gateway (ai-gateway edge function).
--
--  * `_ai_quota` keeps its exact behaviour and signature, but its body moves into
--    `_ai_quota_for(uid, ...)` so the gateway (service role, no auth.uid()) and the
--    existing client RPCs share ONE implementation of the quota rules.
--  * gateway_consume_ai_quota / gateway_refund_ai_quota / gateway_has_consents are
--    callable by service_role ONLY. A client can never name a user or spend/refund.
--  * No new tables -> nothing to add to RLS coverage.

CREATE OR REPLACE FUNCTION public._ai_quota_for(_uid uuid, _bucket text, _cost integer, _consume boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
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
REVOKE ALL ON FUNCTION public._ai_quota_for(uuid, text, integer, boolean) FROM public, anon, authenticated;

-- Existing client-facing behaviour preserved: still keyed on auth.uid() only.
CREATE OR REPLACE FUNCTION public._ai_quota(_bucket text, _cost integer, _consume boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._ai_quota_for(auth.uid(), _bucket, _cost, _consume)
$$;
REVOKE ALL ON FUNCTION public._ai_quota(text, integer, boolean) FROM public, anon, authenticated;

-- Gateway: service role only.
CREATE OR REPLACE FUNCTION public.gateway_consume_ai_quota(_user_id uuid, _bucket text, _cost integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._ai_quota_for(_user_id, _bucket, _cost, true)
$$;

-- Give back a reservation when the user received no result. Never goes below zero;
-- uncapped / not-in-plan buckets have nothing to refund.
CREATE OR REPLACE FUNCTION public.gateway_refund_ai_quota(_user_id uuid, _bucket text, _cost integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _cfg public.plan_quota_config;
  _start timestamptz;
BEGIN
  IF _user_id IS NULL OR _bucket NOT IN ('AI_STANDARD', 'AI_DEEP') OR _cost IS NULL OR _cost < 1 OR _cost > 10 THEN RETURN; END IF;
  SELECT * INTO _cfg FROM public.plan_quota_config
  WHERE level = public.plan_level(public._compute_entitlement_plan(_user_id)) AND bucket = _bucket;
  IF NOT FOUND OR _cfg.quota_limit IS NULL THEN RETURN; END IF;
  IF _cfg.period = 'day' THEN
    _start := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  ELSE
    _start := date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  END IF;
  UPDATE public.ai_quota_usage SET used = GREATEST(used - _cost, 0)
  WHERE user_id = _user_id AND bucket = _bucket AND period_start = _start;
END;
$$;

-- True only if EVERY named feature has an active (granted, not revoked) consent row.
CREATE OR REPLACE FUNCTION public.gateway_has_consents(_user_id uuid, _features text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND COALESCE(array_length(_features, 1), 0) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(_features) AS f(feature)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_consents c
      WHERE c.user_id = _user_id AND c.feature = f.feature AND c.granted = true AND c.revoked_at IS NULL
    )
  )
$$;

REVOKE ALL ON FUNCTION public.gateway_consume_ai_quota(uuid, text, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_refund_ai_quota(uuid, text, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_has_consents(uuid, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_consume_ai_quota(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_refund_ai_quota(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_has_consents(uuid, text[]) TO service_role;
