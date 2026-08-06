# Sync `duospace-oauth-lifecycle-fix.zip` + add web hosting config

## 1. Sync the zip as-is

- Extract the archive (433 files, root folder `duospace-main/`) and copy it over the project, excluding `.git`, `node_modules`, and lockfiles.
- Preserve working local config the zip doesn't know about: `.env` (Supabase URL + anon key), the Supabase client public-key fallbacks, the Vite aliases for `native-plugins/*`, and the `supabase/config.toml` project id / redirect URLs.
- Reinstall dependencies, fix any TypeScript or build errors the new sources introduce, and confirm the preview renders instead of a white screen.

## 2. Hosting files for Netlify / Cloudflare / Vercel

Add the standard static-SPA deployment config so the repo can be hosted anywhere without extra setup:

- `netlify.toml` — build command `npm run build`, publish `dist`, Node 20, and an SPA fallback redirect (`/* -> /index.html 200`).
- `public/_redirects` — already present; keep it (Netlify and Cloudflare Pages both read it).
- `public/_headers` — security headers (X-Content-Type-Options, Referrer-Policy, Permissions-Policy) and long-lived immutable caching for `/assets/*`.
- `vercel.json` — build/output settings plus SPA rewrite, for users deploying there.
- `wrangler.toml` — Cloudflare Pages project name, build output `dist`, compatibility date.
- `.nvmrc` — pin Node 20 so all three platforms build identically.
- `.env.example` — keep current vars documented (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, optional `VITE_PUBLIC_SITE_URL`) as the env-var reference for the hosting dashboards.
- `.gitignore` — verify it excludes `.env`, `dist`, `node_modules`, `android/`, `ios/`.
- `DEPLOY.md` — short guide: build settings per platform, which env vars to set, and the Supabase redirect URLs to add for each new domain.

## 3. GitHub

Lovable pushes the repo automatically once GitHub is connected via the chat's plus menu, so no manual git work is needed — every file above lands in the repo on the next sync. Optionally add `.github/workflows/ci.yml` running install, lint, typecheck, and `vitest run` on push/PR.

## Technical notes

- All hosting configs are static-SPA only; no server runtime, so auth keeps working through the existing client-side Supabase flow.
- New deploy domains must be added to Supabase Auth redirect URLs and to the Google OAuth client's authorized origins, or Google sign-in will fail on those domains — documented in `DEPLOY.md`.
- Out of scope: native APK/iOS work, chat/calls/other features beyond what the zip changes.

Also solve the issue of Build failed

&nbsp;

these Capacitor plugins were not registered in the native Android project: $MISSING2"[0m

&nbsp;

2026-08

```
2026-08-06T11:02:37.1440867Z 
2026-08-06T11:02:37.1440879Z 
2026-08-06T11:02:37.1440978Z Totals:
2026-08-06T11:02:37.1441273Z android: 74 generated, 2.45 MB total
2026-08-06T11:02:37.1564450Z [icon] Native icon/splash resources generated
2026-08-06T11:02:37.6830738Z [error] "." is not a valid value for webDir
2026-08-06T11:02:37.6840598Z [sync] First cap sync failed — retrying after npm install (auto-repair)
2026-08-06T11:02:38.4257553Z 
2026-08-06T11:02:38.4258135Z removed 7 packages in 701ms
2026-08-06T11:02:38.9432708Z [error] "." is not a valid value for webDir
2026-08-06T11:02:38.9443015Z PREBUILD_VALIDATION_FAILED: cap sync android failed. Native plugins could not be synchronized.
2026-08-06T11:02:38.9448277Z ##[error]cap sync android failed. Native plugins could not be synchronized.
2026-08-06T11:02:38.9450769Z ##[error]Process completed with exit code 1.
```