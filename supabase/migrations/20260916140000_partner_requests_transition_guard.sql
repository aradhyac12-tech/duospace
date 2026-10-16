-- SECURITY FIX — closes a gap flagged (but not yet shipped as a
-- migration) by a prior audit pass: "Update received requests" ON
-- public.partner_requests FOR UPDATE ... USING (receiver_id = auth.uid())
-- has no WITH CHECK, so a receiver can UPDATE any column — including
-- sender_id — on any row they're the receiver of, to any value.
--
-- Concrete exploit chain this closes:
--   1. Attacker self-inserts a partner_requests row: sender_id =
--      receiver_id = attacker (the INSERT policy's WITH CHECK only
--      requires auth.uid() = sender_id — nothing forbids
--      sender_id = receiver_id).
--   2. Attacker UPDATEs that row's sender_id to an arbitrary victim's
--      id (the missing WITH CHECK above lets any column change).
--   3. Attacker calls accept_partner_request(request_id, attacker_id) —
--      SECURITY DEFINER, only checks receiver_id = p_user_id AND
--      status = 'pending', which now matches — forcing a pairing with,
--      and silently unlinking any existing partner of, a victim who
--      never sent or consented to any request.
--
-- Two independent fixes, both required to actually close the chain:
--   A) a BEFORE UPDATE trigger (RLS WITH CHECK alone can't express
--      "this transition is legal from that specific prior state" the
--      way a trigger comparing OLD/NEW can — same reasoning as
--      call_history's own transition guard,
--      20260910200000_call_history_transition_guard.sql, which this
--      mirrors) — freezes sender_id/receiver_id/created_at and permits
--      only the one real transition (pending -> accepted, which is all
--      accept_partner_request's own UPDATE ever performs; rejection is
--      handled by DELETE elsewhere in the app, not an UPDATE — see
--      PartnerSettings.tsx, confirmed via grep, no client code updates
--      .status at all outside that one RPC).
--   B) accept_partner_request was ALSO missing the already-partnered
--      guard its sibling accept_invite has (accept_invite checks BOTH
--      parties' profiles.partner_id before linking; accept_partner_request
--      checked neither) — step 3 above still works even with the
--      self-request path closed if a receiver's own already-accepted
--      request could be replayed, so this is fixed independently, not
--      only as a side effect of (A).
--
-- Also blocks the row-level starting point of the chain: a
-- sender_id <> receiver_id check constraint, so step 1 (self-insert) is
-- rejected outright regardless of any policy/trigger reasoning above it.
--
-- NOT LIVE-TESTED — no DB access in this or the originating pass (see
-- docs/PHASE_4_SECURITY_AUDIT.md §15, which describes this exact fix as
-- already written; this migration is what actually ships it, since the
-- describing pass's own migration file was not included in what reached
-- this session). Verified by hand against every partner_requests call
-- site in src/ (Onboarding.tsx, PartnerSettings.tsx, Settings.tsx — all
-- confirmed via grep to only SELECT/INSERT/DELETE directly; the only
-- UPDATE path is inside accept_partner_request itself, which this
-- migration also fixes) and against accept_invite's already-correct
-- pattern.

DO $$ BEGIN
  ALTER TABLE public.partner_requests
    ADD CONSTRAINT partner_requests_sender_ne_receiver CHECK (sender_id <> receiver_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_partner_request_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Identity/timing columns are immutable after insert — no UPDATE
  -- payload, from any caller, may change who a request was between or
  -- when it was created.
  NEW.sender_id := OLD.sender_id;
  NEW.receiver_id := OLD.receiver_id;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();

  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    NULL; -- the one real transition: accept_partner_request's own UPDATE
  ELSIF OLD.status = NEW.status THEN
    NULL; -- no-op update (e.g. a future metadata-only column change) — allowed
  ELSE
    RAISE EXCEPTION 'partner_requests: illegal transition from % to %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_partner_requests_update_enforce_transition ON public.partner_requests;
CREATE TRIGGER on_partner_requests_update_enforce_transition
  BEFORE UPDATE ON public.partner_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_partner_request_transition();

-- (B) — add the already-partnered guard accept_invite already has.
-- Every other line of the function is unchanged from
-- 20260708090100_becb578d-...sql's version.
CREATE OR REPLACE FUNCTION public.accept_partner_request(p_request_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sender_id uuid; v_receiver_existing_partner uuid; v_sender_existing_partner uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT sender_id INTO v_sender_id FROM public.partner_requests WHERE id = p_request_id AND receiver_id = p_user_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already processed'; END IF;

  SELECT partner_id INTO v_receiver_existing_partner FROM public.profiles WHERE user_id = p_user_id;
  IF v_receiver_existing_partner IS NOT NULL THEN
    RAISE EXCEPTION 'You already have a linked partner. Unlink first to accept a new request.';
  END IF;
  SELECT partner_id INTO v_sender_existing_partner FROM public.profiles WHERE user_id = v_sender_id;
  IF v_sender_existing_partner IS NOT NULL THEN
    RAISE EXCEPTION 'The sender already has a linked partner.';
  END IF;

  UPDATE public.partner_requests SET status = 'accepted' WHERE id = p_request_id;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id IN (p_user_id, v_sender_id);
  UPDATE public.profiles SET partner_id = v_sender_id WHERE user_id = p_user_id;
  UPDATE public.profiles SET partner_id = p_user_id WHERE user_id = v_sender_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_partner_request(uuid, uuid) TO authenticated;
