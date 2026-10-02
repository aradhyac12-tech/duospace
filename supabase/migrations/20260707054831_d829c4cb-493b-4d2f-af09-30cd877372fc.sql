-- DuoSpace Lovable Cloud baseline schema + auth support
-- Idempotent setup for profiles, partner linking, chat/media, QR auth, passkeys, OTP, storage policies.

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT '',
  avatar_url text,
  mood_emoji text DEFAULT '😊',
  mood_text text DEFAULT 'Feeling good',
  mood_updated_at timestamptz DEFAULT now(),
  partner_id uuid,
  gallery_shared boolean NOT NULL DEFAULT false,
  public_key text,
  gender text,
  phone_number text,
  pet_name text,
  username text UNIQUE,
  location_mode text NOT NULL DEFAULT 'on_open',
  push_token text,
  push_platform text,
  couple_theme text,
  last_seen_at timestamptz,
  tracking_state text DEFAULT 'offline',
  app_visibility text DEFAULT 'visible',
  device_platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view partner profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can view partner profiles" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = (SELECT p.partner_id FROM public.profiles p WHERE p.user_id = auth.uid()));
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, ''))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.get_partner_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT partner_id FROM public.profiles WHERE user_id = _user_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.get_partner_id(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_partner_id(uuid) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  content text,
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','file','voice')),
  file_url text,
  file_name text,
  is_read boolean NOT NULL DEFAULT false,
  reply_to_id uuid,
  disappear_at timestamptz,
  deleted_by_sender boolean NOT NULL DEFAULT false,
  deleted_by_receiver boolean NOT NULL DEFAULT false,
  edited_at timestamptz,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own messages" ON public.messages;
DROP POLICY IF EXISTS "Users can send messages" ON public.messages;
DROP POLICY IF EXISTS "Users can delete own messages" ON public.messages;
DROP POLICY IF EXISTS "Users can update own messages" ON public.messages;
CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can send messages" ON public.messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Users can delete own messages" ON public.messages FOR DELETE TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can update own messages" ON public.messages FOR UPDATE TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON public.messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON public.messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON public.messages(created_at DESC);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.messages; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locations TO authenticated;
GRANT ALL ON public.locations TO service_role;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view partner location" ON public.locations;
DROP POLICY IF EXISTS "Users can upsert own location" ON public.locations;
DROP POLICY IF EXISTS "Users can update own location" ON public.locations;
CREATE POLICY "Users can view partner location" ON public.locations FOR SELECT TO authenticated USING (auth.uid() = user_id OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Users can upsert own location" ON public.locations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own location" ON public.locations FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.locations; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.countdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL,
  title text NOT NULL,
  target_date timestamptz NOT NULL,
  emoji text DEFAULT '🎉',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.countdowns TO authenticated;
GRANT ALL ON public.countdowns TO service_role;
ALTER TABLE public.countdowns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view countdowns" ON public.countdowns;
DROP POLICY IF EXISTS "Users can create countdowns" ON public.countdowns;
DROP POLICY IF EXISTS "Users can delete own countdowns" ON public.countdowns;
CREATE POLICY "Authenticated users can view countdowns" ON public.countdowns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create countdowns" ON public.countdowns FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own countdowns" ON public.countdowns FOR DELETE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE IF NOT EXISTS public.memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL,
  image_url text,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories TO authenticated;
GRANT ALL ON public.memories TO service_role;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view memories" ON public.memories;
DROP POLICY IF EXISTS "Users can create memories" ON public.memories;
DROP POLICY IF EXISTS "Users can delete own memories" ON public.memories;
CREATE POLICY "Authenticated users can view memories" ON public.memories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create memories" ON public.memories FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own memories" ON public.memories FOR DELETE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE IF NOT EXISTS public.taps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.taps TO authenticated;
GRANT ALL ON public.taps TO service_role;
ALTER TABLE public.taps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view taps" ON public.taps;
DROP POLICY IF EXISTS "Users can send taps" ON public.taps;
CREATE POLICY "Authenticated users can view taps" ON public.taps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can send taps" ON public.taps FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.taps; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.daily_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  question_date date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_answers TO authenticated;
GRANT ALL ON public.daily_answers TO service_role;
ALTER TABLE public.daily_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view answers" ON public.daily_answers;
DROP POLICY IF EXISTS "Users can insert own answers" ON public.daily_answers;
CREATE POLICY "Authenticated users can view answers" ON public.daily_answers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert own answers" ON public.daily_answers FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.gallery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  file_url text NOT NULL,
  file_name text,
  file_type text NOT NULL DEFAULT 'image' CHECK (file_type IN ('image','video')),
  is_shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gallery_items TO authenticated;
GRANT ALL ON public.gallery_items TO service_role;
ALTER TABLE public.gallery_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own gallery" ON public.gallery_items;
DROP POLICY IF EXISTS "Users can upload to own gallery" ON public.gallery_items;
DROP POLICY IF EXISTS "Users can delete own gallery items" ON public.gallery_items;
DROP POLICY IF EXISTS "Users can update own gallery items" ON public.gallery_items;
CREATE POLICY "Users can view own gallery" ON public.gallery_items FOR SELECT TO authenticated
  USING (auth.uid() = owner_id OR (is_shared = true AND owner_id = public.get_partner_id(auth.uid())) OR (owner_id IN (SELECT p.user_id FROM public.profiles p WHERE p.gallery_shared = true AND p.user_id = public.get_partner_id(auth.uid()))));
CREATE POLICY "Users can upload to own gallery" ON public.gallery_items FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own gallery items" ON public.gallery_items FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Users can update own gallery items" ON public.gallery_items FOR UPDATE TO authenticated USING (auth.uid() = owner_id);

CREATE TABLE IF NOT EXISTS public.call_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id uuid NOT NULL,
  receiver_id uuid,
  call_type text NOT NULL DEFAULT 'video',
  call_direction text NOT NULL DEFAULT 'outgoing',
  status text NOT NULL DEFAULT 'completed',
  duration_seconds integer DEFAULT 0,
  room_name text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_history TO authenticated;
GRANT ALL ON public.call_history TO service_role;
ALTER TABLE public.call_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own calls" ON public.call_history;
DROP POLICY IF EXISTS "Users can insert own calls" ON public.call_history;
DROP POLICY IF EXISTS "Users can update own calls" ON public.call_history;
DROP POLICY IF EXISTS "Users can delete own calls" ON public.call_history;
CREATE POLICY "Users can view own calls" ON public.call_history FOR SELECT TO authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can insert own calls" ON public.call_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = caller_id);
CREATE POLICY "Users can update own calls" ON public.call_history FOR UPDATE TO authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can delete own calls" ON public.call_history FOR DELETE TO authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.call_history; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.playlist_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  added_by uuid NOT NULL,
  title text NOT NULL,
  artist text NOT NULL DEFAULT '',
  song_url text NOT NULL,
  platform text NOT NULL DEFAULT 'youtube',
  thumbnail_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.playlist_songs TO authenticated;
GRANT ALL ON public.playlist_songs TO service_role;
ALTER TABLE public.playlist_songs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view songs" ON public.playlist_songs;
DROP POLICY IF EXISTS "Users can add songs" ON public.playlist_songs;
DROP POLICY IF EXISTS "Users can delete own songs" ON public.playlist_songs;
CREATE POLICY "Authenticated users can view songs" ON public.playlist_songs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can add songs" ON public.playlist_songs FOR INSERT TO authenticated WITH CHECK (auth.uid() = added_by);
CREATE POLICY "Users can delete own songs" ON public.playlist_songs FOR DELETE TO authenticated USING (auth.uid() = added_by);

CREATE TABLE IF NOT EXISTS public.invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  used_by uuid,
  used_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invite_links TO authenticated;
GRANT ALL ON public.invite_links TO service_role;
ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can create invite links" ON public.invite_links;
DROP POLICY IF EXISTS "Users can accept invite links" ON public.invite_links;
DROP POLICY IF EXISTS "Users can delete own invite links" ON public.invite_links;
DROP POLICY IF EXISTS "Anyone can lookup invite by code" ON public.invite_links;
CREATE POLICY "Users can create invite links" ON public.invite_links FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can accept invite links" ON public.invite_links FOR UPDATE TO authenticated USING (used_by IS NULL AND expires_at > now()) WITH CHECK (auth.uid() = used_by);
CREATE POLICY "Users can delete own invite links" ON public.invite_links FOR DELETE TO authenticated USING (auth.uid() = creator_id);
CREATE POLICY "Anyone can lookup invite by code" ON public.invite_links FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.shayaris (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text,
  content text NOT NULL,
  is_favorite boolean NOT NULL DEFAULT false,
  delete_requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shayaris TO authenticated;
GRANT ALL ON public.shayaris TO service_role;
ALTER TABLE public.shayaris ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View own and partner shayaris" ON public.shayaris;
DROP POLICY IF EXISTS "Insert own shayaris" ON public.shayaris;
DROP POLICY IF EXISTS "Delete own shayaris" ON public.shayaris;
DROP POLICY IF EXISTS "Update own shayaris" ON public.shayaris;
CREATE POLICY "View own and partner shayaris" ON public.shayaris FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Insert own shayaris" ON public.shayaris FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own shayaris" ON public.shayaris FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Update own shayaris" ON public.shayaris FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.shayaris; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.blend_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blend_invites TO authenticated;
GRANT ALL ON public.blend_invites TO service_role;
ALTER TABLE public.blend_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View blend invites" ON public.blend_invites;
DROP POLICY IF EXISTS "Create blend invites" ON public.blend_invites;
DROP POLICY IF EXISTS "Update blend invites" ON public.blend_invites;
DROP POLICY IF EXISTS "Delete blend invites" ON public.blend_invites;
CREATE POLICY "View blend invites" ON public.blend_invites FOR SELECT TO authenticated USING (sender_id = auth.uid() OR sender_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Create blend invites" ON public.blend_invites FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Update blend invites" ON public.blend_invites FOR UPDATE TO authenticated USING (sender_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Delete blend invites" ON public.blend_invites FOR DELETE TO authenticated USING (sender_id = auth.uid() OR sender_id = public.get_partner_id(auth.uid()));
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.blend_invites; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.mood_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  mood text NOT NULL,
  confidence real NOT NULL DEFAULT 0,
  valence real DEFAULT 0,
  arousal real DEFAULT 0.5,
  feedback text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mood_logs TO authenticated;
GRANT ALL ON public.mood_logs TO service_role;
ALTER TABLE public.mood_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View own and partner mood logs" ON public.mood_logs;
DROP POLICY IF EXISTS "Insert own mood logs" ON public.mood_logs;
DROP POLICY IF EXISTS "Delete own mood logs" ON public.mood_logs;
DROP POLICY IF EXISTS "Update own mood logs" ON public.mood_logs;
CREATE POLICY "View own and partner mood logs" ON public.mood_logs FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Insert own mood logs" ON public.mood_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own mood logs" ON public.mood_logs FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Update own mood logs" ON public.mood_logs FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.code_surprises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'Surprise',
  html_content text NOT NULL DEFAULT '',
  css_content text NOT NULL DEFAULT '',
  js_content text NOT NULL DEFAULT '',
  max_views integer NOT NULL DEFAULT 1,
  views_used integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.code_surprises TO authenticated;
GRANT ALL ON public.code_surprises TO service_role;
ALTER TABLE public.code_surprises ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View partner surprises" ON public.code_surprises;
DROP POLICY IF EXISTS "Create own surprises" ON public.code_surprises;
DROP POLICY IF EXISTS "Update own surprises" ON public.code_surprises;
DROP POLICY IF EXISTS "Delete own surprises" ON public.code_surprises;
DROP POLICY IF EXISTS "Partner can increment views" ON public.code_surprises;
CREATE POLICY "View partner surprises" ON public.code_surprises FOR SELECT TO authenticated USING (creator_id = auth.uid() OR creator_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Create own surprises" ON public.code_surprises FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Update own surprises" ON public.code_surprises FOR UPDATE TO authenticated USING (auth.uid() = creator_id OR creator_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Delete own surprises" ON public.code_surprises FOR DELETE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE IF NOT EXISTS public.code_surprise_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surprise_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.code_surprise_events TO authenticated;
GRANT ALL ON public.code_surprise_events TO service_role;
ALTER TABLE public.code_surprise_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View surprise events" ON public.code_surprise_events;
DROP POLICY IF EXISTS "Insert surprise events" ON public.code_surprise_events;
CREATE POLICY "View surprise events" ON public.code_surprise_events FOR SELECT TO authenticated USING (user_id = auth.uid() OR surprise_id IN (SELECT id FROM public.code_surprises WHERE creator_id = auth.uid()));
CREATE POLICY "Insert surprise events" ON public.code_surprise_events FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.menstrual_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  cycle_start_date date NOT NULL,
  cycle_length integer NOT NULL DEFAULT 28,
  period_length integer NOT NULL DEFAULT 5,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menstrual_cycles TO authenticated;
GRANT ALL ON public.menstrual_cycles TO service_role;
ALTER TABLE public.menstrual_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own cycles" ON public.menstrual_cycles;
DROP POLICY IF EXISTS "Users can insert own cycles" ON public.menstrual_cycles;
DROP POLICY IF EXISTS "Users can update own cycles" ON public.menstrual_cycles;
DROP POLICY IF EXISTS "Users can delete own cycles" ON public.menstrual_cycles;
CREATE POLICY "Users can view own cycles" ON public.menstrual_cycles FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Users can insert own cycles" ON public.menstrual_cycles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own cycles" ON public.menstrual_cycles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own cycles" ON public.menstrual_cycles FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_menstrual_cycles_user ON public.menstrual_cycles(user_id);

CREATE TABLE IF NOT EXISTS public.partner_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id, receiver_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_requests TO authenticated;
GRANT ALL ON public.partner_requests TO service_role;
ALTER TABLE public.partner_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View own requests" ON public.partner_requests;
DROP POLICY IF EXISTS "Send requests" ON public.partner_requests;
DROP POLICY IF EXISTS "Update received requests" ON public.partner_requests;
DROP POLICY IF EXISTS "Delete own requests" ON public.partner_requests;
CREATE POLICY "View own requests" ON public.partner_requests FOR SELECT TO authenticated USING (sender_id = auth.uid() OR receiver_id = auth.uid());
CREATE POLICY "Send requests" ON public.partner_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Update received requests" ON public.partner_requests FOR UPDATE TO authenticated USING (receiver_id = auth.uid());
CREATE POLICY "Delete own requests" ON public.partner_requests FOR DELETE TO authenticated USING (sender_id = auth.uid() OR receiver_id = auth.uid());
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.partner_requests; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.imported_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  sender_name text NOT NULL,
  content text,
  file_url text,
  file_type text DEFAULT 'text',
  original_timestamp timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.imported_chats TO authenticated;
GRANT ALL ON public.imported_chats TO service_role;
ALTER TABLE public.imported_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View own imported chats" ON public.imported_chats;
DROP POLICY IF EXISTS "Insert own imported chats" ON public.imported_chats;
DROP POLICY IF EXISTS "Delete own imported chats" ON public.imported_chats;
CREATE POLICY "View own imported chats" ON public.imported_chats FOR SELECT TO authenticated USING (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Insert own imported chats" ON public.imported_chats FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Delete own imported chats" ON public.imported_chats FOR DELETE TO authenticated USING (auth.uid() = owner_id);

CREATE TABLE IF NOT EXISTS public.message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_reactions TO authenticated;
GRANT ALL ON public.message_reactions TO service_role;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View reactions on visible messages" ON public.message_reactions;
DROP POLICY IF EXISTS "Add own reactions" ON public.message_reactions;
DROP POLICY IF EXISTS "Delete own reactions" ON public.message_reactions;
CREATE POLICY "View reactions on visible messages" ON public.message_reactions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_id AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid())));
CREATE POLICY "Add own reactions" ON public.message_reactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own reactions" ON public.message_reactions FOR DELETE TO authenticated USING (auth.uid() = user_id);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  content text,
  message_type text NOT NULL DEFAULT 'text',
  send_at timestamptz NOT NULL,
  disappear_at text,
  sent boolean NOT NULL DEFAULT false,
  is_processing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_messages TO authenticated;
GRANT ALL ON public.scheduled_messages TO service_role;
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage their own scheduled messages" ON public.scheduled_messages;
CREATE POLICY "Users manage their own scheduled messages" ON public.scheduled_messages FOR ALL TO authenticated USING (sender_id = auth.uid()) WITH CHECK (sender_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.pending_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bucket text NOT NULL,
  object_path text NOT NULL,
  total_chunks integer NOT NULL,
  uploaded_chunks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, bucket, object_path)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_uploads TO authenticated;
GRANT ALL ON public.pending_uploads TO service_role;
ALTER TABLE public.pending_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own pending uploads" ON public.pending_uploads;
CREATE POLICY "Users manage own pending uploads" ON public.pending_uploads FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bucket text NOT NULL,
  hit_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.rate_limits TO service_role;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rate_limits deny anon" ON public.rate_limits;
DROP POLICY IF EXISTS "rate_limits deny authenticated" ON public.rate_limits;
CREATE POLICY "rate_limits deny anon" ON public.rate_limits FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "rate_limits deny authenticated" ON public.rate_limits FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON public.rate_limits (user_id, bucket, hit_at DESC);

CREATE OR REPLACE FUNCTION public.consume_rate_limit(_user_id uuid, _bucket text, _max int, _window_seconds int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM public.rate_limits WHERE hit_at < now() - make_interval(secs => _window_seconds * 4);
  SELECT count(*) INTO v_count FROM public.rate_limits WHERE user_id = _user_id AND bucket = _bucket AND hit_at > now() - make_interval(secs => _window_seconds);
  IF v_count >= _max THEN RETURN false; END IF;
  INSERT INTO public.rate_limits (user_id, bucket) VALUES (_user_id, _bucket);
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, int, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, int, int) TO service_role;

CREATE TABLE IF NOT EXISTS public.qr_pairing_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_type text NOT NULL DEFAULT 'device_pairing' CHECK (token_type IN ('device_pairing','signup_invite')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_ip text,
  redeemed_ua text,
  issuer_ip text,
  issuer_ua text
);
GRANT ALL ON public.qr_pairing_tokens TO service_role;
ALTER TABLE public.qr_pairing_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qr_pairing_tokens deny anon" ON public.qr_pairing_tokens;
DROP POLICY IF EXISTS "qr_pairing_tokens deny authenticated" ON public.qr_pairing_tokens;
CREATE POLICY "qr_pairing_tokens deny anon" ON public.qr_pairing_tokens FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "qr_pairing_tokens deny authenticated" ON public.qr_pairing_tokens FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE INDEX IF NOT EXISTS qr_pairing_tokens_user_idx ON public.qr_pairing_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qr_pairing_tokens_expiry_idx ON public.qr_pairing_tokens (expires_at);

CREATE OR REPLACE FUNCTION public.qr_pairing_tokens_gc()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.qr_pairing_tokens WHERE expires_at < now() - interval '1 hour' OR (redeemed_at IS NOT NULL AND redeemed_at < now() - interval '1 hour');
$$;
REVOKE ALL ON FUNCTION public.qr_pairing_tokens_gc() FROM public;
GRANT EXECUTE ON FUNCTION public.qr_pairing_tokens_gc() TO service_role;

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_name text,
  aaguid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
GRANT SELECT, DELETE ON public.webauthn_credentials TO authenticated;
GRANT ALL ON public.webauthn_credentials TO service_role;
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webauthn own read" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "webauthn own delete" ON public.webauthn_credentials;
CREATE POLICY "webauthn own read" ON public.webauthn_credentials FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "webauthn own delete" ON public.webauthn_credentials FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON public.webauthn_credentials (user_id);

CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  challenge text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registration','authentication')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
GRANT ALL ON public.webauthn_challenges TO service_role;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webauthn_challenges deny anon" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "webauthn_challenges deny authenticated" ON public.webauthn_challenges;
CREATE POLICY "webauthn_challenges deny anon" ON public.webauthn_challenges FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "webauthn_challenges deny authenticated" ON public.webauthn_challenges FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx ON public.webauthn_challenges (expires_at);
CREATE INDEX IF NOT EXISTS webauthn_challenges_user_idx ON public.webauthn_challenges (user_id, kind, created_at DESC);

CREATE OR REPLACE FUNCTION public.webauthn_challenges_gc()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.webauthn_challenges WHERE expires_at < now() - interval '1 hour' OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 hour');
$$;
REVOKE ALL ON FUNCTION public.webauthn_challenges_gc() FROM public;
GRANT EXECUTE ON FUNCTION public.webauthn_challenges_gc() TO service_role;

CREATE TABLE IF NOT EXISTS public.email_change_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text NOT NULL,
  otp_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
GRANT ALL ON public.email_change_otps TO service_role;
ALTER TABLE public.email_change_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_change_otps deny anon" ON public.email_change_otps;
DROP POLICY IF EXISTS "email_change_otps deny authenticated" ON public.email_change_otps;
CREATE POLICY "email_change_otps deny anon" ON public.email_change_otps FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "email_change_otps deny authenticated" ON public.email_change_otps FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE INDEX IF NOT EXISTS email_change_otps_user_idx ON public.email_change_otps (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_change_otps_expiry_idx ON public.email_change_otps (expires_at);

CREATE OR REPLACE FUNCTION public.email_change_otps_gc()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.email_change_otps WHERE expires_at < now() - interval '1 hour' OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 hour');
$$;
REVOKE ALL ON FUNCTION public.email_change_otps_gc() FROM public;
GRANT EXECUTE ON FUNCTION public.email_change_otps_gc() TO service_role;

CREATE OR REPLACE FUNCTION public.search_users(search_term text)
RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id, p.display_name, p.username, p.avatar_url
  FROM public.profiles p
  WHERE (p.username ILIKE '%' || search_term || '%' OR p.phone_number = search_term)
    AND p.user_id != auth.uid()
  LIMIT 20;
$$;
REVOKE EXECUTE ON FUNCTION public.search_users(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.unlink_partner(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_partner_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT partner_id INTO v_partner_id FROM public.profiles WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = p_user_id;
  IF v_partner_id IS NOT NULL THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_partner_id;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.unlink_partner(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.unlink_partner(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_invite(p_code text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_invite record; v_creator_display_name text; v_existing_partner uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('error','Not allowed');
  END IF;
  SELECT partner_id INTO v_existing_partner FROM public.profiles WHERE user_id = p_user_id;
  IF v_existing_partner IS NOT NULL THEN
    RETURN jsonb_build_object('error','You already have a linked partner. Unlink first to accept a new invite.');
  END IF;
  SELECT * INTO v_invite FROM public.invite_links WHERE code = p_code AND used_by IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Invite not found or already used'); END IF;
  IF v_invite.creator_id = p_user_id THEN RETURN jsonb_build_object('error','Cannot use your own invite'); END IF;
  SELECT partner_id INTO v_existing_partner FROM public.profiles WHERE user_id = v_invite.creator_id;
  IF v_existing_partner IS NOT NULL THEN RETURN jsonb_build_object('error','Invite creator already has a linked partner.'); END IF;
  UPDATE public.profiles SET partner_id = v_invite.creator_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_invite.creator_id;
  DELETE FROM public.invite_links WHERE id = v_invite.id;
  SELECT display_name INTO v_creator_display_name FROM public.profiles WHERE user_id = v_invite.creator_id;
  RETURN jsonb_build_object('success', true, 'creator_id', v_invite.creator_id, 'creator_name', COALESCE(v_creator_display_name,'Partner'));
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_invite(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_invite(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_partner_request(p_request_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_sender_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT sender_id INTO v_sender_id FROM public.partner_requests WHERE id = p_request_id AND receiver_id = p_user_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already processed'; END IF;
  UPDATE public.partner_requests SET status = 'accepted' WHERE id = p_request_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id IN (p_user_id, v_sender_id);
  UPDATE public.profiles SET partner_id = v_sender_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_sender_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_partner_request_v2(request_id uuid, accepting_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.accept_partner_request(request_id, accepting_user_id);
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_partner_request_v2(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_partner_request_v2(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_accepted_requests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_id IS NOT NULL AND (OLD.partner_id IS NULL OR OLD.partner_id IS DISTINCT FROM NEW.partner_id) THEN
    UPDATE public.partner_requests SET status = 'accepted'
      WHERE status = 'pending' AND ((sender_id = NEW.user_id AND receiver_id = NEW.partner_id) OR (sender_id = NEW.partner_id AND receiver_id = NEW.user_id));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_partner_linked ON public.profiles;
CREATE TRIGGER on_partner_linked AFTER UPDATE OF partner_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.cleanup_accepted_requests();

CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages WHERE disappear_at IS NOT NULL AND disappear_at <= now();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_expired_messages() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_expired_messages() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cleanup_disappeared_messages()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.messages WHERE disappear_at IS NOT NULL AND disappear_at < now();
$$;
REVOKE EXECUTE ON FUNCTION public.cleanup_disappeared_messages() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_disappeared_messages() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_pending_scheduled_messages()
RETURNS SETOF public.scheduled_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.scheduled_messages
     SET is_processing = true
   WHERE id IN (
     SELECT id FROM public.scheduled_messages
      WHERE sent = false AND is_processing = false AND send_at <= now()
      ORDER BY send_at ASC
      LIMIT 25
   )
  RETURNING *;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() TO service_role;

-- Storage policies for all app buckets. Buckets are created via the storage API/tool; policies are idempotent here.
DROP POLICY IF EXISTS "Authenticated users upload to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users read own or partner files" ON storage.objects;
DROP POLICY IF EXISTS "Users update own files" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own files" ON storage.objects;
DROP POLICY IF EXISTS "avatars public read" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner write" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner update" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner delete" ON storage.objects;
DROP POLICY IF EXISTS "attachments owner all" ON storage.objects;
DROP POLICY IF EXISTS "backups owner all" ON storage.objects;
DROP POLICY IF EXISTS "Auth users can upload surprise assets" ON storage.objects;
DROP POLICY IF EXISTS "Public read surprise assets" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own surprise assets" ON storage.objects;

CREATE POLICY "Authenticated users upload to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Authenticated users read own or partner files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND ((storage.foldername(name))[1] = auth.uid()::text OR (storage.foldername(name))[1] = (SELECT partner_id::text FROM public.profiles WHERE user_id = auth.uid())));
CREATE POLICY "Users update own files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete own files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars public read" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');
CREATE POLICY "avatars owner write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars owner update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars owner delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "attachments owner all" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "backups owner all" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Auth users can upload surprise assets" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'surprise-assets');
CREATE POLICY "Public read surprise assets" ON storage.objects FOR SELECT TO public USING (bucket_id = 'surprise-assets');
CREATE POLICY "Users can delete own surprise assets" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'surprise-assets');