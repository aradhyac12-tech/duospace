-- SECURITY FIX — closes a gap the prior migration
-- (20260811102000_fix_messages_update_rls_regression.sql) explicitly
-- found and documented but left open pending product confirmation:
--
--   "Whether the SENDER should be allowed to change sender_id/
--    receiver_id/created_at at all (currently: yes, trigger only
--    blocks non-senders)."
--
-- Verified before applying this fix: no call site anywhere in src/ or
-- supabase/functions/ ever UPDATEs sender_id, receiver_id, or
-- created_at on an existing message row (every `.update()` call on
-- `messages` only ever touches content/edited_at/is_read/is_pinned/
-- disappear_at/deleted_by_*) — there is no legitimate app flow that
-- needs this, so it's safe to close now rather than leave it flagged.
--
-- THE GAP: guard_message_update()'s checks are all inside
-- `IF auth.uid() IS DISTINCT FROM OLD.sender_id THEN ...` — i.e. they
-- only run for a NON-sender update (the receiver's read-receipt path).
-- "Sender can update own messages" (`USING/WITH CHECK auth.uid() =
-- sender_id`) only requires that the NEW row's sender_id still equals
-- auth.uid() — it does not constrain receiver_id or created_at at all.
-- So the message's own sender, editing their own row (a request the
-- RLS policy allows), could today do:
--
--   UPDATE messages SET receiver_id = '<arbitrary-other-user-uuid>'
--     WHERE id = <a message I sent> AND sender_id = auth.uid();
--
-- — which passes both the policy and the trigger untouched (the
-- trigger's whole IF block is skipped because the updater IS
-- OLD.sender_id), silently redirecting an already-sent message: the
-- new receiver_id immediately becomes readable to that arbitrary user
-- under the existing SELECT policy (`auth.uid() = sender_id OR
-- auth.uid() = receiver_id`), and the message starts appearing to them
-- as part of a conversation they were never in — a real information-
-- disclosure and conversation-integrity bug, not theoretical.
--
-- FIX: move the sender_id/receiver_id/created_at checks outside the
-- non-sender IF block so they're enforced unconditionally (for sender
-- and receiver updates alike). Everything else in the trigger keeps its
-- existing receiver-only scoping — this only tightens the three
-- identity/ordering fields, which spec section 10 and section 32
-- together call out as exactly the fields that must never move under
-- any update path once a message is written.

CREATE OR REPLACE FUNCTION public.guard_message_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Identity/ordering fields: immutable for every updater, sender
  -- included. No legitimate flow changes these post-insert (see the
  -- migration header above for what was checked before applying this).
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

-- Trigger definition itself is unchanged (same function, same
-- BEFORE UPDATE / FOR EACH ROW binding) — no need to drop/recreate it,
-- only the function body changed.
