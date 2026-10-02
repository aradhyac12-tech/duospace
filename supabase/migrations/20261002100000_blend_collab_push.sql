-- ============================================================================
-- Blend (listen-together) collaboration: push notifications + safer UPDATE
-- ============================================================================
-- FIX (direct request: "whenever the collaboration starts the partner should
-- get a proper push notification"): Blend invites and acceptance were only
-- delivered over realtime, so a partner whose app was closed/backgrounded
-- never found out. Same pattern as song_added: a DB trigger -> the shared
-- private.dispatch_push() helper, so it fires no matter which client wrote
-- the row and can never be skipped by a client.
--   * INSERT (status=pending)   -> 'blend_invite'  to the sender's partner
--   * UPDATE (-> accepted)      -> 'blend_started' to the invite's sender
-- Paired changes: pushTypes.ts / fcm.ts (new types), usePushNotifications.ts
-- (tap routing -> /playlist).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_push_on_blend_invite()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_recipient uuid;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  SELECT partner_id INTO v_recipient FROM public.profiles WHERE user_id = NEW.sender_id;
  IF v_recipient IS NULL THEN RETURN NEW; END IF;

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', 'blend_invite',
    'senderId', NEW.sender_id,
    'recipientId', v_recipient,
    'relatedId', NEW.id,
    'createdAt', NEW.created_at
  ));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_push_on_blend_accepted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_accepter uuid;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status = 'accepted' THEN RETURN NEW; END IF;
  -- The accepter is the sender's partner (RLS only lets them UPDATE).
  SELECT partner_id INTO v_accepter FROM public.profiles WHERE user_id = NEW.sender_id;

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', 'blend_started',
    'senderId', v_accepter,
    'recipientId', NEW.sender_id,
    'relatedId', NEW.id,
    'createdAt', now()
  ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_blend_invite_insert_push ON public.blend_invites;
CREATE TRIGGER on_blend_invite_insert_push
  AFTER INSERT ON public.blend_invites
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_blend_invite();

DROP TRIGGER IF EXISTS on_blend_invite_accept_push ON public.blend_invites;
CREATE TRIGGER on_blend_invite_accept_push
  AFTER UPDATE ON public.blend_invites
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_blend_accepted();

-- The accepter must not be able to rewrite who sent the invite.
DROP POLICY IF EXISTS "Update blend invites" ON public.blend_invites;
CREATE POLICY "Update blend invites" ON public.blend_invites FOR UPDATE TO authenticated
  USING (sender_id = public.get_partner_id(auth.uid()))
  WITH CHECK (sender_id = public.get_partner_id(auth.uid()));

-- Realtime DELETE events need the old row's columns to be matchable.
ALTER TABLE public.blend_invites REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS blend_invites_sender_status_idx ON public.blend_invites (sender_id, status);
