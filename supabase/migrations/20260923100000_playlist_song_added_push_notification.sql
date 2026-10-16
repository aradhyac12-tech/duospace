-- ============================================================================
-- "Our Playlist" collaborative queue: notify the partner when a song is added
-- ============================================================================
-- FIX (direct request: "the collaboration notification should be sent to
-- the partner as well"): docs/RELATIONSHIP_FEATURE_QA.md's own Playlist
-- section already flagged this exact gap —
--   "Deep link | — | Not added — songs don't have a natural share/
--   notification target yet (no push type exists for 'song added')."
--
-- public.playlist_songs is the single shared table both add-song entry
-- points write to (src/hooks/useOurPlaylist.ts's addSong(), used from
-- Groic, and src/pages/Playlist.tsx's own addSong()) — realtime already
-- syncs an already-open app instantly (see the existing "on INSERT" realtime
-- subscriptions in both files), but nothing told the OTHER partner's device
-- anything if their app wasn't open, unlike every other couple-facing
-- insert (messages, reactions, calls, partner requests), which already got
-- a push-dispatch trigger in 20260725091342_fcm_push_notifications.sql.
--
-- This migration closes that gap the same way: a new "song_added"
-- PushNotificationType (paired client/edge-function changes in
-- supabase/functions/_shared/pushTypes.ts and fcm.ts, plus a tap-routing
-- case in src/hooks/usePushNotifications.ts -> /playlist), dispatched via
-- the same private.dispatch_push() helper every other trigger in this file
-- already uses — a trigger, not a client-side call, so it fires no matter
-- which of the two add-song entry points inserted the row, and can never be
-- skipped by a client that forgets to call it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_push_on_playlist_song()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_recipient uuid;
  v_preview text;
BEGIN
  -- Direct profiles lookup rather than public.get_partner_id(): that
  -- function was deliberately locked (see
  -- 20260910140000_lock_get_partner_id_to_self.sql) to only ever resolve
  -- for auth.uid() itself, to stop it being used as a cross-user lookup
  -- RPC. This trigger function is already SECURITY DEFINER, same as every
  -- other trigger in 20260725091342_fcm_push_notifications.sql, so it can
  -- read profiles directly instead.
  SELECT partner_id INTO v_recipient FROM public.profiles WHERE user_id = NEW.added_by;
  IF v_recipient IS NULL THEN RETURN NEW; END IF;

  v_preview := trim(both ' — ' from
    coalesce(NEW.title, '') || CASE WHEN NEW.artist IS NOT NULL AND length(trim(NEW.artist)) > 0
      THEN ' — ' || NEW.artist ELSE '' END);

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', 'song_added',
    'senderId', NEW.added_by,
    'recipientId', v_recipient,
    'relatedId', NEW.id,
    'preview', v_preview,
    'createdAt', NEW.created_at
  ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_playlist_song_insert_push ON public.playlist_songs;
CREATE TRIGGER on_playlist_song_insert_push
  AFTER INSERT ON public.playlist_songs
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_playlist_song();
