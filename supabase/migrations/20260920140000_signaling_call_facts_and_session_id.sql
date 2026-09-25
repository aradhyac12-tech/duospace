-- ============================================================================
-- Calling Phase 4 (authoritative WebSocket signaling) — database support.
--
--   1. call_history.session_id — a DB-generated, frozen-at-insert identifier
--      for one logical call attempt. The signaling gateway checks every
--      call-control message's sessionId against THIS value, so a late/forged
--      message from an old attempt (or a client-invented session) can never
--      affect a different call. It is readable by both participants through
--      the existing "Users can view own calls" policy and travels in the
--      Realtime INSERT payload / cold-start poll, so a recipient that learns
--      of a call through push or recovery (not the WebSocket offer) still
--      has the authoritative value.
--
--   2. enforce_call_history_transition() — CREATE OR REPLACE with one added
--      line freezing session_id like every other identity column. Every
--      other clause is byte-for-byte the definition from
--      20260916130000_call_history_provider_column.sql.
--
--   3. signaling_get_call_facts(uuid) — the ONE thing the signaling gateway
--      is allowed to ask Supabase. SECURITY DEFINER, executable by
--      service_role ONLY (revoked from PUBLIC/anon/authenticated), returns
--      just the columns needed to authorize a routing decision plus a
--      current mutual-partnership check computed from the existing
--      profiles.partner_id model (no parallel relationship system). The
--      gateway never trusts a client's claims about who is in a call; this
--      is where it learns the truth.
--
-- Additive only: nothing is dropped, no policy is loosened, no existing
-- caller of any function changes behavior.
--
-- NOT RUN against a live database from the environment this was written in
-- (no DB access). Review + apply via the normal migration path; the
-- signaling gateway and self-hosted calling cannot work until it is applied.
-- ============================================================================

-- 1. session_id ---------------------------------------------------------------
ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS session_id uuid NOT NULL DEFAULT gen_random_uuid();

-- 2. freeze session_id in the transition guard --------------------------------
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
  NEW.session_id := OLD.session_id;

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

-- 3. signaling_get_call_facts -------------------------------------------------
CREATE OR REPLACE FUNCTION public.signaling_get_call_facts(_call_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'found', true,
        'id', c.id,
        'caller_id', c.caller_id,
        'receiver_id', c.receiver_id,
        'provider', c.provider,
        'status', c.status,
        'claimed_by', c.claimed_by,
        'session_id', c.session_id,
        'expires_at', c.expires_at,
        'call_type', c.call_type,
        'declined', c.declined_at IS NOT NULL,
        -- Mutual, CURRENT partnership — the same profiles.partner_id model
        -- get_partner_id() / the call_history INSERT policy already use.
        'are_partners', EXISTS (
          SELECT 1
          FROM public.profiles a
          JOIN public.profiles b ON b.user_id = c.receiver_id
          WHERE a.user_id = c.caller_id
            AND a.partner_id = c.receiver_id
            AND b.partner_id = c.caller_id
        )
      )
      FROM public.call_history c
      WHERE c.id = _call_id
    ),
    jsonb_build_object('found', false)
  );
$$;

REVOKE ALL ON FUNCTION public.signaling_get_call_facts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.signaling_get_call_facts(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.signaling_get_call_facts(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.signaling_get_call_facts(uuid) TO service_role;
