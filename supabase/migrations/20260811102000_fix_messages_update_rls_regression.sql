-- ============================================================
-- P1 FIX (Phase 8I — Message UPDATE Security Review)
--
-- FINDING: this table's UPDATE policy was correctly tightened once
-- already, then silently regressed.
--
--   20260511075549_...sql  ("Phase 4.2 — TIGHTEN messages UPDATE")
--     - split UPDATE into "Sender can update own messages"
--       (USING/WITH CHECK auth.uid() = sender_id) and
--       "Receiver can mark messages read"
--       (USING/WITH CHECK auth.uid() = receiver_id)
--     - added trigger guard_message_update() to enforce, at the row
--       level, that a non-sender UPDATE can only touch is_read /
--       deleted_by_receiver-style fields.
--
--   20260707054831_...sql and 20260708090100_...sql (later,
--   idempotent-looking "CREATE TABLE IF NOT EXISTS public.messages"
--   blocks bundling unrelated feature work) both unconditionally ran:
--     DROP POLICY IF EXISTS "Users can update own messages" ...
--     CREATE POLICY "Users can update own messages" ... FOR UPDATE
--       USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
--   with NO WITH CHECK and NO reference to the split policies from
--   20260511. Since CREATE POLICY names are unique per table, this
--   re-created the single broad "Users can update own messages"
--   policy, coexisting with (not replacing) the two split policies —
--   Postgres OR's all applicable permissive policies together, so the
--   broad policy alone re-opened the receiver's USING/WITH CHECK
--   surface back to the entire row.
--
--   The trg_guard_message_update trigger was never dropped, so it
--   still ran — but it only enumerated content/message_type/file_url/
--   file_name/disappear_at/is_pinned/edited_at/reply_to_id/
--   deleted_by_sender. It did NOT guard sender_id, receiver_id, or
--   created_at. Combined with the broad policy's default WITH CHECK
--   (== its USING clause when none is given), a receiver could:
--     - UPDATE ... SET sender_id = auth.uid() WHERE id = <msg> AND
--       receiver_id = auth.uid()  → passes WITH CHECK (still receiver
--       of the OLD constraint isn't re-checked once sender_id changes,
--       and NEW row satisfies auth.uid() = NEW.sender_id) → rewrites
--       message authorship.
--     - UPDATE ... SET created_at = <anything>  → passes both the
--       policy and the trigger → timestamp tampering, breaks
--       ordering/disappearing-message logic.
--   sender_id/receiver_id are NOT NULL with no FK CHECK constraining
--   them to the caller's actual partner, so this was a real, not
--   theoretical, cross-field mutation path for the receiver.
--
-- FIX:
--   1. Drop the broad "Users can update own messages" policy,
--      leaving only the two split policies as the UPDATE path.
--   2. Extend guard_message_update() to also reject sender_id,
--      receiver_id, and created_at changes from anyone but the
--      current sender (arguably not even the sender should be able to
--      change these, but scoping this fix to "receiver cannot do it"
--      to avoid touching legitimate sender-side edit flows this
--      session didn't audit).
-- ============================================================

DROP POLICY IF EXISTS "Users can update own messages" ON public.messages;

-- Re-assert the split policies from 20260511075549, in case any other
-- migration between then and now touched them (defensive; CREATE OR
-- REPLACE POLICY doesn't exist, so drop+recreate).
DROP POLICY IF EXISTS "Sender can update own messages" ON public.messages;
CREATE POLICY "Sender can update own messages" ON public.messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id) WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "Receiver can mark messages read" ON public.messages;
CREATE POLICY "Receiver can mark messages read" ON public.messages FOR UPDATE TO authenticated
  USING (auth.uid() = receiver_id) WITH CHECK (auth.uid() = receiver_id);

CREATE OR REPLACE FUNCTION public.guard_message_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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
    -- Phase 8I additions: identity/ordering fields must never move under
    -- a receiver-initiated UPDATE (read receipts / receiver-side deletion
    -- are the only legitimate receiver mutation).
    IF NEW.sender_id     IS DISTINCT FROM OLD.sender_id     THEN RAISE EXCEPTION 'sender_id is immutable'; END IF;
    IF NEW.receiver_id   IS DISTINCT FROM OLD.receiver_id   THEN RAISE EXCEPTION 'receiver_id is immutable'; END IF;
    IF NEW.created_at    IS DISTINCT FROM OLD.created_at    THEN RAISE EXCEPTION 'created_at is immutable'; END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_message_update ON public.messages;
CREATE TRIGGER trg_guard_message_update BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_update();

-- ============================================================
-- Not changed in this fix (out of scope / needs product input):
--   - Whether the SENDER should be allowed to change sender_id/
--     receiver_id/created_at at all (currently: yes, trigger only
--     blocks non-senders). No legitimate app flow appears to need
--     this — see docs/RLS_SECURITY_MATRIX.md for the recommendation
--     to lock these down for everyone via a narrow RPC instead, if
--     product confirms sender-side edit UI never needs it.
--   - reactions / read-receipt / soft-delete tables, which are
--     separate tables per Chat UI code and were not found to reuse
--     this UPDATE policy.
-- ============================================================
