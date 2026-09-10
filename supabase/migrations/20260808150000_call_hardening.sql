-- ============================================================================
-- Calling system production-hardening pass — concurrency + security audit
-- follow-up to 20260808120000_ios_voip_push.sql. Every change here closes a
-- specific race or authorization gap found during that audit; see the
-- inline comments and the accompanying CALL_STATE_TEST_MATRIX.md for the
-- reasoning and the scenario each one covers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CRITICAL SECURITY FIX: call_history INSERT never verified receiver_id
--    was actually the caller's linked partner — RLS only checked
--    `auth.uid() = caller_id`. Any authenticated user could insert a row
--    with an arbitrary receiver_id, which (via notify_voip_on_call_insert)
--    would ring a complete stranger's phone with a call that looks
--    legitimate. This is exactly the "calling arbitrary users" attack
--    item 11/12 of the original spec called out to prevent. get_partner_id
--    is the existing SECURITY DEFINER helper already used for this same
--    purpose on every other partner-scoped table (galleries, messages,
--    etc.) — reused here rather than inventing a parallel check.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert own calls" ON public.call_history;
CREATE POLICY "Users can insert own calls" ON public.call_history
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = caller_id AND receiver_id = public.get_partner_id(auth.uid()));

-- ----------------------------------------------------------------------------
-- 2. claimed_device_id — lets the claim/end triggers target (or exclude) a
--    specific device instead of every device a user owns, needed for the
--    "answered elsewhere" push (section 6) to reach ONLY the losing
--    device(s), never the one that actually answered.
-- ----------------------------------------------------------------------------
ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS claimed_device_id text;

-- ----------------------------------------------------------------------------
-- 3. claim_call: now also records which device won, still a single atomic
--    UPDATE ... WHERE ... RETURNING (unchanged shape from the prior
--    migration — CONCURRENT ANSWER TEST: this was already race-safe, a
--    true compare-and-swap, not a SELECT-then-UPDATE. Confirmed instead of
--    reimplemented; only the recorded columns change).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_call(_call_id uuid, _device_id text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.call_history
  SET claimed_by = auth.uid(), claimed_at = now(), claimed_device_id = _device_id
  WHERE id = _call_id
    AND receiver_id = auth.uid()
    AND status = 'in_progress'
    AND claimed_by IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_call(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_call(uuid, text) TO authenticated;
-- The old single-arg overload from the prior migration is superseded —
-- drop it so there's exactly one call_call signature and no ambiguity for
-- PostgREST's RPC resolution.
DROP FUNCTION IF EXISTS public.claim_call(uuid);

-- ----------------------------------------------------------------------------
-- 4. CRITICAL BUG FIX (item 4 — Answer vs Missed race): the client's
--    30-second ring-timeout auto-decline (IncomingCallOverlay.tsx) was
--    doing a bare `.update({ status: 'missed' })` with no state guard
--    beyond matching the row id. That UPDATE could win a race against a
--    claim landing at nearly the same instant (client jitter, backgrounded
--    tab throttling a setTimeout, etc.), producing exactly the forbidden
--    "declined/missed + connected" state the audit was asked to rule out.
--    decline_call() replaces it with the same atomic-CAS pattern as
--    claim_call/cancel_call: only transitions to 'missed' while the call
--    is still genuinely unclaimed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_call(_call_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_declined boolean;
BEGIN
  UPDATE public.call_history
  SET status = 'missed', ended_at = now()
  WHERE id = _call_id
    AND receiver_id = auth.uid()
    AND status = 'in_progress'
    AND claimed_by IS NULL
  RETURNING true INTO v_declined;

  RETURN COALESCE(v_declined, false);
END;
$$;
REVOKE ALL ON FUNCTION public.decline_call(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.decline_call(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Server-authoritative ring-expiry window (item 4 continued): expires_at
--    was added by the prior migration and read by claim_call's guard, but
--    nothing ever SET it — the guard was therefore always vacuously true
--    (`expires_at IS NULL`). Setting it client-side would mean trusting the
--    client's clock/honesty for a security-relevant boundary (item 11: "do
--    not trust client-supplied ... call state"), so it's set here,
--    server-side, at insert time, tied to started_at rather than to
--    whatever timestamp a client sends. 40s gives a little headroom over
--    the client's 30s auto-decline timer so a slow network doesn't let the
--    row expire out from under a person who tapped Answer in time.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_call_expiry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'in_progress' AND NEW.expires_at IS NULL THEN
    NEW.expires_at := COALESCE(NEW.started_at, now()) + interval '40 seconds';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_call_insert_set_expiry ON public.call_history;
CREATE TRIGGER on_call_insert_set_expiry
  BEFORE INSERT ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.set_call_expiry();

-- ----------------------------------------------------------------------------
-- 6. "Answered elsewhere" (item 8): a dedicated event, deliberately NOT
--    reusing 'cancel'. A losing device receiving this must end ONLY its
--    own still-ringing CallKit UUID for this exact call id — never the
--    shared/active call. Firing on claimed_by transitioning NULL -> set
--    (status stays 'in_progress' the moment a claim lands, so the existing
--    "status changed" trigger from the prior migration does not cover
--    this transition at all — a real gap, not just a naming one).
--    excludeDeviceId (the winner's claimed_device_id) is threaded through
--    to send-voip-push so the answering device's own token is never sent
--    a push telling it to hang up.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_voip_on_call_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.receiver_id IS NULL THEN RETURN NEW; END IF;
  IF OLD.claimed_by IS NOT NULL OR NEW.claimed_by IS NULL THEN RETURN NEW; END IF;

  PERFORM private.dispatch_voip_push(jsonb_build_object(
    'internal', true,
    'event', 'answered_elsewhere',
    'callId', NEW.id,
    'callerId', NEW.caller_id,
    'recipientId', NEW.receiver_id,
    'excludeDeviceId', NEW.claimed_device_id,
    'createdAt', now()
  ));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_call_claim_voip_push ON public.call_history;
CREATE TRIGGER on_call_claim_voip_push
  AFTER UPDATE ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.notify_voip_on_call_claim();

-- Extend the end-of-call trigger from the prior migration to carry the
-- same excludeDeviceId — a normal 'completed' call (both parties talked,
-- then hung up) also transitions status away from 'in_progress' and would
-- otherwise send a redundant end-push to the very device that was just on
-- the call. Not incorrect on its own (the native isAnswered guard added in
-- this pass makes that push a harmless no-op — see CallKitManager.swift),
-- but excluding it here avoids the wasted push and the brief
-- report-then-end flash entirely.
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
    'excludeDeviceId', NEW.claimed_device_id,
    'createdAt', now()
  ));
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. apns_push_log: allow the new event type. The UNIQUE(call_id,
--    push_token_id, event_type) idempotency key from the prior migration
--    is untouched — 'answered_elsewhere' is just one more allowed value
--    for the third column, not a new mechanism.
-- ----------------------------------------------------------------------------
ALTER TABLE public.apns_push_log DROP CONSTRAINT IF EXISTS apns_push_log_event_type_check;
ALTER TABLE public.apns_push_log
  ADD CONSTRAINT apns_push_log_event_type_check
  CHECK (event_type IN ('incoming', 'cancel', 'answered_elsewhere'));

-- ----------------------------------------------------------------------------
-- 9. TOKEN LIFECYCLE — logout (item 10). sync_push_token_to_push_tokens()
--    (20260725091342_fcm_push_notifications.sql) only ever handled
--    push_token becoming non-null; the moment the client clears
--    profiles.push_token on sign-out (added in this pass — see
--    Settings.tsx), the OLD token was left `is_valid = true` in
--    push_tokens forever. Concretely: sign out, someone else signs into a
--    different account on the same physical device, and the FIRST
--    account's push_tokens row is still live — an incoming call/message
--    for the account that signed out would still ring THIS device.
--    CREATE OR REPLACE keeps this the one and only sync mechanism (no
--    parallel token-management path introduced) — same trigger, new
--    branch.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_push_token_to_push_tokens()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.push_token IS NOT DISTINCT FROM OLD.push_token
     AND NEW.push_platform IS NOT DISTINCT FROM OLD.push_platform THEN
    RETURN NEW;
  END IF;

  IF NEW.push_token IS NOT NULL AND length(trim(NEW.push_token)) > 0 THEN
    INSERT INTO public.push_tokens (user_id, token, platform, is_valid, last_used_at)
    VALUES (NEW.user_id, NEW.push_token, COALESCE(NEW.push_platform, 'android'), true, now())
    ON CONFLICT (token) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      is_valid = true,
      invalidated_reason = NULL,
      last_used_at = now(),
      updated_at = now();
  ELSIF TG_OP = 'UPDATE' AND OLD.push_token IS NOT NULL AND length(trim(OLD.push_token)) > 0 THEN
    -- push_token was cleared (sign-out) — deactivate the token it
    -- previously pointed to rather than leaving a stale live row behind.
    UPDATE public.push_tokens
    SET is_valid = false, invalidated_reason = 'signed_out', updated_at = now()
    WHERE token = OLD.push_token;
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Migration-safety self-review note (item 14), left as a comment rather
--    than code since there's nothing further to change:
--    - Every new/changed function here is SECURITY DEFINER with
--      `SET search_path = public` (or public+extensions where it touches
--      the net extension) — prevents the classic search_path-hijack where
--      an attacker-created object in a schema earlier in a caller's
--      search_path shadows a table/function the definer body references.
--    - Every RPC meant for client use (claim_call, cancel_call,
--      decline_call) does its own authorization INSIDE the WHERE clause
--      (receiver_id/caller_id = auth.uid()) rather than trusting a
--      SECURITY DEFINER's elevated privilege alone — the elevation is only
--      there to atomically write claimed_by/status past RLS's normal
--      per-column checks, not to skip authorization.
--    - REVOKE ALL ... FROM public + explicit GRANT ... TO authenticated on
--      every one of them, matching the pattern already established by
--      consume_rate_limit in 20260511081322_c574ba37....sql.
--    - All new columns are nullable with backward-compatible defaults;
--      nothing here can fail against pre-existing rows.
--    - New indexes (idx_call_history_ringing, idx_apns_push_log_call from
--      the prior migration) are non-unique and additive; no existing index
--      or constraint is narrowed in a way that could reject previously-
--      valid data, except the call_history INSERT policy in section 1
--      above, which is an intentional tightening (see its comment) rather
--      than an oversight.
-- ============================================================================
