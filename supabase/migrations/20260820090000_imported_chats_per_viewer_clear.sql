-- CLEAR CHAT BUG FIX: "Clear chat" only ever touched the `messages` table
-- (deleted_by_sender/deleted_by_receiver — a per-viewer soft-hide, see the
-- big comment above clearChat() in Chat.tsx). Imported WhatsApp history
-- lives in a completely separate table (`imported_chats`, added later) that
-- clearChat() never touched at all — so after "Clear chat", every real
-- message disappeared but the imported WhatsApp transcript stayed fully
-- visible. This gives imported_chats the same per-viewer hide mechanism
-- `messages` already has, instead of a hard delete:
--
--   - it must be PER-VIEWER, not a hard delete — clearing your own view
--     should not delete your partner's copy of imported history, same
--     rule "Clear chat" already documents for real messages
--   - it must work regardless of WHICH partner originally ran the import
--     — the existing DELETE policy is `owner_id = auth.uid()`, so if
--     partner A imported the file (owner_id = A) and partner B clears the
--     chat, B can't touch A's rows under that policy at all. A per-viewer
--     array column sidesteps this cleanly: either partner can add their
--     own id to it, regardless of who owns the row underneath.
ALTER TABLE public.imported_chats
  ADD COLUMN IF NOT EXISTS cleared_by uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_imported_chats_cleared_by
  ON public.imported_chats USING gin (cleared_by);

-- Either partner in the relationship may update cleared_by on either
-- partner's imported rows — same trust boundary the existing SELECT policy
-- already uses (owner_id = auth.uid() OR owner_id = get_partner_id(...)),
-- just extended to UPDATE. This intentionally does NOT try to restrict
-- *which* column changes via RLS (Postgres RLS can't cheaply express "may
-- only append your own uid to this array column" — that would need a
-- trigger) — the two RPC functions below are the only way the client is
-- expected to touch this column, and both are written to only ever
-- add/remove auth.uid() itself, never an arbitrary id.
DROP POLICY IF EXISTS "Update own or partner imported chats" ON public.imported_chats;
CREATE POLICY "Update own or partner imported chats" ON public.imported_chats
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()))
  WITH CHECK (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()));

-- clear_imported_chats_for_viewer(): the "Clear chat" side. Adds the
-- CALLER's own uid to cleared_by on every imported row either partner owns
-- that the caller hasn't already cleared. SECURITY DEFINER so it can update
-- rows the caller doesn't own (partner's imported rows) while still only
-- ever writing auth.uid() itself into the array — the function body is the
-- actual enforcement, not a wide-open policy.
CREATE OR REPLACE FUNCTION public.clear_imported_chats_for_viewer(p_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.imported_chats
  SET cleared_by = array_append(cleared_by, auth.uid())
  WHERE owner_id IN (auth.uid(), p_partner_id)
    AND NOT (auth.uid() = ANY(cleared_by));
END;
$$;

-- recover_imported_chats_for_viewer(): the "Recover chat" side — mirrors
-- clearChat()'s existing recoverChat() for `messages`.
CREATE OR REPLACE FUNCTION public.recover_imported_chats_for_viewer(p_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.imported_chats
  SET cleared_by = array_remove(cleared_by, auth.uid())
  WHERE owner_id IN (auth.uid(), p_partner_id)
    AND auth.uid() = ANY(cleared_by);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_imported_chats_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_imported_chats_for_viewer(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.recover_imported_chats_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_imported_chats_for_viewer(uuid) TO authenticated;
