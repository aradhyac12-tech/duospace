
-- Create invite_links table for partner connection
CREATE TABLE public.invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  used_by uuid,
  used_at timestamptz
);

ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create invite links" ON public.invite_links
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);

CREATE POLICY "Users can view own invite links" ON public.invite_links
  FOR SELECT TO authenticated USING (auth.uid() = creator_id OR auth.uid() = used_by);

CREATE POLICY "Anyone authenticated can update invite links" ON public.invite_links
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Users can delete own invite links" ON public.invite_links
  FOR DELETE TO authenticated USING (auth.uid() = creator_id);

-- Function to clean up expired disappearing messages
CREATE OR REPLACE FUNCTION public.cleanup_disappeared_messages()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.messages WHERE disappear_at IS NOT NULL AND disappear_at < now();
$$;
