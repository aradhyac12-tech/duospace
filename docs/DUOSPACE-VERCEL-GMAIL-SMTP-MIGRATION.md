# Auth/email infrastructure repair — Vercel domain + Gmail SMTP — v3.4.5

Scope: point auth redirects at `https://duospace-ten.vercel.app`, remove
stale `duospace.app`-domain references, and confirm the project is ready
for Gmail SMTP to be entered in the Supabase Dashboard. No redesign, no new
auth system, no new Edge Functions. Applied on top of this zip's existing
state (includes the earlier flicker fix in `useKeyboardOpen.ts`, v3.4.4,
and an unrelated in-progress "Surprise message" feature — neither touched
here).

## A. Exact files changed

1. `src/lib/auth-redirect.ts`
2. `supabase/config.toml`
3. `src/components/errors/ErrorCard.tsx`
4. `src/integrations/supabase/client.ts` (comment only)
5. `.gitignore`
6. `.env.example` (new file)
7. `docs/SUPABASE_PROJECT_CONFIGURATION.md` (doc only)
8. `src/lib/errors/DuoSpaceError.ts` + `package.json` (version bump, 3.4.4 → 3.4.5)

## B. Exact changes made

**`src/lib/auth-redirect.ts`**
- `PRODUCTION_WEB_ORIGIN` fallback: `https://web-duospace.lovable.app` →
  `https://duospace-ten.vercel.app`. Only matters when
  `window.location.origin` is unavailable or looks local — on the real
  deployed site, `window.location.origin` already resolves correctly and
  this fallback is never reached in practice.
- `buildAuthRedirectUri()`: the `email_confirm` purpose (signup
  confirmation + resend-confirmation) now resolves to `/auth` instead of
  `/auth/callback`, per your request. Safe because `/auth` and
  `/auth/callback` already render the exact same component
  (`App.tsx`'s `AuthRoute`), which detects an incoming callback from the
  URL's query/hash params, not its path. `oauth` and `password_reset`
  purposes are unchanged (still `/auth/callback` and `/reset-password`).

**`supabase/config.toml`**
- `site_url` → `https://duospace-ten.vercel.app`.
- `additional_redirect_urls` now also includes
  `https://duospace-ten.vercel.app/**`, `/auth`, `/auth/callback`, and
  `/reset-password`. The old Lovable URLs are **kept**, not removed, so
  the Lovable editor/preview keeps working.
- Added a comment: this file only matters if you manage Auth config
  through the Supabase CLI — if you set URLs via the Dashboard UI, this
  file doesn't push itself there. See section C.

**`src/components/errors/ErrorCard.tsx`**
- Removed the hardcoded default `supportUrl = "https://duospace.app/support"`
  — a domain you don't own, and a route that never existed. "Contact
  support" now only renders when a caller explicitly passes a real
  `supportUrl` (no current call site does).

**`src/integrations/supabase/client.ts`**
- Comment-only: dropped a reference to a `.env.example` that didn't exist
  yet, and corrected "Cloudflare Pages" → "Vercel" in the deployment note.
  No functional change — the key here is the public anon/publishable key
  (`role: "anon"` in its own JWT payload), not a secret.

**`.gitignore`**
- Added `.env`, `.env.local`, `.env.*.local` — not ignored before at all.

**`.env.example`** (new)
- Documents the three client-side env vars this project actually reads,
  all optional (working fallbacks exist in code). States plainly that
  Gmail/SMTP/Resend credentials never belong in this file.

**Not changed, and why:**
- `capacitor.config.json`, `whitelabel/apps.json`, `src/lib/whitelabelApps.ts`
  — `com.duospace.app` there is the Android `applicationId` / iOS
  `bundleId`, a reverse-DNS package identifier. Doesn't require owning the
  `duospace.app` domain, any more than `com.example.myapp` would. Untouched.
- `supabase/functions/_shared/webauthnOrigin.ts` — mentions `duospace.app`
  only inside an illustrative error-message string, unrelated to email/auth
  redirects (that file is WebAuthn/passkey RP-ID resolution). Untouched.
- No SMTP host/username/password/API key of any kind exists anywhere in
  this codebase, before or after this change — nothing to remove. Supabase
  Auth's SMTP transport has zero code representation by design; it's
  entirely a server-side Dashboard setting.
- `DEPLOY.md`, `DIAGNOSTIC_REPORT.md`, `SETUP_GUIDE.md`,
  `docs/IOS_NATIVE_SETUP.md`, `PUSH_NOTIFICATIONS.md`,
  `docs/PHASE_PRE_IMPLEMENTATION_STABILIZATION_FINAL_REPORT.md`,
  `docs/architecture.md`, `docs/memory.md`, `docs/phases.md` — still
  reference the old Lovable domain in places. Historical/narrative docs,
  not live config; flagged rather than mass-edited to keep this change
  scoped and reviewable.

**Correction to an earlier draft of this report:** I previously wrote that
no Google/Apple OAuth call site existed in this app. That was wrong — I'd
only grepped part of the file. `src/pages/Auth.tsx` has a complete,
already-correct `startOAuth()` implementation (native: fetches the
authorize URL and hands it to the system browser; web: standard top-level
`signInWithOAuth` redirect) wired to a real "Continue with Google" button.
It already uses `buildAuthRedirectUri("oauth")`, so it inherits this
session's origin fix automatically — no separate change was needed there.

## C. Supabase Dashboard settings you must configure manually

**Authentication → URL Configuration:**
- Site URL: `https://duospace-ten.vercel.app`
- Redirect URLs (add; you don't have to remove the Lovable ones yet):
  - `https://duospace-ten.vercel.app/**`
  - `https://duospace-ten.vercel.app/auth`
  - `https://duospace-ten.vercel.app/auth/callback`
  - `https://duospace-ten.vercel.app/reset-password`

**Authentication → Settings → SMTP Settings** (enable "Custom SMTP"):
- Host: `smtp.gmail.com`
- Port: `465`
- Username: your dedicated Gmail address
- Password: your Google App Password
- Sender email: same Gmail address
- Sender name: `DuoSpace`

I have not seen and do not need these credentials — enter them directly
in the Dashboard.

**Google Cloud Console** (only if you haven't already registered this
domain for the existing OAuth client): confirm
`https://duospace-ten.vercel.app/auth/callback` is in that OAuth client's
Authorized redirect URIs. This is separate from Supabase's own redirect
list and the code doesn't touch it.

**Vercel → Project → Environment Variables** (optional — all have working
fallbacks in code):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_PUBLIC_SITE_URL=https://duospace-ten.vercel.app` (belt-and-suspenders;
  `window.location.origin` already resolves this correctly on Vercel)

**Do NOT configure Resend/DNS-dependent items** — separate, independent
system from Auth SMTP. `Resend_api_key` / `EMAIL_FROM` (Edge Function
secrets) only gate the app's own custom notifications (new-device sign-in
alerts, the email-linking one-time code in Settings) — not signup/reset
emails. Leave alone if you don't need those two features working right now.

## D. Exact Auth URL / redirect settings (summary)

| Purpose | Redirect URL |
|---|---|
| Signup confirmation | `https://duospace-ten.vercel.app/auth` |
| Resend confirmation | `https://duospace-ten.vercel.app/auth` |
| OAuth (Google) | `https://duospace-ten.vercel.app/auth/callback` |
| Forgot password / reset | `https://duospace-ten.vercel.app/reset-password` |

Site URL: `https://duospace-ten.vercel.app`

## E. Testing checklist

1. Sign up a brand-new test email → confirm the email arrives via Gmail.
   (Gmail SMTP has its own daily send caps — worth knowing if testing
   repeatedly.)
2. Click the confirmation link → lands on
   `https://duospace-ten.vercel.app/auth` → session established → redirected
   into the app.
3. Sign out, sign in with the now-confirmed account.
4. "Forgot password" from the login screen → confirm the reset email
   arrives.
5. Click the reset link → lands on `/reset-password` → set a new password
   → redirected in.
6. Click "Continue with Google" → completes and lands back on
   `/auth/callback` signed in (confirm the Google Cloud Console redirect
   URI from section C is set, or this will fail at Google's side before
   ever reaching your app).
7. In Settings, the "add email + password" flow (QR/passkey-only accounts)
   — confirm its OTP email still arrives (independent of the Gmail SMTP
   change, see section C's Resend note).
8. Trigger a new-device sign-in alert (log in from a browser/profile the
   account hasn't used before) — same independence note as above.
9. `npm run build` completes with no errors.

## F. Remaining problems discovered in the old ZIP

- `.gitignore` did not ignore any `.env*` files before this change. If a
  local `.env` was ever committed in this project's actual git history
  (not visible from a ZIP snapshot), worth running `git log -p -- .env`
  on your real repo — removing it from `.gitignore` going forward doesn't
  scrub history retroactively.
- The nine docs listed in section B under "Not changed" still describe the
  old domain/deployment — no functional impact, worth a cleanup pass when
  convenient.
- `docs/SUPABASE_PROJECT_CONFIGURATION.md` had already flagged "Auth
  redirect URLs configured in the Dashboard actually match
  `supabase/config.toml`" as needing live verification — still true now,
  restated in section C.

## G. Ready to deploy?

**Code: yes.** Self-contained, no new dependencies, no schema changes, no
unrelated feature touched.

**Not yet, pending your action on:**
1. Entering the Gmail SMTP credentials in the Supabase Dashboard (section C).
2. Adding the redirect URLs in the Supabase Dashboard (section C) — the
   code change alone doesn't make Supabase accept these URLs.
3. Confirming the Google Cloud Console redirect URI (section C) if this is
   a new domain for that OAuth client.
4. Running the testing checklist (section E) — none of this could be
   live-verified from this sandbox (no network access to Supabase/Vercel/
   Gmail/Google from here).
