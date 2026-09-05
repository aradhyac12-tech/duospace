CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE,
  avatar_url TEXT,
  gender TEXT,
  phone_number TEXT,
  pet_name TEXT,
  partner_id UUID,
  mood_emoji TEXT DEFAULT '😊',
  mood_text TEXT DEFAULT 'Feeling good',
  mood_updated_at TIMESTAMPTZ DEFAULT now(),
  public_key TEXT,
  couple_theme TEXT,
  gallery_shared BOOLEAN NOT NULL DEFAULT false,
  push_token TEXT,
  push_platform TEXT,
  last_seen_at TIMESTAMPTZ,
  tracking_state TEXT,
  battery_level NUMERIC,
  battery_charging BOOLEAN,
  ringer_mode TEXT,
  device_status_updated_at TIMESTAMPTZ,
  app_visibility TEXT,
  device_platform TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own or partner profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = partner_id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_profiles_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.update_profiles_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_profiles_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  metadata_name TEXT;
  metadata_avatar TEXT;
BEGIN
  metadata_name := NULLIF(BTRIM(COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'preferred_username',
    ''
  )), '');
  metadata_avatar := NULLIF(BTRIM(COALESCE(
    NEW.raw_user_meta_data ->> 'avatar_url',
    NEW.raw_user_meta_data ->> 'picture',
    ''
  )), '');

  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(metadata_name, NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''), 'DuoSpace user'),
    metadata_avatar
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE INDEX profiles_partner_id_idx ON public.profiles (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX profiles_username_lower_idx ON public.profiles (LOWER(username)) WHERE username IS NOT NULL;