-- Root-cause fix for "unable to send letter" (and the same failure mode in
-- Nudge, which fails identically but silently — see below).
--
-- WHY: public.messages.message_type has carried a CHECK constraint since the
-- very first schema migration restricting it to ('text','image','file',
-- 'voice'). The Love Letter feature (Chat.tsx's handleSendLoveLetter) and
-- the Nudge feature (Chat.tsx's sendNudge) both insert
-- message_type:"letter" / message_type:"nudge" respectively — neither value
-- has ever been in the allowed list, on any migration, in this project's
-- history (verified: grep across every migration touching message_type).
-- Every letter/nudge insert has therefore always been rejected by Postgres
-- with a check-constraint violation. Love Letter surfaces this correctly as
-- a "Failed to send letter" toast (which is the error the user is actually
-- seeing) — Nudge has no error handling at all on that insert, so it fails
-- exactly the same way but completely silently (haptic + heart animation
-- fire locally, the message never saves, the user is never told).
--
-- This does not touch the sender/receiver RLS policies or anything else on
-- the table — only widens what values the column accepts.
--
-- NOTE: like other recent migrations in this folder (see
-- 20260824100000_gallery_albums.sql, 20260824_call_declined_marker.sql),
-- this must be applied to the live project directly (Supabase MCP /
-- dashboard SQL editor) — the migrations folder is a source-of-truth
-- mirror, not an auto-deployed pipeline for this project.

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_message_type_check
  CHECK (message_type IN ('text', 'image', 'file', 'voice', 'letter', 'nudge'));
