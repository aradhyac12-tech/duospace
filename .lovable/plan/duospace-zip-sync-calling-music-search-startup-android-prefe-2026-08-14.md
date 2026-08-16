# DuoSpace — ZIP sync + calling, music search, startup, Android Preferences

## What I verified first

Compared `duospace-redesign-final-2.zip` (490 files) against the workspace (458 tracked files):

- 32 files exist **only in the ZIP**: notification sound assets (`public/sounds/*`, `native/android/res_raw/*`, `native/ios/Sounds/*`), `src/lib/notificationSounds.ts`, `src/lib/authErrors.ts`, `src/pages/settings/NotificationsSettings.tsx`, `supabase/functions/_shared/soundCatalog.ts`, two new migrations (notification sound prefs, WhatsApp import batches/media), `scripts/patch-android-signing.mjs`, `scripts/verify-apk.mjs`, `.github/workflows/android-build.yml`.
- 38 files differ in content, including `src/App.tsx`, `src/pages/Auth.tsx`, `src/pages/Chat.tsx`, `src/pages/Settings.tsx`, `src/contexts/GroicContext.tsx`, `src/components/FloatingDock.tsx`, Groic players, chat composer/timeline, CallKit bridge (web + Kotlin + Swift), push/email edge functions, `package.json`, native patch scripts.
- Nothing in the workspace is missing from the ZIP except `bun.lock`.
- No `android/` or `ios/` folder is committed — native projects are generated locally via `npm run cap:add:*`.

## Phase 1 — Sync the ZIP as source of truth

Copy every ZIP file over the workspace (excluding any git metadata), keeping `bun.lock`. Reinstall dependencies against the ZIP's `package.json`, then run typecheck, lint, tests, and a production build; fix only breakages the sync itself introduces.

## Phase 2 — Calling UI/UX

Current state: `src/lib/callUiState.ts` already derives `idle / connecting / ringing / connected / reconnecting / partner-left / error`, but `Calls.tsx` (844 lines) and `chat/CallOverlay.tsx` render their own control layouts, and terminal outcomes only cover no-answer / cancelled-elsewhere / failed.

- Extend the state machine to the full requested set (`initiating, declined, busy, cancelled, missed` added to the existing states) as pure derivation — no changes to Daily.co, CallKit, push, or the `daily-call` edge function.
- Render the call screen immediately on tap: mount the screen with local avatar/name from already-loaded context, and never gate first paint on room creation, token fetch, or profile queries.
- Extract one shared control bar and one shared status/header component used by both `Calls.tsx` and `CallOverlay.tsx`, built from existing tokens: 56px targets, clear active/inactive states, haptics per the documented `CALL_HAPTIC_SEMANTICS`, end-call visually separated to avoid mis-taps.
- Audio call: large avatar, name, duration, status line, mute / speaker+route / camera-switch-off / end.
- Video call: full-screen remote, draggable PiP local preview, tap-to-reveal controls with 4s auto-hide, transform/opacity-only animations.
- Incoming call: caller identity, avatar, audio/video badge, accept/decline, ring state — keeping existing push/deep-link invitation handling.
- Failure UX: map every known failure (permission denied, no Daily key, 401/402/429/5xx from the edge function, join timeout) to a human sentence via the existing `callErrors.ts` + `edgeFunction.ts` mapping, each with Retry / Back to chat, and permission guidance only when permission is the actual cause.
- Screen share: `toggleScreenShare` exists in `useDailyCall`; verify the track-subscription path and surface the real reason when the platform rejects it (mobile Safari / Android WebView cannot capture display), instead of a silent no-op.

## Phase 3 — Music search

Traced: `Groic.tsx` → `invokeEdgeFunction("music-search")` → edge function → YouTube Data API (needs `YOUTUBE_API_KEY`) → Piped mirrors → **hardcoded `fallbackResults()`**.

Root causes to confirm and fix, in this order:
1. `fallbackResults()` returns six hardcoded songs for *any* query, so a fully failed search looks like a wrong-results search. This is the mock data the request forbids — remove it and return an honest empty/error result.
2. Public Piped mirrors are unreliable; when `YOUTUBE_API_KEY` is unset the function has no working provider. Add a keyless Invidious/Piped mirror rotation plus the YouTube API path, and report `source` and provider errors distinctly.
3. Client side: add request-generation guarding so a stale response cannot overwrite newer results, cancel in-flight requests on query change, clear results/loading immediately on empty input, and render distinct loading / results / "No results found" / error-with-Retry states.
4. Remove the duplicated client-side Piped fallback in `Groic.tsx` so the edge function stays the single search path (secrets remain server-side).

## Phase 4 — Post-splash delay

Confirmed contributors: `SplashScreen.tsx` runs a scripted ~1.5s timeline with `setTimeout` gates; `useLaunchPermissions` hides the native splash then `await`s a 300ms sleep and requests media, push, and geolocation permissions sequentially; `ProtectedRoutes` blocks routing on a `profiles` query before rendering.

- Render the authenticated shell as soon as the session is known; move the profile/onboarding query to a non-blocking check that defaults to "returning user".
- Defer push registration, call SDK warm-up, Groic init, and permission prompts to after first interactive paint, running independent ones concurrently.
- Cut the splash to the minimum needed for a clean handoff and remove the artificial post-hide sleep.

## Phase 5 — Android "Preferences plugin is not implemented"

`@capacitor/preferences@^8.0.1` matches Capacitor 8 in `package.json`, and `scripts/verify-android-build.mjs` already asserts it appears in `capacitor.plugins.json`. The error therefore comes from a native project generated/built without a successful `cap sync`, or from Preferences being called before the bridge is ready.

- Add a small typed Preferences wrapper used by `capacitorAuthStorage.ts`, `deviceId.ts`, and `useCloudBackup.ts` that waits for the Capacitor bridge, uses the real native plugin on native, uses the official web implementation on web, and logs loudly (never silently swallows) if the plugin is genuinely missing — no localStorage substitution on native.
- Strengthen `verify-android-build.mjs` and document the required `npm run cap:sync` step so a missing registration fails the build instead of appearing at runtime.
- Preserve existing stored keys (auth session, device id, onboarding, theme, language, notification/call/music settings) — no key renames, no migration wipes.

## Phase 6 — Capacitor consistency

Verify plugin/core version alignment across `package.json`, run `cap doctor`-equivalent checks in the sandbox, and leave native folders untouched (none are committed; the ZIP's patch scripts remain the generation path).

## Phase 7-8 — Performance and error handling

Targeted only: remove duplicate Supabase subscriptions and effect re-subscribes found while working in the touched files, add missing cleanup, and ensure no raw `undefined` / `[object Object]` / provider error reaches the UI.

## Dock glassmorphism

`index.css` already defines a `.glass-dock` utility with the Apple-style blur/saturation and specular sheen, but `FloatingDock.tsx` renders `surface-dock`. Switch the dock to the glass treatment (with the existing reduced-transparency fallback).

## Groic partner sync

`GroicContext` uses a Supabase broadcast channel keyed by the sorted user/partner pair with host tick broadcasts. Audit and fix: channel recreation churn on partner-id changes, guest drift correction thresholds, invite/join state when one side reloads, and missing teardown — target no perceptible lag between partners.

## Phase 9 — Verification I will actually run

Typecheck, lint, unit tests, production build, and browser-driven checks of splash → app, auth'd/unauth'd launch, music search (query / no results / network failure / rapid repeats), and call screen states reachable without a second live device.

**Cannot run here:** Android/iOS Gradle-Xcode builds, `npx cap sync` against real native projects, real device Preferences read/write, real two-device calling, and Edge Function deployment. I will report these explicitly as unverified rather than claiming they pass.
