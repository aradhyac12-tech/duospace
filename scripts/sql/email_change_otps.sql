-- OTP codes for QR-signed-up users who want to add / change email + password.
-- Apply to external Supabase via SQL editor.

create table if not exists public.email_change_otps (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  email          text not null,
  otp_hash       text not null,              -- sha256(otp)
  attempts       int not null default 0,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz
);
create index if not exists email_change_otps_user_idx
  on public.email_change_otps (user_id, created_at desc);
create index if not exists email_change_otps_expiry_idx
  on public.email_change_otps (expires_at);

grant all on public.email_change_otps to service_role;

alter table public.email_change_otps enable row level security;
create policy "email_change_otps deny anon"
  on public.email_change_otps for all to anon using (false) with check (false);
create policy "email_change_otps deny authenticated"
  on public.email_change_otps for all to authenticated using (false) with check (false);

create or replace function public.email_change_otps_gc()
returns void language sql security definer set search_path = public as $$
  delete from public.email_change_otps
   where expires_at < now() - interval '1 hour'
      or (consumed_at is not null and consumed_at < now() - interval '1 hour');
$$;
revoke all on function public.email_change_otps_gc() from public;
grant execute on function public.email_change_otps_gc() to service_role;
