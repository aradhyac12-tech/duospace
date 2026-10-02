-- Admin lockdown + admin-partner premium.
--
-- 1. Exactly one account may ever hold an ACTIVE ADMIN entitlement. The
--    allowlist lives in the database (never in client code), and a trigger
--    enforces it for every writer, including service_role and the SQL editor.
-- 2. The partner of an ADMIN inherits full premium access (as FOUNDER: same
--    feature set as Plus, but WITHOUT the Admin panel, which is gated on the
--    ADMIN plan). Resolved live from profiles.partner_id in both directions,
--    same relink-safe rule as PLUS_COUPLE.
-- 3. grant_entitlement can no longer mint ADMIN.

CREATE TABLE IF NOT EXISTS public.admin_allowlist (
  email text PRIMARY KEY CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_allowlist ENABLE ROW LEVEL SECURITY;
-- Service-role-only table: no policies for anon/authenticated (same pattern
-- as rtdn_events / location_push_credentials).
REVOKE ALL ON TABLE public.admin_allowlist FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_allowlist TO service_role;

INSERT INTO public.admin_allowlist (email)
VALUES ('chavanaradhya1@gmail.com')
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_admin_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.plan = 'ADMIN' AND NEW.status = 'active' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM auth.users u
      JOIN public.admin_allowlist a ON a.email = lower(u.email)
      WHERE u.id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'this account is not allowed to hold the ADMIN plan';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_admin_allowlist() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS entitlements_enforce_admin_allowlist ON public.entitlements;
CREATE TRIGGER entitlements_enforce_admin_allowlist
  BEFORE INSERT OR UPDATE ON public.entitlements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_admin_allowlist();

-- Clean up: revoke any active ADMIN that is not on the allowlist, then make
-- sure the allowlisted account has one.
UPDATE public.entitlements e
SET status = 'revoked'
WHERE e.plan = 'ADMIN' AND e.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM auth.users u JOIN public.admin_allowlist a ON a.email = lower(u.email)
    WHERE u.id = e.user_id
  );

INSERT INTO public.entitlements (user_id, plan, status, source, granted_by, expires_at, metadata)
SELECT u.id, 'ADMIN', 'active', 'admin_grant', u.id, NULL, jsonb_build_object('note', 'allowlisted admin')
FROM auth.users u
JOIN public.admin_allowlist a ON a.email = lower(u.email)
WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.entitlements e
    WHERE e.user_id = u.id AND e.plan = 'ADMIN' AND e.status = 'active'
  );

-- grant_entitlement: ADMIN is no longer grantable through the RPC.
CREATE OR REPLACE FUNCTION public.grant_entitlement(
  _target_user_id uuid,
  _plan public.entitlement_plan,
  _note text DEFAULT NULL
)
RETURNS public.entitlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _result public.entitlements;
  _source text;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF public.get_effective_entitlement(_caller) <> 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin can grant entitlements';
  END IF;

  IF _plan NOT IN ('FOUNDER', 'BETA') THEN
    RAISE EXCEPTION 'grant_entitlement may only be used for FOUNDER or BETA — ADMIN is restricted and paid plans must come from verified purchases';
  END IF;

  _source := CASE _plan WHEN 'FOUNDER' THEN 'founder_grant' ELSE 'beta_grant' END;

  INSERT INTO public.entitlements (user_id, plan, status, source, granted_by, expires_at, metadata)
  VALUES (_target_user_id, _plan, 'active', _source, _caller, NULL, jsonb_build_object('note', _note))
  RETURNING * INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_entitlement(uuid, public.entitlement_plan, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.grant_entitlement(uuid, public.entitlement_plan, text) TO authenticated;

-- Effective plan: own entitlement wins; otherwise the live partner's ADMIN
-- (-> FOUNDER-level premium) or PLUS_COUPLE; otherwise FREE.
CREATE OR REPLACE FUNCTION public._compute_entitlement_plan(_user_id uuid)
RETURNS public.entitlement_plan
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _own_plan public.entitlement_plan;
  _partner_id uuid;
  _partner_plan public.entitlement_plan;
BEGIN
  SELECT plan INTO _own_plan
  FROM public.entitlements
  WHERE user_id = _user_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY
    CASE plan
      WHEN 'ADMIN' THEN 1 WHEN 'FOUNDER' THEN 2 WHEN 'LIFETIME' THEN 3
      WHEN 'PLUS_COUPLE' THEN 4 WHEN 'PLUS_INDIVIDUAL' THEN 5 WHEN 'BETA' THEN 6
      ELSE 9
    END
  LIMIT 1;

  IF _own_plan IS NOT NULL THEN
    RETURN _own_plan;
  END IF;

  SELECT partner_id INTO _partner_id FROM public.profiles WHERE user_id = _user_id;

  IF _partner_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _partner_id AND partner_id = _user_id) THEN
    SELECT plan INTO _partner_plan
    FROM public.entitlements
    WHERE user_id = _partner_id
      AND plan IN ('ADMIN', 'PLUS_COUPLE')
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY CASE plan WHEN 'ADMIN' THEN 1 ELSE 2 END
    LIMIT 1;

    IF _partner_plan = 'ADMIN' THEN
      RETURN 'FOUNDER';       -- full premium, no Admin panel
    ELSIF _partner_plan = 'PLUS_COUPLE' THEN
      RETURN 'PLUS_COUPLE';
    END IF;
  END IF;

  RETURN 'FREE';
END;
$$;

REVOKE ALL ON FUNCTION public._compute_entitlement_plan(uuid) FROM public, anon, authenticated;
