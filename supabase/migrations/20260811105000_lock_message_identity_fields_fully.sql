-- ============================================================
-- FINALIZE MESSAGE UPDATE SECURITY MODEL (Phase 8.5 — item 5)
--
-- CONTEXT: 20260811102000_fix_messages_update_rls_regression.sql fixed the
-- receiver-mutation regression and left one question explicitly open in its
-- trailing comment: "Whether the SENDER itself should be allowed to change
-- sender_id/receiver_id/created_at ... needs product input."
--
-- RESOLUTION: a full grep of every client call site that performs
-- `supabase.from("messages").update(...)` (src/pages/Chat.tsx — the only
-- place messages are updated from the client) shows exactly five distinct
-- updates, touching only: is_read, disappear_at, deleted_by_sender,
-- deleted_by_receiver, is_pinned. None of them, including the sender-side
-- ones, ever set sender_id, receiver_id, or created_at. No legitimate
-- client operation needs to move these fields for either party.
--
-- Per the Phase 8.5 instruction ("If no legitimate operation requires it,
-- lock those fields against ALL client-side updates, not merely
-- receivers"), this migration removes the sender exemption for these three
-- fields specifically. Sender edit rights are otherwise unchanged — content,
-- message_type, file_url, file_name, disappear_at, is_pinned, edited_at,
-- reply_to_id, and deleted_by_sender remain sender-editable exactly as
-- before; this only makes identity/ordering immutable for absolutely
-- everyone, sender included, closing the ambiguity left open in the prior
-- migration.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_message_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Identity/ordering fields: immutable for every client-side update,
  -- sender included. No legitimate app flow (verified against every
  -- messages UPDATE call site in src/pages/Chat.tsx) ever needs to move
  -- these once a message is written.
  IF NEW.sender_id     IS DISTINCT FROM OLD.sender_id     THEN RAISE EXCEPTION 'sender_id is immutable'; END IF;
  IF NEW.receiver_id   IS DISTINCT FROM OLD.receiver_id   THEN RAISE EXCEPTION 'receiver_id is immutable'; END IF;
  IF NEW.created_at    IS DISTINCT FROM OLD.created_at    THEN RAISE EXCEPTION 'created_at is immutable'; END IF;

  IF auth.uid() IS DISTINCT FROM OLD.sender_id THEN
    IF NEW.content       IS DISTINCT FROM OLD.content       THEN RAISE EXCEPTION 'Only sender can edit content'; END IF;
    IF NEW.message_type  IS DISTINCT FROM OLD.message_type  THEN RAISE EXCEPTION 'Only sender can edit message_type'; END IF;
    IF NEW.file_url      IS DISTINCT FROM OLD.file_url      THEN RAISE EXCEPTION 'Only sender can edit file_url'; END IF;
    IF NEW.file_name     IS DISTINCT FROM OLD.file_name     THEN RAISE EXCEPTION 'Only sender can edit file_name'; END IF;
    IF NEW.disappear_at  IS DISTINCT FROM OLD.disappear_at  THEN RAISE EXCEPTION 'Only sender can edit disappear_at'; END IF;
    IF NEW.is_pinned     IS DISTINCT FROM OLD.is_pinned     THEN RAISE EXCEPTION 'Only sender can pin'; END IF;
    IF NEW.edited_at     IS DISTINCT FROM OLD.edited_at     THEN RAISE EXCEPTION 'Only sender can edit edited_at'; END IF;
    IF NEW.reply_to_id   IS DISTINCT FROM OLD.reply_to_id   THEN RAISE EXCEPTION 'Only sender can edit reply_to_id'; END IF;
    IF NEW.deleted_by_sender IS DISTINCT FROM OLD.deleted_by_sender THEN RAISE EXCEPTION 'Only sender can soft-delete on sender side'; END IF;
  END IF;
  RETURN NEW;
END; $$;

-- Trigger already exists and points at this function by name; no need to
-- drop/recreate the trigger itself, only the function body changed.

-- ============================================================
-- REQUIRES LIVE SUPABASE to confirm: that a sender-side UPDATE attempting
-- to change sender_id/receiver_id/created_at now raises the exception
-- (previously it would have silently succeeded), and that none of the five
-- known legitimate update call sites regress.
-- ============================================================
