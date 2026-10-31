-- Share GPS accuracy (metres) with the partner so the map can draw an honest
-- accuracy circle around their pin instead of a falsely exact dot.
-- Additive + nullable: old clients keep working, RLS is unchanged.

alter table public.locations
  add column if not exists accuracy_m real
  check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m < 100000));

-- Keep accuracy truthful per fix. Runs AFTER locations_monotonic_write_guard_trg
-- (triggers fire alphabetically):
--  * fix not newer than the stored one (stale/duplicate)  -> keep the stored accuracy
--  * newer fix from a writer that sent no accuracy (older client, Android
--    receiver)                                              -> clear it, never show an old fix's accuracy
create or replace function public.locations_accuracy_consistency()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.captured_at is not distinct from OLD.captured_at
       or (NEW.captured_at is not null and OLD.captured_at is not null and NEW.captured_at <= OLD.captured_at) then
      NEW.accuracy_m := OLD.accuracy_m;
    elsif NEW.accuracy_m is not distinct from OLD.accuracy_m then
      NEW.accuracy_m := null;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists locations_zz_accuracy_consistency_trg on public.locations;
create trigger locations_zz_accuracy_consistency_trg
  before update on public.locations
  for each row
  execute function public.locations_accuracy_consistency();
