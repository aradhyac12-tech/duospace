
-- Persistent rate limiter shared by edge functions
CREATE TABLE IF NOT EXISTS public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bucket text NOT NULL,
  hit_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON public.rate_limits (user_id, bucket, hit_at DESC);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- No direct client access. Only service role (edge functions) reads/writes.
CREATE POLICY "service role only" ON public.rate_limits
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  _user_id uuid,
  _bucket text,
  _max int,
  _window_seconds int
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM public.rate_limits
   WHERE hit_at < now() - make_interval(secs => _window_seconds * 4);

  SELECT count(*) INTO v_count
    FROM public.rate_limits
   WHERE user_id = _user_id
     AND bucket = _bucket
     AND hit_at > now() - make_interval(secs => _window_seconds);

  IF v_count >= _max THEN
    RETURN false;
  END IF;

  INSERT INTO public.rate_limits (user_id, bucket) VALUES (_user_id, _bucket);
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, int, int) FROM public, anon;
-- service_role bypasses by default; authenticated callers don't need it
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, int, int) TO service_role;

-- Lock down sensitive RPCs so only authenticated callers can invoke them
REVOKE EXECUTE ON FUNCTION public.accept_invite(text, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.unlink_partner(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.search_users(text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_disappeared_messages() FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.delete_expired_messages() FROM public, anon;

GRANT EXECUTE ON FUNCTION public.accept_invite(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_partner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;
