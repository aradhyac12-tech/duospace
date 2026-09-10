# Phase: Pre-Implementation Stabilization — Final Report

Scope: audit, security, documentation and build baseline only. No new
relationship-AI features were designed or implemented (explicit constraint).

## 1. Inventory

- 540+ files. React 18 + Vite 5 + TS 5 SPA, Capacitor 8 shell, external
  Supabase project `jzlpelxwzjjpddqcrtpu`.
- 19 edge functions, 49 SQL migrations, 34 live public tables, 3 local
  Capacitor plugins, 7 Android Kotlin calling sources.
- Canonical memory created at `.ai/` (PROJECT_CONTEXT, ARCHITECTURE,
  SECURITY_MODEL, BUILD_AND_RELEASE, TEST_PLAN). Where `docs/*.md` disagrees
  with `.ai/`, `.ai/` is authoritative.

## 2. Security findings

### P0 — partner Daily.co key readable by any authenticated user (FIXED)

`public.get_partner_daily_key(_user_id uuid)` was SECURITY DEFINER, took the
target user id as a parameter, never compared it to `auth.uid()`, and (Postgres
default) had `EXECUTE` granted to PUBLIC. Any signed-in user could call it via
`supabase.rpc(...)` with an arbitrary user id and read a stranger's partner's
plaintext Daily.co API key — a billable third-party credential.

Fix: `scripts/sql/harden_partner_daily_key.sql` anchors the lookup to
`auth.uid()` and revokes `EXECUTE` from PUBLIC/anon/authenticated, granting it
to `service_role` only. `supabase/functions/daily-call/index.ts` now verifies
the caller's JWT and then performs *all* secret lookups with a service-role
client, so no secret is reachable from a client-callable path.

**Action required:** run that SQL in the Supabase SQL editor and redeploy
`daily-call` (`npx supabase functions deploy daily-call`). Rotate any Daily.co
keys already stored, since they were exposed.

### P1 — `finalize-upload` not idempotent under concurrency (FIXED)

Two concurrent finalizes for the same upload both passed the ownership SELECT
and both reassembled; whichever finished first deleted the chunks, so the other
failed with a misleading `Missing chunk` 422 despite the file being correct.
The tracking row is now claimed with an atomic delete-returning: exactly one
request owns the finalize, a duplicate/retry returns the same success payload
with `alreadyFinalized: true`, and any failure after the claim restores the row
so a genuine retry still works.

### Verified-good (no change needed)

- Every live public table has RLS enabled with at least one active policy
  (`npm run check:rls`, now a CI gate).
- `finalize-upload` already enforced caller-owned path prefix, server-recorded
  chunk count, and reassembled-size cross-check.
- `cleanup-orphan-uploads` is service-role-only.
- `user_secrets` RLS scopes each row to its owner.

### Accepted risk (documented)

- `qr-anon-issue` / `redeem-qr-token` run with `verify_jwt = false` by
  necessity (pre-session) and carry their own authorisation.
- Supabase URL + publishable anon key hardcoded as fallbacks in the client —
  both are public values by design.

## 3. Build system

`.github/workflows/ci.yml` no longer masks failures: `npx tsc -b --noEmit ||
true` is now a hard gate, `lint` and `test` dropped `--if-present`, and
`check:rls` was added. Bundle identifier `com.duospace.app` is pinned on every
`cap sync` by `scripts/patch-native-permissions.mjs` (iOS
`PRODUCT_BUNDLE_IDENTIFIER`, Android `applicationId`/`namespace`).

## 4. DuoAutoAnswer

Specification only — see `.ai/ARCHITECTURE.md`. No code was written. It is
gated on explicit, revocable, default-off per-device opt-in and on audible
indication that auto-answer occurred.

## 5. Verification run

```
npm run check:rls   ✓ 49 migrations scanned, 34 tables, all RLS-covered
npx tsgo --noEmit   ✓ no errors
npx vitest run      ✓ 5 files, 56 tests passed
```

Live Supabase and real-device checks cannot be executed from this environment;
the executable checklist is `.ai/TEST_PLAN.md`, and item A1 is the direct
regression test for the P0 above.
