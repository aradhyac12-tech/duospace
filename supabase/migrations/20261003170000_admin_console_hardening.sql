-- ============================================================================
-- Admin console hardening (v3.21.1) - follows 20261003100000_admin_console.sql
-- ============================================================================
-- Decisions (see docs/ADMIN_CONSOLE.md "Decisions"):
--  1. BLOCK: a Supabase ban stops sign-in and refresh but does NOT end existing
--     sessions, and an issued access token (JWT, 1 h by default) stays valid
--     until it expires. So blocking now also deletes the user's sessions
--     (service_role only, called by the admin-user-action function).
--  2. COMMISSION: fee rates move from hard-coded numbers to an admin-editable
--     table, because the real Razorpay rate depends on the owner's contract.
--     Seeds: Google Play 15 % (10 % service + 5 % billing, subscriptions),
--     Razorpay 2 % + 18 % GST = 2.36 %. Razorpay keeps its fee on refunds
--     (typical gateway behaviour), so that fee now counts as a cost.
--  3. COUPLES: show a pair whose 14-day unlink is counting down.
--  4. TRANSACTIONS: expose the provider transaction id so a refund can be
--     looked up in Google Play Console / Razorpay (refunds stay there).
-- Additive; nothing existing is dropped except two admin-only read functions
-- that are re-created below with extra output columns.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke sessions (service_role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_revoke_sessions(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n integer;
BEGIN
  -- Deleting a session cascades to its refresh tokens, so the account can no
  -- longer mint new access tokens. Authorisation is the grant list below: only
  -- service_role (the admin-user-action function, after it has proven the
  -- caller is the admin) can execute this.
  DELETE FROM auth.sessions WHERE user_id = _user_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_revoke_sessions(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_sessions(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Editable commission rates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.commission_rates (
  key text PRIMARY KEY CHECK (key IN ('google_play', 'apple', 'razorpay', 'razorpay_subscription_extra')),
  bps integer NOT NULL CHECK (bps BETWEEN 0 AND 5000),       -- basis points, 100 = 1 %
  retained_on_refund boolean NOT NULL DEFAULT false,          -- provider keeps its fee when a payment is refunded
  note text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.commission_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commission_rates FROM anon, authenticated;
GRANT ALL ON TABLE public.commission_rates TO service_role;
-- No policies: read/written only through the admin RPCs below.

INSERT INTO public.commission_rates (key, bps, retained_on_refund, note) VALUES
  ('google_play', 1500, false, 'Subscriptions: 10% service fee + 5% billing fee. Assumes Google returns its fee on refunds - confirm in Play Console.'),
  ('apple', 1500, false, 'Small Business Program / year-2+ subscription rate. Unused unless Apple billing ships.'),
  ('razorpay', 236, true, '2% + 18% GST on the fee. Gateways generally keep the fee on refunded payments.'),
  ('razorpay_subscription_extra', 117, false, 'Extra fee on Razorpay Subscriptions (0.99% + 18% GST per a third-party source). CONFIRM against your Razorpay dashboard.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.admin_get_commission_rates()
RETURNS TABLE (key text, bps integer, retained_on_refund boolean, note text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  RETURN QUERY SELECT c.key, c.bps, c.retained_on_refund, c.note, c.updated_at FROM public.commission_rates c ORDER BY c.key;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_get_commission_rates() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_commission_rates() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_commission_rate(_key text, _bps integer, _retained boolean DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  UPDATE public.commission_rates
     SET bps = _bps,
         retained_on_refund = COALESCE(_retained, retained_on_refund),
         updated_by = auth.uid(), updated_at = now()
   WHERE key = _key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown rate key'; END IF;
  PERFORM private.admin_log('set_commission_rate', NULL,
    jsonb_build_object('key', _key, 'bps', _bps, 'retained_on_refund', _retained));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_commission_rate(text, integer, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_commission_rate(text, integer, boolean) TO authenticated;

-- Fee for one transaction, in minor units, from the editable table.
CREATE OR REPLACE FUNCTION private.est_fee_minor(_provider public.payment_provider, _sub_id text, _amount integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT round(
    COALESCE(_amount, 0)::numeric
    * (
        COALESCE((SELECT bps FROM public.commission_rates WHERE key = _provider::text), 0)
        + CASE WHEN _provider = 'razorpay' AND _sub_id IS NOT NULL
               THEN COALESCE((SELECT bps FROM public.commission_rates WHERE key = 'razorpay_subscription_extra'), 0)
               ELSE 0 END
      ) / 10000
  )::integer;
$$;
REVOKE ALL ON FUNCTION private.est_fee_minor(public.payment_provider, text, integer) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.fee_retained_on_refund(_provider public.payment_provider)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT retained_on_refund FROM public.commission_rates WHERE key = _provider::text), false);
$$;
REVOKE ALL ON FUNCTION private.fee_retained_on_refund(public.payment_provider) FROM public, anon, authenticated;

-- Summary: fee on paid rows + fee the provider keeps on refunded rows.
CREATE OR REPLACE FUNCTION public.admin_payments_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r jsonb;
BEGIN
  PERFORM private.assert_admin();
  SELECT COALESCE(jsonb_agg(row_to_json(s)), '[]'::jsonb) INTO _r FROM (
    SELECT
      currency,
      COALESCE(sum(amount_minor) FILTER (WHERE status NOT IN ('pending','failed','refunded','revoked')), 0) AS gross_minor,
      COALESCE(sum(amount_minor) FILTER (WHERE status = 'refunded'), 0) AS refunded_minor,
      COALESCE(sum(private.est_fee_minor(provider, provider_subscription_id, amount_minor))
               FILTER (WHERE (status NOT IN ('pending','failed','refunded','revoked'))
                          OR (status = 'refunded' AND private.fee_retained_on_refund(provider))), 0) AS est_fee_minor,
      COALESCE(sum(private.est_fee_minor(provider, provider_subscription_id, amount_minor))
               FILTER (WHERE status = 'refunded' AND private.fee_retained_on_refund(provider)), 0) AS fee_kept_on_refunds_minor,
      count(*) FILTER (WHERE status NOT IN ('pending','failed','refunded','revoked')) AS paid_count,
      count(*) FILTER (WHERE status = 'refunded') AS refunded_count,
      count(*) FILTER (WHERE status = 'failed') AS failed_count,
      count(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM public.payment_transactions
    GROUP BY currency
    ORDER BY currency
  ) s;
  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_payments_summary() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_payments_summary() TO authenticated;

-- Transactions: + provider_transaction_id, fee follows the editable rates.
DROP FUNCTION IF EXISTS public.admin_list_transactions(text, integer, integer);
CREATE FUNCTION public.admin_list_transactions(_filter text DEFAULT 'all', _limit integer DEFAULT 30, _offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  username text,
  email text,
  provider public.payment_provider,
  provider_transaction_id text,
  plan public.entitlement_plan,
  amount_minor integer,
  currency text,
  status public.transaction_status,
  created_at timestamptz,
  expires_at timestamptz,
  refunded_at timestamptz,
  est_fee_minor integer,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _lim integer := LEAST(GREATEST(COALESCE(_limit, 30), 1), 100);
  _off integer := GREATEST(COALESCE(_offset, 0), 0);
BEGIN
  PERFORM private.assert_admin();

  RETURN QUERY
  SELECT t.id, t.user_id, p.username, u.email::text, t.provider, t.provider_transaction_id, t.plan, t.amount_minor, t.currency, t.status,
         t.created_at, t.expires_at, t.refunded_at,
         CASE
           WHEN t.status IN ('pending','failed','revoked') THEN 0
           WHEN t.status = 'refunded' AND NOT private.fee_retained_on_refund(t.provider) THEN 0
           ELSE private.est_fee_minor(t.provider, t.provider_subscription_id, t.amount_minor)
         END,
         count(*) OVER () AS total_count
  FROM public.payment_transactions t
  JOIN public.profiles p ON p.user_id = t.user_id
  JOIN auth.users u ON u.id = t.user_id
  WHERE CASE COALESCE(_filter, 'all')
    WHEN 'paid'     THEN t.status NOT IN ('pending','failed','refunded','revoked')
    WHEN 'refunded' THEN t.status = 'refunded'
    WHEN 'failed'   THEN t.status = 'failed'
    WHEN 'pending'  THEN t.status = 'pending'
    ELSE true
  END
  ORDER BY t.created_at DESC
  LIMIT _lim OFFSET _off;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_transactions(text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_transactions(text, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Couples: show a live (irreversible) unlink countdown
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_couples(text, integer, integer);
CREATE FUNCTION public.admin_list_couples(_query text DEFAULT NULL, _limit integer DEFAULT 30, _offset integer DEFAULT 0)
RETURNS TABLE (
  link_state text,
  a_user_id uuid, a_username text, a_display_name text, a_email text, a_plan public.entitlement_plan, a_blocked boolean,
  b_user_id uuid, b_username text, b_display_name text, b_email text, b_plan public.entitlement_plan, b_blocked boolean,
  unlink_execute_at timestamptz,
  unlink_requested_by uuid,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _q text := NULLIF(trim(COALESCE(_query, '')), '');
  _lim integer := LEAST(GREATEST(COALESCE(_limit, 30), 1), 100);
  _off integer := GREATEST(COALESCE(_offset, 0), 0);
BEGIN
  PERFORM private.assert_admin();

  RETURN QUERY
  WITH pairs AS (
    SELECT
      CASE WHEN b.partner_id = a.user_id THEN 'mutual' ELSE 'one_way' END AS link_state,
      a.user_id AS a_id, b.user_id AS b_id
    FROM public.profiles a
    JOIN public.profiles b ON b.user_id = a.partner_id
    WHERE (b.partner_id = a.user_id AND a.user_id < b.user_id)   -- mutual: once per pair
       OR (b.partner_id IS DISTINCT FROM a.user_id)               -- one-way: a points at b
  )
  SELECT
    x.link_state,
    pa.user_id, pa.username, pa.display_name, ua.email::text, public._compute_entitlement_plan(pa.user_id), COALESCE(ma.status = 'blocked', false),
    pb.user_id, pb.username, pb.display_name, ub.email::text, public._compute_entitlement_plan(pb.user_id), COALESCE(mb.status = 'blocked', false),
    su.execute_at,
    su.requester_id,
    count(*) OVER () AS total_count
  FROM pairs x
  JOIN public.profiles pa ON pa.user_id = x.a_id
  JOIN public.profiles pb ON pb.user_id = x.b_id
  JOIN auth.users ua ON ua.id = pa.user_id
  JOIN auth.users ub ON ub.id = pb.user_id
  LEFT JOIN public.user_moderation ma ON ma.user_id = pa.user_id
  LEFT JOIN public.user_moderation mb ON mb.user_id = pb.user_id
  LEFT JOIN LATERAL (
    SELECT s.execute_at, s.requester_id
    FROM public.scheduled_unlinks s
    WHERE s.status = 'scheduled'
      AND ((s.requester_id = pa.user_id AND s.partner_id = pb.user_id)
        OR (s.requester_id = pb.user_id AND s.partner_id = pa.user_id))
    ORDER BY s.execute_at
    LIMIT 1
  ) su ON true
  WHERE _q IS NULL
     OR ua.email ILIKE '%' || _q || '%' OR ub.email ILIKE '%' || _q || '%'
     OR pa.username ILIKE '%' || _q || '%' OR pb.username ILIKE '%' || _q || '%'
     OR pa.display_name ILIKE '%' || _q || '%' OR pb.display_name ILIKE '%' || _q || '%'
  ORDER BY GREATEST(pa.created_at, pb.created_at) DESC
  LIMIT _lim OFFSET _off;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_couples(text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_couples(text, integer, integer) TO authenticated;
