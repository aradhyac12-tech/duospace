-- "Heading home" (safe arrival). Builds on the two earlier home migrations
-- (20261018120000 / 20261018130000) — apply those first.
--
-- The user taps "I'm heading home". The partner then:
--   * gets a push "<name> is heading home" (tap opens the Map),
--   * sees distance + a rough ETA on the Map (never coordinates),
--   * gets ONE push if no progress toward home for 10 minutes ("stopped moving"),
--   * gets the usual "reached home" push on arrival — even if the user left the
--     general "notify when I get home" switch off, because starting a trip is an
--     explicit request to be followed.
-- Trips expire after 3 hours. Everything runs in the database off `locations`
-- writes, so it works with the app closed.
--
-- LIMITS (by design, see HANDOFF_MAP_HOME.md): stall detection needs the phone to
-- keep uploading fixes (the app sends a keep-alive every ~45 s); a phone that goes
-- completely silent is NOT flagged because there is no scheduler in this setup.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.home_trips (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'arrived', 'cancelled', 'expired')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '3 hours',
  start_distance_m  double precision,
  best_distance_m   double precision,
  last_distance_m   double precision,
  last_progress_at  timestamptz NOT NULL DEFAULT now(),
  last_update_at    timestamptz,
  stalled_notified_at timestamptz
);
-- One active trip per user.
CREATE UNIQUE INDEX IF NOT EXISTS home_trips_one_active_per_user ON public.home_trips (user_id) WHERE status = 'active';

ALTER TABLE public.home_trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.home_trips TO authenticated;
GRANT ALL ON public.home_trips TO service_role;
DROP POLICY IF EXISTS "home_trips owner select" ON public.home_trips;
DROP POLICY IF EXISTS "home_trips owner insert" ON public.home_trips;
DROP POLICY IF EXISTS "home_trips owner update" ON public.home_trips;
CREATE POLICY "home_trips owner select" ON public.home_trips FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "home_trips owner insert" ON public.home_trips FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "home_trips owner update" ON public.home_trips FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Insert guard: needs a Home, a current fix, and being outside the circle.
--    Server fills every server-owned column; clients cannot forge them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_trips_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.home_places%ROWTYPE;
  l record;
  d double precision;
BEGIN
  SELECT * INTO h FROM public.home_places WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Set your Home first'; END IF;

  SELECT latitude, longitude, captured_at INTO l FROM public.locations WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Waiting for your location'; END IF;
  IF l.captured_at IS NOT NULL AND l.captured_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Your location is out of date — open the Map and try again';
  END IF;

  d := private.haversine_m(l.latitude, l.longitude, h.latitude, h.longitude);
  IF h.is_inside OR d <= h.radius_m THEN RAISE EXCEPTION 'You are already home'; END IF;

  -- A stale active trip must not block starting a new one.
  UPDATE public.home_trips SET status = 'expired', ended_at = now()
   WHERE user_id = NEW.user_id AND status = 'active' AND expires_at < now();

  NEW.status := 'active';
  NEW.started_at := now();
  NEW.ended_at := NULL;
  NEW.expires_at := now() + interval '3 hours';
  NEW.start_distance_m := d;
  NEW.best_distance_m := d;
  NEW.last_distance_m := d;
  NEW.last_progress_at := now();
  NEW.last_update_at := now();
  NEW.stalled_notified_at := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_trips_before_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS home_trips_before_insert_trg ON public.home_trips;
CREATE TRIGGER home_trips_before_insert_trg BEFORE INSERT ON public.home_trips
  FOR EACH ROW EXECUTE FUNCTION public.home_trips_before_insert();

-- Clients may only cancel their own active trip; everything else is server-owned.
-- (SECURITY INVOKER so current_user distinguishes a client from the location trigger.)
CREATE OR REPLACE FUNCTION public.home_trips_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
      NEW := OLD;
      NEW.status := 'cancelled';
      NEW.ended_at := now();
    ELSE
      NEW := OLD;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_trips_before_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS home_trips_before_update_trg ON public.home_trips;
CREATE TRIGGER home_trips_before_update_trg BEFORE UPDATE ON public.home_trips
  FOR EACH ROW EXECUTE FUNCTION public.home_trips_before_update();

-- "<name> is heading home" push on start.
CREATE OR REPLACE FUNCTION public.home_trips_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.home_places%ROWTYPE;
  partner uuid;
  nm text;
BEGIN
  SELECT * INTO h FROM public.home_places WHERE user_id = NEW.user_id;
  IF NOT FOUND OR NOT h.notify_partner THEN RETURN NEW; END IF;
  partner := public.get_partner_id(NEW.user_id);
  IF partner IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
    INTO nm FROM public.profiles WHERE user_id = NEW.user_id;
  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true, 'type', 'custom', 'recipientId', partner,
    'title', coalesce(nm, 'Your partner') || ' is heading home',
    'body', 'Tap to follow along on the map.',
    'data', jsonb_build_object('route', '/map'),
    'createdAt', now()
  ));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'home trip start push failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_trips_after_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS home_trips_after_insert_trg ON public.home_trips;
CREATE TRIGGER home_trips_after_insert_trg AFTER INSERT ON public.home_trips
  FOR EACH ROW EXECUTE FUNCTION public.home_trips_after_insert();

-- ---------------------------------------------------------------------------
-- 3. Location trigger: arrival / leave (unchanged rules) + trip progress.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_places_on_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h        public.home_places%ROWTYPE;
  t        public.home_trips%ROWTYPE;
  d        double precision;
  acc      real;
  partner  uuid;
  nm       text;
  place    text;
  same_fix boolean := false;
  trip_arrived boolean := false;
  trip_id  uuid;
BEGIN
  SELECT * INTO h FROM public.home_places WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.captured_at IS NOT NULL AND NEW.captured_at < now() - interval '10 minutes' THEN
    RETURN NEW;
  END IF;
  -- Identical coordinates (keep-alive write): skip arrival/leave, but still let
  -- the trip logic see it, otherwise a stalled phone would never be noticed.
  IF TG_OP = 'UPDATE' AND NEW.latitude = OLD.latitude AND NEW.longitude = OLD.longitude THEN
    same_fix := true;
  END IF;

  d   := private.haversine_m(NEW.latitude, NEW.longitude, h.latitude, h.longitude);
  acc := NEW.accuracy_m;
  place := CASE WHEN lower(h.label) = 'home' THEN 'home' ELSE h.label END;

  IF NOT same_fix THEN
    IF NOT h.is_inside THEN
      -- ── Arrival ──────────────────────────────────────────────────────────
      IF d <= h.radius_m AND (acc IS NULL OR acc <= greatest(h.radius_m, 100)) THEN
        UPDATE public.home_places SET is_inside = true, last_arrived_at = now() WHERE id = h.id;

        UPDATE public.home_trips
           SET status = 'arrived', ended_at = now(), last_distance_m = d, last_update_at = now()
         WHERE user_id = NEW.user_id AND status = 'active'
        RETURNING id INTO trip_id;
        trip_arrived := trip_id IS NOT NULL;

        IF (h.notify_partner AND (h.last_notified_at IS NULL OR h.last_notified_at < now() - interval '20 minutes'))
           OR trip_arrived THEN
          partner := public.get_partner_id(NEW.user_id);
          IF partner IS NOT NULL THEN
            SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
              INTO nm FROM public.profiles WHERE user_id = NEW.user_id;
            PERFORM private.dispatch_push(jsonb_build_object(
              'internal', true, 'type', 'custom', 'recipientId', partner,
              'title', coalesce(nm, 'Your partner') || ' reached ' || place,
              'body', 'They just arrived safely.',
              'data', jsonb_build_object('route', '/map'),
              'createdAt', now()
            ));
            UPDATE public.home_places SET last_notified_at = now() WHERE id = h.id;
          END IF;
        END IF;
      END IF;
    ELSE
      -- ── Leaving (hysteresis) ─────────────────────────────────────────────
      IF d > h.radius_m * 1.25 + 30 AND (acc IS NULL OR acc <= 200) THEN
        UPDATE public.home_places SET is_inside = false, last_left_at = now() WHERE id = h.id;

        IF h.notify_partner AND h.notify_leave
           AND (h.last_left_notified_at IS NULL OR h.last_left_notified_at < now() - interval '20 minutes') THEN
          partner := public.get_partner_id(NEW.user_id);
          IF partner IS NOT NULL THEN
            SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
              INTO nm FROM public.profiles WHERE user_id = NEW.user_id;
            PERFORM private.dispatch_push(jsonb_build_object(
              'internal', true, 'type', 'custom', 'recipientId', partner,
              'title', coalesce(nm, 'Your partner') || ' left ' || place,
              'body', 'They just stepped out.',
              'data', jsonb_build_object('route', '/map'),
              'createdAt', now()
            ));
            UPDATE public.home_places SET last_left_notified_at = now() WHERE id = h.id;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── Active trip: expire, track progress, flag a stall ───────────────────
  IF NOT trip_arrived THEN
    SELECT * INTO t FROM public.home_trips WHERE user_id = NEW.user_id AND status = 'active';
    IF FOUND THEN
      IF t.expires_at < now() THEN
        UPDATE public.home_trips SET status = 'expired', ended_at = now() WHERE id = t.id;
      ELSE
        IF d < t.best_distance_m - 30 THEN
          -- Real progress: remember it and re-arm the stall alert.
          UPDATE public.home_trips
             SET best_distance_m = d, last_distance_m = d, last_progress_at = now(),
                 last_update_at = now(), stalled_notified_at = NULL
           WHERE id = t.id;
        ELSE
          UPDATE public.home_trips SET last_distance_m = d, last_update_at = now() WHERE id = t.id;
          IF t.stalled_notified_at IS NULL
             AND t.last_progress_at < now() - interval '10 minutes'
             AND d > h.radius_m * 2 THEN
            partner := public.get_partner_id(NEW.user_id);
            IF partner IS NOT NULL AND h.notify_partner THEN
              SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
                INTO nm FROM public.profiles WHERE user_id = NEW.user_id;
              PERFORM private.dispatch_push(jsonb_build_object(
                'internal', true, 'type', 'custom', 'recipientId', partner,
                'title', coalesce(nm, 'Your partner') || ' hasn''t moved in 10 minutes',
                'body', 'They''re heading home but have stopped. Maybe check in?',
                'data', jsonb_build_object('route', '/map'),
                'createdAt', now()
              ));
            END IF;
            UPDATE public.home_trips SET stalled_notified_at = now() WHERE id = t.id;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'home arrival check failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_places_on_location() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Partner-facing trip status (distance + rough ETA, never coordinates)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_partner_trip()
RETURNS TABLE (started_at timestamptz, distance_m integer, eta_min integer, stalled boolean, last_update_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.started_at,
         round(t.last_distance_m)::integer,
         -- ETA only once there is a meaningful pace: >= 2 min elapsed and > 50 m gained.
         CASE
           WHEN extract(epoch FROM (now() - t.started_at)) >= 120
                AND (t.start_distance_m - t.last_distance_m) > 50
           THEN least(240, greatest(1, ceil(
                  t.last_distance_m
                  / ((t.start_distance_m - t.last_distance_m) / extract(epoch FROM (now() - t.started_at)))
                  / 60.0)))::integer
         END,
         (t.last_progress_at < now() - interval '10 minutes'),
         t.last_update_at
    FROM public.home_trips t
    JOIN public.home_places h ON h.user_id = t.user_id
   WHERE t.user_id = public.get_partner_id(auth.uid())
     AND t.status = 'active'
     AND t.expires_at > now()
     AND h.notify_partner
     AND NOT private.sharing_is_stopped(t.user_id)
$$;
REVOKE ALL ON FUNCTION public.get_partner_trip() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_trip() TO authenticated, service_role;
