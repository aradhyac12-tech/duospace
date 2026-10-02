
CREATE TABLE public.call_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id uuid NOT NULL,
  receiver_id uuid,
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

CREATE POLICY "Users can view own calls" ON public.call_history
  FOR SELECT TO authenticated
  USING (auth.uid() = caller_id OR auth.uid() = receiver_id);

CREATE POLICY "Users can insert own calls" ON public.call_history
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = caller_id);

CREATE POLICY "Users can update own calls" ON public.call_history
  FOR UPDATE TO authenticated
  USING (auth.uid() = caller_id);
