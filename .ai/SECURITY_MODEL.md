# DuoSpace — Security Model (verified)

## Identity and access

- One Supabase auth user per person; `profiles.partner_id` links the pair.
- Every `public` table has RLS enabled; `scripts/check-rls-coverage.mjs` is a
  CI gate that fails the build if a created table lacks RLS + policies.
- Roles are not stored on `profiles`; there is no admin surface in the app.

## What must never happen

- A user must never read another couple's rows, files, or secrets.
- A third-party credential (Daily.co API key, service-role key, FCM key) must
  never be reachable from browser code or from a client-callable RPC.
- `finalize-upload` must never write outside the caller's own `<user_id>/`
  storage prefix.

## Secrets

- `user_secrets` holds per-user third-party keys (currently the Daily.co API
  key plus the `daily_provides_calls` flag). RLS restricts each row to its
  owner, so a user can read/write only their own key.
- Partner key resolution is **server-only**. `public.get_partner_daily_key` is
  SECURITY DEFINER; `EXECUTE` is granted to `service_role` only and the
  function anchors its lookup to `auth.uid()` when a caller identity exists.
  See `scripts/sql/harden_partner_daily_key.sql`.
  *Fixed in the stabilization phase:* the function previously trusted a
  caller-supplied `_user_id` and was executable by `authenticated`, letting any
  signed-in user read a stranger's partner's plaintext Daily key.
- `daily-call` verifies the caller's JWT first, then does all secret lookups
  with the service-role client.

## Uploads

`finalize-upload` enforces, in order: authenticated caller → first path segment
equals `auth.uid()` → an atomic claim of the matching `pending_uploads` row →
server-recorded chunk count (client value must match) → reassembled byte length
must match the recorded size. A second concurrent or retried finalize returns
the same success payload instead of a spurious "Missing chunk" error; any
failure after the claim restores the tracking row so the client may retry.

## Client-side crypto

Chat is end-to-end encrypted (`src/lib/crypto.ts`, `src/hooks/useE2E.ts`). The
server stores ciphertext. Message fetching is gated on `e2eReady` so plaintext
is never replaced in cache by an "[encrypted]" placeholder.

## Accepted risks

- `qr-anon-issue` and `redeem-qr-token` run with `verify_jwt = false` because
  they execute before a session exists. They are rate-limited and token-scoped;
  they must never return anything beyond a short-lived, single-use QR token.
- The Supabase URL and publishable anon key are hardcoded as fallbacks in
  `src/integrations/supabase/client.ts`. This is intentional (a missing `.env`
  used to blank-screen the app) and safe: both values are public by design.
