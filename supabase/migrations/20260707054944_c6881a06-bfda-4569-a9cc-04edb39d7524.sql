ALTER TABLE public.pending_uploads
  ADD COLUMN IF NOT EXISTS total_bytes bigint,
  ADD COLUMN IF NOT EXISTS content_type text;

-- Keep trigger/helper functions off the public API surface where possible.
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_accepted_requests() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_expired_messages() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_disappeared_messages() FROM authenticated;

-- Re-affirm intended app RPC access.
GRANT EXECUTE ON FUNCTION public.get_partner_id(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_partner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_partner_request_v2(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_pairing_tokens_gc() TO service_role;
GRANT EXECUTE ON FUNCTION public.webauthn_challenges_gc() TO service_role;
GRANT EXECUTE ON FUNCTION public.email_change_otps_gc() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() TO service_role;