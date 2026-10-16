-- ============================================================================
-- FIX: callee phone keeps ringing/vibrating after the CALLER hangs up.
--
-- ROOT CAUSE: notify_push_on_call() only dispatched a "stop" push for
-- missed / declined / completed calls. When the caller cancels while ringing,
-- cancel_call() sets status='cancelled' (and a failed join sets 'failed') —
-- neither branch existed, so NO push reached the callee. On Android the ringer
-- (CallRingingService: looping ringtone + vibration + full-screen
-- notification) is started by the FCM push alone and is stopped only by a
-- call_ended / call_rejected / missed_call push or its own 45s timeout. If the
-- app was backgrounded/killed (no WebSocket, no JS), the phone kept ringing
-- for the full 45s after the caller had already hung up.
--
-- Fix: when an unanswered call goes in_progress -> cancelled|failed, send the
-- receiver the existing data-only HIGH-priority 'call_ended' push. It posts no
-- tray notification (see DuoSpaceMessagingService) — it only silences the
-- ringer and removes the incoming-call notification. (iOS already covered by
-- notify_voip_on_call_end.)
-- ============================================================================
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
    ELSIF NEW.status IN ('cancelled', 'failed') AND OLD.status = 'in_progress' THEN
      -- NEW: caller hung up while ringing (or the call failed) — stop the
      -- callee's native ringer/vibration/notification.
      PERFORM private.dispatch_push(jsonb_build_object(
        'internal', true,
        'type', 'call_ended',
        'senderId', NEW.caller_id,
        'recipientId', NEW.receiver_id,
        'conversationId', v_conversation,
        'callId', NEW.id,
        'callType', NEW.call_type,
        'durationSeconds', COALESCE(NEW.duration_seconds, 0),
        'createdAt', COALESCE(NEW.ended_at, now())
      ));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
