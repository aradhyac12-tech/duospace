# DuoSpace — Project Context (canonical AI memory)

This directory is the **source of truth** for any agent or engineer picking up
this repository. Anything written here has been verified against the actual
source code, not against older docs. Where a `docs/*.md` file disagrees with a
file in `.ai/`, `.ai/` wins.

## What DuoSpace is

A private two-person ("duo") relationship app: end-to-end-encrypted chat,
audio/video calling, shared gallery, music (Groic), map/location sharing, and
a large set of personalisation features (themes, wallpapers, icon studio).
Every account is paired with exactly one partner.

- Stack: React 18 + Vite 5 + TypeScript 5 + Tailwind 3 (SPA, no SSR).
- Backend: external Supabase project `jzlpelxwzjjpddqcrtpu`
  (Postgres + Auth + Storage + Edge Functions). This project is **not** on
  Lovable Cloud — schema changes are applied manually via `scripts/sql/*.sql`
  and `supabase/migrations/`, and edge functions are deployed with the
  Supabase CLI.
- Native: Capacitor 8 (`capacitor.config.json`, `webDir: dist`), bundle id
  `com.duospace.app` for both Android and iOS, pinned on every `cap sync` by
  `scripts/patch-native-permissions.mjs`.

## Hard rules

1. No relationship-inference AI. No cheating detection, lie detection,
   sentiment policing, or breakup recommendation features. This is an explicit
   product constraint, not a backlog item.
2. Secrets (Daily.co keys, service-role keys) never reach client code. The
   browser bundle may only ever hold the Supabase URL + publishable anon key.
3. Auth redirects are platform-aware and must never fall back to localhost —
   see `src/lib/auth-redirect.ts`.
4. Migrations are additive. There is no destructive-migration path in this
   repo.

## Entry points

| Concern | File |
| --- | --- |
| App bootstrap | `src/main.tsx`, `src/App.tsx` |
| Supabase client | `src/integrations/supabase/client.ts` |
| Auth UI + OAuth | `src/pages/Auth.tsx` |
| OAuth callback handling | `src/lib/auth-callback.ts`, `src/lib/auth-redirect.ts` |
| Calls | `src/hooks/useDailyCall.ts`, `src/contexts/CallContext.tsx` |
| E2E encryption | `src/lib/crypto.ts`, `src/hooks/useE2E.ts` |
| Error system | `src/lib/errors/*` |
| Native permission patching | `scripts/patch-native-permissions.mjs` |

See `.ai/ARCHITECTURE.md`, `.ai/SECURITY_MODEL.md`, `.ai/BUILD_AND_RELEASE.md`,
and `.ai/TEST_PLAN.md`.
