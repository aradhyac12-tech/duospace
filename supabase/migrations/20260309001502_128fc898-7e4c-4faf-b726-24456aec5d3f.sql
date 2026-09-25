
-- Fix overly permissive UPDATE policy on invite_links
DROP POLICY "Anyone authenticated can update invite links" ON public.invite_links;

CREATE POLICY "Users can accept invite links" ON public.invite_links
  FOR UPDATE TO authenticated
  USING (used_by IS NULL AND expires_at > now())
  WITH CHECK (auth.uid() = used_by);
