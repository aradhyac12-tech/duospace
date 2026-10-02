-- Per-account music taste. One row per user: the rolling play log that feeds
-- suggestions (artist affinity, skips, completions) and the recent-plays
-- window used for "don't suggest this again". Previously this lived only in
-- the device's localStorage under global keys, so it was shared between
-- every account on a phone and lost on reinstall.
CREATE TABLE IF NOT EXISTS public.music_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  play_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  play_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- recent searches + chosen trending languages, last-edit-wins
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT music_profiles_play_log_is_array CHECK (jsonb_typeof(play_log) = 'array' AND jsonb_array_length(play_log) <= 400),
  CONSTRAINT music_profiles_play_history_is_array CHECK (jsonb_typeof(play_history) = 'array' AND jsonb_array_length(play_history) <= 100)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.music_profiles TO authenticated;
GRANT ALL ON public.music_profiles TO service_role;
ALTER TABLE public.music_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own music profile select" ON public.music_profiles;
CREATE POLICY "Own music profile select" ON public.music_profiles FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Own music profile insert" ON public.music_profiles;
CREATE POLICY "Own music profile insert" ON public.music_profiles FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Own music profile update" ON public.music_profiles;
CREATE POLICY "Own music profile update" ON public.music_profiles FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Own music profile delete" ON public.music_profiles;
CREATE POLICY "Own music profile delete" ON public.music_profiles FOR DELETE TO authenticated USING (user_id = auth.uid());
