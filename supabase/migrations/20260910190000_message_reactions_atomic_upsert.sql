-- RELIABILITY FIX (P1 — Phase 4 adversarial audit, "reaction database
-- invariant" + "chat race audit"): src/components/chat/MessageReactions.tsx
-- used to toggle a reaction with a DELETE followed by a separate INSERT —
-- two round trips, not one atomic operation, even though the DB already
-- correctly enforces one-reaction-per-user-per-message
-- (message_reactions_message_id_user_id_key, migration 20260722120000).
-- Two devices signed into the same account (phone + web, or two tabs)
-- reacting to the same message in the same race window could both pass
-- past their own DELETE (harmless no-op on an already-gone row for
-- whichever loses the race) and then both attempt an INSERT for the same
-- (message_id, user_id) — the second INSERT then hits the unique
-- constraint and fails outright, silently, since the app never checked
-- the insert's error.
--
-- The app-side fix (this same PR) replaces that with a single upsert
-- keyed on the existing unique constraint (`ON CONFLICT (message_id,
-- user_id) DO UPDATE`) — but this table had NO UPDATE RLS policy at all,
-- only SELECT/INSERT/DELETE. Postgres RLS evaluates the UPDATE policy (not
-- INSERT) for the DO UPDATE branch of an upsert; with no permitting UPDATE
-- policy, RLS's default-deny would have silently rejected every upsert
-- that landed on the conflict path, defeating the atomicity fix entirely.
--
-- This migration adds the missing UPDATE policy — own rows only, mirroring
-- the existing INSERT/DELETE policies' auth.uid() = user_id check exactly
-- — so the app's upsert can actually update its own existing row on
-- conflict. No new privilege is introduced beyond what a user could
-- already achieve via DELETE + INSERT; this only makes the equivalent
-- single-statement path work.
CREATE POLICY "Update own reactions" ON public.message_reactions
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
