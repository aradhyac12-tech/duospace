-- SECURITY FIX (P1 — Phase 4 adversarial audit, "call_history server
-- authority"): "Users can update own calls" (originally
-- 20260308232149_bbdd18ba-...sql, still current — FOR UPDATE TO
-- authenticated USING (auth.uid() = caller_id OR auth.uid() = receiver_id),
-- no WITH CHECK) lets either party to a call UPDATE **any column, to any
-- value, from any current state**, with zero state-machine awareness.
-- claim_call/decline_call/cancel_call (20260808150000_call_hardening.sql)
-- are all correctly atomic CAS-guarded SECURITY DEFINER RPCs — but they
-- don't replace this blanket policy, they sit alongside it. Every
-- legitimate "end my own call" write in the app (Calls.tsx, Chat.tsx,
-- CallContext.tsx, MinimizedCallBubble.tsx, usePushNotifications.ts) is a
-- plain client-side `.update(...).eq("status","in_progress")` — an honest
-- client's own WHERE-clause discipline, not something RLS enforces. Per
-- this audit's own threat model (the client is never trusted, an attacker
-- can call Supabase REST directly with an arbitrary payload and no
-- WHERE-clause guard at all), this policy alone currently allows:
--   - forcing status to 'completed' on a call that was actually declined/
--     missed/still in_progress (fabricating call history)
--   - reopening/re-ending an already-terminal call (double-end, end after
--     already ended, decline after connected — all named explicitly in
--     the audit brief)
--   - fabricating duration_seconds to any value (the app itself sends its
--     own client-tracked counter as this column's value on every legitimate
--     end-call write — completely unverified against reality)
--   - fabricating ended_at to any timestamp
--
-- FIX: a BEFORE UPDATE trigger — RLS policies can only compare the
-- proposed new row against a fixed predicate (WITH CHECK) or filter which
-- existing rows are targetable (USING); neither can express "this
-- transition is legal from that specific prior state," which needs OLD
-- and NEW together, i.e. a real trigger. This one:
--   1. Freezes caller_id/receiver_id/started_at/room_name/call_type against
--      any UPDATE payload — these can never legitimately change after
--      insert, by anyone, through any path including the RPCs above (none
--      of them touch these columns either).
--   2. Only permits 'in_progress' -> {'in_progress' (claim_call's own
--      claimed_by/claimed_at/claimed_device_id write), 'completed',
--      'cancelled', 'failed', 'missed'} and the one narrow
--      'missed' -> 'seen' transition (DockBadgesContext.tsx's badge-ack on
--      viewing the Calls tab — the one legitimate non-terminal-from-
--      in_progress transition in the app). Everything else — including
--      any further change once a row is 'completed'/'cancelled'/'failed'/
--      'seen' — raises an exception, which supabase-js surfaces as a
--      normal `{ error }` result (it does not throw), so every existing
--      call site's already-unchecked `.then()`/no-op error handling
--      degrades to exactly what it already does today for a 0-row/denied
--      update: nothing visibly breaks, the row just doesn't change.
--   3. Whenever a call actually leaves 'in_progress' for a terminal state,
--      ended_at and duration_seconds are computed HERE, from now() and the
--      row's own (frozen) started_at — never taken from the UPDATE
--      payload, regardless of what the client sent. This is the direct
--      fix for "arbitrary duration manipulation" / "arbitrary timestamps."
--
-- This intentionally does NOT touch claimed_by/claimed_at/
-- claimed_device_id/declined_at/cancel_reason/cancelled_at — those already
-- have real CAS protection (claim_call/decline_call/cancel_call's own
-- WHERE clauses, running as SECURITY DEFINER so their elevated-privilege
-- writes still pass through this same trigger unmodified for those
-- columns) or are low-stakes descriptive fields (cancel_reason), not
-- authoritative state.
--
-- Verified against every current call_history UPDATE call site (grep
-- across src/ and supabase/): claim_call, decline_call, cancel_call, the
-- expire-stale-calls sweep, DockBadgesContext.tsx's 'missed'->'seen'
-- badge-ack, and every app-level end-call site in Calls.tsx/Chat.tsx/
-- CallContext.tsx/MinimizedCallBubble.tsx/usePushNotifications.ts — all
-- perform only transitions this trigger allows; none are broken by it.

CREATE OR REPLACE FUNCTION public.enforce_call_history_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Identity/timing columns are immutable after insert, full stop — no
  -- UPDATE payload, from any caller, may change who a call was between or
  -- when/where it started.
  NEW.caller_id := OLD.caller_id;
  NEW.receiver_id := OLD.receiver_id;
  NEW.started_at := OLD.started_at;
  NEW.room_name := OLD.room_name;
  NEW.call_type := OLD.call_type;
  NEW.call_direction := OLD.call_direction;

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
    -- Leaving in_progress for a terminal state — timing is authoritative
    -- server state from here on, never the client's payload.
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

DROP TRIGGER IF EXISTS on_call_history_update_enforce_transition ON public.call_history;
CREATE TRIGGER on_call_history_update_enforce_transition
  BEFORE UPDATE ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_call_history_transition();
