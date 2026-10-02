-- ============================================================================
-- "Stop sharing": an IMMEDIATE, UNILATERAL way to stop sending my own data to
-- my partner while staying linked.
--
-- Before this migration there was no way to do that: live location and device
-- status were published unconditionally (LocationContext's `sharingActive`
-- was hard-wired to true) and the only exit was unlinking, which needs the
-- partner's consent (20260920150000_partner_unlink_consent.sql).
--
-- What "stop sharing" covers (everything the partner can SEE about me that I
-- produce myself):
--   1. live location          (public.locations)
--   2. device status          (profiles.battery_level / battery_charging /
--                              ringer_mode / device_status_updated_at)
--   3. relationship shares I own (public.relationship_shares) — revoked
-- What it deliberately does NOT touch:
--   * chat, calls, shared playlist/gallery, surprises — the relationship
--     itself continues; only the unlink flow ends that.
--   * presence (last_seen_at / tracking_state / app_visibility) — the push
--     pipeline reads these to decide whether to notify, so blanking them would
--     silently break notifications.
--
-- Design:
--   * public.sharing_state — one row per person who has stopped sharing. A row
--     EXISTS <=> sharing is stopped. Clients can only READ their own row; the
--     two RPCs below are the only writers. The partner can never read it.
--   * Enforcement lives in the DATABASE, not the UI, and also covers writers
--     that bypass RLS (the service-role `location-push-upload` edge function):
--       - BEFORE INSERT/UPDATE trigger on locations silently drops the write
--         (RETURN NULL) so offline queues and native one-shots don't retry
--         forever against an error;
--       - BEFORE UPDATE trigger on profiles blanks the device-status columns;
--       - BEFORE INSERT trigger on relationship_shares RAISES, because that is
--         a deliberate user action and deserves a real error.
--   * stop_sharing() also removes what is already out there: deletes my
--     locations row, blanks my device status, revokes my active shares — so
--     the partner stops seeing me at once, not "after the next update".
--   * No push is sent to the partner. The partner simply stops receiving
--     updates (their Map shows the existing stale/unavailable state).
--   * The setting is per person and survives an unlink: if you stopped sharing
--     and later link with someone new, you are still not sharing until you
--     resume. (Privacy-preserving default; resume_sharing() is one tap.)
--
-- Idempotent: safe to run twice. NOT LIVE-TESTED — see docs/STOP_SHARING_AND_SCHEDULED_UNLINK.md.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 1. State table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sharing_state (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stopped_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sharing_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sharing_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sharing_state TO authenticated;
GRANT ALL ON public.sharing_state TO service_role;

DROP POLICY IF EXISTS "View own sharing state" ON public.sharing_state;
CREATE POLICY "View own sharing state" ON public.sharing_state
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. Internal check used by the triggers. Not callable by clients.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.sharing_is_stopped(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.sharing_state WHERE user_id = _user_id)
$$;
REVOKE ALL ON FUNCTION private.sharing_is_stopped(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Database-level enforcement
-- ---------------------------------------------------------------------------
-- (a) locations: drop the write instead of erroring. For INSERT ... ON
-- CONFLICT DO UPDATE a NULL from the BEFORE INSERT trigger skips the row
-- entirely (no conflict action), so the upsert path is covered too.
CREATE OR REPLACE FUNCTION public.locations_block_when_sharing_stopped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF private.sharing_is_stopped(NEW.user_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.locations_block_when_sharing_stopped() FROM PUBLIC, anon, authenticated;

-- Named so it sorts BEFORE locations_monotonic_write_guard_trg (BEFORE
-- triggers fire alphabetically) — no point running the monotonic check for a
-- write that is about to be dropped.
DROP TRIGGER IF EXISTS locations_block_stopped_trg ON public.locations;
CREATE TRIGGER locations_block_stopped_trg
  BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_block_when_sharing_stopped();

-- (b) profiles device status: blank instead of reject, so one UPDATE that also
-- carries unrelated columns still succeeds.
CREATE OR REPLACE FUNCTION public.profiles_blank_device_status_when_stopped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF private.sharing_is_stopped(NEW.user_id) THEN
    NEW.battery_level := NULL;
    NEW.battery_charging := NULL;
    NEW.ringer_mode := NULL;
    NEW.device_status_updated_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.profiles_blank_device_status_when_stopped() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_device_status_stopped_trg ON public.profiles;
CREATE TRIGGER profiles_device_status_stopped_trg
  BEFORE UPDATE OF battery_level, battery_charging, ringer_mode, device_status_updated_at ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_blank_device_status_when_stopped();

-- (c) relationship_shares: a new share is a deliberate action, so say no loudly.
CREATE OR REPLACE FUNCTION public.relationship_shares_block_when_sharing_stopped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF private.sharing_is_stopped(NEW.owner_id) THEN
    RAISE EXCEPTION 'SHARING_STOPPED: resume sharing before sharing new items'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.relationship_shares_block_when_sharing_stopped() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS relationship_shares_block_stopped_trg ON public.relationship_shares;
CREATE TRIGGER relationship_shares_block_stopped_trg
  BEFORE INSERT ON public.relationship_shares
  FOR EACH ROW EXECUTE FUNCTION public.relationship_shares_block_when_sharing_stopped();

-- ---------------------------------------------------------------------------
-- 4. stop_sharing() — immediate, unilateral, idempotent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stop_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_stopped timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  -- Flip the switch FIRST so no concurrent write can land after the cleanup.
  INSERT INTO public.sharing_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT stopped_at INTO v_stopped FROM public.sharing_state WHERE user_id = v_uid;

  -- Remove what is already visible.
  DELETE FROM public.locations WHERE user_id = v_uid;

  UPDATE public.profiles
     SET battery_level = NULL,
         battery_charging = NULL,
         ringer_mode = NULL,
         device_status_updated_at = NULL
   WHERE user_id = v_uid;

  -- Only shares I own: shares my partner made to me are theirs to revoke.
  -- (The immutability trigger stamps revoked_at with server time.)
  UPDATE public.relationship_shares
     SET revoked_at = now()
   WHERE owner_id = v_uid AND revoked_at IS NULL;

  RETURN jsonb_build_object('status', 'stopped', 'stopped_at', v_stopped);
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_sharing() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. resume_sharing() — also unilateral: it is my own data. Revoked shares
-- stay revoked (a revoke is permanent by design); new ones need a new action.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resume_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;
  DELETE FROM public.sharing_state WHERE user_id = v_uid;
  RETURN jsonb_build_object('status', 'sharing');
END;
$$;
REVOKE ALL ON FUNCTION public.resume_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resume_sharing() TO authenticated;
