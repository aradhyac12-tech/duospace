-- "Left home" alert (optional, OFF by default). Builds on
-- 20261018120000_home_places_arrival_alerts.sql.
--
-- notify_leave only matters when notify_partner is also on. Same safeguards as
-- arrival: hysteresis (must be clearly outside radius * 1.25 + 30 m), trustworthy
-- fix, and at most one "left" alert per 20 minutes.

ALTER TABLE public.home_places
  ADD COLUMN IF NOT EXISTS notify_leave boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_left_notified_at timestamptz;

-- Guard: clients may not forge the new server-side timestamp.
CREATE OR REPLACE FUNCTION public.home_places_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
-- SECURITY INVOKER on purpose (see the original migration): current_user tells a
-- client write ('authenticated') apart from the server-side location trigger.
DECLARE
  l record;
  rebaseline boolean := false;
BEGIN
  NEW.updated_at := now();
  NEW.label := btrim(NEW.label);

  IF TG_OP = 'INSERT' THEN
    NEW.last_arrived_at       := NULL;
    NEW.last_left_at          := NULL;
    NEW.last_notified_at      := NULL;
    NEW.last_left_notified_at := NULL;
    rebaseline := true;
  ELSE
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.last_arrived_at       := OLD.last_arrived_at;
      NEW.last_left_at          := OLD.last_left_at;
      NEW.last_notified_at      := OLD.last_notified_at;
      NEW.last_left_notified_at := OLD.last_left_notified_at;
      NEW.is_inside             := OLD.is_inside;
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

-- Arrival (unchanged) + the new leave alert.
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

  IF TG_OP = 'UPDATE'
     AND NEW.latitude = OLD.latitude AND NEW.longitude = OLD.longitude THEN
    RETURN NEW;
  END IF;
  IF NEW.captured_at IS NOT NULL AND NEW.captured_at < now() - interval '10 minutes' THEN
    RETURN NEW;
  END IF;

  d   := private.haversine_m(NEW.latitude, NEW.longitude, h.latitude, h.longitude);
  acc := NEW.accuracy_m;
  place := CASE WHEN lower(h.label) = 'home' THEN 'home' ELSE h.label END;

  IF NOT h.is_inside THEN
    -- ── Arrival ────────────────────────────────────────────────────────────
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
    -- ── Leaving (hysteresis: clearly outside, not just on the edge) ───────
    IF d > h.radius_m * 1.25 + 30 AND (acc IS NULL OR acc <= 200) THEN
      UPDATE public.home_places
         SET is_inside = false, last_left_at = now()
       WHERE id = h.id;

      IF h.notify_partner AND h.notify_leave
         AND (h.last_left_notified_at IS NULL OR h.last_left_notified_at < now() - interval '20 minutes') THEN
        partner := public.get_partner_id(NEW.user_id);
        IF partner IS NOT NULL THEN
          SELECT coalesce(nullif(btrim(pet_name), ''), nullif(btrim(display_name), ''), 'Your partner')
            INTO nm FROM public.profiles WHERE user_id = NEW.user_id;

          PERFORM private.dispatch_push(jsonb_build_object(
            'internal',    true,
            'type',        'custom',
            'recipientId', partner,
            'title',       coalesce(nm, 'Your partner') || ' left ' || place,
            'body',        'They just stepped out.',
            'data',        jsonb_build_object('route', '/map'),
            'createdAt',   now()
          ));
          UPDATE public.home_places SET last_left_notified_at = now() WHERE id = h.id;
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
