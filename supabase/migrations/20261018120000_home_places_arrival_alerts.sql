-- Home place + "reached home" alerts.
--
-- Each user can save ONE home (label, address, pin, radius). When their live
-- location enters that radius the database itself notices (a trigger on
-- `locations`, so it works for foreground fixes AND background/push uploads)
-- and pushes "<name> reached home" to the linked partner.
--
-- Privacy: the partner NEVER reads this table or the home coordinates. They get
-- only a coarse status (label, inside/outside, when) through
-- get_partner_home_status(), and only while the owner has notify_partner on and
-- has not stopped sharing.
--
-- Additive and idempotent. No existing table/column is changed.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.home_places (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  label            text NOT NULL DEFAULT 'Home' CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
  address          text CHECK (address IS NULL OR char_length(address) <= 300),
  latitude         double precision NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude        double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m         integer NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 50 AND 2000),
  notify_partner   boolean NOT NULL DEFAULT true,
  -- Server-maintained state (clients cannot change these, see the guard trigger).
  is_inside        boolean NOT NULL DEFAULT false,
  last_arrived_at  timestamptz,
  last_left_at     timestamptz,
  last_notified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.home_places ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.home_places TO authenticated;
GRANT ALL ON public.home_places TO service_role;

DROP POLICY IF EXISTS "home_places owner select" ON public.home_places;
DROP POLICY IF EXISTS "home_places owner insert" ON public.home_places;
DROP POLICY IF EXISTS "home_places owner update" ON public.home_places;
DROP POLICY IF EXISTS "home_places owner delete" ON public.home_places;
CREATE POLICY "home_places owner select" ON public.home_places FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "home_places owner insert" ON public.home_places FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "home_places owner update" ON public.home_places FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "home_places owner delete" ON public.home_places FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Distance helper (metres, great-circle)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.haversine_m(lat1 double precision, lon1 double precision,
                                               lat2 double precision, lon2 double precision)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )))
$$;

-- ---------------------------------------------------------------------------
-- 3. Guard: clients may not forge server state, and moving/resizing the home
--    re-baselines is_inside from the current fix WITHOUT sending an alert
--    (saving a home while standing in it must not buzz the partner).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_places_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
-- SECURITY INVOKER on purpose: current_user tells a client write ('authenticated')
-- apart from the server-side arrival trigger below (a SECURITY DEFINER function,
-- where current_user is the function owner).
DECLARE
  l record;
  rebaseline boolean := false;
BEGIN
  NEW.updated_at := now();
  NEW.label := btrim(NEW.label);

  IF TG_OP = 'INSERT' THEN
    NEW.last_arrived_at  := NULL;
    NEW.last_left_at     := NULL;
    NEW.last_notified_at := NULL;
    rebaseline := true;
  ELSE
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.last_arrived_at  := OLD.last_arrived_at;
      NEW.last_left_at     := OLD.last_left_at;
      NEW.last_notified_at := OLD.last_notified_at;
      NEW.is_inside        := OLD.is_inside;
    END IF;
    IF NEW.latitude IS DISTINCT FROM OLD.latitude
       OR NEW.longitude IS DISTINCT FROM OLD.longitude
       OR NEW.radius_m IS DISTINCT FROM OLD.radius_m THEN
      rebaseline := true;
    END IF;
  END IF;

  IF rebaseline THEN
    SELECT latitude, longitude INTO l FROM public.locations WHERE user_id = NEW.user_id;
    IF FOUND THEN
      NEW.is_inside := private.haversine_m(l.latitude, l.longitude, NEW.latitude, NEW.longitude) <= NEW.radius_m;
    ELSE
      NEW.is_inside := false;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_places_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS home_places_before_write_trg ON public.home_places;
CREATE TRIGGER home_places_before_write_trg
  BEFORE INSERT OR UPDATE ON public.home_places
  FOR EACH ROW EXECUTE FUNCTION public.home_places_before_write();

-- ---------------------------------------------------------------------------
-- 4. Arrival detection on every accepted location write
-- ---------------------------------------------------------------------------
-- Arrival: was outside, fix is inside the radius, and the fix is trustworthy
--          (accuracy no worse than the radius, but never stricter than 100 m).
-- Leaving: only once clearly outside radius * 1.25 + 30 m (hysteresis), so GPS
--          jitter on the edge of the circle cannot flap in/out.
-- Alerts:  at most one per 20 minutes, only if the owner enabled notify_partner.
-- This runs AFTER the stop-sharing / monotonic-write guards, so a dropped or
-- stale write never reaches it. It can never fail the location write itself.
CREATE OR REPLACE FUNCTION public.home_places_on_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h        public.home_places%ROWTYPE;
  d        double precision;
  acc      real;
  partner  uuid;
  nm       text;
  place    text;
BEGIN
  SELECT * INTO h FROM public.home_places WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Ignore replays of an identical fix and anything older than 10 minutes.
  IF TG_OP = 'UPDATE'
     AND NEW.latitude = OLD.latitude AND NEW.longitude = OLD.longitude THEN
    RETURN NEW;
  END IF;
  IF NEW.captured_at IS NOT NULL AND NEW.captured_at < now() - interval '10 minutes' THEN
    RETURN NEW;
  END IF;

  d   := private.haversine_m(NEW.latitude, NEW.longitude, h.latitude, h.longitude);
  acc := NEW.accuracy_m;

  IF NOT h.is_inside THEN
    IF d <= h.radius_m AND (acc IS NULL OR acc <= greatest(h.radius_m, 100)) THEN
      UPDATE public.home_places
         SET is_inside = true, last_arrived_at = now()
       WHERE id = h.id;

      IF h.notify_partner
         AND (h.last_notified_at IS NULL OR h.last_notified_at < now() - interval '20 minutes') THEN
        partner := public.get_partner_id(NEW.user_id);
        IF partner IS NOT NULL THEN
          SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
            INTO nm FROM public.profiles WHERE user_id = NEW.user_id;
          place := CASE WHEN lower(h.label) = 'home' THEN 'home' ELSE h.label END;

          PERFORM private.dispatch_push(jsonb_build_object(
            'internal',    true,
            'type',        'custom',
            'recipientId', partner,
            'title',       coalesce(nm, 'Your partner') || ' reached ' || place,
            'body',        'They just arrived safely.',
            'data',        jsonb_build_object('route', '/map'),
            'createdAt',   now()
          ));
          UPDATE public.home_places SET last_notified_at = now() WHERE id = h.id;
        END IF;
      END IF;
    END IF;
  ELSE
    IF d > h.radius_m * 1.25 + 30 AND (acc IS NULL OR acc <= 200) THEN
      UPDATE public.home_places
         SET is_inside = false, last_left_at = now()
       WHERE id = h.id;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'home arrival check failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_places_on_location() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS locations_home_arrival_trg ON public.locations;
CREATE TRIGGER locations_home_arrival_trg
  AFTER INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.home_places_on_location();

-- ---------------------------------------------------------------------------
-- 5. Partner-facing status (no coordinates, no address, no radius)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_partner_home_status()
RETURNS TABLE (label text, is_inside boolean, last_arrived_at timestamptz, last_left_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT h.label, h.is_inside, h.last_arrived_at, h.last_left_at
    FROM public.home_places h
   WHERE h.user_id = public.get_partner_id(auth.uid())
     AND h.notify_partner
     AND NOT private.sharing_is_stopped(h.user_id)
$$;
REVOKE ALL ON FUNCTION public.get_partner_home_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_home_status() TO authenticated, service_role;
