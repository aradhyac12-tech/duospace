-- The app subscribes to postgres_changes UPDATE on public.profiles (partner battery,
-- charging, ringer, presence — LocationContext.tsx, ThemeContext.tsx) but the table was
-- never in the supabase_realtime publication, so those events never fired and partner
-- status only ever refreshed on a manual refetch. Realtime applies the table's RLS
-- (SELECT policy: own row + partner's row), so publishing exposes nothing new.
-- APPLIED LIVE 2026-10-01 via the Supabase connector.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
