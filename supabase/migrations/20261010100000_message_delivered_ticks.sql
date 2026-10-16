-- WhatsApp-style ticks: single = sent, double grey = delivered to the
-- recipient's device, double blue = read (is_read).
alter table public.messages add column if not exists delivered_at timestamptz;

-- Called by the RECIPIENT's device when messages reach it (app open / online).
-- SECURITY DEFINER so it works regardless of column-level UPDATE restrictions,
-- but it only ever touches rows addressed to the caller.
create or replace function public.mark_messages_delivered()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.messages
     set delivered_at = now()
   where receiver_id = auth.uid() and delivered_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.mark_messages_delivered() from public, anon;
grant execute on function public.mark_messages_delivered() to authenticated;
