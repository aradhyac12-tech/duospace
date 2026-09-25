-- Restores and finishes the /important + /urgent push path.
--
-- WHY /important AND /urgent WERE STILL ARRIVING AS NORMAL MESSAGES
-- The live public.notify_push_on_message() was the 20260824120000 (silent
-- column) definition: it never put `important` — let alone `urgent` — into
-- the send-push payload, so send-push had nothing to act on and every flagged
-- message went out as an ordinary push. It got there because that old
-- migration was applied on the live project AFTER 20260921120000 (which had
-- added `important`), silently overwriting it — it also brought back
-- `'preview', NEW.content`, i.e. E2E ciphertext in push bodies, which
-- 20260908090000 had removed. CREATE OR REPLACE FUNCTION migrations that
-- each re-declare the whole function clobber one another whenever they are
-- applied out of file order, so THIS migration is deliberately the newest
-- word on the function: it carries every prior change (silent skip, message
-- type mapping, no preview, important) plus urgent, and any future edit must
-- be a later-dated migration that starts from this body.
--
-- What changes vs. the previous body:
--   * 'important' = NEW.important OR NEW.urgent  (urgent implies important)
--   * 'urgent'    = NEW.urgent                    (new — picks the strongest tier)
--   * 'preview' stays omitted (ciphertext must never reach a push body)
-- Additive to the payload only; send-push ignores keys it doesn't know.

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS important boolean NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS silent boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type text;
BEGIN
  -- /silent: skip the push entirely (the message still inserts and delivers
  -- over realtime / on next open). Silent wins over important/urgent.
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
    -- 'preview' deliberately omitted: NEW.content is E2E ciphertext, never a
    -- human-readable preview (see 20260908090000).
    'fileName', NEW.file_name,
    'createdAt', NEW.created_at,
    'important', (COALESCE(NEW.important, false) OR COALESCE(NEW.urgent, false)),
    'urgent', COALESCE(NEW.urgent, false)
  ));
  RETURN NEW;
END;
$$;
-- The trigger (on_message_insert_push) already points at this function name.
