-- Declined-vs-no-answer distinction for outgoing calls (WhatsApp-style
-- truthful call feedback).
--
-- WHY: decline_call() and server-side ring expiry both land as
-- call_history.status = 'missed', so the caller's UI could only ever say
-- "didn't answer" — even when the receiver explicitly declined. That's a
-- small but real honesty gap in the ring flow. This migration adds an
-- optional marker column and updates decline_call() to set it, so the
-- caller can distinguish:
--   declined_at IS NULL     -> "didn't answer"  (ring lapsed / unreachable)
--   declined_at IS NOT NULL -> "declined"        (receiver tapped decline)
--
-- BACKWARD COMPATIBILITY: clients treat declined_at as optional — rows
-- written before this migration is applied to the live project simply
-- show the old "didn't answer" message. No existing query breaks.
--
-- NOTE: like 20260824100000_gallery_albums.sql, this must be applied to
-- the live project (Supabase MCP / dashboard SQL editor) — the migrations
-- folder is source-of-truth mirror, not an auto-deployed pipeline.

ALTER TABLE public.call_history ADD COLUMN IF NOT EXISTS declined_at timestamptz;

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
  SET status = 'missed', ended_at = now(), declined_at = now()
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
-- Honest pre-call busy check (caller side).
--
-- call_history's SELECT policy only exposes rows where the *viewer* is a
-- participant, so the client cannot see the partner's active calls to ask
-- "are they busy right now?" before ringing them. This SECURITY DEFINER
-- helper deliberately leaks exactly one bit — whether the partner is a
-- participant of any in_progress call started in the last two hours —
-- and nothing else (no row contents, no other-party identity). The stale-
-- row window is bounded by the same ring-expiry machinery that already
-- closes out abandoned 'in_progress' rows.
CREATE OR REPLACE FUNCTION public.is_partner_on_call(p_partner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.call_history c
    WHERE c.status = 'in_progress'
      AND c.started_at > now() - interval '2 hours'
      AND (c.caller_id = p_partner_id OR c.receiver_id = p_partner_id)
  );
$$;
REVOKE ALL ON FUNCTION public.is_partner_on_call(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_partner_on_call(uuid) TO authenticated;
