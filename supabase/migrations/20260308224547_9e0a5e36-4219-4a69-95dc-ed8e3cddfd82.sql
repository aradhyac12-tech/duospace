
-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Profiles table
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

CREATE POLICY "Users can view partner profiles" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = (SELECT partner_id FROM public.profiles WHERE user_id = auth.uid()));
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Messages table
CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file', 'voice')),
  file_url TEXT,
  file_name TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  disappear_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Users can delete own messages" ON public.messages FOR DELETE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can update own messages" ON public.messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

CREATE INDEX idx_messages_sender ON public.messages(sender_id);
CREATE INDEX idx_messages_receiver ON public.messages(receiver_id);
CREATE INDEX idx_messages_created ON public.messages(created_at DESC);

-- Locations table
CREATE TABLE public.locations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view partner location" ON public.locations FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = (SELECT partner_id FROM public.profiles WHERE user_id = auth.uid()));
CREATE POLICY "Users can upsert own location" ON public.locations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own location" ON public.locations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.locations;

-- Couple features: Countdowns
CREATE TABLE public.countdowns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_date TIMESTAMP WITH TIME ZONE NOT NULL,
  emoji TEXT DEFAULT '🎉',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.countdowns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view countdowns" ON public.countdowns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create countdowns" ON public.countdowns FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own countdowns" ON public.countdowns FOR DELETE TO authenticated USING (auth.uid() = creator_id);

-- Memory wall
CREATE TABLE public.memories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  image_url TEXT,
  caption TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view memories" ON public.memories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create memories" ON public.memories FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Users can delete own memories" ON public.memories FOR DELETE TO authenticated USING (auth.uid() = creator_id);

-- Thinking of you taps
CREATE TABLE public.taps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.taps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view taps" ON public.taps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can send taps" ON public.taps FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.taps;

-- Daily questions
CREATE TABLE public.daily_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  question_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_date)
);

ALTER TABLE public.daily_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view answers" ON public.daily_answers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert own answers" ON public.daily_answers FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Gallery items
CREATE TABLE public.gallery_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'image' CHECK (file_type IN ('image', 'video')),
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.gallery_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own gallery" ON public.gallery_items FOR SELECT TO authenticated
  USING (
    auth.uid() = owner_id
    OR (is_shared = true AND owner_id = (SELECT partner_id FROM public.profiles WHERE user_id = auth.uid()))
    OR (owner_id IN (SELECT user_id FROM public.profiles WHERE gallery_shared = true AND user_id = (SELECT partner_id FROM public.profiles WHERE user_id = auth.uid())))
  );
CREATE POLICY "Users can upload to own gallery" ON public.gallery_items FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own gallery items" ON public.gallery_items FOR DELETE TO authenticated
  USING (auth.uid() = owner_id);
CREATE POLICY "Users can update own gallery items" ON public.gallery_items FOR UPDATE TO authenticated
  USING (auth.uid() = owner_id);

-- Storage buckets (private — access controlled via RLS + signed URLs)
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-files', 'chat-files', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('gallery', 'gallery', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('memories', 'memories', false);

-- Storage policies: authenticated-only access for owner + partner.
-- File naming convention assumed: <user_id>/... (first path segment = owner uid)
-- For partner access we look up partner_id on profiles.

-- INSERT: authenticated users can only upload to their own folder
CREATE POLICY "Authenticated users upload to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('chat-files', 'gallery', 'avatars', 'memories')
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- SELECT: authenticated users can read their own files OR their partner's files
CREATE POLICY "Authenticated users read own or partner files" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id IN ('chat-files', 'gallery', 'avatars', 'memories')
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR (storage.foldername(name))[1] = (
        SELECT partner_id::text FROM public.profiles WHERE user_id = auth.uid()
      )
    )
  );

-- UPDATE: only owner can update their own files
CREATE POLICY "Users update own files" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('chat-files', 'gallery', 'avatars', 'memories')
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE: only owner can delete their own files
CREATE POLICY "Users delete own files" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id IN ('chat-files', 'gallery', 'avatars', 'memories')
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
