-- ============================================================================
-- Delayed UNILATERAL unlink: either person can end the pairing on their own,
-- 14 days after they ask, with no approval from the other person.
--
-- Context. 20260920150000_partner_unlink_consent.sql made unlinking need the
-- partner's approval. That left no way out if the partner never answers, or
-- refuses. This migration adds the escape hatch WITHOUT removing the fast
-- consent path: request_unlink / respond_unlink / cancel_unlink are untouched
-- and still work exactly as before (both agree -> unlinked immediately).
--
-- How the 14 days work.
--   * public.scheduled_unlinks — one row per "unlink me in 14 days" ask.
--     execute_at is fixed by the SERVER at insert time (clients cannot choose
--     or shorten it). Clients can only READ rows involving them (so the other
--     person SEES the countdown — a scheduled unlink is never secret); every
--     write goes through the RPCs below.
--   * schedule_unlink()         — caller asks to be unlinked on execute_at.
--                                 Idempotent. Notifies the partner (push).
--   * cancel_scheduled_unlink() — ONLY the person who scheduled it can cancel.
--                                 The partner cannot block or cancel it.
--   * private.execute_due_unlinks() — completes every due row via the same
--     private.apply_unlink() the consent path uses, so chat/share revocation
--     and partner_requests cleanup behave identically.
--       - run by pg_cron every 5 minutes (best-effort, same guarded pattern as
--         expire-stale-calls); and
--       - run LAZILY for the caller by public.process_my_due_unlink(), which
--         the app calls on open / return to foreground. So the unlink still
--         completes on time on projects where pg_cron isn't installed.
--   * A scheduled row is only valid for the pairing it was created for. If the
--     two people are no longer linked to EACH OTHER when it comes due (they
--     unlinked another way, or re-paired with someone else) it is marked
--     'void' and nothing is touched — it can never sever a NEW pairing.
--   * If the pairing ends by any other route (consent path, either side),
--     private.apply_unlink() voids the leftover schedule in the same
--     transaction.
--
-- Stopping what the other person sees is a separate, IMMEDIATE action:
-- see 20261002110000_stop_sharing.sql (stop_sharing()).
--
-- Deploy order: apply this migration, deploy send-push (two new push types
-- 'unlink_scheduled' / 'unlink_completed' — without it those pushes get a 400
-- but never block the write), then ship the app build. An old app build is
-- unaffected: it simply doesn't show the new controls.
--
-- Idempotent: safe to run twice. NOT LIVE-TESTED — see
-- docs/STOP_SHARING_AND_SCHEDULED_UNLINK.md for the manual matrix.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduled_unlinks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'cancelled', 'executed', 'void')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  execute_at   timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  resolved_at  timestamptz,
  CONSTRAINT scheduled_unlinks_distinct_people CHECK (requester_id <> partner_id)
);

-- At most one live schedule per requester.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_unlinks_one_live_per_requester
  ON public.scheduled_unlinks (requester_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS scheduled_unlinks_partner_live
  ON public.scheduled_unlinks (partner_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS scheduled_unlinks_due
  ON public.scheduled_unlinks (execute_at) WHERE status = 'scheduled';

ALTER TABLE public.scheduled_unlinks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduled_unlinks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.scheduled_unlinks TO authenticated;
GRANT ALL ON public.scheduled_unlinks TO service_role;

DROP POLICY IF EXISTS "View own scheduled unlinks" ON public.scheduled_unlinks;
CREATE POLICY "View own scheduled unlinks" ON public.scheduled_unlinks
  FOR SELECT TO authenticated
  USING (requester_id = (SELECT auth.uid()) OR partner_id = (SELECT auth.uid()));

ALTER TABLE public.scheduled_unlinks REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.scheduled_unlinks;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Server-owned lifecycle: a row's identity and dates never change after insert,
-- and a finished row never reopens. (Writers are SECURITY DEFINER functions, so
-- this is defence in depth against a future grant/policy mistake.)
CREATE OR REPLACE FUNCTION public.scheduled_unlinks_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.execute_at IS DISTINCT FROM OLD.execute_at THEN
    RAISE EXCEPTION 'scheduled_unlinks: identity and dates are immutable';
  END IF;
  IF OLD.status <> 'scheduled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'scheduled_unlinks: a finished schedule cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scheduled_unlinks_guard_trg ON public.scheduled_unlinks;
CREATE TRIGGER scheduled_unlinks_guard_trg
  BEFORE UPDATE ON public.scheduled_unlinks
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_unlinks_guard();

-- ---------------------------------------------------------------------------
-- 2. apply_unlink(): also retire any schedule for this pair.
-- CREATE OR REPLACE on top of 20260922100100's version — everything already in
-- it is unchanged; this only adds the final UPDATE. A schedule that reaches
-- here through the consent path (or any non-scheduled route) is marked 'void'.
-- execute_scheduled_unlink() sets 'executed' BEFORE calling this, so its own
-- row is already finished and the UPDATE below skips it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.apply_unlink(_a uuid, _b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.profiles WHERE user_id IN (_a, _b) ORDER BY user_id FOR UPDATE;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _a AND partner_id = _b;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _b AND partner_id = _a;
  DELETE FROM public.partner_requests
    WHERE status = 'accepted'
      AND ((sender_id = _a AND receiver_id = _b) OR (sender_id = _b AND receiver_id = _a));
  PERFORM public.revoke_relationship_shares_between(_a, _b);
  -- The pairing is over, so a countdown for it has nothing left to do.
  UPDATE public.scheduled_unlinks
     SET status = 'void', resolved_at = now()
   WHERE status = 'scheduled'
     AND ((requester_id = _a AND partner_id = _b) OR (requester_id = _b AND partner_id = _a));
END;
$$;
REVOKE ALL ON FUNCTION private.apply_unlink(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. schedule_unlink()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_unlink()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_partner uuid;
  v_their   uuid;
  v_open    public.scheduled_unlinks%ROWTYPE;
  v_new     public.scheduled_unlinks%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;

  PERFORM 1 FROM public.profiles WHERE user_id IN (v_uid, v_partner) ORDER BY user_id FOR UPDATE;
  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;
  SELECT partner_id INTO v_their FROM public.profiles WHERE user_id = v_partner;

  -- One-sided pairing: nobody else is affected, so there is nothing to wait for.
  IF v_their IS DISTINCT FROM v_uid THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_uid AND partner_id = v_partner;
    RETURN jsonb_build_object('status', 'executed', 'reason', 'ONE_SIDED');
  END IF;

  -- Already counting down for THIS pairing -> idempotent (keeps the original date).
  SELECT * INTO v_open FROM public.scheduled_unlinks
    WHERE requester_id = v_uid AND status = 'scheduled'
    FOR UPDATE;
  IF FOUND THEN
    IF v_open.partner_id = v_partner THEN
      RETURN jsonb_build_object('status', 'scheduled', 'id', v_open.id, 'execute_at', v_open.execute_at);
    END IF;
    -- Left over from a previous partner: retire it, then schedule fresh.
    UPDATE public.scheduled_unlinks SET status = 'void', resolved_at = now() WHERE id = v_open.id;
  END IF;

  INSERT INTO public.scheduled_unlinks (requester_id, partner_id)
    VALUES (v_uid, v_partner)
    RETURNING * INTO v_new;

  RETURN jsonb_build_object('status', 'scheduled', 'id', v_new.id, 'execute_at', v_new.execute_at);
END;
$$;
REVOKE ALL ON FUNCTION public.schedule_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_unlink() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. cancel_scheduled_unlink(id) — requester only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_scheduled_unlink(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  UPDATE public.scheduled_unlinks
     SET status = 'cancelled', resolved_at = now()
   WHERE id = p_id AND requester_id = v_uid AND status = 'scheduled'
   RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    -- Not theirs (or made up) looks identical to the caller; if it IS theirs,
    -- say what actually happened so the UI can show it.
    SELECT status INTO v_status FROM public.scheduled_unlinks
      WHERE id = p_id AND requester_id = v_uid;
    IF v_status IS NULL THEN
      RETURN jsonb_build_object('error', 'NOT_FOUND');
    END IF;
    RETURN jsonb_build_object('error', 'ALREADY_HANDLED', 'status', v_status);
  END IF;

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_scheduled_unlink(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_scheduled_unlink(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Execution
-- ---------------------------------------------------------------------------
-- Completes ONE due row. Returns true if the pairing was actually ended.
CREATE OR REPLACE FUNCTION private.execute_scheduled_unlink(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.scheduled_unlinks%ROWTYPE;
  v_still_paired boolean;
BEGIN
  SELECT * INTO v_row FROM public.scheduled_unlinks
    WHERE id = p_id AND status = 'scheduled' AND execute_at <= now()
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM public.profiles
    WHERE user_id IN (v_row.requester_id, v_row.partner_id) ORDER BY user_id FOR UPDATE;

  -- Only act while the SAME two people still point at each other; otherwise this
  -- schedule belongs to a pairing that no longer exists.
  SELECT EXISTS (
    SELECT 1 FROM public.profiles a
      JOIN public.profiles b ON b.user_id = a.partner_id AND b.partner_id = a.user_id
     WHERE a.user_id = v_row.requester_id AND a.partner_id = v_row.partner_id
  ) INTO v_still_paired;

  IF NOT v_still_paired THEN
    UPDATE public.scheduled_unlinks SET status = 'void', resolved_at = now() WHERE id = v_row.id;
    RETURN false;
  END IF;

  -- Mark first so apply_unlink()'s "void leftovers" step has nothing to touch.
  UPDATE public.scheduled_unlinks SET status = 'executed', resolved_at = now() WHERE id = v_row.id;
  PERFORM private.apply_unlink(v_row.requester_id, v_row.partner_id);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION private.execute_scheduled_unlink(uuid) FROM PUBLIC, anon, authenticated;

-- Sweep: every due row. service_role / pg_cron only.
CREATE OR REPLACE FUNCTION public.execute_due_unlinks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_done integer := 0;
BEGIN
  FOR v_id IN
    SELECT id FROM public.scheduled_unlinks
     WHERE status = 'scheduled' AND execute_at <= now()
     ORDER BY execute_at
     LIMIT 200
  LOOP
    BEGIN
      IF private.execute_scheduled_unlink(v_id) THEN v_done := v_done + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not stop the rest; it stays 'scheduled' and is retried.
      RAISE WARNING 'execute_due_unlinks: % failed: %', v_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION public.execute_due_unlinks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_due_unlinks() TO service_role;

-- Lazy path for the CALLER: completes their own due schedule (as requester or
-- as the other person) when they open the app, so correctness never depends on
-- pg_cron being installed.
CREATE OR REPLACE FUNCTION public.process_my_due_unlink()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_ended boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;
  FOR v_id IN
    SELECT id FROM public.scheduled_unlinks
     WHERE status = 'scheduled' AND execute_at <= now()
       AND (requester_id = v_uid OR partner_id = v_uid)
  LOOP
    IF private.execute_scheduled_unlink(v_id) THEN v_ended := true; END IF;
  END LOOP;
  RETURN jsonb_build_object('unlinked', v_ended);
END;
$$;
REVOKE ALL ON FUNCTION public.process_my_due_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_my_due_unlink() TO authenticated;

-- Best-effort schedule (same guarded pattern as 20260910120000).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'execute-due-unlinks';
    PERFORM cron.schedule(
      'execute-due-unlinks',
      '*/5 * * * *',
      $cron$SELECT public.execute_due_unlinks();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; skipping execute-due-unlinks schedule.';
END $$;

-- ---------------------------------------------------------------------------
-- 6. Push notifications (best-effort; never blocks the write)
--   scheduled -> tell the OTHER person right away (transparency: they can see
--                the date, and cannot be surprised by it)
--   executed  -> tell the other person it has happened
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push_on_scheduled_unlink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'scheduled' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'unlink_scheduled',
      'senderId', NEW.requester_id,
      'recipientId', NEW.partner_id,
      'relatedId', NEW.id,
      'createdAt', NEW.created_at
    ));
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'scheduled' AND NEW.status = 'executed' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'unlink_completed',
      'senderId', NEW.requester_id,
      'recipientId', NEW.partner_id,
      'relatedId', NEW.id,
      'createdAt', COALESCE(NEW.resolved_at, now())
    ));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'scheduled unlink push dispatch failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_push_on_scheduled_unlink() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_scheduled_unlink_push ON public.scheduled_unlinks;
CREATE TRIGGER on_scheduled_unlink_push
  AFTER INSERT OR UPDATE ON public.scheduled_unlinks
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_scheduled_unlink();
