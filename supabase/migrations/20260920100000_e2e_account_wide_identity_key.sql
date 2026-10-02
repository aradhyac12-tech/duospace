-- FIX: E2E messages undecryptable across platforms/devices for the same
-- account ("decrypted... on apk or websites messages are unable to
-- decrypt on different platform").
--
-- ROOT CAUSE (confirmed by reading src/hooks/useE2E.ts and
-- src/lib/crypto.ts directly, not guessed): the ECDH identity keypair
-- was generated and stored purely LOCALLY per device
-- (src/lib/keystore.ts's IndexedDB, which is device+browser-profile
-- scoped and never syncs). useE2E.ts's init() ran, on EVERY device that
-- had an empty local IndexedDB (i.e. every new platform the same
-- account was opened on): generate a brand-new keypair, then
-- unconditionally overwrite the single `profiles.public_key` column
-- with it. Since ECDH's derived shared secret depends on which specific
-- keypair was used, this meant: opening the same account on a second
-- platform silently invalidated E2E for every OTHER device already
-- signed in — the partner's client would start encrypting against the
-- newest device's public key, which no other device holds the matching
-- private key for, and any messages already encrypted under a since-
-- overwritten public key become undecryptable by definition (the private
-- key that could decrypt them only ever existed in that one device's
-- local IndexedDB).
--
-- FIX: one identity keypair per ACCOUNT, not per device/session. The
-- private key now also syncs via this table (owner-only readable — see
-- RLS below), so any device signing into the same account adopts the
-- SAME keypair instead of generating a new one. `profiles.public_key`
-- is untouched (still the single, partner-visible current public key —
-- now actually consistent across every device because there's only ever
-- one real keypair per account again).
--
-- HONEST SECURITY TRADE-OFF, stated plainly rather than glossed over:
-- previously, a private key never left its device, which meant even a
-- fully compromised Supabase project (a stolen service_role key, or
-- direct database access) could not decrypt past messages without also
-- physically compromising a specific user's device. That property is
-- given up here in exchange for actually working across devices, which
-- is what was asked for. `user_e2e_identity_keys` is RLS'd so no other
-- END USER (not even a partner) can ever read a row that isn't their
-- own — but `service_role` (edge functions, or direct Postgres/dashboard
-- access) CAN. A future, stronger version of this fix would wrap the
-- private key with a key derived from something only the legitimate
-- user can reproduce (a passphrase, or the login password captured
-- transiently at sign-in) before it ever leaves the device — deliberately
-- NOT built here, since it needs new user-facing UX (a recovery
-- passphrase prompt) this pass wasn't asked to add and couldn't
-- responsibly improvise without discussing that trade-off first.

CREATE TABLE IF NOT EXISTS public.user_e2e_identity_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  private_key_jwk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_e2e_identity_keys ENABLE ROW LEVEL SECURITY;

-- Owner-only, full stop. Never readable by a partner or anyone else —
-- this is the one property that must hold for this design to be worth
-- anything at all.
DROP POLICY IF EXISTS "own e2e identity key: select" ON public.user_e2e_identity_keys;
CREATE POLICY "own e2e identity key: select" ON public.user_e2e_identity_keys
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- INSERT only, deliberately no UPDATE/DELETE grant for the client — this
-- key is meant to be set once per account and then adopted by every
-- device, not silently overwritten the way profiles.public_key used to
-- be. "First real keypair wins" is enforced by the PRIMARY KEY itself:
-- the client always does INSERT ... ON CONFLICT (user_id) DO NOTHING,
-- then re-selects to find out which row actually won any simultaneous-
-- first-run race between two devices.
DROP POLICY IF EXISTS "own e2e identity key: insert" ON public.user_e2e_identity_keys;
CREATE POLICY "own e2e identity key: insert" ON public.user_e2e_identity_keys
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.user_e2e_identity_keys IS 'One synced E2E identity keypair per account (not per device) — see src/hooks/useE2E.ts. Owner-only RLS; service_role can still read it (see this migration''s own header comment for the security trade-off that implies).';
