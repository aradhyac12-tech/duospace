
-- Shayaris table for poetry section
CREATE TABLE public.shayaris (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shayaris ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own and partner shayaris" ON public.shayaris
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id = get_partner_id(auth.uid()));

CREATE POLICY "Insert own shayaris" ON public.shayaris
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Delete own shayaris" ON public.shayaris
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Enable realtime for shayaris
ALTER PUBLICATION supabase_realtime ADD TABLE public.shayaris;

-- Blend invites for synced listening permission
CREATE TABLE public.blend_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.blend_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View blend invites" ON public.blend_invites
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR sender_id = get_partner_id(auth.uid()));

CREATE POLICY "Create blend invites" ON public.blend_invites
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Update blend invites" ON public.blend_invites
  FOR UPDATE TO authenticated
  USING (sender_id = get_partner_id(auth.uid()));

CREATE POLICY "Delete blend invites" ON public.blend_invites
  FOR DELETE TO authenticated
  USING (sender_id = auth.uid() OR sender_id = get_partner_id(auth.uid()));

-- Enable realtime for blend invites
ALTER PUBLICATION supabase_realtime ADD TABLE public.blend_invites;
