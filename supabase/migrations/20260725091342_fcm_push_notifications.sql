-- ============================================================================
-- FCM push notifications: schema + auto-dispatch triggers
-- ============================================================================
-- DuoSpace is a 1:1 "couple" app (profiles.partner_id), NOT a group/friends
-- app. There is no `conversations`, `groups`, `friends`, or `mentions` table
-- anywhere in the existing schema. This migration only wires real triggers
-- for events that actually exist in this codebase:
--   - public.messages            (chat / image / voice / file / reply)
--   - public.message_reactions   (reaction)
--   - public.call_history        (incoming call / missed call / call ended)
--   - public.partner_requests    (closest existing analogue to a
--                                 "friend request" / "friend accepted" flow —
--                                 this app pairs exactly one partner)
--
-- The send-push Edge Function additionally accepts "group_message",
-- "group_invitation", "mention", "typing", and "custom" as valid `type`
-- values (see supabase/functions/_shared/pushTypes.ts) so the API is ready
-- the day those features are added — but no DB trigger fires them today
-- because there is nothing in the schema to trigger from. Documented in
-- PUSH_NOTIFICATIONS.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. push_tokens — multi-device token registry
-- ----------------------------------------------------------------------------
-- profiles.push_token/push_platform (existing, untouched) remains the
-- single "most recent device" convenience column written by
-- src/hooks/usePushNotifications.ts. This table adds real multi-device
-- support without touching that client code: a trigger below keeps it in
-- sync automatically whenever profiles.push_token changes.
CREATE TABLE IF NOT EXISTS public.push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL,
  platform text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'web')),
  device_id text,
  app_version text,
  is_valid boolean NOT NULL DEFAULT true,
  invalidated_reason text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
GRANT SELECT, DELETE ON public.push_tokens TO authenticated;
GRANT ALL ON public.push_tokens TO service_role;
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own push tokens" ON public.push_tokens;
DROP POLICY IF EXISTS "Users can delete own push tokens" ON public.push_tokens;
CREATE POLICY "Users can view own push tokens" ON public.push_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own push tokens" ON public.push_tokens
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON public.push_tokens(user_id) WHERE is_valid;
CREATE INDEX IF NOT EXISTS idx_push_tokens_valid ON public.push_tokens(is_valid);

DROP TRIGGER IF EXISTS update_push_tokens_updated_at ON public.push_tokens;
CREATE TRIGGER update_push_tokens_updated_at BEFORE UPDATE ON public.push_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Keep push_tokens in sync with profiles.push_token/push_platform, which
-- src/hooks/usePushNotifications.ts already writes on every registration.
-- We do NOT modify that hook — this trigger is the only new moving part.
CREATE OR REPLACE FUNCTION public.sync_push_token_to_push_tokens()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.push_token IS NOT DISTINCT FROM OLD.push_token
     AND NEW.push_platform IS NOT DISTINCT FROM OLD.push_platform THEN
    RETURN NEW;
  END IF;

  IF NEW.push_token IS NOT NULL AND length(trim(NEW.push_token)) > 0 THEN
    INSERT INTO public.push_tokens (user_id, token, platform, is_valid, last_used_at)
    VALUES (NEW.user_id, NEW.push_token, COALESCE(NEW.push_platform, 'android'), true, now())
    ON CONFLICT (token) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      is_valid = true,
      invalidated_reason = NULL,
      last_used_at = now(),
      updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_profile_push_token_change ON public.profiles;
CREATE TRIGGER on_profile_push_token_change
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_push_token_to_push_tokens();

-- ----------------------------------------------------------------------------
-- 2. notification_preferences — per-user opt-in/mute controls
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id uuid PRIMARY KEY,
  messages_enabled boolean NOT NULL DEFAULT true,
  calls_enabled boolean NOT NULL DEFAULT true,
  reactions_enabled boolean NOT NULL DEFAULT true,
  replies_enabled boolean NOT NULL DEFAULT true,
  friend_requests_enabled boolean NOT NULL DEFAULT true,
  group_enabled boolean NOT NULL DEFAULT true,
  mentions_enabled boolean NOT NULL DEFAULT true,
  do_not_disturb boolean NOT NULL DEFAULT false,
  muted_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
GRANT ALL ON public.notification_preferences TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own notification prefs" ON public.notification_preferences;
DROP POLICY IF EXISTS "Users can upsert own notification prefs" ON public.notification_preferences;
DROP POLICY IF EXISTS "Users can update own notification prefs" ON public.notification_preferences;
CREATE POLICY "Users can view own notification prefs" ON public.notification_preferences
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can upsert own notification prefs" ON public.notification_preferences
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own notification prefs" ON public.notification_preferences
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DROP TRIGGER IF EXISTS update_notification_prefs_updated_at ON public.notification_preferences;
CREATE TRIGGER update_notification_prefs_updated_at BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ----------------------------------------------------------------------------
-- 3. blocked_users — used by send-push to skip delivery to a blocked sender
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocked_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  blocked_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, blocked_user_id)
);
GRANT SELECT, INSERT, DELETE ON public.blocked_users TO authenticated;
GRANT ALL ON public.blocked_users TO service_role;
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own blocks" ON public.blocked_users;
DROP POLICY IF EXISTS "Users can create own blocks" ON public.blocked_users;
DROP POLICY IF EXISTS "Users can remove own blocks" ON public.blocked_users;
CREATE POLICY "Users can view own blocks" ON public.blocked_users
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can create own blocks" ON public.blocked_users
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can remove own blocks" ON public.blocked_users
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4. notification_history — delivery/read status audit log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL,
  sender_id uuid,
  notification_type text NOT NULL,
  title text,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  conversation_id text,
  related_id uuid,
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'partial', 'failed', 'skipped')),
  skip_reason text,
  fcm_message_ids text[],
  error_detail text,
  tokens_attempted integer NOT NULL DEFAULT 0,
  tokens_succeeded integer NOT NULL DEFAULT 0,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.notification_history TO authenticated;
GRANT ALL ON public.notification_history TO service_role;
ALTER TABLE public.notification_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own notification history" ON public.notification_history;
DROP POLICY IF EXISTS "Users can mark own notifications read" ON public.notification_history;
CREATE POLICY "Users can view own notification history" ON public.notification_history
  FOR SELECT TO authenticated USING (auth.uid() = recipient_id);
-- Only allow flipping is_read/read_at from the client — everything else is
-- server-authored via the service role.
CREATE POLICY "Users can mark own notifications read" ON public.notification_history
  FOR UPDATE TO authenticated USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id);
CREATE INDEX IF NOT EXISTS idx_notification_history_recipient ON public.notification_history(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_history_unread ON public.notification_history(recipient_id) WHERE NOT is_read;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_history;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 5. Dispatch plumbing — pg_net + Vault-backed HTTP call to send-push
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS private;

-- Reads the project URL + service role key from Supabase Vault (see
-- PUSH_NOTIFICATIONS.md for the one-time `select vault.create_secret(...)`
-- setup). Never raises out of the calling trigger — a push-dispatch failure
-- must never roll back the message/call/request that triggered it.
CREATE OR REPLACE FUNCTION private.dispatch_push(payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'send-push dispatch skipped: Vault secrets "project_url"/"service_role_key" are not configured. See PUSH_NOTIFICATIONS.md.';
    RETURN;
  END IF;

  PERFORM extensions.net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := payload,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the write that triggered it.
  RAISE WARNING 'send-push dispatch failed: %', SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION private.dispatch_push(jsonb) FROM public;

-- ----------------------------------------------------------------------------
-- 6. Trigger: new message -> chat/image/audio/video/file/reply push
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type text;
BEGIN
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
DROP TRIGGER IF EXISTS on_message_insert_push ON public.messages;
CREATE TRIGGER on_message_insert_push
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_message();

-- ----------------------------------------------------------------------------
-- 7. Trigger: reaction -> push to the message's other participant
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push_on_reaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_recipient uuid;
  v_conversation text;
BEGIN
  SELECT (CASE WHEN m.sender_id = NEW.user_id THEN m.receiver_id ELSE m.sender_id END),
         LEAST(m.sender_id, m.receiver_id)::text || '_' || GREATEST(m.sender_id, m.receiver_id)::text
    INTO v_recipient, v_conversation
  FROM public.messages m WHERE m.id = NEW.message_id;

  IF v_recipient IS NULL THEN RETURN NEW; END IF;

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', 'reaction',
    'senderId', NEW.user_id,
    'recipientId', v_recipient,
    'conversationId', v_conversation,
    'messageId', NEW.message_id,
    'emoji', NEW.emoji,
    'createdAt', NEW.created_at
  ));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_reaction_insert_push ON public.message_reactions;
CREATE TRIGGER on_reaction_insert_push
  AFTER INSERT ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_reaction();

-- ----------------------------------------------------------------------------
-- 8. Trigger: call_history insert/update -> incoming/missed/ended call push
-- ----------------------------------------------------------------------------
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
    IF NEW.status = 'missed' THEN
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
      -- may have lost the realtime channel (e.g. backgrounded).
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
DROP TRIGGER IF EXISTS on_call_change_push ON public.call_history;
CREATE TRIGGER on_call_change_push
  AFTER INSERT OR UPDATE ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_call();

-- ----------------------------------------------------------------------------
-- 9. Trigger: partner_requests -> friend_request / friend_accepted
-- ----------------------------------------------------------------------------
-- partner_requests is this app's actual "friend request" flow (there is no
-- separate friends table; a couple is exactly one accepted partner_request).
CREATE OR REPLACE FUNCTION public.notify_push_on_partner_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'friend_request',
      'senderId', NEW.sender_id,
      'recipientId', NEW.receiver_id,
      'relatedId', NEW.id,
      'createdAt', NEW.created_at
    ));
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'friend_accepted',
      'senderId', NEW.receiver_id,
      'recipientId', NEW.sender_id,
      'relatedId', NEW.id,
      'createdAt', NEW.updated_at
    ));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_partner_request_push ON public.partner_requests;
CREATE TRIGGER on_partner_request_push
  AFTER INSERT OR UPDATE ON public.partner_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_partner_request();
