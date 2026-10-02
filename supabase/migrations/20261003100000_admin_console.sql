-- ============================================================================
-- Admin console (v3.21.0)
-- ============================================================================
-- WHY: the Admin screen could only search accounts and grant/revoke
-- Founder/Beta. This adds the rest of a real admin console, scoped to ACCOUNT
-- METADATA ONLY (never chat, media, location or any partner-private content):
--   * overview stats, user list (with partner link state), couples list
--   * block / unblock (+ verify email, done in the admin-user-action function)
--   * payments / refunds / failed-transaction ledger view
--   * announcements / offers / important updates, app-update (min version) config
--   * audit log of every admin action
--   * user_notices: the "an admin granted you Beta/Founder" card, written by a
--     trigger on entitlements so it fires no matter which writer made the grant
--
-- SECURITY MODEL (unchanged): every admin RPC re-checks the caller is the
-- ADMIN plan in Postgres (the single allowlisted account, see
-- 20260930100000_admin_allowlist_and_partner_premium.sql). RLS is enabled on
-- every new table; clients get no direct write access to any of them.
-- Additive only: nothing existing is altered or dropped.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 0. Admin gate + audit helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.assert_admin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_effective_entitlement(auth.uid()) <> 'ADMIN' THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION private.assert_admin() FROM public, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON public.admin_audit_log (created_at DESC);
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_audit_log FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_audit_log TO service_role;
-- No policies: only SECURITY DEFINER admin RPCs / service_role touch it.

CREATE OR REPLACE FUNCTION private.admin_log(_action text, _target uuid, _details jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.admin_audit_log (actor_id, action, target_user_id, details)
  VALUES (auth.uid(), _action, _target, COALESCE(_details, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION private.admin_log(text, uuid, jsonb) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Moderation (block / unblock)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_moderation (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_moderation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own moderation status" ON public.user_moderation;
CREATE POLICY "Users can read own moderation status"
  ON public.user_moderation FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- No write policies: only admin_set_blocked() (SECURITY DEFINER) writes.

-- The blocked-account screen reacts live when an admin blocks/unblocks.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_moderation;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_blocked(_user_id uuid, _blocked boolean, _reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  IF _user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot block yourself';
  END IF;
  IF EXISTS (SELECT 1 FROM public.entitlements WHERE user_id = _user_id AND plan = 'ADMIN' AND status = 'active') THEN
    RAISE EXCEPTION 'an admin account cannot be blocked';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _user_id) THEN
    RAISE EXCEPTION 'unknown user';
  END IF;

  INSERT INTO public.user_moderation (user_id, status, reason, changed_by, changed_at)
  VALUES (_user_id, CASE WHEN _blocked THEN 'blocked' ELSE 'active' END, NULLIF(trim(_reason), ''), auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET status = EXCLUDED.status, reason = EXCLUDED.reason, changed_by = EXCLUDED.changed_by, changed_at = now();

  PERFORM private.admin_log(CASE WHEN _blocked THEN 'block_user' ELSE 'unblock_user' END, _user_id,
                            jsonb_build_object('reason', NULLIF(trim(_reason), '')));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_blocked(uuid, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_blocked(uuid, boolean, text) TO authenticated;

-- Used by the admin-user-action function (verify email) to record the action
-- under the caller's identity after the caller is proven to be admin.
CREATE OR REPLACE FUNCTION public.admin_record_action(_action text, _target uuid, _details jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  IF _action NOT IN ('verify_user') THEN
    RAISE EXCEPTION 'unsupported action';
  END IF;
  PERFORM private.admin_log(_action, _target, _details);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_record_action(text, uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_action(text, uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Overview + users + couples (account metadata only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r jsonb;
BEGIN
  PERFORM private.assert_admin();
  SELECT jsonb_build_object(
    'total_users',      (SELECT count(*) FROM public.profiles),
    'new_7d',           (SELECT count(*) FROM public.profiles WHERE created_at > now() - interval '7 days'),
    'new_30d',          (SELECT count(*) FROM public.profiles WHERE created_at > now() - interval '30 days'),
    'active_24h',       (SELECT count(*) FROM public.profiles WHERE last_seen_at > now() - interval '24 hours'),
    'active_7d',        (SELECT count(*) FROM public.profiles WHERE last_seen_at > now() - interval '7 days'),
    'linked_couples',   (SELECT count(*) FROM public.profiles a JOIN public.profiles b
                          ON a.partner_id = b.user_id AND b.partner_id = a.user_id WHERE a.user_id < b.user_id),
    'solo_users',       (SELECT count(*) FROM public.profiles WHERE partner_id IS NULL),
    'one_way_links',    (SELECT count(*) FROM public.profiles a
                          WHERE a.partner_id IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM public.profiles b WHERE b.user_id = a.partner_id AND b.partner_id = a.user_id)),
    'unverified',       (SELECT count(*) FROM auth.users u JOIN public.profiles p ON p.user_id = u.id WHERE u.email_confirmed_at IS NULL),
    'blocked',          (SELECT count(*) FROM public.user_moderation WHERE status = 'blocked'),
    'paying_active',    (SELECT count(DISTINCT user_id) FROM public.entitlements
                          WHERE status = 'active' AND plan IN ('PLUS_INDIVIDUAL','PLUS_COUPLE','PRO_INDIVIDUAL','PRO_COUPLE')
                            AND (expires_at IS NULL OR expires_at > now())),
    'complimentary',    (SELECT count(DISTINCT user_id) FROM public.entitlements
                          WHERE status = 'active' AND plan IN ('FOUNDER','BETA','LIFETIME')
                            AND (expires_at IS NULL OR expires_at > now())),
    'signups_by_day',   COALESCE((
                          SELECT jsonb_agg(jsonb_build_object('day', d::date, 'count', COALESCE(c.n, 0)) ORDER BY d)
                          FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
                          LEFT JOIN (SELECT date_trunc('day', created_at) AS day, count(*) AS n FROM public.profiles
                                      WHERE created_at > now() - interval '14 days' GROUP BY 1) c ON c.day = d
                        ), '[]'::jsonb)
  ) INTO _r;
  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_overview() TO authenticated;

-- filter: all | linked | solo | one_way | unverified | blocked | paid | complimentary
CREATE OR REPLACE FUNCTION public.admin_list_users(
  _query text DEFAULT NULL,
  _filter text DEFAULT 'all',
  _limit integer DEFAULT 30,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  username text,
  display_name text,
  email text,
  email_verified boolean,
  created_at timestamptz,
  last_seen_at timestamptz,
  current_plan public.entitlement_plan,
  partner_user_id uuid,
  partner_username text,
  partner_display_name text,
  partner_email text,
  link_state text,
  blocked boolean,
  block_reason text,
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
  WITH base AS (
    SELECT
      p.user_id,
      p.username,
      p.display_name,
      u.email::text AS email,
      (u.email_confirmed_at IS NOT NULL) AS email_verified,
      p.created_at,
      p.last_seen_at,
      public._compute_entitlement_plan(p.user_id) AS plan,
      p.partner_id AS partner_user_id,
      pp.username AS partner_username,
      pp.display_name AS partner_display_name,
      pu.email::text AS partner_email,
      CASE
        WHEN p.partner_id IS NULL THEN 'solo'
        WHEN pp.partner_id = p.user_id THEN 'mutual'
        ELSE 'one_way'
      END AS link_state,
      (m.status = 'blocked') AS blocked,
      m.reason AS block_reason
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.user_id
    LEFT JOIN public.profiles pp ON pp.user_id = p.partner_id
    LEFT JOIN auth.users pu ON pu.id = p.partner_id
    LEFT JOIN public.user_moderation m ON m.user_id = p.user_id
    WHERE _q IS NULL
       OR u.email ILIKE '%' || _q || '%'
       OR p.username ILIKE '%' || _q || '%'
       OR p.display_name ILIKE '%' || _q || '%'
       OR pu.email ILIKE '%' || _q || '%'
       OR pp.username ILIKE '%' || _q || '%'
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE CASE COALESCE(_filter, 'all')
      WHEN 'linked'        THEN b.link_state = 'mutual'
      WHEN 'solo'          THEN b.link_state = 'solo'
      WHEN 'one_way'       THEN b.link_state = 'one_way'
      WHEN 'unverified'    THEN NOT b.email_verified
      WHEN 'blocked'       THEN COALESCE(b.blocked, false)
      WHEN 'paid'          THEN b.plan IN ('PLUS_INDIVIDUAL','PLUS_COUPLE','PRO_INDIVIDUAL','PRO_COUPLE')
      WHEN 'complimentary' THEN b.plan IN ('FOUNDER','BETA','LIFETIME','ADMIN')
      ELSE true
    END
  )
  SELECT f.user_id, f.username, f.display_name, f.email, f.email_verified, f.created_at, f.last_seen_at,
         f.plan, f.partner_user_id, f.partner_username, f.partner_display_name, f.partner_email,
         f.link_state, COALESCE(f.blocked, false), f.block_reason,
         count(*) OVER () AS total_count
  FROM filtered f
  ORDER BY f.created_at DESC
  LIMIT _lim OFFSET _off;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_users(text, text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, text, integer, integer) TO authenticated;

-- One row per CONNECTED PAIR (mutual), plus one row per one-way link, so the
-- admin can see exactly who is connected to whom.
CREATE OR REPLACE FUNCTION public.admin_list_couples(_query text DEFAULT NULL, _limit integer DEFAULT 30, _offset integer DEFAULT 0)
RETURNS TABLE (
  link_state text,
  a_user_id uuid, a_username text, a_display_name text, a_email text, a_plan public.entitlement_plan, a_blocked boolean,
  b_user_id uuid, b_username text, b_display_name text, b_email text, b_plan public.entitlement_plan, b_blocked boolean,
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
    count(*) OVER () AS total_count
  FROM pairs x
  JOIN public.profiles pa ON pa.user_id = x.a_id
  JOIN public.profiles pb ON pb.user_id = x.b_id
  JOIN auth.users ua ON ua.id = pa.user_id
  JOIN auth.users ub ON ub.id = pb.user_id
  LEFT JOIN public.user_moderation ma ON ma.user_id = pa.user_id
  LEFT JOIN public.user_moderation mb ON mb.user_id = pb.user_id
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

-- Active manual grants (Founder/Beta/Admin) with each holder's partner, so the
-- Access screen shows who is connected to whom right where access is given.
CREATE OR REPLACE FUNCTION public.admin_list_grants()
RETURNS TABLE (
  entitlement_id uuid, user_id uuid, username text, email text, plan public.entitlement_plan, source text,
  granted_by uuid, granted_at timestamptz,
  partner_user_id uuid, partner_username text, partner_email text, link_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  RETURN QUERY
  SELECT e.id, e.user_id, p.username, u.email::text, e.plan, e.source, e.granted_by, e.created_at,
         p.partner_id, pp.username, pu.email::text,
         CASE WHEN p.partner_id IS NULL THEN 'solo' WHEN pp.partner_id = p.user_id THEN 'mutual' ELSE 'one_way' END
  FROM public.entitlements e
  JOIN public.profiles p ON p.user_id = e.user_id
  JOIN auth.users u ON u.id = e.user_id
  LEFT JOIN public.profiles pp ON pp.user_id = p.partner_id
  LEFT JOIN auth.users pu ON pu.id = p.partner_id
  WHERE e.status = 'active'
    AND e.source IN ('admin_grant', 'founder_grant', 'beta_grant')
    AND (e.expires_at IS NULL OR e.expires_at > now())
  ORDER BY e.created_at DESC
  LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_grants() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_grants() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Payments / refunds / failed transactions
-- ---------------------------------------------------------------------------
-- Estimated store/provider fee. These rates are ASSUMPTIONS for a rough
-- "commission" figure (Google Play / Apple small-business subscription rate,
-- Razorpay typical rate) - NOT read from provider settlement reports.
CREATE OR REPLACE FUNCTION private.est_fee_bps(_provider public.payment_provider)
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE _provider WHEN 'google_play' THEN 1500 WHEN 'apple' THEN 1500 WHEN 'razorpay' THEN 200 ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION private.est_fee_bps(public.payment_provider) FROM public, anon, authenticated;

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
      COALESCE(sum((amount_minor::numeric * private.est_fee_bps(provider) / 10000)::bigint)
               FILTER (WHERE status NOT IN ('pending','failed','refunded','revoked')), 0) AS est_fee_minor,
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

-- filter: all | paid | refunded | failed | pending
CREATE OR REPLACE FUNCTION public.admin_list_transactions(_filter text DEFAULT 'all', _limit integer DEFAULT 30, _offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  username text,
  email text,
  provider public.payment_provider,
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
  SELECT t.id, t.user_id, p.username, u.email::text, t.provider, t.plan, t.amount_minor, t.currency, t.status,
         t.created_at, t.expires_at, t.refunded_at,
         (t.amount_minor::numeric * private.est_fee_bps(t.provider) / 10000)::integer,
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
-- 4. user_notices: "an admin granted you Beta/Founder" card
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan_granted', 'plan_revoked')),
  plan public.entitlement_plan,
  title text NOT NULL,
  body text NOT NULL,
  entitlement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_user_notices_user_unseen ON public.user_notices (user_id, created_at DESC) WHERE seen_at IS NULL;
ALTER TABLE public.user_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own notices" ON public.user_notices;
CREATE POLICY "Users can read own notices"
  ON public.user_notices FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- No client write policies; seen_at is set only through mark_notice_seen().

ALTER TABLE public.user_notices REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notices;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.mark_notice_seen(_notice_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.user_notices SET seen_at = now()
  WHERE id = _notice_id AND user_id = auth.uid() AND seen_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.mark_notice_seen(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mark_notice_seen(uuid) TO authenticated;

-- Fires for every writer (RPC, SQL editor, service role). Only the manual,
-- complimentary grants notify; purchases and the allowlisted-admin bootstrap
-- row never do.
CREATE OR REPLACE FUNCTION public.notify_user_on_complimentary_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _label text;
  _title text;
  _body text;
  _sender text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.source NOT IN ('founder_grant', 'beta_grant') THEN RETURN NEW; END IF;
    IF NEW.granted_by IS NOT DISTINCT FROM NEW.user_id THEN RETURN NEW; END IF; -- self-grant: no card

    _label := CASE NEW.plan WHEN 'FOUNDER' THEN 'Founder' ELSE 'Beta' END;
    _title := CASE NEW.plan WHEN 'FOUNDER' THEN 'You''re a DuoSpace Founder 👑' ELSE 'You''re in the DuoSpace Beta 🎉' END;
    _body  := 'An admin has granted you ' || _label || ' access, which unlocks DuoSpace Pro features for you. Enjoy!';

    INSERT INTO public.user_notices (user_id, kind, plan, title, body, entitlement_id)
    VALUES (NEW.user_id, 'plan_granted', NEW.plan, _title, _body, NEW.id);

    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'custom',
      'recipientId', NEW.user_id,
      'title', _title,
      'body', _body,
      'relatedId', NEW.id
    ));

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'active' AND NEW.status = 'revoked' AND NEW.source IN ('founder_grant', 'beta_grant') THEN
      INSERT INTO public.user_notices (user_id, kind, plan, title, body, entitlement_id)
      VALUES (NEW.user_id, 'plan_revoked', NEW.plan, 'Your ' || CASE NEW.plan WHEN 'FOUNDER' THEN 'Founder' ELSE 'Beta' END || ' access has ended',
              'An admin has ended your complimentary access. Your chats, photos and everything you''ve shared stay exactly as they are.', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A notice failure must never roll back the grant itself.
  RAISE WARNING 'grant notice failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_user_on_complimentary_grant() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS entitlements_notify_complimentary_grant ON public.entitlements;
CREATE TRIGGER entitlements_notify_complimentary_grant
  AFTER INSERT OR UPDATE ON public.entitlements
  FOR EACH ROW EXECUTE FUNCTION public.notify_user_on_complimentary_grant();

-- ---------------------------------------------------------------------------
-- 5. Announcements / offers / important updates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('important_update', 'offer', 'announcement')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  cta_label text CHECK (cta_label IS NULL OR char_length(cta_label) <= 30),
  cta_url text CHECK (cta_url IS NULL OR cta_url ~ '^https://'),
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'free', 'paid', 'linked', 'solo')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  push_requested boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_announcements FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_announcements TO service_role;
-- No policies: users read through get_my_announcements() (audience-filtered).

CREATE TABLE IF NOT EXISTS public.admin_announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES public.admin_announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
ALTER TABLE public.admin_announcement_dismissals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own dismissals" ON public.admin_announcement_dismissals;
CREATE POLICY "Users can read own dismissals"
  ON public.admin_announcement_dismissals FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION private.announcement_audience_ok(_audience text, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE _audience
    WHEN 'all'    THEN true
    WHEN 'linked' THEN EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _user_id AND partner_id IS NOT NULL)
    WHEN 'solo'   THEN EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _user_id AND partner_id IS NULL)
    WHEN 'paid'   THEN public._compute_entitlement_plan(_user_id) IN ('PLUS_INDIVIDUAL','PLUS_COUPLE','PRO_INDIVIDUAL','PRO_COUPLE')
    WHEN 'free'   THEN public._compute_entitlement_plan(_user_id) = 'FREE'
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION private.announcement_audience_ok(text, uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_announcements()
RETURNS TABLE (id uuid, kind text, title text, body text, cta_label text, cta_url text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT a.id, a.kind, a.title, a.body, a.cta_label, a.cta_url, a.created_at
  FROM public.admin_announcements a
  WHERE a.active
    AND a.starts_at <= now()
    AND (a.expires_at IS NULL OR a.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM public.admin_announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = auth.uid())
    AND private.announcement_audience_ok(a.audience, auth.uid())
  ORDER BY a.created_at DESC
  LIMIT 5;
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_announcements() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_announcements() TO authenticated;

CREATE OR REPLACE FUNCTION public.dismiss_announcement(_announcement_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.admin_announcement_dismissals (announcement_id, user_id)
  SELECT _announcement_id, auth.uid()
  WHERE auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.admin_announcements WHERE id = _announcement_id)
  ON CONFLICT DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public.dismiss_announcement(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_announcement(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_publish_announcement(
  _kind text, _title text, _body text, _audience text DEFAULT 'all',
  _cta_label text DEFAULT NULL, _cta_url text DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL, _push boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid;
  _recipients uuid[];
BEGIN
  PERFORM private.assert_admin();

  INSERT INTO public.admin_announcements (kind, title, body, audience, cta_label, cta_url, expires_at, push_requested, created_by)
  VALUES (_kind, trim(_title), trim(_body), COALESCE(_audience, 'all'), NULLIF(trim(_cta_label), ''), NULLIF(trim(_cta_url), ''),
          _expires_at, COALESCE(_push, false), auth.uid())
  RETURNING id INTO _id;

  IF COALESCE(_push, false) THEN
    -- Push is capped at 1000 recipients per publish; the in-app card still
    -- reaches everyone in the audience regardless.
    SELECT array_agg(user_id) INTO _recipients FROM (
      SELECT p.user_id FROM public.profiles p
      WHERE p.push_token IS NOT NULL
        AND private.announcement_audience_ok(COALESCE(_audience, 'all'), p.user_id)
      LIMIT 1000
    ) r;
    IF _recipients IS NOT NULL AND array_length(_recipients, 1) > 0 THEN
      PERFORM private.dispatch_push(jsonb_build_object(
        'internal', true, 'type', 'custom',
        'recipientIds', to_jsonb(_recipients),
        'title', trim(_title), 'body', trim(_body), 'relatedId', _id
      ));
    END IF;
  END IF;

  PERFORM private.admin_log('publish_announcement', NULL,
    jsonb_build_object('id', _id, 'kind', _kind, 'audience', COALESCE(_audience, 'all'), 'push', COALESCE(_push, false)));
  RETURN _id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_publish_announcement(text, text, text, text, text, text, timestamptz, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_publish_announcement(text, text, text, text, text, text, timestamptz, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_announcement_active(_id uuid, _active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  UPDATE public.admin_announcements SET active = _active WHERE id = _id;
  PERFORM private.admin_log(CASE WHEN _active THEN 'enable_announcement' ELSE 'disable_announcement' END, NULL, jsonb_build_object('id', _id));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_announcement_active(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_announcement_active(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_announcements()
RETURNS TABLE (id uuid, kind text, title text, body text, audience text, cta_label text, cta_url text,
               starts_at timestamptz, expires_at timestamptz, active boolean, push_requested boolean,
               created_at timestamptz, dismissed_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  RETURN QUERY
  SELECT a.id, a.kind, a.title, a.body, a.audience, a.cta_label, a.cta_url, a.starts_at, a.expires_at, a.active,
         a.push_requested, a.created_at,
         (SELECT count(*) FROM public.admin_announcement_dismissals d WHERE d.announcement_id = a.id)
  FROM public.admin_announcements a
  ORDER BY a.created_at DESC
  LIMIT 50;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_announcements() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_announcements() TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. App update config (single row)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_update_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),         -- exactly one row
  latest_version text NOT NULL DEFAULT '0.0.0' CHECK (latest_version ~ '^\d+\.\d+\.\d+$'),
  min_supported_version text NOT NULL DEFAULT '0.0.0' CHECK (min_supported_version ~ '^\d+\.\d+\.\d+$'),
  message text CHECK (message IS NULL OR char_length(message) <= 300),
  android_url text CHECK (android_url IS NULL OR android_url ~ '^https://'),
  ios_url text CHECK (ios_url IS NULL OR ios_url ~ '^https://'),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.app_update_config (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.app_update_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read app update config" ON public.app_update_config;
CREATE POLICY "Anyone can read app update config"
  ON public.app_update_config FOR SELECT TO anon, authenticated
  USING (true);
-- Writes only via admin_set_app_update().

CREATE OR REPLACE FUNCTION public.admin_set_app_update(
  _latest text, _min_supported text, _message text DEFAULT NULL,
  _android_url text DEFAULT NULL, _ios_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  UPDATE public.app_update_config
  SET latest_version = trim(_latest), min_supported_version = trim(_min_supported),
      message = NULLIF(trim(_message), ''), android_url = NULLIF(trim(_android_url), ''), ios_url = NULLIF(trim(_ios_url), ''),
      updated_by = auth.uid(), updated_at = now()
  WHERE id;
  PERFORM private.admin_log('set_app_update', NULL, jsonb_build_object('latest', _latest, 'min', _min_supported));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_app_update(text, text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_update(text, text, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Audit log reader
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_audit(_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, action text, target_user_id uuid, target_username text, details jsonb, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.assert_admin();
  RETURN QUERY
  SELECT l.id, l.action, l.target_user_id, p.username, l.details, l.created_at
  FROM public.admin_audit_log l
  LEFT JOIN public.profiles p ON p.user_id = l.target_user_id
  ORDER BY l.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_audit(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_audit(integer) TO authenticated;

-- Grants/revokes made through the existing RPCs should also be auditable.
CREATE OR REPLACE FUNCTION public.audit_entitlement_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.source IN ('founder_grant', 'beta_grant') AND NEW.granted_by IS NOT NULL THEN
    INSERT INTO public.admin_audit_log (actor_id, action, target_user_id, details)
    VALUES (NEW.granted_by, 'grant_' || lower(NEW.plan::text), NEW.user_id, jsonb_build_object('entitlement_id', NEW.id));
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'revoked' AND NEW.source IN ('founder_grant', 'beta_grant') THEN
    INSERT INTO public.admin_audit_log (actor_id, action, target_user_id, details)
    VALUES (COALESCE(auth.uid(), NEW.granted_by), 'revoke_' || lower(NEW.plan::text), NEW.user_id, jsonb_build_object('entitlement_id', NEW.id));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_entitlement_grants() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS entitlements_audit_grants ON public.entitlements;
CREATE TRIGGER entitlements_audit_grants
  AFTER INSERT OR UPDATE ON public.entitlements
  FOR EACH ROW EXECUTE FUNCTION public.audit_entitlement_grants();
