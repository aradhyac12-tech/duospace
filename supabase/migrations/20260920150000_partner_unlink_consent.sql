-- ============================================================================
-- Partner unlink now needs the OTHER partner's approval.
--
-- Before this migration, unlink_partner(uuid) was executable by every
-- signed-in user and cleared BOTH sides of the pairing in one call — so one
-- person could end the relationship on the other's device without them ever
-- being asked (and the other person's app only found out on its next fetch).
-- Worse, "Users can update own profile" has no column restriction, so a client
-- could also just `UPDATE profiles SET partner_id = NULL` on its own row and
-- skip any RPC entirely. A consent step that only exists in the UI would be
-- cosmetic, so this migration enforces it in the database:
--
--   1. public.unlink_requests — one row per "I want to unlink" ask. Clients
--      can only READ it (RLS: requester or receiver). Every write goes
--      through the three RPCs below, so there is no way to forge an approval.
--   2. request_unlink()           — caller asks to unlink from their partner.
--      Idempotent (one open request per requester). If the partner had
--      ALREADY asked to unlink from the caller, both sides want out, so it
--      completes immediately instead of deadlocking on two pending requests.
--      If the pairing is already one-sided (only one profile still points at
--      the other) there is nobody to consent, so the caller's dangling link
--      is simply cleared.
--   3. respond_unlink(id, approve) — only the RECEIVER can answer. Approve
--      clears both profiles' partner_id atomically; decline leaves the link
--      alone. Refuses stale/expired/already-answered requests and requests
--      whose pairing no longer exists.
--   4. cancel_unlink(id)          — the requester withdraws a pending ask.
--   5. unlink_partner(uuid) is revoked from authenticated (it stays callable
--      by service_role/postgres), and a BEFORE UPDATE trigger on
--      profiles.partner_id rejects direct writes from the `authenticated`/
--      `anon` roles. Every legitimate writer (accept_invite,
--      accept_partner_request, link_partners, the RPCs here) is a SECURITY
--      DEFINER function, so it runs as the function owner and is unaffected;
--      edge functions use service_role, also unaffected. No client code
--      writes partner_id directly (checked: grep of src/ for partner_id
--      writes).
--   6. Push notifications: a request notifies the partner
--      ('unlink_request'); the answer notifies the requester
--      ('unlink_approved' / 'unlink_declined'). Uses the existing
--      private.dispatch_push plumbing and never blocks the write.
--   7. Requests expire after 7 days (expires_at) so a forgotten ask doesn't
--      sit in someone's inbox forever; asking again creates a fresh one.
--
-- DEPLOY ORDER: apply this migration, deploy the updated send-push edge
-- function (it must know the three new notification types or the pushes are
-- rejected with a 400), then ship the app build. An OLD app build talking to
-- this migrated database can no longer unlink at all (its direct
-- unlink_partner call is now denied) — it fails with a normal error toast
-- rather than half-working. Idempotent: safe to run twice.
--
-- NOT LIVE-TESTED — no database was available when this was written. See
-- docs/PARTNER_UNLINK_CONSENT.md for the manual test matrix to run against a
-- real project before relying on it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unlink_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  responded_at timestamptz,
  CONSTRAINT unlink_requests_distinct_people CHECK (requester_id <> partner_id)
);

-- At most one open request per requester.
CREATE UNIQUE INDEX IF NOT EXISTS unlink_requests_one_pending_per_requester
  ON public.unlink_requests (requester_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS unlink_requests_partner_pending
  ON public.unlink_requests (partner_id) WHERE status = 'pending';

ALTER TABLE public.unlink_requests ENABLE ROW LEVEL SECURITY;
-- Read-only for clients. No INSERT/UPDATE/DELETE grant and no such policy:
-- the RPCs below (SECURITY DEFINER) are the only writers.
REVOKE ALL ON public.unlink_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.unlink_requests TO authenticated;
GRANT ALL ON public.unlink_requests TO service_role;

DROP POLICY IF EXISTS "View own unlink requests" ON public.unlink_requests;
CREATE POLICY "View own unlink requests" ON public.unlink_requests
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR partner_id = auth.uid());

-- Both people need live updates: the receiver to see the ask appear, the
-- requester to see it answered.
ALTER TABLE public.unlink_requests REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.unlink_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Internal helper: actually end a pairing. Not callable by clients.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.apply_unlink(_a uuid, _b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Stable lock order so two simultaneous unlink/link operations can't
  -- deadlock or interleave (same approach as link_partners).
  PERFORM 1 FROM public.profiles WHERE user_id IN (_a, _b) ORDER BY user_id FOR UPDATE;
  -- Only clear a side that still points at the other person, so this can
  -- never wipe a NEW pairing formed since the request was made.
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _a AND partner_id = _b;
  UPDATE public.profiles SET partner_id = NULL WHERE user_id = _b AND partner_id = _a;
END;
$$;
REVOKE ALL ON FUNCTION private.apply_unlink(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. request_unlink()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_unlink()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_partner  uuid;
  v_partners_partner uuid;
  v_open     public.unlink_requests%ROWTYPE;
  v_crossed  public.unlink_requests%ROWTYPE;
  v_new_id   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;

  -- Serialise against anything else touching this pairing, then re-read.
  PERFORM 1 FROM public.profiles WHERE user_id IN (v_uid, v_partner) ORDER BY user_id FOR UPDATE;
  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;
  SELECT partner_id INTO v_partners_partner FROM public.profiles WHERE user_id = v_partner;

  -- One-sided pairing (the other profile no longer points back at us, or is
  -- gone): there is no one whose consent matters. Clear our dangling link.
  IF v_partners_partner IS DISTINCT FROM v_uid THEN
    UPDATE public.profiles SET partner_id = NULL WHERE user_id = v_uid AND partner_id = v_partner;
    UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
      WHERE status = 'pending' AND requester_id = v_uid;
    RETURN jsonb_build_object('status', 'approved', 'reason', 'ONE_SIDED');
  END IF;

  -- Retire this caller's stale asks so the one-open-request index can't
  -- block a fresh one.
  UPDATE public.unlink_requests SET status = 'expired', responded_at = now()
    WHERE status = 'pending' AND expires_at <= now()
      AND (requester_id = v_uid OR requester_id = v_partner);

  -- Partner already asked to unlink from us -> both want out. Finish now.
  SELECT * INTO v_crossed FROM public.unlink_requests
    WHERE requester_id = v_partner AND partner_id = v_uid AND status = 'pending'
    FOR UPDATE;
  IF FOUND THEN
    PERFORM private.apply_unlink(v_uid, v_partner);
    UPDATE public.unlink_requests SET status = 'approved', responded_at = now() WHERE id = v_crossed.id;
    UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
      WHERE status = 'pending' AND requester_id = v_uid;
    RETURN jsonb_build_object('status', 'approved', 'reason', 'BOTH_REQUESTED');
  END IF;

  -- Already asked -> idempotent.
  SELECT * INTO v_open FROM public.unlink_requests
    WHERE requester_id = v_uid AND partner_id = v_partner AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'pending', 'request_id', v_open.id, 'expires_at', v_open.expires_at);
  END IF;

  -- A pending row aimed at someone else (old partner) can't apply anymore.
  UPDATE public.unlink_requests SET status = 'cancelled', responded_at = now()
    WHERE status = 'pending' AND requester_id = v_uid;

  INSERT INTO public.unlink_requests (requester_id, partner_id)
    VALUES (v_uid, v_partner)
    RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'status', 'pending',
    'request_id', v_new_id,
    'expires_at', (SELECT expires_at FROM public.unlink_requests WHERE id = v_new_id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.request_unlink() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_unlink() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. respond_unlink(request, approve)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_unlink(p_request_id uuid, p_approve boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.unlink_requests%ROWTYPE;
  v_still_linked boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;
  IF p_request_id IS NULL OR p_approve IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ARGUMENT');
  END IF;

  -- Only the RECEIVER may answer. A requester (or anyone else) gets the same
  -- NOT_FOUND as a made-up id, so ids can't be probed.
  SELECT * INTO v_req FROM public.unlink_requests
    WHERE id = p_request_id AND partner_id = v_uid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'ALREADY_HANDLED', 'status', v_req.status);
  END IF;

  IF v_req.expires_at <= now() THEN
    UPDATE public.unlink_requests SET status = 'expired', responded_at = now() WHERE id = v_req.id;
    RETURN jsonb_build_object('error', 'EXPIRED');
  END IF;

  PERFORM 1 FROM public.profiles WHERE user_id IN (v_uid, v_req.requester_id) ORDER BY user_id FOR UPDATE;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id = v_uid AND partner_id = v_req.requester_id
  ) INTO v_still_linked;

  IF NOT v_still_linked THEN
    -- The pairing this request was about is already gone; nothing to approve.
    UPDATE public.unlink_requests SET status = 'expired', responded_at = now() WHERE id = v_req.id;
    RETURN jsonb_build_object('error', 'NOT_LINKED');
  END IF;

  IF p_approve THEN
    PERFORM private.apply_unlink(v_uid, v_req.requester_id);
    UPDATE public.unlink_requests SET status = 'approved', responded_at = now() WHERE id = v_req.id;
    RETURN jsonb_build_object('status', 'approved');
  END IF;

  UPDATE public.unlink_requests SET status = 'declined', responded_at = now() WHERE id = v_req.id;
  RETURN jsonb_build_object('status', 'declined');
END;
$$;
REVOKE ALL ON FUNCTION public.respond_unlink(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_unlink(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. cancel_unlink(request)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_unlink(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  UPDATE public.unlink_requests
     SET status = 'cancelled', responded_at = now()
   WHERE id = p_request_id AND requester_id = v_uid AND status = 'pending'
   RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    -- Either not theirs, or it was answered a moment ago. Report the current
    -- state (if it's theirs) so the UI can show what actually happened.
    SELECT status INTO v_status FROM public.unlink_requests
      WHERE id = p_request_id AND requester_id = v_uid;
    IF v_status IS NULL THEN
      RETURN jsonb_build_object('error', 'NOT_FOUND');
    END IF;
    RETURN jsonb_build_object('error', 'ALREADY_HANDLED', 'status', v_status);
  END IF;

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_unlink(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_unlink(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Close the two unilateral back doors
-- ---------------------------------------------------------------------------
-- (a) the old one-call unilateral RPC
REVOKE EXECUTE ON FUNCTION public.unlink_partner(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unlink_partner(uuid) TO service_role;

-- (b) direct writes to profiles.partner_id from a client session. Not
-- SECURITY DEFINER on purpose: current_user must be the role actually running
-- the statement — `authenticated`/`anon` for a PostgREST client, the function
-- owner inside our SECURITY DEFINER functions, `service_role` for edge
-- functions.
CREATE OR REPLACE FUNCTION public.guard_profiles_partner_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'partner_id can only be changed through the partner linking functions'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_partner_id ON public.profiles;
CREATE TRIGGER profiles_guard_partner_id
  BEFORE UPDATE OF partner_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_partner_id();

-- ---------------------------------------------------------------------------
-- 7. Push notifications (best-effort; never blocks the write)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push_on_unlink_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', 'unlink_request',
      'senderId', NEW.requester_id,
      'recipientId', NEW.partner_id,
      'relatedId', NEW.id,
      'createdAt', NEW.created_at
    ));
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('approved', 'declined') THEN
    PERFORM private.dispatch_push(jsonb_build_object(
      'internal', true,
      'type', CASE WHEN NEW.status = 'approved' THEN 'unlink_approved' ELSE 'unlink_declined' END,
      'senderId', NEW.partner_id,
      'recipientId', NEW.requester_id,
      'relatedId', NEW.id,
      'createdAt', COALESCE(NEW.responded_at, now())
    ));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A notification problem must never roll back the unlink decision.
  RAISE WARNING 'unlink push dispatch failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_unlink_request_push ON public.unlink_requests;
CREATE TRIGGER on_unlink_request_push
  AFTER INSERT OR UPDATE ON public.unlink_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_unlink_request();
