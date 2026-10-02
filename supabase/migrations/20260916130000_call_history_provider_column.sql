-- Phase 1 calling-architecture migration (migration brief STEP 8/9): adds
-- two columns to the EXISTING call_history table rather than creating a
-- new call/room table, per the brief's explicit instruction ("Do NOT
-- create duplicate tables if an appropriate existing call table already
-- exists. Inspect the existing Supabase schema first.") — call_history's
-- own `id` already serves as the stable call identifier used everywhere
-- (claim_call/decline_call/cancel_call, IncomingCallOverlay, Calls.tsx,
-- Chat.tsx — see AUDIT_FIXES_SUMMARY / the transition-guard migration's
-- own doc comment for the full call-site inventory).
--
-- `provider`: which CallEngine adapter actually handled this call
-- (STEP 9's provider-selection requirement, surfaced into telemetry so a
-- future Daily-vs-self-hosted latency comparison, STEP 10/11, can group
-- by it). Defaults to 'daily' — every historical row and every row
-- written by a client that doesn't yet know about this column gets the
-- correct value with no backfill needed, since Daily is and remains the
-- only provider actually in production use this phase.
--
-- `ended_reason`: free-text, descriptive only — same trust tier as the
-- existing `cancel_reason` column (see the transition-guard migration's
-- own doc comment: "low-stakes descriptive fields ... not authoritative
-- state"). NOT the source of truth for WHY a call ended — `status`
-- (server-computed by the transition trigger) remains that. This exists
-- so a generic CallEngineErrorCode (AUTH_FAILED, ICE_FAILED, TURN_FAILED,
-- etc — see src/lib/callEngine/types.ts) can be recorded per call for
-- debugging without inventing a new table.
ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS ended_reason text;

DO $$ BEGIN
  ALTER TABLE public.call_history
    ADD CONSTRAINT call_history_provider_check CHECK (provider IN ('daily', 'self_hosted'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Freeze `provider` the same way caller_id/receiver_id/started_at/
-- room_name/call_type/call_direction are already frozen by this
-- function (20260910200000_call_history_transition_guard.sql) — which
-- engine handled a call is decided once, at row creation, never
-- rewritten by a later UPDATE from any caller. CREATE OR REPLACE keeps
-- every other clause of that function byte-for-byte identical; only the
-- freeze list and this comment change.
CREATE OR REPLACE FUNCTION public.enforce_call_history_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.caller_id := OLD.caller_id;
  NEW.receiver_id := OLD.receiver_id;
  NEW.started_at := OLD.started_at;
  NEW.room_name := OLD.room_name;
  NEW.call_type := OLD.call_type;
  NEW.call_direction := OLD.call_direction;
  NEW.provider := OLD.provider;

  IF OLD.status = 'in_progress' THEN
    IF NEW.status NOT IN ('in_progress', 'completed', 'cancelled', 'failed', 'missed') THEN
      RAISE EXCEPTION 'call_history: illegal transition from in_progress to %', NEW.status;
    END IF;
  ELSIF OLD.status = 'missed' AND NEW.status = 'seen' THEN
    NULL; -- badge-ack, no further column changes needed
  ELSE
    RAISE EXCEPTION 'call_history: cannot modify a call that is already %', OLD.status;
  END IF;

  IF OLD.status = 'in_progress' AND NEW.status <> 'in_progress' THEN
    NEW.ended_at := now();
    IF NEW.status = 'completed' THEN
      NEW.duration_seconds := GREATEST(0, EXTRACT(EPOCH FROM (now() - OLD.started_at))::int);
    ELSE
      NEW.duration_seconds := 0;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
