
-- 1. FIX INVITE LINKS RLS
CREATE POLICY "Anyone can lookup invite by code"
ON public.invite_links FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Users can view own invite links" ON public.invite_links;

-- 2. PARTNER DISCOVERY
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text UNIQUE;

CREATE TABLE IF NOT EXISTS public.partner_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id, receiver_id)
);
ALTER TABLE public.partner_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own requests" ON public.partner_requests FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR receiver_id = auth.uid());
CREATE POLICY "Send requests" ON public.partner_requests FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Update received requests" ON public.partner_requests FOR UPDATE TO authenticated
  USING (receiver_id = auth.uid());
CREATE POLICY "Delete own requests" ON public.partner_requests FOR DELETE TO authenticated
  USING (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE OR REPLACE FUNCTION public.search_users(search_term text)
RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.user_id, p.display_name, p.username, p.avatar_url
  FROM public.profiles p
  WHERE (p.username ILIKE '%' || search_term || '%'
    OR p.phone_number = search_term)
  AND p.user_id != auth.uid()
  LIMIT 20;
$$;

-- 3. SHAYARI UPGRADES
ALTER TABLE public.shayaris ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
ALTER TABLE public.shayaris ADD COLUMN IF NOT EXISTS delete_requested_by uuid;

-- 4. CODE SURPRISE ANALYTICS
CREATE TABLE IF NOT EXISTS public.code_surprise_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surprise_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.code_surprise_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View surprise events" ON public.code_surprise_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR surprise_id IN (
    SELECT id FROM public.code_surprises WHERE creator_id = auth.uid()
  ));
CREATE POLICY "Insert surprise events" ON public.code_surprise_events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- 5. MOOD IMPROVEMENTS
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS valence real DEFAULT 0;
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS arousal real DEFAULT 0.5;
ALTER TABLE public.mood_logs ADD COLUMN IF NOT EXISTS feedback text;

-- 6. WHATSAPP IMPORT
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
ALTER TABLE public.imported_chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own imported chats" ON public.imported_chats FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR owner_id = get_partner_id(auth.uid()));
CREATE POLICY "Insert own imported chats" ON public.imported_chats FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Delete own imported chats" ON public.imported_chats FOR DELETE TO authenticated
  USING (auth.uid() = owner_id);

-- 7. STORAGE
INSERT INTO storage.buckets (id, name, public) VALUES ('surprise-assets', 'surprise-assets', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Auth users can upload surprise assets"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'surprise-assets');

CREATE POLICY "Public read surprise assets"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'surprise-assets');

CREATE POLICY "Users can delete own surprise assets"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'surprise-assets');

-- 8. REALTIME
ALTER PUBLICATION supabase_realtime ADD TABLE public.partner_requests;
