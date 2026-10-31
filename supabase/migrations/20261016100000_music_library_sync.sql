-- Per-account Liked Songs + personal playlists, so they follow the ACCOUNT instead of the phone
-- (previously per-device localStorage: lost on reinstall / clear-data, never shared between phones).
--
-- One row per user, same shape/RLS as music_profiles. The two columns are MAPS keyed by item id:
--   liked[trackId]     = { at: <ms>, t: <slim track> }  or  { at: <ms>, del: true }   (tombstone)
--   playlists[plId]    = { at: <ms>, pl: <playlist> }   or  { at: <ms>, del: true }
-- `at` is last-writer-wins per item; tombstones make an unlike/delete on one phone win over a stale
-- copy on another (a plain union would resurrect it). The client merges; the server just stores.
--
-- updated_at is bumped by a trigger on every UPDATE and is the optimistic-concurrency token: the client
-- writes `UPDATE ... WHERE updated_at = <value it pulled>`, so two phones can't silently overwrite each other.
CREATE TABLE IF NOT EXISTS public.music_library (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  liked jsonb NOT NULL DEFAULT '{}'::jsonb,
  playlists jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT music_library_liked_is_object CHECK (jsonb_typeof(liked) = 'object' AND pg_column_size(liked) <= 1500000),
  CONSTRAINT music_library_playlists_is_object CHECK (jsonb_typeof(playlists) = 'object' AND pg_column_size(playlists) <= 4000000)
);

CREATE OR REPLACE FUNCTION public.music_library_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS music_library_touch ON public.music_library;
CREATE TRIGGER music_library_touch BEFORE UPDATE ON public.music_library
  FOR EACH ROW EXECUTE FUNCTION public.music_library_touch();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.music_library TO authenticated;
GRANT ALL ON public.music_library TO service_role;
ALTER TABLE public.music_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own music library select" ON public.music_library;
CREATE POLICY "Own music library select" ON public.music_library FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Own music library insert" ON public.music_library;
CREATE POLICY "Own music library insert" ON public.music_library FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Own music library update" ON public.music_library;
CREATE POLICY "Own music library update" ON public.music_library FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Own music library delete" ON public.music_library;
CREATE POLICY "Own music library delete" ON public.music_library FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));
