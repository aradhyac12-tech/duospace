-- PHASE 9/10/13 hardening: real Google Play subscription lifecycle states,
-- linkedPurchaseToken-based replacement handling, RTDN event dedupe, and the
-- account-binding column. Additive only.

-- Google's subscription lifecycle has more states than "active/expired".
-- Modeled per SubscriptionPurchaseV2.subscriptionState. This is layered on
-- top of entitlement_status (active/cancelled/expired/revoked), which stays
-- the coarse "does this currently grant access" signal the app already
-- reads everywhere (get_effective_entitlement only checks status/expires_at
-- — unchanged); subscription_state is the detailed Google-side reason,
-- kept for observability, support, and correct reconciliation logic.
CREATE TYPE public.subscription_lifecycle_state AS ENUM (
  'active',
  'pending',
  'canceled',        -- will not renew, but still active until expiry (maps to entitlement_status 'cancelled')
  'in_grace_period',
  'on_hold',
  'paused',
  'expired',
  'revoked'
);

ALTER TABLE public.purchase_events
  ADD COLUMN IF NOT EXISTS subscription_state public.subscription_lifecycle_state,
  ADD COLUMN IF NOT EXISTS linked_purchase_token_hash text,  -- hash of the OLD token this purchase replaces, when Google reports one
  ADD COLUMN IF NOT EXISTS obfuscated_account_id text,       -- the value this purchase was launched/verified with (PHASE 6)
  ADD COLUMN IF NOT EXISTS acknowledged boolean NOT NULL DEFAULT false;

ALTER TABLE public.entitlements
  ADD COLUMN IF NOT EXISTS subscription_state public.subscription_lifecycle_state,
  ADD COLUMN IF NOT EXISTS purchase_event_id uuid REFERENCES public.purchase_events(id);

-- When a subscription is replaced (upgrade/downgrade/resubscribe), Google
-- reports the NEW purchase with a linkedPurchaseToken pointing at the OLD
-- one. The old token's purchase_events row + any entitlement it produced
-- must stop granting access even though its own expires_at may not have
-- passed yet (PHASE 9: "do not allow an old subscription token to continue
-- granting Plus after it has been replaced"). This function does that
-- reconciliation atomically. Called from verify-google-play-purchase and
-- from RTDN processing — both paths funnel through here so the logic only
-- exists once.
CREATE OR REPLACE FUNCTION public.reconcile_linked_purchase_token(
  _old_token_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.purchase_events
  SET subscription_state = 'revoked', status = 'invalid', verification_status = 'superseded'
  WHERE purchase_token_hash = _old_token_hash
    AND status = 'verified';

  UPDATE public.entitlements e
  SET status = 'revoked', subscription_state = 'revoked'
  FROM public.purchase_events pe
  WHERE pe.purchase_token_hash = _old_token_hash
    AND e.purchase_event_id = pe.id
    AND e.status = 'active';
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_linked_purchase_token(text) FROM public, anon, authenticated;
-- service_role only (called from Edge Functions), never from the client.

-- RTDN (Real-Time Developer Notifications) dedupe + audit trail. Google can
-- and does redeliver the same Pub/Sub message; messageId is the dedupe key
-- Google itself guarantees is unique per notification. PHASE 10/13: process
-- idempotently, never store more payload than needed for reconciliation.
CREATE TABLE public.rtdn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id text NOT NULL UNIQUE,          -- Pub/Sub messageId — the real dedupe key
  notification_type integer,                 -- SubscriptionNotificationType enum value
  purchase_token_hash text,
  subscription_id text,
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'received', -- 'received' | 'processed' | 'ignored' | 'error'
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rtdn_events_token ON public.rtdn_events (purchase_token_hash);

ALTER TABLE public.rtdn_events ENABLE ROW LEVEL SECURITY;
-- No policies at all for authenticated/anon — this table is never read or
-- written by the client, only by the RTDN Edge Function via service_role.
-- (Passes this repo's own check-rls-coverage.mjs as a documented
-- service-role-only table, same pattern as location_push_credentials.)
REVOKE ALL ON TABLE public.rtdn_events FROM anon, authenticated;
GRANT ALL ON TABLE public.rtdn_events TO service_role;
