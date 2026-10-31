-- Callee phone received the incoming-call push and is ringing. Lets the
-- caller show "Ringing…" (vs "Calling…") even when the callee app is killed.
alter table public.call_history add column if not exists ringing_at timestamptz;

create or replace function public.mark_call_ringing(_call_id uuid, _receiver_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.call_history
     set ringing_at = now()
   where id = _call_id
     and receiver_id = _receiver_id
     and status = 'in_progress'
     and ringing_at is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.mark_call_ringing(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_call_ringing(uuid, uuid) to service_role;
