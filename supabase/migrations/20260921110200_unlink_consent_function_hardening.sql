-- Applied live 2026-09-21 (security advisor follow-up to 20260920150000_partner_unlink_consent.sql):
-- trigger functions must not be callable via /rest/v1/rpc; pin the guard's search_path.
REVOKE EXECUTE ON FUNCTION public.notify_push_on_unlink_request() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_profiles_partner_id() FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.guard_profiles_partner_id() SET search_path = public;
