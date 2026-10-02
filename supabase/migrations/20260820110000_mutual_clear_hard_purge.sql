-- "Clear chat" stays one-sided and recoverable (unchanged) — this adds the
-- other half of what was asked: once BOTH partners have independently
-- cleared their own side of the SAME row, there is no one left who could
-- still see or recover it, so at that exact moment it is permanently
-- purged from Supabase instead of sitting around forever as two soft-
-- delete flags. Recovery (recoverChat) remains possible for as long as at
-- least one side hasn't cleared — the row simply won't exist anymore to
-- recover once the second side does.
--
-- Implemented as AFTER UPDATE triggers rather than application code: this
-- makes the purge unconditional and race-safe regardless of which client
-- performs the second clear, or whether clearChat/recoverChat ever changes
-- later — the guarantee lives at the data layer, not in whichever code
-- path happens to call it today.

-- ── messages ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_mutually_cleared_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_by_sender AND NEW.deleted_by_receiver THEN
    DELETE FROM public.messages WHERE id = NEW.id;
  END IF;
  -- Return value of an AFTER trigger is ignored; NULL is the convention.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_purge_mutually_cleared_message ON public.messages;
CREATE TRIGGER trg_purge_mutually_cleared_message
  AFTER UPDATE OF deleted_by_sender, deleted_by_receiver ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.purge_mutually_cleared_message();

-- ── imported_chats ───────────────────────────────────────────────────────
-- imported_chats has no sender/receiver split — it has cleared_by (see the
-- imported_chats_per_viewer_clear migration), a per-viewer array. "Both
-- partners have cleared" here means cleared_by contains BOTH members of
-- the relationship: the row's owner_id (whoever ran the import) and that
-- person's partner (looked up via the existing get_partner_id()).
CREATE OR REPLACE FUNCTION public.purge_mutually_cleared_imported_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  partner uuid;
BEGIN
  partner := public.get_partner_id(NEW.owner_id);
  IF partner IS NOT NULL
     AND NEW.owner_id = ANY(NEW.cleared_by)
     AND partner = ANY(NEW.cleared_by)
  THEN
    DELETE FROM public.imported_chats WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_purge_mutually_cleared_imported_chat ON public.imported_chats;
CREATE TRIGGER trg_purge_mutually_cleared_imported_chat
  AFTER UPDATE OF cleared_by ON public.imported_chats
  FOR EACH ROW
  EXECUTE FUNCTION public.purge_mutually_cleared_imported_chat();

-- ── Known, deliberate gap: attached media is NOT deleted from Storage ──
-- A purged message/imported row can carry a file_url pointing at a real
-- object in the chat-files bucket (photo/voice/file). This migration only
-- removes the DATABASE ROW — it does not call the Storage API to remove
-- the underlying object, because plpgsql has no Storage access (that needs
-- an edge function running with a service-role key). The practical effect
-- is an orphaned file left in Storage after a mutual purge — invisible to
-- both partners (no row references it anymore) but still consuming
-- storage. This project already has a cron precedent for exactly this
-- shape of problem (cleanup-orphan-uploads, for abandoned resumable-upload
-- chunks) — extending that job (or a new one) to also sweep chat-files
-- objects with no remaining messages/imported_chats row referencing them
-- is the natural follow-up, intentionally not built in this session.
