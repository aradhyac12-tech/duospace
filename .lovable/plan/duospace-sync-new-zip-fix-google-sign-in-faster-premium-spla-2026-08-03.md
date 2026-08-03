# DuoSpace: sync new zip, fix Google sign-in, faster premium splash, glass dock

## 1. Sync `duospace-main-fixed.zip` into the project

- Extract the archive (712 files, root folder `duospace-main/`) and copy it over the project, excluding any `.git` metadata, `node_modules`, and lockfiles.
- Preserve the working local config that the zip does not know about: `.env` (Supabase URL + anon key), the Supabase client fallbacks, the Vite aliases for the local `native-plugins/*` packages, and `supabase/config.toml` project id.
- Reinstall dependencies and fix any TypeScript/build errors the new sources introduce, then confirm the preview renders instead of a white screen.

## 2. Fix "Browser plugin is not implemented on android"

Root cause: `@capacitor/browser` is in `package.json` but the plugin is only registered natively after `npx cap sync` runs in the exported Android/iOS project. Until then (and on any device where the plugin is missing) every call throws and the Google flow dies.

- Make every `@capacitor/browser` call site defensive: try the plugin, and on `UNIMPLEMENTED`/import failure fall back to a plain `window.location.href` navigation (native system browser) so OAuth still completes via the `duospace://auth` deep link.
- Same guard for `Browser.close()` and the "open app settings" call in `mediaPermissions.ts` — a failed close must never block the session from being installed.
- Note in `BUILD.md` that `npx cap sync` is required after pulling, so the plugin gets registered properly in the APK.

## 3. Fix Google sign-in failure

- Audit `src/pages/Auth.tsx` + `src/lib/auth-redirect.ts` + `src/lib/auth-callback.ts` against the newly synced versions, keeping one platform-aware redirect: web -> current https origin `/auth/callback`, native -> `duospace://auth`.
- Ensure `skipBrowserRedirect: true` is used only on native (on web it must redirect normally), and that the web path never gets stuck waiting for a deep link.
- Surface the real provider/Supabase error text in the UI instead of a generic "Google sign-in failed", and log the trace through the existing telemetry so the failing stage is visible.

## 4. Splash screen: much faster and more premium

Current timeline runs 6 languages x 1.15s + 0.85s hold + 0.55s exit = about 6.6 seconds before the app appears. That is why it feels slow.

- Cut to a single sequence of roughly 1.4-1.8s total: 2-3 tagline beats maximum (or one line with a refined reveal), shorter crossfade, shorter exit.
- Skip the splash entirely on warm reloads (only show once per app session).
- Premium polish: crisper logo entrance with a subtle scale/shadow settle, a fine hairline shimmer sweep across the wordmark, tighter tracking, and an exit that hands off directly into the app with no dead frame.
- Keep animations transform/opacity-only so it stays smooth on low-end Android.

## 5. Dock glassmorphism (iOS/Instagram style)

- Rework `FloatingDock` surface: heavier `backdrop-blur-xl` with saturation boost, translucent layered background, a top inner highlight hairline and a soft bottom shadow, plus a subtle border that adapts to light/dark.
- All values via semantic tokens in `index.css` so it themes correctly (including vanish mode) rather than hardcoded colors.
- Keep the existing tab behaviour, badges, and active pill motion untouched.

## Technical notes

- Files expected to change: whatever the zip brings, plus `src/pages/Auth.tsx`, `src/lib/auth-redirect.ts`, `src/lib/auth-callback.ts`, `src/lib/mediaPermissions.ts`, `src/components/SplashScreen.tsx`, `src/components/FloatingDock.tsx`, `src/index.css`, `BUILD.md`.
- APK correctness beyond code (registering the `duospace` scheme, media permissions) still requires running `npm run cap:patch-permissions` and `npx cap sync` locally; the script already handles the manifest/Info.plist edits.
- Out of scope: chat, calls, and other feature work not named above.
