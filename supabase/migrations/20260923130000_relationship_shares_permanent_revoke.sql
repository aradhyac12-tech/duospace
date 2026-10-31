-- Phase 2B hardening: a revoked share is PERMANENTLY revoked, and share rows
-- are immutable records with explicit revoke semantics.
--
-- Gaps closed (20260922100000 froze identity columns only):
--   1. revoked_at could go timestamp -> NULL (resurrecting partner access)
--      or be re-dated;
--   2. expires_at was not frozen: an owner could extend a share indefinitely;
--   3. on INSERT the client chose created_at / expires_at / revoked_at freely;
--   4. the recipient SELECT policy did not re-check the partnership (unlink
--      revokes rows, but the read path now also refuses a non-partner).
-- RLS is only tightened here, never loosened.

CREATE OR REPLACE FUNCTION public.enforce_relationship_share_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Server-owned lifecycle fields: never client-chosen.
    NEW.created_at := now();
    NEW.revoked_at := NULL;
    IF NEW.expires_at IS NULL OR NEW.expires_at > now() + interval '180 days' THEN
      NEW.expires_at := now() + interval '180 days';
    END IF;
    IF NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'relationship_shares: expires_at must be in the future';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: identity and content are immutable.
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.item_ref IS DISTINCT FROM OLD.item_ref
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'relationship_shares rows are immutable except for revocation';
  END IF;

  -- Revocation is one-way: NULL -> now(). Once set, never changed or cleared.
  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'relationship_shares: a revoked share cannot be un-revoked or re-dated';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now(); -- server time, never a client-supplied (e.g. future) timestamp
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_relationship_shares_immutable ON public.relationship_shares;
CREATE TRIGGER on_relationship_shares_immutable
  BEFORE INSERT OR UPDATE ON public.relationship_shares
  FOR EACH ROW EXECUTE FUNCTION public.enforce_relationship_share_immutability();

-- Recipient reads additionally require a CURRENT partnership (defense in
-- depth: unlink already revokes rows via private.apply_unlink).
DROP POLICY IF EXISTS "relationship shares: select own or received" ON public.relationship_shares;
CREATE POLICY "relationship shares: select own or received" ON public.relationship_shares
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (
      recipient_id = auth.uid()
      AND revoked_at IS NULL
      AND expires_at > now()
      AND public.get_partner_id(auth.uid()) = owner_id
    )
  );
