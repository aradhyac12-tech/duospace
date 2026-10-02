-- Phase 2A: Relationship Intelligence V1 — explicit partner sharing.
--
-- Values answers, expectations and insights are PRIVATE by default and live
-- only in device-local encrypted storage (src/lib/relationship/stores.ts,
-- src/lib/ai/localInsightStore.ts) — nothing about them reaches this table
-- unless the owner takes an explicit, per-item share action
-- (src/lib/relationship/sharing.ts). This migration is the "concrete
-- requirement" the brief's §23 asks for before adding a Supabase table: a
-- share has to be durable and visible to the recipient across their own
-- devices, which local-only storage cannot provide.
--
-- What is stored here is a SNAPSHOT the owner explicitly previewed and
-- confirmed (payload jsonb — see SharePayload in
-- src/lib/relationship/types.ts) — never the owner's raw private record.
-- Editing the source item later does not change what was already shared
-- (src/lib/relationship/stores.ts always resets an edited item to PRIVATE,
-- which requires a fresh share+preview to re-share it).

CREATE TABLE IF NOT EXISTS public.relationship_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN ('VALUE_ANSWER', 'EXPECTATION', 'INSIGHT')),
  -- Owner-device reference to the source item (a values questionId or an
  -- expectation/insight id) — used only to let the owner revoke by item and
  -- to stop a duplicate share of the exact same still-unedited item; never
  -- used to look anything up server-side, since the source record never
  -- reaches the server at all.
  item_ref text NOT NULL,

  payload jsonb NOT NULL,
  -- Binds this row to exactly the payload the owner previewed and
  -- confirmed (SharePreview.payloadHash in sharing.ts) — belt-and-braces
  -- against a client bug sending a preview for one item and a payload for
  -- another.
  payload_hash text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Shares are not forever (mirrors the local insight expiry rule, brief
  -- §19): a snapshot of a reflection from months ago going stale in a
  -- partner's view is exactly the kind of silent "history becomes current
  -- truth" the brief warns against.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  revoked_at timestamptz,

  CONSTRAINT relationship_shares_not_self CHECK (owner_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_relationship_shares_owner ON public.relationship_shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_relationship_shares_recipient ON public.relationship_shares(recipient_id)
  WHERE revoked_at IS NULL;
-- One active (non-revoked) share per source item — re-sharing an edited
-- item is a fresh row only after the previous one is revoked, so a
-- recipient never sees two live snapshots of the same item disagreeing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_relationship_shares_active_item
  ON public.relationship_shares(owner_id, item_ref)
  WHERE revoked_at IS NULL;

ALTER TABLE public.relationship_shares ENABLE ROW LEVEL SECURITY;

-- Owner sees everything they've shared (including revoked, for their own
-- history/undo UI). Recipient sees only currently-active, unexpired shares
-- — a revoked or expired share must stop being visible immediately, not
-- just stop being "new".
DROP POLICY IF EXISTS "relationship shares: select own or received" ON public.relationship_shares;
CREATE POLICY "relationship shares: select own or received" ON public.relationship_shares
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (recipient_id = auth.uid() AND revoked_at IS NULL AND expires_at > now())
  );

-- Insert only as yourself, and only to your CURRENT linked partner — this
-- is the DB-layer half of "explicit per-item partner sharing", so a client
-- bug (or a direct API call) cannot address a share to anyone else,
-- including a partner who has since unlinked.
DROP POLICY IF EXISTS "relationship shares: insert own to current partner" ON public.relationship_shares;
CREATE POLICY "relationship shares: insert own to current partner" ON public.relationship_shares
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id = auth.uid()
    AND recipient_id = public.get_partner_id(auth.uid())
  );

-- Only the owner may revoke (set revoked_at), and only that one field —
-- payload/hash/kind/item_ref are otherwise immutable once written (see the
-- trigger below); a recipient has no UPDATE access at all.
DROP POLICY IF EXISTS "relationship shares: owner revoke" ON public.relationship_shares;
CREATE POLICY "relationship shares: owner revoke" ON public.relationship_shares
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- Owner may delete their own rows outright (distinct from revoke — this is
-- for the owner's own cleanup, e.g. clearing old expired rows from their
-- history view). Recipients never delete a share they received.
DROP POLICY IF EXISTS "relationship shares: owner delete" ON public.relationship_shares;
CREATE POLICY "relationship shares: owner delete" ON public.relationship_shares
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

CREATE OR REPLACE FUNCTION public.enforce_relationship_share_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.item_ref IS DISTINCT FROM OLD.item_ref
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'relationship_shares rows are immutable except revoked_at';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_relationship_shares_immutable ON public.relationship_shares;
CREATE TRIGGER on_relationship_shares_immutable
  BEFORE UPDATE ON public.relationship_shares
  FOR EACH ROW EXECUTE FUNCTION public.enforce_relationship_share_immutability();

-- Unlink must end sharing immediately (mirrors the ex-partner concern the
-- Realtime-authorization fix documented for other channels — see
-- .ai/DECISIONS.md): revoke every still-active share in either direction
-- between the two people being unlinked. Called from the unlink RPC
-- transaction (supabase/migrations/20260920150000_partner_unlink_consent.sql's
-- respond_unlink), same transaction, so a share can never outlive the link
-- even for the seconds between an unlink and a client re-sync.
CREATE OR REPLACE FUNCTION public.revoke_relationship_shares_between(p_user_a uuid, p_user_b uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.relationship_shares
  SET revoked_at = now()
  WHERE revoked_at IS NULL
    AND ((owner_id = p_user_a AND recipient_id = p_user_b) OR (owner_id = p_user_b AND recipient_id = p_user_a));
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_relationship_shares_between(uuid, uuid) FROM PUBLIC, anon, authenticated;
