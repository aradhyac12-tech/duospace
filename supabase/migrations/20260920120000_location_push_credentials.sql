-- KI-12 gap 2: let a push-triggered location fix be uploaded even when the app
-- process is dead (no WebView, no JS, no Supabase session refresh possible).
--
-- WHY NOT JUST REUSE THE SESSION TOKEN: natively, an access token is only
-- valid ~1 h and cannot be refreshed safely (refresh-token rotation would race
-- the JS client and could sign the person out). So the device instead holds a
-- narrow, revocable per-device credential that can do exactly ONE thing —
-- write that user's own location row, via the `location-push-upload` edge
-- function. It cannot read anything, and it is worthless for any other API.
--
-- Only a SHA-256 hash of the secret is stored. RLS is enabled with NO policies
-- and all client-role grants are revoked: only the edge functions (service
-- role) can touch this table. Rows cascade-delete with the auth user.

CREATE TABLE IF NOT EXISTS public.location_push_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id    text NOT NULL,
  secret_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT location_push_credentials_device_len CHECK (char_length(device_id) BETWEEN 1 AND 100),
  CONSTRAINT location_push_credentials_user_device_uniq UNIQUE (user_id, device_id)
);

ALTER TABLE public.location_push_credentials ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.location_push_credentials FROM anon, authenticated;
GRANT ALL ON TABLE public.location_push_credentials TO service_role;

COMMENT ON TABLE public.location_push_credentials IS
  'Per-device write-only credential for push-triggered location upload while the app is closed. Service-role only (no RLS policies on purpose). See supabase/functions/location-push-register and location-push-upload.';
