-- Partner device status: battery level + ringer/silent mode, shown mutually
-- on the Map. No RLS changes needed — the existing "Users can view partner
-- profiles" / "Users can update own profile" policies on public.profiles
-- already cover these new columns (SELECT: own row + partner's row, UPDATE:
-- own row only), same as the existing last_seen_at/tracking_state columns.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS battery_level numeric(5,2),
  ADD COLUMN IF NOT EXISTS battery_charging boolean,
  ADD COLUMN IF NOT EXISTS ringer_mode text,
  ADD COLUMN IF NOT EXISTS device_status_updated_at timestamptz;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_ringer_mode_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ringer_mode_check
  CHECK (ringer_mode IS NULL OR ringer_mode IN ('normal', 'vibrate', 'silent', 'unknown'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_battery_level_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_battery_level_check
  CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100));

COMMENT ON COLUMN public.profiles.battery_level IS 'Latest self-reported battery percentage (0-100), best-effort, may be null if unsupported/unavailable.';
COMMENT ON COLUMN public.profiles.ringer_mode IS 'Latest self-reported ringer state: normal | vibrate | silent | unknown. iOS cannot detect the physical mute switch (no public Apple API) so iOS devices always report unknown.';
COMMENT ON COLUMN public.profiles.device_status_updated_at IS 'When battery_level/ringer_mode were last refreshed — used to gray out stale values in the UI, independent of last_seen_at.';
