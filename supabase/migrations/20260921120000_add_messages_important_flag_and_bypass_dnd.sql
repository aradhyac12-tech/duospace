-- CORRECTION (2026-09-21): the first version of this file was written from the
-- 20260824120000 definition of notify_push_on_message() and re-added
-- `'preview', NEW.content`, silently undoing 20260908090000 (E2E ciphertext leaking
-- into push payloads). The live database already has the corrected function
-- (important flag, NO preview), so pushing the old file would have regressed it.
--
-- Adds /important (a.k.a. /emergency): the mirror image of /silent. Where
-- /silent sends normally but skips the push, /important sends normally and
-- marks the push so it gets through even when the recipient has Do Not
-- Disturb on or has muted the conversation — same carve-out CALL_TYPES
-- already gets in send-push/index.ts, just extended to this one flagged
-- message rather than every message. The message itself is not otherwise
-- special: still end-to-end encrypted, still a normal row, still subject to
-- blocked-sender/rate-limit checks.
--
-- Actual "ring the partner's phone" behavior (bypassing the OS-level
-- silent/DND switch, not just DuoSpace's own notification_preferences) is
-- delivered by routing the push through a dedicated Android notification
-- channel with setBypassDnd(true) (see native/android/NotificationChannels.kt,
-- "duospace_urgent_message") and, on iOS, apns-push-type/interruption-level
-- "time-sensitive" (see supabase/functions/_shared/fcm.ts) — both applied
-- only when this flag is set.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS important boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type text;
BEGIN
  -- /silent: sender explicitly asked to skip the push notification. The
  -- message itself still inserts and delivers normally over realtime/on
  -- next open — only the push is suppressed. (A message can't be both
  -- silent and important — the composer treats them as separate slash
  -- commands — but silent wins here if it somehow were.)
  IF NEW.silent THEN
    RETURN NEW;
  END IF;

  IF NEW.reply_to_id IS NOT NULL THEN
    v_type := 'reply';
  ELSIF NEW.message_type = 'image' THEN
    v_type := 'image_message';
  ELSIF NEW.message_type = 'voice' THEN
    v_type := 'audio_message';
  ELSIF NEW.message_type = 'file' AND NEW.file_name ~* '\.(mp4|mov|webm|mkv|m4v|3gp)$' THEN
    v_type := 'video_message';
  ELSIF NEW.message_type = 'file' THEN
    v_type := 'file_message';
  ELSE
    v_type := 'chat_message';
  END IF;

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', v_type,
    'senderId', NEW.sender_id,
    'recipientId', NEW.receiver_id,
    'conversationId', (
      SELECT LEAST(NEW.sender_id, NEW.receiver_id)::text || '_' || GREATEST(NEW.sender_id, NEW.receiver_id)::text
    ),
    'messageId', NEW.id,
    'replyToId', NEW.reply_to_id,
    -- 'preview' deliberately omitted: NEW.content is E2E ciphertext, never
    -- a human-readable preview (see 20260908090000_fix_push_preview_leak_and_call_status.sql).
    'fileName', NEW.file_name,
    'createdAt', NEW.created_at,
    'important', NEW.important
  ));
  RETURN NEW;
END;
$$;
-- Trigger already points at this function name (on_message_insert_push);
-- CREATE OR REPLACE above is sufficient, no need to re-create the trigger.
