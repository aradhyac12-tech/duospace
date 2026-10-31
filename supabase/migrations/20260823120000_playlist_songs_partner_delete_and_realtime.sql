-- Applied directly to the live project (jzlpelxwzjjpddqcrtpu) on 2026-08-23
-- via the Supabase MCP connector; this file exists so the migration
-- history in source control matches what's actually live.
--
-- NOTE ON HISTORY: an earlier draft of this migration assumed
-- playlist_songs' SELECT policy was still the old
-- `USING (true)` from this repo's own older migration files (see
-- 20260308233714 / 20260511075549 / 20260707054831 / 20260708090100) and
-- set out to fix a "every user can read every couple's playlist" bug.
-- Checking the live database directly showed that assumption was wrong —
-- SELECT there was already correctly couple-scoped
-- (added_by = auth.uid() OR added_by = get_partner_id(auth.uid())),
-- evidently fixed at some point without the corresponding migration file
-- landing in this working copy. Only the two gaps below were real.

-- 1) DELETE only allowed removing your own additions, not your partner's.
-- The Phase 4 Music brief's collaborative-playlist test matrix expects
-- "Our Playlist" to behave as one joint list ("A removes -> B sees" for
-- tracks either partner added), not two privately-owned lists rendered
-- together.
DROP POLICY IF EXISTS "Users can delete own songs" ON public.playlist_songs;

CREATE POLICY "Couple can remove their playlist songs" ON public.playlist_songs
  FOR DELETE TO authenticated
  USING (
    added_by = auth.uid()
    OR added_by = public.get_partner_id(auth.uid())
  );

-- 2) playlist_songs was never added to the supabase_realtime publication,
-- so a partner's add/remove required a manual refresh to see. Mirrors the
-- existing ADD TABLE pattern already used for call_history.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.playlist_songs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
