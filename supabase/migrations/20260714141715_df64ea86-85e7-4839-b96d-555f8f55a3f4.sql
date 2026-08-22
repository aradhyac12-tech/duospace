
CREATE TABLE public.known_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  label text,
  user_agent text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

GRANT SELECT, DELETE ON public.known_devices TO authenticated;
GRANT ALL ON public.known_devices TO service_role;

ALTER TABLE public.known_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own devices" ON public.known_devices
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users delete own devices" ON public.known_devices
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX known_devices_user_idx ON public.known_devices(user_id, last_seen_at DESC);
