-- PHASE 3/4/10: provider-agnostic commerce core. entitlements stays the
-- server-authoritative ACCESS RESULT (unchanged — get_effective_entitlement
-- still just reads status/expires_at from it, nothing here touches that
-- contract). payment_transactions becomes the actual payment ledger, one
-- row per provider transaction/subscription-period, across every provider.
-- commercial_products is the catalog so ₹149/₹199 and provider product IDs
-- live in one place instead of scattered through Kotlin/TS/Edge Functions.

CREATE TYPE public.payment_provider AS ENUM ('google_play', 'razorpay', 'apple');

CREATE TYPE public.transaction_status AS ENUM (
  'pending',     -- created, awaiting payment/verification
  'active',
  'cancelled',   -- won't renew, active until period end
  'in_grace_period',
  'on_hold',
  'paused',
  'expired',
  'refunded',
  'revoked',
  'failed',
  'replaced'     -- superseded by a newer transaction (upgrade/downgrade/resubscribe)
);

-- The commercial catalog: one row per (plan, billing period) with each
-- provider's own product/plan identifier attached. This is what PHASE 10
-- means by "provider product IDs must be configuration/database data, not
-- hard-coded throughout UI components" — the client reads this table
-- (via a thin view, see below) instead of importing a hard-coded map.
CREATE TABLE public.commercial_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan public.entitlement_plan NOT NULL,       -- PLUS_INDIVIDUAL / PLUS_COUPLE only — FREE/FOUNDER/etc never sold
  billing_period text NOT NULL DEFAULT 'monthly',
  base_price_minor integer NOT NULL,            -- ₹149 -> 14900. Integer minor units, never float.
  base_currency text NOT NULL DEFAULT 'INR',
  google_product_id text,
  google_base_plan_id text,
  razorpay_plan_id text,
  apple_product_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan, billing_period)
);

CREATE TRIGGER commercial_products_set_updated_at
  BEFORE UPDATE ON public.commercial_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.commercial_products (plan, billing_period, base_price_minor, base_currency, google_product_id, razorpay_plan_id)
VALUES
  ('PLUS_INDIVIDUAL', 'monthly', 14900, 'INR', 'duospace_plus_individual_monthly', NULL),
  ('PLUS_COUPLE', 'monthly', 19900, 'INR', 'duospace_plus_couple_monthly', NULL);
-- razorpay_plan_id left NULL until a real Razorpay plan is created via the
-- Razorpay dashboard/API and the ID is filled in (REQUIRES RAZORPAY ACCOUNT).

ALTER TABLE public.commercial_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read active commercial products"
  ON public.commercial_products FOR SELECT
  TO authenticated
  USING (active = true);
-- No write policy for authenticated — catalog is admin/service-role-managed.

-- The payment ledger. One row per provider transaction or billing period.
-- Distinct from purchase_events (Google-specific raw verification log,
-- kept for its own audit trail) and from entitlements (the access result) —
-- this is the commercial record: what was bought, from whom, for how much.
CREATE TABLE public.payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  provider public.payment_provider NOT NULL,
  provider_transaction_id text,            -- Razorpay payment_id / order_id, Google orderId, Apple transactionId
  provider_subscription_id text,           -- Razorpay subscription_id, Google subscriptionId
  provider_purchase_token_hash text,       -- Google purchaseToken, hashed — never store raw
  product_id uuid NOT NULL REFERENCES public.commercial_products(id),
  plan public.entitlement_plan NOT NULL,
  billing_period text NOT NULL DEFAULT 'monthly',
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  status public.transaction_status NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  expires_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  revoked_at timestamptz,
  replaced_by_transaction_id uuid REFERENCES public.payment_transactions(id),
  obfuscated_account_id text,              -- PHASE 6 account-binding value this transaction was bound to
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: a given provider transaction/purchase token is recorded
  -- exactly once, whatever number of times verification/webhooks retry it.
  UNIQUE (provider, provider_transaction_id),
  UNIQUE (provider, provider_purchase_token_hash)
);

CREATE INDEX idx_payment_transactions_user ON public.payment_transactions (user_id, created_at DESC);
CREATE INDEX idx_payment_transactions_subscription ON public.payment_transactions (provider, provider_subscription_id);

CREATE TRIGGER payment_transactions_set_updated_at
  BEFORE UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.entitlements
  ADD COLUMN IF NOT EXISTS payment_transaction_id uuid REFERENCES public.payment_transactions(id);

ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own payment transactions"
  ON public.payment_transactions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
-- No INSERT/UPDATE/DELETE policy for authenticated — service_role
-- (Edge Functions) is the only writer, same principle as entitlements.

-- PHASE 4: the ONE place a provider transaction becomes an entitlement.
-- Both verify-google-play-purchase and the Razorpay webhook call this
-- instead of inserting into entitlements directly, so there is exactly one
-- reconciliation code path regardless of provider. Idempotent: calling it
-- twice for the same transaction produces the same entitlement state, not
-- a duplicate active row.
CREATE OR REPLACE FUNCTION public.reconcile_entitlement_from_transaction(_transaction_id uuid)
RETURNS public.entitlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn public.payment_transactions;
  _entitlement_status public.entitlement_status;
  _existing_entitlement_id uuid;
  _product_label text;
  _result public.entitlements;
BEGIN
  SELECT * INTO _txn FROM public.payment_transactions WHERE id = _transaction_id;
  IF _txn IS NULL THEN
    RAISE EXCEPTION 'transaction not found';
  END IF;

  -- entitlements.product_id is a free-text label (pre-existing column, used
  -- for display/audit only — plan is what actually gates features). Prefer
  -- the provider's own product id for that provider; fall back to the plan
  -- name if the catalog row is missing one for some reason.
  SELECT COALESCE(
    CASE _txn.provider
      WHEN 'google_play' THEN cp.google_product_id
      WHEN 'razorpay' THEN cp.razorpay_plan_id
      WHEN 'apple' THEN cp.apple_product_id
    END,
    _txn.plan::text
  ) INTO _product_label
  FROM public.commercial_products cp WHERE cp.id = _txn.product_id;

  _entitlement_status := CASE _txn.status
    WHEN 'active' THEN 'active'
    WHEN 'in_grace_period' THEN 'active'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'on_hold' THEN 'cancelled'
    WHEN 'paused' THEN 'expired'
    WHEN 'expired' THEN 'expired'
    WHEN 'refunded' THEN 'revoked'
    WHEN 'revoked' THEN 'revoked'
    WHEN 'replaced' THEN 'revoked'
    ELSE 'expired' -- 'pending'/'failed' grant nothing
  END;

  -- Idempotent upsert: one entitlement row per transaction, not per event.
  -- A renewal/state-change UPDATEs the same entitlement row (found via
  -- purchase_transaction_id) rather than inserting a new active row
  -- alongside old ones — this is what PHASE 4 means by "a renewal should
  -- update the existing... state rather than creating uncontrolled
  -- independent entitlement rows."
  SELECT id INTO _existing_entitlement_id
  FROM public.entitlements
  WHERE payment_transaction_id = _transaction_id;

  IF _existing_entitlement_id IS NOT NULL THEN
    UPDATE public.entitlements
    SET status = _entitlement_status, expires_at = _txn.expires_at, updated_at = now()
    WHERE id = _existing_entitlement_id
    RETURNING * INTO _result;
  ELSE
    INSERT INTO public.entitlements (user_id, plan, status, source, product_id, expires_at, payment_transaction_id)
    VALUES (_txn.user_id, _txn.plan, _entitlement_status, _txn.provider::text, _product_label, _txn.expires_at, _transaction_id)
    RETURNING * INTO _result;
  END IF;

  -- Replacement handling (PHASE 9, now provider-agnostic): if this
  -- transaction replaces another, the OLD one's entitlement is revoked
  -- regardless of its own expires_at.
  IF _txn.replaced_by_transaction_id IS NULL THEN
    UPDATE public.entitlements
    SET status = 'revoked'
    WHERE payment_transaction_id IN (
      SELECT id FROM public.payment_transactions WHERE replaced_by_transaction_id = _transaction_id
    ) AND status = 'active';
  END IF;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_entitlement_from_transaction(uuid) FROM public, anon, authenticated;
-- service_role only, called from Edge Functions.

