-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  mood_emoji TEXT DEFAULT '😊',
  mood_text TEXT DEFAULT 'Feeling good',
  mood_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  partner_id UUID,
  gallery_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','file','voice')),
  file_url TEXT, file_name TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  disappear_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can send messages" ON public.messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Users can delete own messages" ON public.messages FOR DELETE TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
-- NOTE: tightened in a follow-up migration so receivers can only flip is_read, not edit content.
CREATE POLICY "Users can update own messages" ON public.messages FOR UPDATE TO authenticated USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
CREATE INDEX idx_messages_sender ON public.messages(sender_id);
CREATE INDEX idx_messages_receiver ON public.messages(receiver_id);
CREATE INDEX idx_messages_created ON public.messages(created_at DESC);

CREATE TABLE public.locations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can upsert own location" ON public.locations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own location" ON public.locations FOR UPDATE TO authenticated USING (auth.uid() = user_id);
ALTER PUBLICATION supabase_realtime ADD TABLE public.locations;

CREATE TABLE public.countdowns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, target_date TIMESTAMP WITH TIME ZONE NOT NULL,
  emoji TEXT DEFAULT '🎉', created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.countdowns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view countdowns" ON public.countdowns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create countdowns" ON public.countdowns FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own countdowns" ON public.countdowns FOR DELETE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE public.memories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  image_url TEXT, caption TEXT, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view memories" ON public.memories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create memories" ON public.memories FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own memories" ON public.memories FOR DELETE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE public.taps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.taps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view taps" ON public.taps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can send taps" ON public.taps FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
ALTER PUBLICATION supabase_realtime ADD TABLE public.taps;

CREATE TABLE public.daily_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question TEXT NOT NULL, answer TEXT NOT NULL,
  question_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_date)
);
ALTER TABLE public.daily_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view answers" ON public.daily_answers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert own answers" ON public.daily_answers FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.gallery_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'image' CHECK (file_type IN ('image','video')),
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.gallery_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can upload to own gallery" ON public.gallery_items FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own gallery items" ON public.gallery_items FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Users can update own gallery items" ON public.gallery_items FOR UPDATE TO authenticated USING (auth.uid() = owner_id);

-- Storage buckets: PRIVATE (was public — Phase 2 fix)
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-files','chat-files',false);
INSERT INTO storage.buckets (id, name, public) VALUES ('gallery','gallery',false);
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars','avatars',false);
INSERT INTO storage.buckets (id, name, public) VALUES ('memories','memories',false);

CREATE POLICY "Authenticated users upload to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('chat-files','gallery','avatars','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete own files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','avatars','memories') AND (storage.foldername(name))[1] = auth.uid()::text);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS public_key text;

CREATE TABLE public.call_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id uuid NOT NULL, receiver_id uuid,
  call_type text NOT NULL DEFAULT 'video',
  call_direction text NOT NULL DEFAULT 'outgoing',
  status text NOT NULL DEFAULT 'completed',
  duration_seconds integer DEFAULT 0,
  room_name text,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.call_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own calls" ON public.call_history FOR SELECT TO authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can insert own calls" ON public.call_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = caller_id);
CREATE POLICY "Users can update own calls" ON public.call_history FOR UPDATE TO authenticated USING (auth.uid() = caller_id);
CREATE POLICY "Users can delete own calls" ON public.call_history FOR DELETE TO authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id);

CREATE OR REPLACE FUNCTION public.get_partner_id(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT partner_id FROM public.profiles WHERE user_id = _user_id LIMIT 1
$$;

CREATE POLICY "Users can view partner profiles" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Users can view partner location" ON public.locations FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Users can view own gallery" ON public.gallery_items FOR SELECT TO authenticated
  USING (auth.uid() = owner_id
    OR (is_shared = true AND owner_id = public.get_partner_id(auth.uid()))
    OR (owner_id IN (SELECT p.user_id FROM public.profiles p WHERE p.gallery_shared = true AND p.user_id = public.get_partner_id(auth.uid()))));

-- Phase 2 partner-aware storage read policy
CREATE POLICY "Authenticated users read own or partner files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('chat-files','gallery','avatars','memories') AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (storage.foldername(name))[1] = (SELECT partner_id::text FROM public.profiles WHERE user_id = auth.uid())
  ));
CREATE POLICY "Users update own files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','avatars','memories') AND (storage.foldername(name))[1] = auth.uid()::text);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gender text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS phone_number text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pet_name text DEFAULT NULL;

CREATE TABLE public.playlist_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  added_by uuid NOT NULL, title text NOT NULL,
  artist text NOT NULL DEFAULT '', song_url text NOT NULL,
  platform text NOT NULL DEFAULT 'youtube',
  thumbnail_url text DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.playlist_songs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view songs" ON public.playlist_songs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can add songs" ON public.playlist_songs FOR INSERT TO authenticated WITH CHECK (auth.uid() = added_by);
CREATE POLICY "Users can delete own songs" ON public.playlist_songs FOR DELETE TO authenticated USING (auth.uid() = added_by);

ALTER TABLE public.messages ADD COLUMN reply_to_id uuid REFERENCES public.messages(id) ON DELETE SET NULL DEFAULT NULL;

CREATE TABLE public.invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  used_by uuid, used_at timestamptz
);
ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can create invite links" ON public.invite_links FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can accept invite links" ON public.invite_links FOR UPDATE TO authenticated
  USING (used_by IS NULL AND expires_at > now()) WITH CHECK (auth.uid() = used_by);
CREATE POLICY "Users can delete own invite links" ON public.invite_links FOR DELETE TO authenticated USING (auth.uid() = creator_id);
CREATE POLICY "Anyone can lookup invite by code" ON public.invite_links FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.cleanup_disappeared_messages()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.messages WHERE disappear_at IS NOT NULL AND disappear_at < now();
$$;

CREATE TABLE public.shayaris (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, title text, content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.shayaris ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View own and partner shayaris" ON public.shayaris FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id = get_partner_id(auth.uid()));
CREATE POLICY "Insert own shayaris" ON public.shayaris FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own shayaris" ON public.shayaris FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Update own shayaris" ON public.shayaris FOR UPDATE TO authenticated USING (auth.uid() = user_id);
ALTER PUBLICATION supabase_realtime ADD TABLE public.shayaris;
ALTER TABLE public.shayaris ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
ALTER TABLE public.shayaris ADD COLUMN IF NOT EXISTS delete_requested_by uuid;

CREATE TABLE public.blend_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.blend_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View blend invites" ON public.blend_invites FOR SELECT TO authenticated USING (sender_id = auth.uid() OR sender_id = get_partner_id(auth.uid()));
CREATE POLICY "Create blend invites" ON public.blend_invites FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Update blend invites" ON public.blend_invites FOR UPDATE TO authenticated USING (sender_id = get_partner_id(auth.uid()));
CREATE POLICY "Delete blend invites" ON public.blend_invites FOR DELETE TO authenticated USING (sender_id = auth.uid() OR sender_id = get_partner_id(auth.uid()));
ALTER PUBLICATION supabase_realtime ADD TABLE public.blend_invites;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS deleted_by_sender boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_by_receiver boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS location_mode text NOT NULL DEFAULT 'on_open';

CREATE TABLE public.mood_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL, mood text NOT NULL,
  confidence real NOT NULL DEFAULT 0,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.mood_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View own and partner mood logs" ON public.mood_logs FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id = get_partner_id(auth.uid()));
CREATE POLICY "Insert own mood logs" ON public.mood_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own mood logs" ON public.mood_logs FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Update own mood logs" ON public.mood_logs FOR UPDATE TO authenticated USING (auth.uid() = user_id);
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS valence real DEFAULT 0;
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS arousal real DEFAULT 0.5;
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS feedback text;

CREATE TABLE public.code_surprises (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'Surprise',
  html_content text NOT NULL DEFAULT '',
  css_content text NOT NULL DEFAULT '',
  js_content text NOT NULL DEFAULT '',
  max_views integer NOT NULL DEFAULT 1,
  views_used integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.code_surprises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View partner surprises" ON public.code_surprises FOR SELECT TO authenticated USING (creator_id = auth.uid() OR creator_id = get_partner_id(auth.uid()));
CREATE POLICY "Create own surprises" ON public.code_surprises FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Update own surprises" ON public.code_surprises FOR UPDATE TO authenticated USING (auth.uid() = creator_id);
CREATE POLICY "Delete own surprises" ON public.code_surprises FOR DELETE TO authenticated USING (auth.uid() = creator_id);
CREATE POLICY "Partner can increment views" ON public.code_surprises FOR UPDATE TO authenticated USING (creator_id = get_partner_id(auth.uid()));

CREATE TABLE public.menstrual_cycles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  cycle_start_date DATE NOT NULL,
  cycle_length INTEGER NOT NULL DEFAULT 28,
  period_length INTEGER NOT NULL DEFAULT 5,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.menstrual_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own cycles" ON public.menstrual_cycles FOR SELECT USING (user_id = auth.uid() OR user_id = public.get_partner_id(auth.uid()));
CREATE POLICY "Users can insert own cycles" ON public.menstrual_cycles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own cycles" ON public.menstrual_cycles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own cycles" ON public.menstrual_cycles FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_menstrual_cycles_user ON public.menstrual_cycles(user_id);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text UNIQUE;

CREATE TABLE IF NOT EXISTS public.partner_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL, receiver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id, receiver_id)
);
ALTER TABLE public.partner_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View own requests" ON public.partner_requests FOR SELECT TO authenticated USING (sender_id = auth.uid() OR receiver_id = auth.uid());
CREATE POLICY "Send requests" ON public.partner_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Update received requests" ON public.partner_requests FOR UPDATE TO authenticated USING (receiver_id = auth.uid());
CREATE POLICY "Delete own requests" ON public.partner_requests FOR DELETE TO authenticated USING (sender_id = auth.uid() OR receiver_id = auth.uid());
ALTER PUBLICATION supabase_realtime ADD TABLE public.partner_requests;

CREATE OR REPLACE FUNCTION public.search_users(search_term text)
RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.user_id, p.display_name, p.username, p.avatar_url FROM public.profiles p
  WHERE (p.username ILIKE '%' || search_term || '%' OR p.phone_number = search_term)
    AND p.user_id != auth.uid() LIMIT 20;
$$;

CREATE TABLE IF NOT EXISTS public.code_surprise_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surprise_id uuid NOT NULL, user_id uuid NOT NULL,
  event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.code_surprise_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View surprise events" ON public.code_surprise_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR surprise_id IN (SELECT id FROM public.code_surprises WHERE creator_id = auth.uid()));
CREATE POLICY "Insert surprise events" ON public.code_surprise_events FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.imported_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL, sender_name text NOT NULL,
  content text, file_url text, file_type text DEFAULT 'text',
  original_timestamp timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.imported_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View own imported chats" ON public.imported_chats FOR SELECT TO authenticated USING (owner_id = auth.uid() OR owner_id = get_partner_id(auth.uid()));
CREATE POLICY "Insert own imported chats" ON public.imported_chats FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Delete own imported chats" ON public.imported_chats FOR DELETE TO authenticated USING (auth.uid() = owner_id);

-- surprise-assets: app-distributed surprise content (still public for sharing)
INSERT INTO storage.buckets (id, name, public) VALUES ('surprise-assets','surprise-assets',true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Auth users can upload surprise assets" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'surprise-assets');
CREATE POLICY "Public read surprise assets" ON storage.objects FOR SELECT TO public USING (bucket_id = 'surprise-assets');
CREATE POLICY "Users can delete own surprise assets" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'surprise-assets');

-- message_reactions (referenced by later indexes / app code but never defined in original migrations)
CREATE TABLE public.message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View reactions on visible messages" ON public.message_reactions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_id AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid())));
CREATE POLICY "Add own reactions" ON public.message_reactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own reactions" ON public.message_reactions FOR DELETE TO authenticated USING (auth.uid() = user_id);
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_token TEXT,
  ADD COLUMN IF NOT EXISTS push_platform TEXT,
  ADD COLUMN IF NOT EXISTS couple_theme TEXT;
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.taps ADD COLUMN IF NOT EXISTS receiver_id UUID;

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL, receiver_id UUID NOT NULL,
  content TEXT, message_type TEXT NOT NULL DEFAULT 'text',
  send_at TIMESTAMPTZ NOT NULL, disappear_at TEXT,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  is_processing BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own scheduled messages" ON public.scheduled_messages FOR ALL TO authenticated
  USING (sender_id = auth.uid()) WITH CHECK (sender_id = auth.uid());

CREATE OR REPLACE FUNCTION public.unlink_partner(p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_partner_id UUID;
BEGIN
  SELECT partner_id INTO v_partner_id FROM public.profiles WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = p_user_id;
  IF v_partner_id IS NOT NULL THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_partner_id;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION public.unlink_partner(UUID) TO authenticated;

-- Phase 4.5 — accept_invite refuses to overwrite an existing partner
CREATE OR REPLACE FUNCTION public.accept_invite(p_code TEXT, p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_invite RECORD; v_creator_display_name TEXT; v_existing_partner UUID;
BEGIN
  -- integrity: caller must not already have a partner
  SELECT partner_id INTO v_existing_partner FROM public.profiles WHERE user_id = p_user_id;
  IF v_existing_partner IS NOT NULL THEN
    RETURN jsonb_build_object('error','You already have a linked partner. Unlink first to accept a new invite.');
  END IF;

  SELECT * INTO v_invite FROM public.invite_links
    WHERE code = p_code AND used_by IS NULL AND (expires_at IS NULL OR expires_at > now())
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Invite not found or already used'); END IF;
  IF v_invite.creator_id = p_user_id THEN RETURN jsonb_build_object('error','Cannot use your own invite'); END IF;

  -- integrity: creator must not already have a partner
  SELECT partner_id INTO v_existing_partner FROM public.profiles WHERE user_id = v_invite.creator_id;
  IF v_existing_partner IS NOT NULL THEN
    RETURN jsonb_build_object('error','Invite creator already has a linked partner.');
  END IF;

  UPDATE public.profiles SET partner_id = v_invite.creator_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_invite.creator_id;
  DELETE FROM public.invite_links WHERE id = v_invite.id;
  SELECT display_name INTO v_creator_display_name FROM public.profiles WHERE user_id = v_invite.creator_id;
  RETURN jsonb_build_object('success', true, 'creator_id', v_invite.creator_id, 'creator_name', COALESCE(v_creator_display_name,'Partner'));
END; $$;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_partner_request(p_request_id UUID, p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sender_id UUID;
BEGIN
  SELECT sender_id INTO v_sender_id FROM public.partner_requests
    WHERE id = p_request_id AND receiver_id = p_user_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already processed'; END IF;
  UPDATE public.partner_requests SET status = 'accepted' WHERE id = p_request_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id IN (p_user_id, v_sender_id);
  UPDATE public.profiles SET partner_id = v_sender_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_sender_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_accepted_requests()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.partner_id IS NOT NULL AND (OLD.partner_id IS NULL OR OLD.partner_id IS DISTINCT FROM NEW.partner_id) THEN
    UPDATE public.partner_requests SET status = 'accepted'
      WHERE status = 'pending' AND ((sender_id = NEW.user_id AND receiver_id = NEW.partner_id) OR (sender_id = NEW.partner_id AND receiver_id = NEW.user_id));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_partner_linked AFTER UPDATE OF partner_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.cleanup_accepted_requests();

CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.messages WHERE disappear_at IS NOT NULL AND disappear_at <= now();
END; $$;

CREATE OR REPLACE FUNCTION public.claim_pending_scheduled_messages()
RETURNS SETOF public.scheduled_messages LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.scheduled_messages SET is_processing = true
  WHERE sent = false AND is_processing = false AND send_at <= now() RETURNING *;
$$;
GRANT EXECUTE ON FUNCTION public.claim_pending_scheduled_messages() TO service_role;

-- Profiles SELECT: allow lookups across users for search/requests
DROP POLICY IF EXISTS "Users can view partner profiles" ON public.profiles;
CREATE POLICY "Authenticated users can view profiles" ON public.profiles FOR SELECT TO authenticated USING (true);

-- Phase 4.2 — TIGHTEN messages UPDATE: only sender can edit content; receiver can ONLY flip is_read
DROP POLICY IF EXISTS "Users can update own messages" ON public.messages;
CREATE POLICY "Sender can update own messages" ON public.messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id) WITH CHECK (auth.uid() = sender_id);

CREATE OR REPLACE FUNCTION public.guard_message_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- If the updater is NOT the sender, only is_read / deleted_by_receiver may change.
  IF auth.uid() IS DISTINCT FROM OLD.sender_id THEN
    IF NEW.content       IS DISTINCT FROM OLD.content       THEN RAISE EXCEPTION 'Only sender can edit content'; END IF;
    IF NEW.message_type  IS DISTINCT FROM OLD.message_type  THEN RAISE EXCEPTION 'Only sender can edit message_type'; END IF;
    IF NEW.file_url      IS DISTINCT FROM OLD.file_url      THEN RAISE EXCEPTION 'Only sender can edit file_url'; END IF;
    IF NEW.file_name     IS DISTINCT FROM OLD.file_name     THEN RAISE EXCEPTION 'Only sender can edit file_name'; END IF;
    IF NEW.disappear_at  IS DISTINCT FROM OLD.disappear_at  THEN RAISE EXCEPTION 'Only sender can edit disappear_at'; END IF;
    IF NEW.is_pinned     IS DISTINCT FROM OLD.is_pinned     THEN RAISE EXCEPTION 'Only sender can pin'; END IF;
    IF NEW.edited_at     IS DISTINCT FROM OLD.edited_at     THEN RAISE EXCEPTION 'Only sender can edit edited_at'; END IF;
    IF NEW.reply_to_id   IS DISTINCT FROM OLD.reply_to_id   THEN RAISE EXCEPTION 'Only sender can edit reply_to_id'; END IF;
    IF NEW.deleted_by_sender IS DISTINCT FROM OLD.deleted_by_sender THEN RAISE EXCEPTION 'Only sender can soft-delete on sender side'; END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE POLICY "Receiver can mark messages read" ON public.messages FOR UPDATE TO authenticated
  USING (auth.uid() = receiver_id) WITH CHECK (auth.uid() = receiver_id);

CREATE TRIGGER trg_guard_message_update BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_update();

-- indexes
CREATE INDEX IF NOT EXISTS idx_messages_pair_created ON public.messages (LEAST(sender_id,receiver_id), GREATEST(sender_id,receiver_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_created ON public.messages (receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON public.messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_not_deleted ON public.messages (sender_id, receiver_id, created_at DESC) WHERE deleted_by_sender IS NOT TRUE AND deleted_by_receiver IS NOT TRUE;
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON public.messages (sender_id, receiver_id) WHERE is_pinned = TRUE;
CREATE INDEX IF NOT EXISTS idx_messages_disappear_at ON public.messages (disappear_at) WHERE disappear_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_partner_id ON public.profiles (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_history_receiver_status ON public.call_history (receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_call_history_pair_created ON public.call_history (LEAST(caller_id,receiver_id), GREATEST(caller_id,receiver_id), created_at ASC);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON public.message_reactions (message_id, user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_claimable ON public.scheduled_messages (send_at ASC) WHERE sent = FALSE AND is_processing = FALSE;
CREATE INDEX IF NOT EXISTS idx_locations_user_updated ON public.locations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_chats_owner_ts ON public.imported_chats (owner_id, original_timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_taps_receiver_created ON public.taps (receiver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pending_uploads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL, bucket TEXT NOT NULL, object_path TEXT NOT NULL,
  total_chunks INTEGER NOT NULL, total_bytes BIGINT NOT NULL,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bucket, object_path)
);
CREATE INDEX IF NOT EXISTS idx_pending_uploads_created_at ON public.pending_uploads (created_at);
CREATE INDEX IF NOT EXISTS idx_pending_uploads_user ON public.pending_uploads (user_id);
ALTER TABLE public.pending_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own pending uploads" ON public.pending_uploads FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own pending uploads" ON public.pending_uploads FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own pending uploads" ON public.pending_uploads FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users delete own pending uploads" ON public.pending_uploads FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER update_pending_uploads_updated_at BEFORE UPDATE ON public.pending_uploads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- private backups bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('backups','backups',false) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Users read own backups" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users insert own backups" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete own backups" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users update own backups" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);