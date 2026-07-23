-- BUG FIX: message_reactions allowed multiple emoji per user per message
-- (UNIQUE was on message_id, user_id, emoji). A user should only ever have
-- ONE reaction on a given message. Dedupe existing rows (keep the newest
-- per user/message), then replace the constraint.

-- 1. Remove duplicate reactions, keeping only the most recent one per
--    (message_id, user_id).
DELETE FROM public.message_reactions mr
WHERE EXISTS (
  SELECT 1 FROM public.message_reactions newer
  WHERE newer.message_id = mr.message_id
    AND newer.user_id = mr.user_id
    AND newer.created_at > mr.created_at
);
-- Tie-break any exact-same-timestamp duplicates by id so the constraint
-- below can be added cleanly.
DELETE FROM public.message_reactions mr
WHERE EXISTS (
  SELECT 1 FROM public.message_reactions newer
  WHERE newer.message_id = mr.message_id
    AND newer.user_id = mr.user_id
    AND newer.created_at = mr.created_at
    AND newer.id > mr.id
);

-- 2. Drop the old 3-column unique constraint (name is Postgres's default
--    for the inline UNIQUE(message_id, user_id, emoji) clause used across
--    every migration that created this table).
ALTER TABLE public.message_reactions
  DROP CONSTRAINT IF EXISTS message_reactions_message_id_user_id_emoji_key;

-- 3. Add the correct constraint: one reaction row per user per message.
ALTER TABLE public.message_reactions
  ADD CONSTRAINT message_reactions_message_id_user_id_key UNIQUE (message_id, user_id);

-- WHATSAPP IMPORT: add a flag so imported messages can be attributed to
-- "you" vs your partner instead of showing the raw WhatsApp export name
-- (often just a phone number for whichever contact wasn't saved).
ALTER TABLE public.imported_chats
  ADD COLUMN IF NOT EXISTS is_self boolean NOT NULL DEFAULT false;
