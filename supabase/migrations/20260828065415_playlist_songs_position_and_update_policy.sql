-- Applied directly to the live project (jzlpelxwzjjpddqcrtpu) on 2026-08-28
-- via the Supabase MCP connector, as part of Music 2.0 phase 1 (Couple
-- Playlist rebuild). This file exists so the migration history in source
-- control matches what's actually live — same convention as
-- 20260823120000_playlist_songs_partner_delete_and_realtime.sql.
--
-- Couple Playlist reordering + last-editor attribution.
-- position: fractional-index style float -- reordering one song only ever
-- needs to update that one row (position set to a value between its new
-- neighbors), never a full renumber of the list. Backfilled below in
-- created_at order so existing playlists get a stable starting order that
-- matches what users already saw.
ALTER TABLE public.playlist_songs
  ADD COLUMN IF NOT EXISTS position double precision,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by uuid;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at ASC) AS rn
  FROM public.playlist_songs
  WHERE position IS NULL
)
UPDATE public.playlist_songs p
SET position = ordered.rn * 1000
FROM ordered
WHERE p.id = ordered.id;

ALTER TABLE public.playlist_songs ALTER COLUMN position SET NOT NULL;
ALTER TABLE public.playlist_songs ALTER COLUMN position SET DEFAULT (extract(epoch from now()) * 1000);

-- Keep updated_at/updated_by accurate without relying on every call site
-- remembering to set them (client only ever sends the fields it's
-- actually changing).
CREATE OR REPLACE FUNCTION public.touch_playlist_song()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_playlist_song ON public.playlist_songs;
CREATE TRIGGER trg_touch_playlist_song
  BEFORE UPDATE ON public.playlist_songs
  FOR EACH ROW EXECUTE FUNCTION public.touch_playlist_song();

-- Reordering (and any other collaborative edit) needs an UPDATE policy --
-- there wasn't one before, so any UPDATE was silently denied by RLS.
-- Same couple-scoping as the existing SELECT/DELETE policies: either
-- partner can move either partner's songs, since it's one joint list.
DROP POLICY IF EXISTS "Couple can update their playlist songs" ON public.playlist_songs;
CREATE POLICY "Couple can update their playlist songs" ON public.playlist_songs
  FOR UPDATE TO authenticated
  USING (added_by = auth.uid() OR added_by = public.get_partner_id(auth.uid()))
  WITH CHECK (added_by = auth.uid() OR added_by = public.get_partner_id(auth.uid()));
