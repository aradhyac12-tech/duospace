ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS tracking_state text DEFAULT 'offline',
  ADD COLUMN IF NOT EXISTS app_visibility text DEFAULT 'visible',
  ADD COLUMN IF NOT EXISTS device_platform text;