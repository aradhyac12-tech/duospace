
-- ============================================================
-- Section 1: profiles — push tokens + couple theme
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_token TEXT,
  ADD COLUMN IF NOT EXISTS push_platform TEXT,
  ADD COLUMN IF NOT EXISTS couple_theme TEXT;

-- ============================================================
-- Section 2: messages — edit, pin, soft-delete safety
-- ============================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_by_sender BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_by_receiver BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- Section 3: invite_links — make sure used_by/used_at exist
-- ============================================================
ALTER TABLE public.invite_links
  ADD COLUMN IF NOT EXISTS used_by UUID,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- ============================================================
-- Section 4: taps — receiver_id for direct delivery
-- ============================================================
ALTER TABLE public.taps
  ADD COLUMN IF NOT EXISTS receiver_id UUID;

-- ============================================================
-- Section 5: scheduled_messages table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  send_at TIMESTAMPTZ NOT NULL,
  disappear_at TEXT,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  is_processing BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own scheduled messages" ON public.scheduled_messages;
CREATE POLICY "Users manage their own scheduled messages"
  ON public.scheduled_messages
  FOR ALL
  TO authenticated
  USING (sender_id = auth.uid())
  WITH CHECK (sender_id = auth.uid());

-- ============================================================
-- Section 6: helper functions
-- ============================================================

-- Atomic unlink
CREATE OR REPLACE FUNCTION public.unlink_partner(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner_id UUID;
BEGIN
  SELECT partner_id INTO v_partner_id FROM public.profiles WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = p_user_id;
  IF v_partner_id IS NOT NULL THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_partner_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.unlink_partner(UUID) TO authenticated;

-- Atomic accept invite (deletes the invite so it can't be reused)
CREATE OR REPLACE FUNCTION public.accept_invite(p_code TEXT, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite RECORD;
  v_creator_display_name TEXT;
BEGIN
  SELECT * INTO v_invite
  FROM public.invite_links
  WHERE code = p_code
    AND (used_by IS NULL)
    AND (expires_at IS NULL OR expires_at > now())
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Invite not found or already used');
  END IF;

  IF v_invite.creator_id = p_user_id THEN
    RETURN jsonb_build_object('error', 'Cannot use your own invite');
  END IF;

  UPDATE public.profiles SET partner_id = v_invite.creator_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_invite.creator_id;

  DELETE FROM public.invite_links WHERE id = v_invite.id;

  SELECT display_name INTO v_creator_display_name FROM public.profiles WHERE user_id = v_invite.creator_id;

  RETURN jsonb_build_object(
    'success', true,
    'creator_id', v_invite.creator_id,
    'creator_name', COALESCE(v_creator_display_name, 'Partner')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT, UUID) TO authenticated;

-- Atomic accept partner request
CREATE OR REPLACE FUNCTION public.accept_partner_request(p_request_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_id UUID;
BEGIN
  SELECT sender_id INTO v_sender_id
  FROM public.partner_requests
  WHERE id = p_request_id
    AND receiver_id = p_user_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found or already processed';
  END IF;

  UPDATE public.partner_requests SET status = 'accepted' WHERE id = p_request_id;

  UPDATE public.profiles SET partner_id = NULL
  WHERE user_id IN (p_user_id, v_sender_id);

  UPDATE public.profiles SET partner_id = v_sender_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id   WHERE user_id = v_sender_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(UUID, UUID) TO authenticated;

-- Trigger: when a partner link is established, mark related pending requests accepted
CREATE OR REPLACE FUNCTION public.cleanup_accepted_requests()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_id IS NOT NULL AND (OLD.partner_id IS NULL OR OLD.partner_id IS DISTINCT FROM NEW.partner_id) THEN
    UPDATE public.partner_requests
    SET status = 'accepted'
    WHERE status = 'pending'
      AND (
        (sender_id = NEW.user_id AND receiver_id = NEW.partner_id)
        OR (sender_id = NEW.partner_id AND receiver_id = NEW.user_id)
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_partner_linked ON public.profiles;
CREATE TRIGGER on_partner_linked
  AFTER UPDATE OF partner_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_accepted_requests();

-- Server-side expiry sweep for disappearing messages
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages
  WHERE disappear_at IS NOT NULL
    AND disappear_at <= now();
END;
$$;

-- Atomic claimer for pending scheduled messages
CREATE OR REPLACE FUNCTION public.claim_pending_scheduled_messages()
RETURNS SETOF public.scheduled_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.scheduled_messages
  SET    is_processing = true
  WHERE  sent          = false
    AND  is_processing = false
    AND  send_at       <= now()
  RETURNING *;
$$;
GRANT EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() TO service_role;

-- ============================================================
-- Section 7: pg_cron schedule for expiry sweep (best-effort)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'delete-expired-messages';

    PERFORM cron.schedule(
      'delete-expired-messages',
      '* * * * *',
      $cron$SELECT public.delete_expired_messages();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron not installed in this environment; skip scheduling.
  RAISE NOTICE 'pg_cron not available; skipping schedule.';
END $$;

-- ============================================================
-- Section 8: re-assert RLS is ON for every user-data table
-- ============================================================
ALTER TABLE IF EXISTS public.messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.call_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.message_reactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.imported_chats     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.locations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.playlist_songs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.shayaris           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.gallery_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mood_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.partner_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.invite_links       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.code_surprises     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.code_surprise_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.menstrual_cycles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.taps               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.daily_answers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.countdowns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.blend_invites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Section 9: performance indexes
-- ============================================================

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_pair_created
  ON public.messages (
    LEAST(sender_id, receiver_id),
    GREATEST(sender_id, receiver_id),
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_messages_receiver_created
  ON public.messages (receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON public.messages (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_not_deleted
  ON public.messages (sender_id, receiver_id, created_at DESC)
  WHERE deleted_by_sender IS NOT TRUE AND deleted_by_receiver IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_messages_pinned
  ON public.messages (sender_id, receiver_id)
  WHERE is_pinned = TRUE;

CREATE INDEX IF NOT EXISTS idx_messages_disappear_at
  ON public.messages (disappear_at)
  WHERE disappear_at IS NOT NULL;

-- profiles
CREATE INDEX IF NOT EXISTS idx_profiles_partner_id
  ON public.profiles (partner_id)
  WHERE partner_id IS NOT NULL;

-- call_history
CREATE INDEX IF NOT EXISTS idx_call_history_receiver_status
  ON public.call_history (receiver_id, status);

CREATE INDEX IF NOT EXISTS idx_call_history_pair_created
  ON public.call_history (
    LEAST(caller_id, receiver_id),
    GREATEST(caller_id, receiver_id),
    created_at ASC
  );

-- message_reactions
CREATE INDEX IF NOT EXISTS idx_reactions_message_id
  ON public.message_reactions (message_id, user_id);

-- scheduled_messages
CREATE INDEX IF NOT EXISTS idx_scheduled_claimable
  ON public.scheduled_messages (send_at ASC)
  WHERE sent = FALSE AND is_processing = FALSE;

-- locations
CREATE INDEX IF NOT EXISTS idx_locations_user_updated
  ON public.locations (user_id, updated_at DESC);

-- imported_chats
CREATE INDEX IF NOT EXISTS idx_imported_chats_owner_ts
  ON public.imported_chats (owner_id, original_timestamp ASC);

-- taps
CREATE INDEX IF NOT EXISTS idx_taps_receiver_created
  ON public.taps (receiver_id, created_at DESC);
