-- Security-linter cleanup for pre-existing production functions (2026-09-26).
-- No behaviour change: verified on the staging project before being proposed.
--
-- 1) Pin search_path on three trigger functions (lint 0011). Their bodies use
--    only NEW/OLD, now() and the schema-qualified auth.uid(), so resolution is
--    identical.
ALTER FUNCTION public.guard_message_update() SET search_path = public;
ALTER FUNCTION public.touch_user_consents_updated_at() SET search_path = public;
ALTER FUNCTION public.enforce_ai_insight_immutability() SET search_path = public;

-- 2) SECURITY DEFINER *trigger* functions were callable via /rest/v1/rpc
--    (lints 0028/0029). Postgres checks EXECUTE only when a trigger is
--    created, not when it fires, so revoking it does not stop the triggers.
REVOKE EXECUTE ON FUNCTION public.enforce_ai_insight_consent() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_push_on_playlist_song() FROM PUBLIC, anon, authenticated;

-- Deliberately NOT changed:
--  * public.is_couple_realtime_topic_authorized(text): used by the realtime
--    policies "couple realtime topics: send/receive"; revoking EXECUTE from
--    authenticated would break live chat.
--  * public.location_push_credentials: RLS on with no policy = deny-all to
--    clients, intended (service-role only).
--  * the remaining authenticated-callable SECURITY DEFINER RPCs are the app's
--    own API (partner linking, calls, unlink…).
