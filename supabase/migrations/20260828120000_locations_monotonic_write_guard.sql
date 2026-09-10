-- Root-cause fix for two related Map bugs (Phase: Map reliability + live
-- location hardening).
--
-- BUG 1 — "Updated X ago" was effectively frozen at account-creation time.
-- Every write path (useLiveLocation.ts's writeLocation, locationQueue.ts's
-- flushQueuedLocations, LocationContext.tsx's native writeFix) has always
-- upserted only { user_id, latitude, longitude }. Supabase-js builds the
-- upsert's ON CONFLICT ... DO UPDATE SET clause from the keys actually
-- present in the payload object — since updated_at was never one of them,
-- every UPDATE after the very first INSERT left updated_at completely
-- untouched (its DEFAULT now() only ever applies on INSERT). So
-- `partnerLocation.updated_at`, which every staleness/"Updated Xm ago"
-- calculation in LocationContext.tsx and MapView.tsx reads, has never once
-- reflected an actual update after row creation.
--
-- BUG 2 — no protection against an older fix overwriting a newer one. There
-- are three concurrent producers of writes to this table (foreground GPS
-- watcher, offline-queue flush, native background watcher/one-shot), and
-- nothing before this migration compared timestamps at all — an
-- out-of-order write (e.g. a delayed offline-queue flush racing a fresher
-- live write, or a stale cached one-shot fix arriving after a fresher
-- watcher tick) would silently clobber the newer, more-correct position
-- with an older, less-correct one.
--
-- FIX: add a `captured_at` column (the actual fix-capture time reported by
-- the GPS/fused-location/CoreLocation API, distinct from `updated_at` which
-- is "when the server accepted this row") and a single BEFORE INSERT OR
-- UPDATE trigger that is the one place both bugs are fixed, regardless of
-- which of the three client write paths lands, in whatever order they
-- arrive:
--   1. Always bump `updated_at` to the moment the server actually applies
--      the row (fixes bug 1).
--   2. Reject (no-op) an UPDATE whose `captured_at` is older than the
--      currently-stored `captured_at` (fixes bug 2) — the client's upsert
--      still succeeds (no error to surface/retry), it just has no effect,
--      which matches "never lose the newest valid location" without
--      turning an out-of-order write into a client-visible failure.
-- Enforcing this in the database (rather than only in client JS) is the
-- safest mechanism here because it's the one place all three producers
-- converge, and it can't be bypassed by a client that's behind, offline-
-- queued, or buggy.

alter table public.locations
  add column if not exists captured_at timestamptz;

-- Backfill: best-effort, existing rows have no real capture time on record
-- — treat "last known updated_at" as the best available estimate rather
-- than leaving it null (a null captured_at on an existing row is treated
-- as "always acceptable to overwrite" by the trigger below, since there's
-- nothing meaningful to compare against yet).
update public.locations set captured_at = updated_at where captured_at is null;

create or replace function public.locations_monotonic_write_guard()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.captured_at is null then
      NEW.captured_at := now();
    end if;
    NEW.updated_at := now();
    return NEW;
  end if;

  -- TG_OP = 'UPDATE' from here.

  if NEW.captured_at is null then
    -- Caller didn't supply a capture timestamp (e.g. an older client build
    -- mid-rollout). Can't compare it against anything, so accept it rather
    -- than blocking location updates entirely — but never let it look
    -- older/newer than it actually is: stamp it with the current OLD value
    -- if present, otherwise now().
    NEW.captured_at := coalesce(OLD.captured_at, now());
    NEW.updated_at := now();
    return NEW;
  end if;

  if OLD.captured_at is not null and NEW.captured_at < OLD.captured_at then
    -- Stale fix arriving late — keep the row exactly as it is. Do NOT
    -- touch updated_at either: nothing actually changed.
    NEW.latitude    := OLD.latitude;
    NEW.longitude   := OLD.longitude;
    NEW.captured_at := OLD.captured_at;
    NEW.updated_at  := OLD.updated_at;
    return NEW;
  end if;

  -- Newer (or equal, e.g. a harmless duplicate delivery) fix — apply it.
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists locations_monotonic_write_guard_trg on public.locations;
create trigger locations_monotonic_write_guard_trg
  before insert or update on public.locations
  for each row
  execute function public.locations_monotonic_write_guard();

comment on column public.locations.captured_at is
  'When the fix was actually captured on-device (GPS/FusedLocationProviderClient/CoreLocation timestamp), as opposed to updated_at which is when the server accepted the row. Used by locations_monotonic_write_guard_trg to reject out-of-order writes.';
