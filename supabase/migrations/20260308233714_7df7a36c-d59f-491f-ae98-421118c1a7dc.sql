
CREATE TABLE public.playlist_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  added_by uuid NOT NULL,
  title text NOT NULL,
  artist text NOT NULL DEFAULT '',
  song_url text NOT NULL,
  platform text NOT NULL DEFAULT 'youtube',
  thumbnail_url text DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.playlist_songs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view songs"
  ON public.playlist_songs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users can add songs"
  ON public.playlist_songs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = added_by);

CREATE POLICY "Users can delete own songs"
  ON public.playlist_songs FOR DELETE TO authenticated
  USING (auth.uid() = added_by);
