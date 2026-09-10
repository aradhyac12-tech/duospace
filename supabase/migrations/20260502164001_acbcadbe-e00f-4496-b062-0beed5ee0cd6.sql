-- Resumable uploads tracking + cleanup scheduling
CREATE TABLE IF NOT EXISTS public.pending_uploads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  bucket TEXT NOT NULL,
  object_path TEXT NOT NULL,
  total_chunks INTEGER NOT NULL,
  total_bytes BIGINT NOT NULL,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bucket, object_path)
);

CREATE INDEX IF NOT EXISTS idx_pending_uploads_created_at
  ON public.pending_uploads (created_at);
CREATE INDEX IF NOT EXISTS idx_pending_uploads_user
  ON public.pending_uploads (user_id);

ALTER TABLE public.pending_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own pending uploads"
  ON public.pending_uploads FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own pending uploads"
  ON public.pending_uploads FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own pending uploads"
  ON public.pending_uploads FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own pending uploads"
  ON public.pending_uploads FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER update_pending_uploads_updated_at
  BEFORE UPDATE ON public.pending_uploads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Schedule cleanup of orphaned chunks every hour
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup-orphan-uploads')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-orphan-uploads');
    PERFORM cron.schedule(
      'cleanup-orphan-uploads',
      '0 * * * *',
      $cron$
      SELECT net.http_post(
        url := 'https://lotznohocfmwmyyexoxp.supabase.co/functions/v1/cleanup-orphan-uploads',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      );
      $cron$
    );
  END IF;
END $$;