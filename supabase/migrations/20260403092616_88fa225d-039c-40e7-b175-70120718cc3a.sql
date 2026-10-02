
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

CREATE POLICY "Users can view own cycles"
ON public.menstrual_cycles FOR SELECT
USING (user_id = auth.uid() OR user_id = public.get_partner_id(auth.uid()));

CREATE POLICY "Users can insert own cycles"
ON public.menstrual_cycles FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own cycles"
ON public.menstrual_cycles FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own cycles"
ON public.menstrual_cycles FOR DELETE
USING (auth.uid() = user_id);

CREATE INDEX idx_menstrual_cycles_user ON public.menstrual_cycles(user_id);
