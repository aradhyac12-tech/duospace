# Supabase Production Dashboard Checklist

Everything below requires the live Supabase Dashboard or a live/device test —
none of it can be confirmed from source. Status: **VERIFIED** / **NOT
VERIFIED** / **REQUIRES DASHBOARD** / **REQUIRES LIVE TEST** / **NOT
APPLICABLE**.

## AUTH

| Item | Status |
|---|---|
| Redirect URLs match `supabase/config.toml` `additional_redirect_urls` | REQUIRES DASHBOARD |
| OAuth providers configured (if any used — none found referenced in `src/` beyond email/passkey; confirm none are silently expected) | REQUIRES DASHBOARD |
| Password policy (min length, complexity) | REQUIRES DASHBOARD |
| Email provider configured (custom SMTP vs Supabase default — `send-email` Edge Function suggests custom sending, worth confirming it's not double-sending alongside Supabase Auth's own emails) | REQUIRES DASHBOARD |
| Auth rate limits (signup, OTP, password reset) | REQUIRES DASHBOARD |
| CAPTCHA/bot protection | REQUIRES DASHBOARD — nothing in source suggests this is configured; `complete-signup` Edge Function has no visible CAPTCHA verification step |
| JWT expiry / refresh token rotation settings | REQUIRES DASHBOARD |
| Session invalidation on password change / account deletion | REQUIRES LIVE TEST |

## DATABASE

| Item | Status |
|---|---|
| RLS enabled on every table | VERIFIED (source) — see `SUPABASE_RLS_FINAL_MATRIX.md` |
| Security Advisor clean or justified | REQUIRES DASHBOARD — see matrix for source-level disposition of each numbered item |
| Performance Advisor reviewed | REQUIRES DASHBOARD |
| Extensions enabled: `pg_cron`, `pg_net`, `pgcrypto` (for `gen_random_uuid()`) | REQUIRES DASHBOARD |
| SSL enforcement | REQUIRES DASHBOARD (Supabase default; not overridden in source) |
| Database backups / PITR enabled | REQUIRES DASHBOARD — note: this is a *different* concern from the app's own `backup_runs`/`backups` bucket feature; see Section 12 note in `SUPABASE_SCHEMA_INVENTORY.md` |

## STORAGE

| Item | Status |
|---|---|
| Bucket privacy matches intent (6 private, 2 intentionally public) | VERIFIED (source) |
| Storage policies match `SUPABASE_RLS_FINAL_MATRIX.md` | VERIFIED (source) |
| File size / MIME-type limits per bucket | REQUIRES DASHBOARD — no client-side or policy-level MIME/size restriction found in migrations for any bucket; large uploads rely entirely on the app's own resumable-upload threshold (6MB, client-side only), not a server-enforced cap |

## REALTIME

| Item | Status |
|---|---|
| Publication includes exactly the 9 tables listed in `SUPABASE_SCHEMA_INVENTORY.md` | REQUIRES DASHBOARD to confirm the live publication matches migration history (a table could theoretically be added/removed from the publication outside a migration) |
| Realtime respects RLS (Supabase default behavior for `postgres_changes`) | REQUIRES LIVE TEST — the RLS fixes made across this repo (profiles, countdowns, memories, etc.) apply to realtime the same way as to REST, but confirming a realtime subscription actually filters correctly per-row needs a live two-account test |

## EDGE FUNCTIONS

| Item | Status |
|---|---|
| All 18 functions actually deployed to `jzlpelxwzjjpddqcrtpu` | REQUIRES DASHBOARD — existing in `supabase/functions/` in git is not deployment |
| Secrets (`SUPABASE_SERVICE_ROLE_KEY`, FCM/APNs credentials, music-search API key, etc.) configured per-function | REQUIRES DASHBOARD |
| Vault secrets `project_url`/`service_role_key` exist (required by the new scheduled-message cron and the existing push cron functions) | REQUIRES DASHBOARD |
| Function logs reachable / no secret leakage in logs | REQUIRES DASHBOARD — see `SUPABASE_OBSERVABILITY.md` for what each function does and doesn't log per source |

## CRON

| Item | Status |
|---|---|
| All 3 named jobs registered (`delete-expired-messages`, `cleanup-orphan-uploads`, `deliver-scheduled-messages`) | REQUIRES DASHBOARD |
| `cleanup-orphan-uploads` auth actually works — **known likely-broken** (`app.settings.service_role_key` never set in this snapshot; not fixed this session, see `SUPABASE_SCHEMA_INVENTORY.md`) | NOT VERIFIED — flagged as a known probable failure, not a hopeful "should be fine" |
| `deliver-scheduled-messages` cron actually fires and reaches the Edge Function | REQUIRES LIVE TEST |

## PUSH

| Item | Status |
|---|---|
| FCM server key/service account configured | REQUIRES DASHBOARD/EXTERNAL SERVICE |
| APNs certificate/key configured | REQUIRES DASHBOARD/EXTERNAL SERVICE |
| VoIP push certificate (separate from standard APNs) configured | REQUIRES DASHBOARD/EXTERNAL SERVICE |

## CALLS

| Item | Status |
|---|---|
| Daily.co API key / domain configured (`user_secrets.daily_api_key` per-user, or a shared project-level key — source doesn't clarify which model is live) | REQUIRES DASHBOARD/EXTERNAL SERVICE |

## ENVIRONMENT

| Item | Status |
|---|---|
| Production project ref = `jzlpelxwzjjpddqcrtpu` | VERIFIED (source-internal consistency) — REQUIRES DASHBOARD for final confirmation this is the live one |
| Frontend `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set in the actual deployment environment (not just `.env.example`) | REQUIRES DASHBOARD/DEPLOYMENT PLATFORM |
| No service-role key or secret ever present in a `VITE_*` variable | VERIFIED (source) — grepped `.env.example`, `vite.config.*`, and all `import.meta.env.VITE_*` usages in `src/`; none reference a service key |
