-- Follow-up to 20261003190000_app_releases_ota.sql (found by checking the LIVE
-- grants right after applying it).
--
-- Supabase's default privileges grant ALL on every new public table to
-- `authenticated`. The OTA migration only added GRANT SELECT and never revoked
-- those defaults. RLS stops INSERT/UPDATE/DELETE (no policy = denied) but does
-- NOT apply to TRUNCATE, so any signed-in user could have emptied app_releases.
-- PGlite has no default privileges, which is why the unit tests did not see it.
-- Strip everything and re-grant only SELECT (still filtered by the admin policy).
REVOKE ALL ON TABLE public.app_releases FROM authenticated, anon, public;
GRANT SELECT ON TABLE public.app_releases TO authenticated;
GRANT ALL ON TABLE public.app_releases TO service_role;
