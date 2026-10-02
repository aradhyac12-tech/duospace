
ALTER TABLE public.user_secrets
  ADD COLUMN IF NOT EXISTS last_backup_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_backup_file_id text,
  ADD COLUMN IF NOT EXISTS last_backup_size bigint,
  ADD COLUMN IF NOT EXISTS last_backup_error text;

CREATE TABLE IF NOT EXISTS public.backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google_drive',
  status text NOT NULL CHECK (status IN ('success','error')),
  file_id text,
  size_bytes bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.backup_runs TO authenticated;
GRANT ALL ON public.backup_runs TO service_role;

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own backup runs" ON public.backup_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS backup_runs_user_idx ON public.backup_runs(user_id, created_at DESC);
