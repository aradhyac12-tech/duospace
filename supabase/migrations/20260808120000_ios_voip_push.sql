-- ============================================================================
-- iOS VoIP push backend: token model extension, call claim/cancel state,
-- and idempotent APNs dispatch logging.
-- ============================================================================
-- This migration EVOLVES the existing public.push_tokens table (added in
-- 20260725091342_fcm_push_notifications.sql) rather than creating a
-- parallel one. All existing rows/data are preserved. Android/FCM behavior
-- is untouched: every new column has a default that reproduces today's
-- behavior for rows that already exist.
--
-- Scope: registers a distinct 'apns_voip' token type used ONLY for the
-- CallKit/PushKit incoming-call flow (see supabase/functions/send-voip-push).
-- Regular chat/reaction/etc. notifications keep using push_tokens rows with
-- token_type IN ('fcm', 'apns') via the existing supabase/functions/send-push
-- (FCM HTTP v1) path — nothing about that changes here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. push_tokens: token_type + device_id + apns_environment
-- ----------------------------------------------------------------------------
ALTER TABLE public.push_tokens
  ADD COLUMN IF NOT EXISTS token_type text NOT NULL DEFAULT 'fcm'
    CHECK (token_type IN ('fcm', 'apns', 'apns_voip')),
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS apns_environment text
    CHECK (apns_environment IS NULL OR apns_environment IN ('sandbox', 'production'));

-- Every row that exists today was written by usePushNotifications.ts via
-- FCM HTTP v1 (see PUSH_NOTIFICATIONS.md) regardless of platform — the
-- DEFAULT 'fcm' above already backfills them correctly, so no separate
-- UPDATE is needed. Only newly-registered `apns_voip` rows (this feature)
-- and any future direct-APNs `apns` rows will use the other two values.

-- One token per (user, device, type): lets the client upsert on rotation
-- (`.upsert(..., { onConflict: 'user_id,device_id,token_type' })`) instead
-- of accumulating stale rows for the same physical device. A genuine
-- UNIQUE constraint rather than a partial index deliberately: Postgres
-- never treats two NULLs as duplicates under UNIQUE, so pre-existing rows
-- with no device_id (written before this migration) are completely
-- unaffected, while a plain (non-partial) constraint is what lets
-- supabase-js's `onConflict` target it without also needing to repeat a
-- matching WHERE predicate on every upsert call site.
ALTER TABLE public.push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_user_device_type_key;
ALTER TABLE public.push_tokens
  ADD CONSTRAINT push_tokens_user_device_type_key UNIQUE (user_id, device_id, token_type);

CREATE INDEX IF NOT EXISTS idx_push_tokens_voip
  ON public.push_tokens (user_id)
  WHERE token_type = 'apns_voip' AND is_valid;

-- The client (usePushNotifications.ts) needs to upsert its own VoIP token
-- directly into push_tokens (previously all writes here came only from the
-- service-definer sync trigger on profiles.push_token). Scope strictly to
-- the caller's own rows, matching the existing SELECT/DELETE policies.
GRANT INSERT, UPDATE ON public.push_tokens TO authenticated;
DROP POLICY IF EXISTS "Users can insert own push tokens" ON public.push_tokens;
DROP POLICY IF EXISTS "Users can update own push tokens" ON public.push_tokens;
CREATE POLICY "Users can insert own push tokens" ON public.push_tokens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own push tokens" ON public.push_tokens
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 2. call_history: claim/cancel/expiry state for the VoIP flow
-- ----------------------------------------------------------------------------
-- claimed_by / claimed_at: multi-device answer race. Exactly one device may
-- claim a ringing call (see public.claim_call below); every other device's
-- PushKit/FCM-delivered incoming-call UI must be torn down once a claim
-- lands elsewhere.
-- expires_at: caller-set ring timeout, used to reject a claim/cancel on a
-- call nobody will ever answer instead of leaving it claimable forever.
-- cancelled_at / cancel_reason: caller-initiated pre-answer cancellation —
-- the 'cancelled' status was already anticipated by the web client
-- (src/components/IncomingCallOverlay.tsx's realtime UPDATE handler
-- already checks for it) but nothing ever set it until now.
ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS claimed_by uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

CREATE INDEX IF NOT EXISTS idx_call_history_ringing
  ON public.call_history (receiver_id, started_at DESC)
  WHERE status = 'in_progress';

-- Atomically claims a still-ringing call for the calling device/session.
-- Returns true iff this call is won: the caller becomes the sole device
-- allowed to proceed to `daily-call` get-token + join. Every other device
-- that also received the incoming-call push must treat a false return (or
-- the realtime UPDATE it causes) as "someone else answered" and tear down
-- its own ringing UI (CallKit endCall / Android Telecom disconnect).
-- SECURITY DEFINER because RLS's own USING clause on UPDATE only compares
-- OLD row visibility, not this row's specific race-free CAS semantics —
-- the WHERE clause below is the actual guard.
CREATE OR REPLACE FUNCTION public.claim_call(_call_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.call_history
  SET claimed_by = auth.uid(), claimed_at = now()
  WHERE id = _call_id
    AND receiver_id = auth.uid()
    AND status = 'in_progress'
    AND claimed_by IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_call(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_call(uuid) TO authenticated;

-- Caller-initiated cancellation of a call that hasn't been answered yet.
-- Only the caller may cancel their own outgoing call, and only while it is
-- still genuinely ringing (unclaimed, in_progress) — prevents a caller from
-- retroactively cancelling a call the recipient already answered.
CREATE OR REPLACE FUNCTION public.cancel_call(_call_id uuid, _reason text DEFAULT 'caller_cancelled')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cancelled boolean;
BEGIN
  UPDATE public.call_history
  SET status = 'cancelled', cancelled_at = now(), ended_at = now(), cancel_reason = _reason
  WHERE id = _call_id
    AND caller_id = auth.uid()
    AND status = 'in_progress'
    AND claimed_by IS NULL
  RETURNING true INTO v_cancelled;

  RETURN COALESCE(v_cancelled, false);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_call(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.cancel_call(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. apns_push_log: idempotency + audit for VoIP push dispatch
-- ----------------------------------------------------------------------------
-- The same logical call event (a specific call reaching a specific device)
-- must never produce two CallKit experiences on that device even if
-- send-voip-push is invoked twice (trigger retry, duplicate Postgres NOTIFY,
-- manual re-dispatch). UNIQUE(call_id, push_token_id, event_type) below is
-- the idempotency key: a second attempt hits the unique violation and the
-- function treats it as "already sent," not an error.
CREATE TABLE IF NOT EXISTS public.apns_push_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL,
  push_token_id uuid NOT NULL REFERENCES public.push_tokens(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('incoming', 'cancel')),
  apns_id text,
  http_status integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, push_token_id, event_type)
);
GRANT ALL ON public.apns_push_log TO service_role;
ALTER TABLE public.apns_push_log ENABLE ROW LEVEL SECURITY;
-- No client policies at all — this table is server-internal audit/idempotency
-- state, never read or written by the app directly (mirrors notification_history's
-- shape but without a user-facing surface).
CREATE INDEX IF NOT EXISTS idx_apns_push_log_call ON public.apns_push_log (call_id);

-- ----------------------------------------------------------------------------
-- 4. Dispatch plumbing for send-voip-push, mirroring private.dispatch_push
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.dispatch_voip_push(payload jsonb)
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
    RAISE WARNING 'send-voip-push dispatch skipped: Vault secrets "project_url"/"service_role_key" are not configured. See PUSH_NOTIFICATIONS.md.';
    RETURN;
  END IF;

  PERFORM extensions.net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/send-voip-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := payload,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  -- Never let a VoIP push failure block the call-state write that
  -- triggered it — the ringing UX degrades (no CallKit alert), but the
  -- call row / realtime signal / Android FCM path must still go through.
  RAISE WARNING 'send-voip-push dispatch failed: %', SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION private.dispatch_voip_push(jsonb) FROM public;

-- ----------------------------------------------------------------------------
-- 5. Trigger: call_history insert (ringing) -> incoming VoIP push
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_voip_on_call_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.receiver_id IS NULL OR NEW.status IS DISTINCT FROM 'in_progress' THEN
    RETURN NEW;
  END IF;

  PERFORM private.dispatch_voip_push(jsonb_build_object(
    'internal', true,
    'event', 'incoming',
    'callId', NEW.id,
    'callerId', NEW.caller_id,
    'recipientId', NEW.receiver_id,
    'callType', NEW.call_type,
    'roomName', NEW.room_name,
    'createdAt', NEW.started_at
  ));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_call_insert_voip_push ON public.call_history;
CREATE TRIGGER on_call_insert_voip_push
  AFTER INSERT ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.notify_voip_on_call_insert();

-- ----------------------------------------------------------------------------
-- 6. Trigger: call_history -> cancelled/completed/missed before claim ->
--    cancel VoIP push (ends CallKit ringing on every unclaimed device)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_voip_on_call_end()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.receiver_id IS NULL OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'in_progress' THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('cancelled', 'missed', 'completed') THEN
    RETURN NEW;
  END IF;

  PERFORM private.dispatch_voip_push(jsonb_build_object(
    'internal', true,
    'event', 'cancel',
    'callId', NEW.id,
    'callerId', NEW.caller_id,
    'recipientId', NEW.receiver_id,
    'reason', NEW.status,
    'createdAt', now()
  ));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_call_end_voip_push ON public.call_history;
CREATE TRIGGER on_call_end_voip_push
  AFTER UPDATE ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.notify_voip_on_call_end();
