-- Fixes /silent: the client (Chat.tsx attemptSendText) has been inserting
-- `silent: isSilent` into public.messages since the /silent slash command
-- was added, but no migration ever created that column. Two consequences:
--
--   1. Every text-message insert included an unknown `silent` key in the
--      PostgREST insert body, which PostgREST rejects outright (schema
--      cache error) — so /silent didn't just fail to suppress the push,
--      the send itself was failing at the database layer.
--   2. Even with the column present, the push-notification trigger
--      (notify_push_on_message, from 20260725091342_fcm_push_notifications)
--      dispatches a push on every INSERT unconditionally — it has never
--      checked any "silent" flag, so there was no enforcement point for
--      /silent's actual purpose even in principle.
--
-- This migration adds the column and makes the trigger skip the push
-- dispatch when it's true.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS silent boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type text;
BEGIN
  -- /silent: sender explicitly asked to skip the push notification. The
  -- message itself still inserts and delivers normally over realtime/on
  -- next open — only the push is suppressed.
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
    'preview', NEW.content,
    'fileName', NEW.file_name,
    'createdAt', NEW.created_at
  ));
  RETURN NEW;
END;
$$;
-- Trigger already points at this function name (on_message_insert_push);
-- CREATE OR REPLACE above is sufficient, no need to re-create the trigger.
