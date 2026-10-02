-- Fixes a real gap introduced by the payment_transactions refactor
-- (20260927140000): entitlements now link via payment_transaction_id, not
-- purchase_event_id, but reconcile_linked_purchase_token() still only
-- touched purchase_events/entitlements via purchase_event_id. That join now
-- matches nothing, so a REPLACED Google subscription's old token silently
-- kept granting access — the exact "old token continues granting Plus
-- after replacement" failure this was supposed to prevent.
--
-- Fix: a ledger-aware replacement function that marks the OLD
-- payment_transactions row 'replaced' and revokes its entitlement through
-- the same reconcile_entitlement_from_transaction() path everything else
-- uses, so there is still exactly one way an entitlement's status changes.
CREATE OR REPLACE FUNCTION public.reconcile_replaced_transaction(
  _old_purchase_token_hash text,
  _new_transaction_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _old_id uuid;
BEGIN
  SELECT id INTO _old_id
  FROM public.payment_transactions
  WHERE provider_purchase_token_hash = _old_purchase_token_hash
    AND status NOT IN ('replaced', 'revoked', 'refunded');

  IF _old_id IS NULL THEN
    RETURN; -- nothing to replace, or already terminal — not an error
  END IF;

  UPDATE public.payment_transactions
  SET status = 'replaced', replaced_by_transaction_id = _new_transaction_id
  WHERE id = _old_id;

  PERFORM public.reconcile_entitlement_from_transaction(_old_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_replaced_transaction(text, uuid) FROM public, anon, authenticated;
-- service_role only, same as reconcile_entitlement_from_transaction and
-- reconcile_linked_purchase_token.

-- reconcile_linked_purchase_token is superseded by the above for anything
-- created after the ledger refactor. Left in place (not dropped) since old
-- purchase_events-only rows from before the refactor may still reference
-- it, and dropping a function a prior migration granted execute on is not
-- worth the risk here — it's simply no longer called from application code.
