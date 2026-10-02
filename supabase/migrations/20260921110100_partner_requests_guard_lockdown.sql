-- Applied live 2026-09-21 together with 20260916140000_partner_requests_transition_guard.sql
-- (which was NOT on the live project until then and closed a live exploit: a receiver could
-- rewrite sender_id and call accept_partner_request to force a pairing).
-- The trigger function is SECURITY DEFINER and must not be callable through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.enforce_partner_request_transition() FROM PUBLIC, anon, authenticated;
