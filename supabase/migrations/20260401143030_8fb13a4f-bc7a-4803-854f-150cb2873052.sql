
-- Mood detection logs
CREATE TABLE public.mood_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  mood text NOT NULL,
  confidence real NOT NULL DEFAULT 0,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.mood_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own and partner mood logs" ON public.mood_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id = get_partner_id(auth.uid()));

CREATE POLICY "Insert own mood logs" ON public.mood_logs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Delete own mood logs" ON public.mood_logs
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Code surprises
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

CREATE POLICY "View partner surprises" ON public.code_surprises
  FOR SELECT TO authenticated
  USING (creator_id = auth.uid() OR creator_id = get_partner_id(auth.uid()));

CREATE POLICY "Create own surprises" ON public.code_surprises
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = creator_id);

CREATE POLICY "Update own surprises" ON public.code_surprises
  FOR UPDATE TO authenticated
  USING (auth.uid() = creator_id);

CREATE POLICY "Delete own surprises" ON public.code_surprises
  FOR DELETE TO authenticated
  USING (auth.uid() = creator_id);

-- Allow partner to increment views_used
CREATE POLICY "Partner can increment views" ON public.code_surprises
  FOR UPDATE TO authenticated
  USING (creator_id = get_partner_id(auth.uid()));
