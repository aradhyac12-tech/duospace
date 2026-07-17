-- WebAuthn / passkey support.
-- Apply to Supabase (external project povhwwcswvfihmcdqgyv) via SQL editor or
-- `supabase db push` — this file sits outside supabase/migrations/ on purpose.

-- ── Credentials ──────────────────────────────────────────────────────────
create table if not exists public.webauthn_credentials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  credential_id  text not null unique,          -- base64url
  public_key     text not null,                 -- base64url COSE key
  counter        bigint not null default 0,
  transports     text[] not null default '{}',
  device_name    text,
  aaguid         text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
create index if not exists webauthn_credentials_user_idx
  on public.webauthn_credentials (user_id);

grant select, delete on public.webauthn_credentials to authenticated;
grant all on public.webauthn_credentials to service_role;

alter table public.webauthn_credentials enable row level security;

create policy "webauthn own read"
  on public.webauthn_credentials for select
  to authenticated
  using (user_id = auth.uid());

create policy "webauthn own delete"
  on public.webauthn_credentials for delete
  to authenticated
  using (user_id = auth.uid());

-- Anon cannot see credentials; but the login-options edge function (service_role)
-- needs to look them up by email → user_id. That happens outside RLS.

-- ── Challenges (nonces) ──────────────────────────────────────────────────
create table if not exists public.webauthn_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  challenge   text not null,
  kind        text not null check (kind in ('registration','authentication')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index if not exists webauthn_challenges_expiry_idx
  on public.webauthn_challenges (expires_at);
create index if not exists webauthn_challenges_user_idx
  on public.webauthn_challenges (user_id, kind, created_at desc);

grant all on public.webauthn_challenges to service_role;
alter table public.webauthn_challenges enable row level security;
create policy "webauthn_challenges deny anon"
  on public.webauthn_challenges for all to anon using (false) with check (false);
create policy "webauthn_challenges deny authenticated"
  on public.webauthn_challenges for all to authenticated using (false) with check (false);

-- ── GC ───────────────────────────────────────────────────────────────────
create or replace function public.webauthn_challenges_gc()
returns void language sql security definer set search_path = public as $$
  delete from public.webauthn_challenges
   where expires_at < now() - interval '1 hour'
      or (consumed_at is not null and consumed_at < now() - interval '1 hour');
$$;
revoke all on function public.webauthn_challenges_gc() from public;
grant execute on function public.webauthn_challenges_gc() to service_role;
