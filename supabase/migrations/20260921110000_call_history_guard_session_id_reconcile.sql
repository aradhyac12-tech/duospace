-- Reconciliation (applied live 2026-09-21, adapted from 20260920140000).
--
-- 20260920140000 freezes call_history.session_id by CREATE OR REPLACE-ing
-- enforce_call_history_transition(). The LIVE project never had that function:
-- its call_history guard is enforce_call_history_update_rules()
-- (trigger enforce_call_history_update_rules_trg). This migration makes the
-- freeze hold on whichever guard actually exists:
--   * repo-built database  -> enforce_call_history_transition already freezes it; nothing to do.
--   * live-style database  -> add `session_id` to the identity-column check of the live guard.
-- Idempotent: it only rewrites the live guard while its body does not mention session_id.

DO $reconcile$
BEGIN
  IF to_regprocedure('public.enforce_call_history_update_rules()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'call_history' AND column_name = 'session_id')
     AND pg_get_functiondef('public.enforce_call_history_update_rules()'::regprocedure) NOT LIKE '%session_id%'
  THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.enforce_call_history_update_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Identity columns are immutable once a call row exists.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.caller_id IS DISTINCT FROM OLD.caller_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id
     OR NEW.call_type IS DISTINCT FROM OLD.call_type
     OR NEW.call_direction IS DISTINCT FROM OLD.call_direction
     OR NEW.room_name IS DISTINCT FROM OLD.room_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
  THEN
    RAISE EXCEPTION 'call_history: identity columns are immutable';
  END IF;

  -- claimed_by: same atomic guard as claim_call(), enforced regardless of write path.
  IF NEW.claimed_by IS DISTINCT FROM OLD.claimed_by THEN
    IF OLD.claimed_by IS NOT NULL THEN
      RAISE EXCEPTION 'call_history: claimed_by is immutable once set';
    END IF;
    IF NEW.claimed_by IS DISTINCT FROM auth.uid()
       OR auth.uid() IS DISTINCT FROM OLD.receiver_id
       OR OLD.status IS DISTINCT FROM 'in_progress'
       OR (OLD.expires_at IS NOT NULL AND OLD.expires_at <= now())
    THEN
      RAISE EXCEPTION 'call_history: illegal claim attempt';
    END IF;
  END IF;

  -- claimed_device_id can only move together with claimed_by, and freezes once claimed.
  IF NEW.claimed_device_id IS DISTINCT FROM OLD.claimed_device_id
     AND OLD.claimed_by IS NOT NULL
  THEN
    RAISE EXCEPTION 'call_history: claimed_device_id is immutable once claimed';
  END IF;

  -- Status transitions: terminal states cannot be reopened.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'call_history: status % is terminal', OLD.status;
    END IF;
    IF OLD.status = 'missed' AND NEW.status <> 'seen' THEN
      RAISE EXCEPTION 'call_history: missed calls may only transition to seen';
    END IF;
    IF OLD.status = 'in_progress' AND NEW.status NOT IN ('completed','missed','cancelled','seen') THEN
      RAISE EXCEPTION 'call_history: illegal transition from in_progress to %', NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
    $fn$;
  END IF;
END
$reconcile$;
