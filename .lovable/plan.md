
# Duospace Import + Fresh Auth Provisioning

The current project is an empty TanStack Start template. The upload is a full Vite + React Router + Capacitor SPA (`guardian-zen-patch-main/`) with ~50 Supabase migrations, edge functions, and a Capacitor shell. To keep the app runnable on web preview AND on Capacitor (which needs a static SPA build), we import the zip wholesale, throw out the TanStack scaffolding, and stand up a fresh Lovable Cloud project for it.

## 1. Import the zip as the project

- Extract `guardian-zen-patch-main/` into the project root, excluding any `.git` metadata and the uploaded `.env` (secrets go into Cloud, not committed).
- Remove TanStack template files that don't apply to a Vite SPA: `src/routes/`, `src/router.tsx`, `src/routeTree.gen.ts`, `src/start.ts`, `src/server.ts`, `src/styles.css` (replaced by imported `src/index.css`), and the TanStack-specific `vite.config.ts` / `package.json` bits.
- Replace `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `tailwind.config.ts`, `postcss.config.js`, `components.json` from the zip. Install with `bun install` (Capacitor, `@capacitor/browser`, `@supabase/supabase-js`, React Router DOM, etc.).
- Keep the Lovable-generated `.gitignore` / `.prettier*` where they don't conflict.

## 2. Provision fresh Lovable Cloud

- Call `supabase--enable` to create a new Supabase project fully managed from here.
- Rewrite `src/integrations/supabase/client.ts` to read `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `import.meta.env` (no hardcoded old project ref).
- Regenerate `src/integrations/supabase/types.ts` off the new project after migrations apply.
- Run the imported `supabase/migrations/*` fresh against the new project (single consolidated migration if any of them are ordering-fragile; otherwise apply as-is). No data import — new project, empty state.
- Verify every `CREATE TABLE public.*` in the migrations has matching `GRANT` + RLS + policies; add a follow-up migration for any missing grants (Supabase no longer grants Data API access by default).

## 3. Auth providers

- Enable Email/Password with email confirmation on and `password_hibp_enabled: true` (leaked-password check) via `supabase--configure_auth`.
- Enable Google and Apple providers via `supabase--configure_social_auth`. Surface the exact callback URL: `https://<new-ref>.supabase.co/auth/v1/callback`.
- Add secrets via `add_secret` (never committed):
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
  - `APPLE_OAUTH_CLIENT_ID` (Services ID), `APPLE_OAUTH_CLIENT_SECRET` (signed JWT)
- Configure redirect allow-list on the new project:
  - Preview URL + `/auth/callback`
  - Published URL + `/auth/callback`
  - `http://localhost` + `/auth/callback`
  - `capacitor://localhost` + `/auth/callback`
  - `duospace://auth/callback`
- The uploaded `client_secret_*.json` (old orphan client, redirect points at `connector-gateway.lovable.dev`) is unusable for the new project — user must create fresh Google and Apple credentials. Provide step-by-step instructions in the closing summary.

## 4. Verify frontend OAuth code survived the import

- Confirm `src/pages/Auth.tsx` calls `supabase.auth.signInWithOAuth()` directly (not a Lovable proxy), with Capacitor branch using `@capacitor/browser` + `skipBrowserRedirect: true`. Restore if reverted.
- Confirm `src/lib/auth-redirect.ts` returns `${origin}/auth/callback` on web and `duospace://auth/callback` on native.
- Confirm `src/lib/edgeFunction.ts` (15s timeout + one transport-retry) is intact and used by `QRSignInDisplay.tsx` / `QRSignInScanner.tsx`.

## 5. QR sign-in edge functions

Deploy `supabase/functions/issue-qr-token`, `qr-anon-issue`, `redeem-qr-token` on the new project:

- Explicit CORS: allow-list origins (`preview`, `published`, `capacitor://localhost`, `http://localhost`) — no wildcard. Handle `OPTIONS` preflight.
- `issue-qr-token` + `redeem-qr-token`: require a valid JWT (`supabase.auth.getUser()` → 401 with CORS on failure).
- `qr-anon-issue`: unauthenticated but IP rate-limited (simple table-based or KV counter).
- Add a `qr_tokens` migration if not present: `token`, `issuer`, `purpose`, `expires_at`, `redeemed_at`, RLS + explicit `GRANT`s to `service_role` (functions use service role), plus a scheduled TTL cleanup.

## 6. Verification pass

- Web: sign up + sign in with email; confirm session persists across reload.
- Web: click Google/Apple → real provider consent (not 404, not "missing OAuth secret").
- Curl `issue-qr-token` with a bearer → 200 JSON; without → 401 with CORS headers.
- Report what's fixed vs. what still needs user action (native Info.plist / AndroidManifest camera & deep-link entries user must verify in Xcode/Android Studio — outside sandbox visibility).

## 7. Closing handoff

Final message will list, per credential:
- **Google Cloud Console**: create OAuth 2.0 Web Client, authorized redirect URI = `https://<new-ref>.supabase.co/auth/v1/callback`, paste Client ID → `GOOGLE_OAUTH_CLIENT_ID`, Secret → `GOOGLE_OAUTH_CLIENT_SECRET`.
- **Apple Developer**: create Services ID + Sign-in with Apple key (.p8), generate signed client-secret JWT (Team ID + Key ID + .p8), Return URL = same callback, paste Services ID → `APPLE_OAUTH_CLIENT_ID`, JWT → `APPLE_OAUTH_CLIENT_SECRET`.
- Native-only checks the user must verify locally (Info.plist camera usage strings, `duospace` URL scheme registration, AndroidManifest intent filter).

## Notes / risks

- The imported migrations span ~50 files with heavy interdependencies; if any fail on the fresh project I'll consolidate the failing group rather than editing history piecemeal.
- Chat/calls/gallery/etc. code is imported as-is and NOT touched beyond what's required for auth to compile and run.
- Old orphan Google credentials in the uploaded JSON are ignored; new ones will be created on the user's side.
