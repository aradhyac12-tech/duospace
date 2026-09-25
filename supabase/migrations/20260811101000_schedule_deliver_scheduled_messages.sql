-- ============================================================
-- P0 FIX (Final Release Audit — Phase 8C)
--
-- FINDING: `supabase/functions/deliver-scheduled-messages/` exists and is
-- correctly implemented (atomic claim via claim_pending_scheduled_messages(),
-- service-role auth check, structured error logging) — but nothing in this
-- repository's migration history ever invokes it. There is no pg_cron job,
-- no pg_net call, no external scheduler pointed at it anywhere. A user can
-- schedule a message in the Chat UI, it inserts into scheduled_messages
-- successfully, and it is then never delivered — silently, with no error
-- surfaced anywhere, because nothing is polling for due messages.
--
-- (This repo does have ONE other cron job — "Section 7" in
-- 20260501205802_...sql, an expiry sweep unrelated to message delivery —
-- and the older cleanup-orphan-uploads cron in 20260502164001_...sql, which
-- authenticates via current_setting('app.settings.service_role_key', true).
-- That setting is never SET anywhere in this repo (no ALTER DATABASE/ALTER
-- ROLE doing so), so it silently resolves to NULL and that cron's
-- Authorization header has always been "Bearer " — a guaranteed 401. Not
-- touching that job in this migration since it's a separate, lower-priority
-- (P2/P3, orphan-cleanup) issue with its own pre-existing history — flagged
-- in docs/RLS_SECURITY_MATRIX.md / ENVIRONMENT_VERIFICATION.md for a
-- follow-up fix, not bundled into this P0 migration to keep this change
-- reviewable as one thing.)
--
-- This repo already has a working, secure pattern for authenticated
-- server-to-server invocation: Supabase Vault, used by
-- 20260725091342_fcm_push_notifications.sql and
-- 20260808120000_ios_voip_push.sql via `vault.decrypted_secrets`
-- ('project_url' / 'service_role_key'), inside a SECURITY DEFINER function
-- (private.dispatch_push). This migration reuses that exact pattern rather
-- than introducing `app.settings.*` as a second, broken secret-storage
-- mechanism — the project ref used matches the one confirmed consistent
-- across supabase/config.toml, client.ts, DEPLOY.md, and .env.example:
-- jzlpelxwzjjpddqcrtpu.
--
-- Runs every minute, matching the granularity users pick a send time at.
-- If the Vault secrets aren't configured yet, dispatch is skipped with a
-- RAISE WARNING rather than sending an unauthenticated request — see
-- PUSH_NOTIFICATIONS.md for the one-time `select vault.create_secret(...)`
-- setup (same secrets already required for push notifications; if push
-- works today, these likely already exist).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.dispatch_scheduled_message_delivery()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'deliver-scheduled-messages dispatch skipped: Vault secrets "project_url"/"service_role_key" are not configured. See PUSH_NOTIFICATIONS.md.';
    RETURN;
  END IF;

  PERFORM extensions.net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/deliver-scheduled-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  -- Never let a dispatch failure kill the cron job itself; it will just
  -- retry next minute.
  RAISE WARNING 'deliver-scheduled-messages dispatch failed: %', SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION private.dispatch_scheduled_message_delivery() FROM public;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'deliver-scheduled-messages';

    PERFORM cron.schedule(
      'deliver-scheduled-messages',
      '* * * * *',
      $cron$SELECT private.dispatch_scheduled_message_delivery();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron/pg_net not installed in this environment; skip scheduling.
  RAISE NOTICE 'pg_cron/pg_net not available; skipping deliver-scheduled-messages schedule.';
END $$;

-- ============================================================
-- STILL REQUIRED BEFORE THIS IS LIVE (cannot be verified from source):
--   1. Confirm vault.create_secret('project_url', 'https://jzlpelxwzjjpddqcrtpu.supabase.co')
--      and vault.create_secret('service_role_key', '<service_role_key>') have
--      actually been run against the production project.
--   2. Confirm pg_cron + pg_net extensions are enabled on the production
--      Postgres instance.
--   3. After applying, check cron.job and cron.job_run_details to confirm
--      the job registered and is executing without error.
-- See docs/SCHEDULED_MESSAGE_RELEASE_TEST.md.
-- ============================================================
