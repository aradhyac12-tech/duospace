-- ============================================================================
-- Fix 1: stop leaking raw E2E ciphertext into push notification previews
-- ============================================================================
-- ROOT CAUSE: notify_push_on_message() passed NEW.content straight through
-- as `preview`. messages.content is the CLIENT-encrypted E2E payload (see
-- src/lib/crypto.ts, "E2E::<iv>:<ciphertext>" format) — the server never
-- has the plaintext, by design. send-push's buildNotificationContent()
-- (supabase/functions/_shared/fcm.ts) does `truncate(body.preview, 140) ||
-- "Sent you a message"`, so a non-empty preview always wins — meaning every
-- chat/reply push notification showed the raw "E2E::..." ciphertext string
-- as its body, on the lock screen, in the notification shade, everywhere.
-- Fix: never pass ciphertext as preview. Omitting the key makes
-- buildNotificationContent() fall back to its existing generic
-- "Sent you a message" copy, which is also the correct WhatsApp-style
-- behavior for an E2E-encrypted app (the server literally cannot show a
-- real preview, so it must not try).
CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type text;
BEGIN
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
    -- a human-readable preview. See fix comment above.
    'fileName', NEW.file_name,
    'createdAt', NEW.created_at
  ));
  RETURN NEW;
END;
$$;

-- ============================================================================
-- Fix 2: distinguish "missed" (no answer) from "declined" (receiver tapped
-- Decline) in the push that actually gets sent, and send it to the right
-- person.
-- ============================================================================
-- ROOT CAUSE: 20260824_call_declined_marker.sql added call_history.declined_at
-- so the CALLER's in-app UI could honestly show "declined" vs "didn't
-- answer" (see useCallOutcome.ts) — but notify_push_on_call() (defined
-- earlier, in 20260725091342_fcm_push_notifications.sql) was never updated
-- to look at that column. Every call landing on status='missed' — whether
-- the receiver explicitly declined or genuinely never answered — dispatched
-- the same 'missed_call' push to the receiver ("You missed a call from
-- X"), and the already-defined 'call_rejected' push type
-- (supabase/functions/_shared/fcm.ts, "Call declined") was never dispatched
-- by anything, anywhere. On top of the wrong copy, a decline was also being
-- reported to the wrong person: if X explicitly declined Y's call, the
-- push telling Y about it (the party who actually needs to know) never
-- went out — only a "you missed a call" push to X, about X's own action.
--
-- Fix: when declined_at is set, dispatch 'call_rejected' to the CALLER
-- (senderId=receiver_id who declined, recipientId=caller_id) instead of
-- 'missed_call' to the receiver.
CREATE OR REPLACE FUNCTION public.notify_push_on_call()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conversation text;
BEGIN
  IF NEW.receiver_id IS NULL THEN RETURN NEW; END IF;
  v_conversation := LEAST(NEW.caller_id, NEW.receiver_id)::text || '_' || GREATEST(NEW.caller_id, NEW.receiver_id)::text;

  IF TG_OP = 'INSERT' AND NEW.status = 'in_progress' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', CASE WHEN NEW.call_type = 'voice' THEN 'incoming_audio_call' ELSE 'incoming_video_call' END,
      'senderId', NEW.caller_id,
      'recipientId', NEW.receiver_id,
      'conversationId', v_conversation,
      'callId', NEW.id,
      'callType', NEW.call_type,
      'roomName', NEW.room_name,
      'createdAt', NEW.started_at
    ));

  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'missed' AND NEW.declined_at IS NOT NULL THEN
      -- Receiver explicitly tapped Decline — tell the CALLER, honestly,
      -- not the receiver (who already knows what they just did).
      PERFORM private.dispatch_push(jsonb_build_object(
        'internal', true,
        'type', 'call_rejected',
        'senderId', NEW.receiver_id,
        'recipientId', NEW.caller_id,
        'conversationId', v_conversation,
        'callId', NEW.id,
        'callType', NEW.call_type,
        'createdAt', NEW.ended_at
      ));
    ELSIF NEW.status = 'missed' THEN
      -- Genuine no-answer (ring lapsed / unreachable) — tell the receiver
      -- they missed it, as before.
      PERFORM private.dispatch_push(jsonb_build_object(
        'internal', true,
        'type', 'missed_call',
        'senderId', NEW.caller_id,
        'recipientId', NEW.receiver_id,
        'conversationId', v_conversation,
        'callId', NEW.id,
        'callType', NEW.call_type,
        'createdAt', NEW.ended_at
      ));
    ELSIF NEW.status = 'completed' AND OLD.status = 'in_progress' THEN
      -- Low-priority, data-only "call ended" signal to whichever side's app
      -- may have lost the realtime channel (e.g. backgrounded). Unchanged.
      PERFORM private.dispatch_push(jsonb_build_object(
        'internal', true,
        'type', 'call_ended',
        'senderId', NEW.caller_id,
        'recipientId', NEW.receiver_id,
        'conversationId', v_conversation,
        'callId', NEW.id,
        'callType', NEW.call_type,
        'durationSeconds', NEW.duration_seconds,
        'createdAt', NEW.ended_at
      ));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Trigger already points at this function name (on_call_change_push);
-- CREATE OR REPLACE above is sufficient, no need to re-create the trigger.
