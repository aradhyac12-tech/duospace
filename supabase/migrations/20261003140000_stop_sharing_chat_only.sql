-- ============================================================================
-- Stop sharing => chat-only mode (owner decision 2026-10-03)
-- ============================================================================
-- While a person has stopped sharing (which also starts the irreversible
-- 14-day unlink, see 20261003120000), between them and their partner:
--   * PHOTOS hidden: the stopper's gallery items/albums and the gallery +
--     memories storage files are no longer readable by the partner.
--   * CALLS blocked: no new call_history row can be inserted in either
--     direction, and any call in progress is ended when sharing is stopped.
--   * URGENT / IMPORTANT disabled: both flags are forced to false on every
--     message between the pair (so the DND-bypassing push never fires).
--   * CHAT stays available (text, chat-files, nudges, letters).
-- Enforced in Postgres so a stale or patched client cannot get around it.
-- The sharing_state row is cleared when the unlink completes (or when there
-- was nothing to unlink), so nobody is left permanently restricted.
-- ============================================================================

-- Policies run as the querying role, which cannot call private.*. This public
-- wrapper only ever answers about the caller's OWN partner, so it is not an
-- oracle for other people's state.
CREATE OR REPLACE FUNCTION public.partner_has_stopped_sharing(_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _owner IS NOT NULL
     AND _owner = public.get_partner_id(auth.uid())
     AND private.sharing_is_stopped(_owner)
$$;
REVOKE ALL ON FUNCTION public.partner_has_stopped_sharing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_has_stopped_sharing(uuid) TO authenticated;

-- No-argument form for storage policies (avoids casting folder names to uuid).
CREATE OR REPLACE FUNCTION public.my_partner_has_stopped_sharing()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.partner_has_stopped_sharing(public.get_partner_id(auth.uid()))
$$;
REVOKE ALL ON FUNCTION public.my_partner_has_stopped_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_partner_has_stopped_sharing() TO authenticated;

-- Pair check for triggers (either side stopped).
CREATE OR REPLACE FUNCTION private.pair_sharing_stopped(_a uuid, _b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT private.sharing_is_stopped(_a) OR private.sharing_is_stopped(_b)
$$;
REVOKE ALL ON FUNCTION private.pair_sharing_stopped(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---- Photos: gallery_items --------------------------------------------------
DROP POLICY IF EXISTS "Users can view own gallery" ON public.gallery_items;
CREATE POLICY "Users can view own gallery" ON public.gallery_items FOR SELECT TO authenticated
USING (
  (SELECT auth.uid()) = owner_id
  OR (
    NOT public.partner_has_stopped_sharing(owner_id)
    AND (
      (is_shared = true AND owner_id = public.get_partner_id((SELECT auth.uid())))
      OR owner_id IN (
        SELECT p.user_id FROM public.profiles p
        WHERE p.gallery_shared = true AND p.user_id = public.get_partner_id((SELECT auth.uid()))
      )
    )
  )
);

DROP POLICY IF EXISTS "Users can update own or shared gallery items" ON public.gallery_items;
CREATE POLICY "Users can update own or shared gallery items" ON public.gallery_items FOR UPDATE TO authenticated
USING (
  (SELECT auth.uid()) = owner_id
  OR (
    owner_id = public.get_partner_id((SELECT auth.uid()))
    AND NOT public.partner_has_stopped_sharing(owner_id)
    AND (
      is_shared = true
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = gallery_items.owner_id AND p.gallery_shared = true
          AND p.user_id = public.get_partner_id((SELECT auth.uid()))
      )
    )
  )
)
WITH CHECK (
  (SELECT auth.uid()) = owner_id OR owner_id = public.get_partner_id((SELECT auth.uid()))
);

-- ---- Photos: albums ---------------------------------------------------------
DROP POLICY IF EXISTS "Couple can view their albums" ON public.gallery_albums;
CREATE POLICY "Couple can view their albums" ON public.gallery_albums FOR SELECT TO authenticated
USING (
  owner_id = (SELECT auth.uid())
  OR (owner_id = public.get_partner_id((SELECT auth.uid())) AND NOT public.partner_has_stopped_sharing(owner_id))
);

-- ---- Photos: storage files (gallery + memories buckets only; chat-files stay)
DROP POLICY IF EXISTS "Authenticated users read own or partner files" ON storage.objects;
CREATE POLICY "Authenticated users read own or partner files" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = ANY (ARRAY['chat-files'::text, 'gallery'::text, 'memories'::text])
  AND (
    (storage.foldername(name))[1] = (auth.uid())::text
    OR (
      (storage.foldername(name))[1] = (SELECT profiles.partner_id::text FROM public.profiles WHERE profiles.user_id = auth.uid())
      AND NOT (
        bucket_id = ANY (ARRAY['gallery'::text, 'memories'::text])
        AND public.my_partner_has_stopped_sharing()
      )
    )
  )
);

-- ---- Calls blocked ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_history_block_when_sharing_stopped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF private.pair_sharing_stopped(NEW.caller_id, NEW.receiver_id) THEN
    RAISE EXCEPTION 'CALLS_DISABLED: calls are turned off while sharing is stopped'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.call_history_block_when_sharing_stopped() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS call_history_block_stopped_trg ON public.call_history;
CREATE TRIGGER call_history_block_stopped_trg
  BEFORE INSERT ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.call_history_block_when_sharing_stopped();

-- ---- Urgent / important disabled -------------------------------------------
CREATE OR REPLACE FUNCTION public.messages_strip_alert_flags_when_stopped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.urgent OR NEW.important)
     AND private.pair_sharing_stopped(NEW.sender_id, NEW.receiver_id) THEN
    NEW.urgent := false;
    NEW.important := false;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.messages_strip_alert_flags_when_stopped() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_strip_alerts_stopped_trg ON public.messages;
CREATE TRIGGER messages_strip_alerts_stopped_trg
  BEFORE INSERT OR UPDATE OF urgent, important ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_strip_alert_flags_when_stopped();

-- ---- stop_sharing(): also end live calls; never leave a stuck state ---------
CREATE OR REPLACE FUNCTION public.stop_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_stopped timestamptz;
  v_unlink  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  INSERT INTO public.sharing_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT stopped_at INTO v_stopped FROM public.sharing_state WHERE user_id = v_uid;

  DELETE FROM public.locations WHERE user_id = v_uid;

  UPDATE public.profiles
     SET battery_level = NULL, battery_charging = NULL,
         ringer_mode = NULL, device_status_updated_at = NULL
   WHERE user_id = v_uid;

  UPDATE public.relationship_shares
     SET revoked_at = now()
   WHERE owner_id = v_uid AND revoked_at IS NULL;

  -- Calls are off: end anything still ringing / in progress.
  BEGIN
    UPDATE public.call_history
       SET status = 'cancelled'
     WHERE status = 'in_progress' AND (caller_id = v_uid OR receiver_id = v_uid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stop_sharing: could not end live calls: %', SQLERRM;
  END;

  v_unlink := public.schedule_unlink();

  -- Nothing left to restrict if there was no pairing to unlink, or it was
  -- one-sided and ended immediately. Otherwise the restriction lasts until
  -- the 14 days are up (execute_scheduled_unlink clears it).
  IF v_unlink->>'status' = 'executed' OR v_unlink->>'error' = 'NOT_LINKED' THEN
    DELETE FROM public.sharing_state WHERE user_id = v_uid;
  END IF;

  RETURN jsonb_build_object('status', 'stopped', 'stopped_at', v_stopped, 'unlink', v_unlink);
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_sharing() TO authenticated;

-- ---- execute_scheduled_unlink(): clear the requester's restriction ----------
CREATE OR REPLACE FUNCTION private.execute_scheduled_unlink(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.scheduled_unlinks%ROWTYPE;
  v_still_paired boolean;
BEGIN
  SELECT * INTO v_row FROM public.scheduled_unlinks
    WHERE id = p_id AND status = 'scheduled' AND execute_at <= now()
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM public.profiles
    WHERE user_id IN (v_row.requester_id, v_row.partner_id) ORDER BY user_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles a
      JOIN public.profiles b ON b.user_id = a.partner_id AND b.partner_id = a.user_id
     WHERE a.user_id = v_row.requester_id AND a.partner_id = v_row.partner_id
  ) INTO v_still_paired;

  IF NOT v_still_paired THEN
    UPDATE public.scheduled_unlinks SET status = 'void', resolved_at = now() WHERE id = v_row.id;
    DELETE FROM public.sharing_state WHERE user_id = v_row.requester_id;
    RETURN false;
  END IF;

  UPDATE public.scheduled_unlinks SET status = 'executed', resolved_at = now() WHERE id = v_row.id;
  PERFORM private.apply_unlink(v_row.requester_id, v_row.partner_id);
  -- The pairing is over; the requester starts clean for any future partner.
  DELETE FROM public.sharing_state WHERE user_id = v_row.requester_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION private.execute_scheduled_unlink(uuid) FROM PUBLIC, anon, authenticated;
