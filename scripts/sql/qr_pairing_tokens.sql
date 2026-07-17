-- QR cross-device pairing tokens.
-- Apply this to your Supabase project (linked as povhwwcswvfihmcdqgyv) via:
--   supabase db push
-- or paste it into the SQL editor. It sits outside supabase/migrations/ because
-- Lovable Cloud is not managing this project's migrations — your external
-- Supabase CLI/dashboard is authoritative here.
--
-- One row per QR sign-in attempt. Device A (authed) creates the row via the
-- issue-qr-token edge function; Device B (unauthed) redeems it via
-- redeem-qr-token. Only the SHA-256 of the raw token is stored server-side.
-- Raw tokens live only in the QR payload for 90s and are single-use.

create table if not exists public.qr_pairing_tokens (
  id            uuid primary key default gen_random_uuid(),
  -- For device_pairing tokens: the already-authenticated user granting sign-in
  --   to a second device. Required.
  -- For signup_invite tokens: the user who *issued* the invite (inviter).
  --   Required — signup_invite QRs are always minted by an authed user.
  user_id       uuid not null references auth.users(id) on delete cascade,
  token_hash    text not null unique,
  -- 'device_pairing' → redeem mints a session for user_id (existing behavior).
  -- 'signup_invite'  → redeem returns { kind:'signup_invite', inviter_id }
  --                   and the scanning device must run the normal signup flow.
  token_type    text not null default 'device_pairing'
                check (token_type in ('device_pairing','signup_invite')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  redeemed_at   timestamptz,
  redeemed_ip   text,
  redeemed_ua   text,
  issuer_ip     text,
  issuer_ua     text
);

-- Idempotent add for existing deployments that predate token_type.
alter table public.qr_pairing_tokens
  add column if not exists token_type text not null default 'device_pairing';
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'qr_pairing_tokens_token_type_check'
  ) then
    alter table public.qr_pairing_tokens
      add constraint qr_pairing_tokens_token_type_check
      check (token_type in ('device_pairing','signup_invite'));
  end if;
end $$;

create index if not exists qr_pairing_tokens_user_idx
  on public.qr_pairing_tokens (user_id, created_at desc);
create index if not exists qr_pairing_tokens_expiry_idx
  on public.qr_pairing_tokens (expires_at);

-- Data API access. Only edge functions running with the service role touch
-- this table; clients must never read or write it directly.
grant all on public.qr_pairing_tokens to service_role;

alter table public.qr_pairing_tokens enable row level security;

-- Deny-all for anon and authenticated. service_role bypasses RLS.
create policy "qr_pairing_tokens deny anon"
  on public.qr_pairing_tokens for all
  to anon
  using (false) with check (false);

create policy "qr_pairing_tokens deny authenticated"
  on public.qr_pairing_tokens for all
  to authenticated
  using (false) with check (false);

-- GC helper: purge expired / redeemed rows older than an hour.
create or replace function public.qr_pairing_tokens_gc()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.qr_pairing_tokens
   where expires_at < now() - interval '1 hour'
      or (redeemed_at is not null and redeemed_at < now() - interval '1 hour');
$$;

revoke all on function public.qr_pairing_tokens_gc() from public;
grant execute on function public.qr_pairing_tokens_gc() to service_role;
