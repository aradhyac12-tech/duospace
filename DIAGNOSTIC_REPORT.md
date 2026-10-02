# DuoSpace Android Google OAuth — Diagnostic Report

## Root cause (confirmed via live Supabase auth logs, project jzlpelxwzjjpddqcrtpu)

Pulled `auth` service logs for the last 24h. Every recent Google login (04 attempts
between 04:20–04:22 UTC today) shows the same pattern:

- `GET /authorize` — `referer: duospace://auth` ✅ (native correctly initiates OAuth
  with the `duospace://auth` redirect_to)
- `GET /callback` — `referer: https://web-duospace.lovable.app` ❌
- `POST /token` — `referer: https://web-duospace.lovable.app` ❌ (login succeeds, but
  inside the web app, not the APK)

**Supabase's `/callback` never redirected to `duospace://auth`.** It fell back to the
web Site URL instead. This is not a code bug — it's the Supabase Auth **Redirect URLs
allow-list** (Dashboard → Authentication → URL Configuration). If `duospace://auth`
(and `duospace://auth/reset-password`) aren't in that list, Supabase silently ignores
the app's requested `redirect_to` and falls back to the Site URL, which is exactly the
"opened the web DuoSpace app instead of returning to the APK" symptom.

**Action required (cannot be done from source code / this sandbox — no dashboard
write access here):**
1. Supabase Dashboard → Authentication → URL Configuration → Redirect URLs
2. Add exactly:
   - `duospace://auth`
   - `duospace://auth/reset-password`
3. Save. Re-test — `/callback` and `/token` referer should then show `duospace://auth`.

Until this is added, no source-level fix will make the native callback work — Supabase
rejects/redirects away from any `redirect_to` not on that list before the app ever
gets a chance to see it.

## Code-level issues found and fixed

The native flow itself (PKCE, `duospace://auth` scheme, `Browser.open`/`close`,
`appUrlOpen` + `getLaunchUrl` cold-start fallback, single-use exchange) was already
correctly implemented in `src/lib/auth-redirect.ts`, `src/lib/auth-callback.ts`, and
`src/pages/Auth.tsx`. Two real bugs were found and fixed:

### 1. "Setting up…" infinite hang (`src/App.tsx`)
This is what "gets stuck on Setting up" actually is — it's **after** sign-in succeeds.
`ProtectedRoutes` awaits a `profiles` query with no try/catch and no timeout. If that
request throws (common right after the browser→app handoff, before network settles)
or simply stalls, `needsOnboarding` is never set and the screen hangs forever.
Fixed: wrapped in try/catch, raced against an 8s timeout, defaults to "not onboarding"
on failure/timeout so it always resolves.

### 2. No duplicate/race guard on the deep-link handler (`src/pages/Auth.tsx`)
Android can redeliver the same `appUrlOpen` event, and a cold start can hand the same
callback URL to both `getLaunchUrl()` and the first `appUrlOpen` event. A PKCE code is
single-use, so a second exchange attempt errors. Fixed: added a per-code dedupe set
and an in-flight guard, both reset in a `finally`. Also added a 20s timeout around
`exchangeCodeForSession` so "Completing sign in" itself can't hang forever either.

## What I could NOT verify in this environment

- No network access in this sandbox → could not run `npm install`, `npx cap sync`,
  `npx cap add android`, or a Gradle build. `android/` does not exist in the uploaded
  project (matches prior finding: `cap add android` has never been run against this
  checkout) — it's generated at build time (by your `cap:add:android` script, which
  also runs `patch-native-permissions.mjs` to inject the `duospace://auth`
  intent-filter, per your existing setup). I verified that script's logic is correct
  (correct scheme, host, action, both categories) but could not generate or inspect an
  actual `AndroidManifest.xml` from it here.
- Run this yourself (or in Codemagic) to get the real APK-level checks:
  ```
  npm install
  npx cap:add:android   # or: npx cap add android && npm run cap:patch-permissions
  npx cap sync
  cd android && ./gradlew clean assembleRelease
  ```
  Then confirm in the built manifest:
  `android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml`
  should contain:
  ```xml
  <intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="duospace" android:host="auth" />
  </intent-filter>
  ```

## Answers to the requested checklist

1. **Redirect URI Android actually uses**: `duospace://auth` (confirmed correct in
   `auth-redirect.ts` and in the `/authorize` request's referer in live logs).
2. **Final APK contains the deep-link intent filter**: not verified — no network/build
   tooling in this sandbox. `patch-native-permissions.mjs` logic verified correct;
   run the build yourself to confirm the merged manifest.
3. **`appUrlOpen` fires**: verified in source (registered on Auth page mount, before
   any OAuth click); not verified on-device.
4. **Authorization code received**: yes, per live logs (`/authorize` returns 302
   correctly) — but Supabase then redirects to the web Site URL, not the app, so the
   code currently never reaches `duospace://auth` on-device. Fixing the redirect
   allow-list (above) is required before this can be confirmed end-to-end.
5. **`exchangeCodeForSession` succeeds**: yes, but currently happening in the web
   context (`web-duospace.lovable.app`), not the APK — same root cause.
6. **`getSession()` returns the authenticated user**: not independently re-checked;
   `completeAuthCallback()` already logs `has_session`/`user_id` after exchange — check
   `auth.callback exchangeCodeForSession ok` in your logging backend after a real
   device test.
7. **App navigates to the authenticated DuoSpace screen**: was blocked by the
   `App.tsx` "Setting up…" hang (fixed above) even when a session was established.

## Only files changed
- `src/App.tsx`
- `src/pages/Auth.tsx`

No UI/UX, iOS, Codemagic config, or unrelated functionality touched.
