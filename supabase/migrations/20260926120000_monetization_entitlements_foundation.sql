-- Monetization foundation: entitlements + purchase_events + server-authoritative
-- feature gating. Additive only — does not touch profiles, chat, calls, or any
-- existing table/RLS policy. Follows the existing get_partner_id() pattern:
-- every SECURITY DEFINER function validates _user_id = auth.uid() itself.
--
-- Design note on the couple-plan risk called out in the spec (A buys Couple
-- Plus, A+B linked, B gets Plus, A unlinks B, A links C -> C must NOT
-- silently inherit access): entitlements are owned by a single user_id, never
-- duplicated onto the partner. Couple access is computed live, at read time,
-- from profiles.partner_id — so it always reflects the *current* pairing,
-- never a cached one. If A unlinks B and links C, C is only covered once the
-- live partner_id lookup resolves to A, which is correct and desired; B loses
-- coverage the instant the unlink happens because the same live lookup no
-- longer resolves to A for B.

CREATE TYPE public.entitlement_plan AS ENUM (
  'FREE',
  'PLUS_INDIVIDUAL',
  'PLUS_COUPLE',
  'LIFETIME',
  'FOUNDER',
  'BETA',
  'ADMIN'
);

CREATE TYPE public.entitlement_status AS ENUM (
  'active',
  'cancelled',   -- will not renew, but still active until expires_at
  'expired',
  'revoked'      -- forcibly removed (chargeback, fraud, admin action)
);

-- One row per *purchasing* user. Never duplicated onto a partner — couple
-- coverage is derived live in get_effective_entitlement(), not stored twice.
CREATE TABLE public.entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  plan public.entitlement_plan NOT NULL,
  status public.entitlement_status NOT NULL DEFAULT 'active',
  source text NOT NULL DEFAULT 'google_play', -- 'google_play' | 'app_store' | 'founder_grant' | 'beta_grant' | 'admin_grant'
  product_id text,                            -- e.g. duospace_plus_individual_monthly
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                     -- null = never expires (FOUNDER/ADMIN/LIFETIME)
  granted_by uuid REFERENCES public.profiles(user_id), -- who granted a manual entitlement, if applicable
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_entitlements_user_active
  ON public.entitlements (user_id)
  WHERE status = 'active';

CREATE TRIGGER entitlements_set_updated_at
  BEFORE UPDATE ON public.entitlements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auditable, replay-safe record of every purchase notification received,
-- whether or not it resulted in an entitlement change. purchase_token is
-- hashed, never stored raw, per PHASE 5.
CREATE TABLE public.purchase_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  platform text NOT NULL,               -- 'google_play' | 'app_store'
  product_id text NOT NULL,
  purchase_token_hash text NOT NULL,    -- sha256 of the raw token; raw token never stored
  order_id text,
  status text NOT NULL,                 -- 'verified' | 'invalid' | 'duplicate' | 'pending'
  verification_status text NOT NULL DEFAULT 'pending',
  purchased_at timestamptz,
  expires_at timestamptz,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, -- safe fields only, never full provider payload
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, purchase_token_hash) -- hard replay-protection constraint
);

CREATE INDEX idx_purchase_events_user ON public.purchase_events (user_id, created_at DESC);

CREATE TRIGGER purchase_events_set_updated_at
  BEFORE UPDATE ON public.purchase_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === RLS =====================================================================
-- Clients may only ever READ their own entitlement/purchase rows. All writes
-- happen through service_role from the verification Edge Function — never
-- from the app. This is what makes "client says I paid" impossible: there is
-- no INSERT/UPDATE policy for `authenticated` on either table.

ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own entitlements"
  ON public.entitlements FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can view own purchase events"
  ON public.purchase_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- No INSERT / UPDATE / DELETE policies for `authenticated` on either table
-- — intentionally. service_role (used only inside Edge Functions) bypasses
-- RLS and is the sole writer.

-- === Effective entitlement (server-authoritative, live couple resolution) ===
--
-- Returns the single highest-priority plan currently in effect for a user:
-- their own non-expired entitlement, or — if none — a PLUS_COUPLE their
-- *current* partner holds. SECURITY DEFINER + auth.uid() self-check, same
-- pattern as get_partner_id().
CREATE OR REPLACE FUNCTION public.get_effective_entitlement(_user_id uuid)
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
  -- M1 fix (found on staging before this was ever deployed): with no JWT,
  -- auth.uid() is NULL, `_user_id <> NULL` is NULL (not true), the guard was
  -- skipped and an anonymous caller could read ANY user's plan.
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN
    RETURN 'FREE';
  END IF;

  SELECT plan INTO _own_plan
  FROM public.entitlements
  WHERE user_id = _user_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY
    CASE plan
      WHEN 'ADMIN' THEN 1
      WHEN 'FOUNDER' THEN 2
      WHEN 'LIFETIME' THEN 3
      WHEN 'PLUS_COUPLE' THEN 4
      WHEN 'PLUS_INDIVIDUAL' THEN 5
      WHEN 'BETA' THEN 6
      ELSE 9
    END
  LIMIT 1;

  IF _own_plan IS NOT NULL THEN
    RETURN _own_plan;
  END IF;

  -- No entitlement of their own — check whether their *current* partner
  -- holds an active PLUS_COUPLE plan. Read live from profiles, never cached,
  -- so unlink/relink is always correct.
  SELECT partner_id INTO _partner_id FROM public.profiles WHERE user_id = _user_id;

  IF _partner_id IS NOT NULL THEN
    SELECT plan INTO _partner_plan
    FROM public.entitlements
    WHERE user_id = _partner_id
      AND plan = 'PLUS_COUPLE'
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

    -- Only honor it if the partner's profile currently points back at us —
    -- guards the exact A/B/C relink scenario from the spec.
    IF _partner_plan IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id = _partner_id AND partner_id = _user_id
      ) THEN
        RETURN 'PLUS_COUPLE';
      END IF;
    END IF;
  END IF;

  RETURN 'FREE';
END;
$$;

REVOKE ALL ON FUNCTION public.get_effective_entitlement(uuid) FROM public;
-- Supabase's default privileges grant EXECUTE to anon directly; revoking from
-- PUBLIC does not remove that, so revoke it explicitly (M1).
REVOKE ALL ON FUNCTION public.get_effective_entitlement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_effective_entitlement(uuid) TO authenticated, service_role;

-- Convenience view for the client to read its own effective plan in one
-- query instead of calling the RPC ad hoc everywhere.
CREATE OR REPLACE VIEW public.my_entitlement AS
SELECT public.get_effective_entitlement(auth.uid()) AS plan;

GRANT SELECT ON public.my_entitlement TO authenticated;
