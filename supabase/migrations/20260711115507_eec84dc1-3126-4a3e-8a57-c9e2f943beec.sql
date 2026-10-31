CREATE TABLE IF NOT EXISTS public.user_secrets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_api_key TEXT,
  daily_key_hint TEXT,
  daily_provides_calls BOOLEAN NOT NULL DEFAULT false,
  google_drive_refresh_token TEXT,
  google_drive_email TEXT,
  google_drive_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_secrets TO authenticated;
GRANT ALL ON public.user_secrets TO service_role;

ALTER TABLE public.user_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own secrets"
  ON public.user_secrets FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_user_secrets_updated_at
  BEFORE UPDATE ON public.user_secrets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Helper: fetch partner's Daily.co key when caller lacks one.
-- SECURITY DEFINER so it can read another user's row via the policy owner.
-- Returns NULL if no partner or partner has no key.
CREATE OR REPLACE FUNCTION public.get_partner_daily_key(_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT us.daily_api_key
  FROM public.profiles p
  JOIN public.user_secrets us ON us.user_id = p.partner_id
  WHERE p.user_id = _user_id
    AND us.daily_api_key IS NOT NULL
    AND us.daily_provides_calls = true
  LIMIT 1;
$$;