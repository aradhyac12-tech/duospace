-- Add soft-delete columns to messages for chat recovery
ALTER TABLE public.messages 
  ADD COLUMN IF NOT EXISTS deleted_by_sender boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_by_receiver boolean NOT NULL DEFAULT false;

-- Add location sharing mode to profiles
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS location_mode text NOT NULL DEFAULT 'on_open';

-- Update shayaris to allow updates
CREATE POLICY "Update own shayaris" ON public.shayaris FOR UPDATE TO authenticated USING (auth.uid() = user_id);
