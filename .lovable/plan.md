# Sync uploaded build + Fix native OAuth deep-link

You chose "Everything" — apply the full uploaded zip and then verify the auth root cause is actually fixed.

## Root cause (native Google login opens the web app)

On Android/iOS, the app already does the right thing in JS: `signInWithOAuth({ skipBrowserRedirect: true })` → open Google in the system browser via `@capacitor/browser` → wait for `appUrlOpen` deep link on `duospace://auth` → `exchangeCodeForSession`.

The failure is one step earlier: **`duospace://` is never registered as an OS-level URL scheme in the native projects**. Capacitor's `ios.scheme` / `androidScheme` config only affects how the WebView loads local pages — it does NOT register an external deep link. So after Google → Supabase → `duospace://auth?code=…`, the OS has no app to hand the URL to, the browser silently follows Supabase's fallback (Site URL = the web app), and the user "logs into the web app" instead of returning to native.

The uploaded zip fixes exactly this by extending `scripts/patch-native-permissions.mjs` to also inject:
- iOS `CFBundleURLTypes` → `duospace` scheme in `ios/App/App/Info.plist`
- Android `<intent-filter>` with `android:scheme="duospace" android:host="auth"` in the launcher Activity of `android/app/src/main/AndroidManifest.xml`

…run via `npm run cap:patch-permissions` after every `cap add` / `cap sync`. Idempotent.

## Plan

1. **Sync the entire uploaded zip into the project** (overwriting existing files, skipping `.git`, `node_modules`, `dist`, lockfiles). This brings in:
   - Auth root-cause fix: `scripts/patch-native-permissions.mjs` (adds native URL scheme registration + camera/mic/photo usage strings).
   - `capacitor.config.ts` — comment cleanup pointing to the patch script.
   - `src/lib/auth-redirect.ts`, `src/pages/Auth.tsx` — remove overly aggressive localhost/null origin throws that were blocking legitimate preview flows.
   - Unrelated bundled work (per your "Everything" choice): `SplashScreen.tsx` + wiring in `App.tsx`, wallpapers/theme engine (`themeEngine.ts`, `textDensity.ts`, updated `ThemeContext`, `ThemeStudio`, `customThemes`, `index.css`), `BottomNav`, `GridMenu`, `Chat/Onboarding/Settings` tweaks, and new/updated icons (`favicon`, PWA 192/512, `icon-1024`, `apple-touch-icon`, `duospace-logo-full`, `resources/icon.png`).

2. **Add the `cap:patch-permissions` npm script** if the current `package.json` doesn't already expose it, so `npm run cap:patch-permissions` invokes the extended patch script.

3. **Verify build passes** and preview loads (auth screen still renders, Google/QR/email buttons still present and unchanged in behavior on web).

4. **Provide a clear native-verification checklist** you must run outside the sandbox (Lovable cannot execute `npx cap sync` for you). Root cause is only fully resolved once the native projects contain the URL scheme entries — no code change alone can bypass that.

## Post-apply verification checklist for native builds

After pulling this change, on your local machine:

```
npm install
npm run build
npx cap sync
npm run cap:patch-permissions
npx cap open ios      # or android
```

Then confirm:

- `ios/App/App/Info.plist` contains `<key>CFBundleURLTypes</key>` with `<string>duospace</string>`.
- `android/app/src/main/AndroidManifest.xml` launcher Activity contains an `<intent-filter>` with `android:scheme="duospace" android:host="auth"`.
- In Supabase Dashboard → Authentication → URL Configuration:
  - **Site URL** = `https://web-duospace.lovable.app`
  - **Redirect URLs** include all of:
    - `https://web-duospace.lovable.app/auth/callback`
    - `https://id-preview--8d9c3eda-6653-478e-bc47-b4ffd4636f5f.lovable.app/auth/callback`
    - `duospace://auth`
- In Google Cloud Console → your OAuth Web Client → Authorized redirect URIs contains:
  - `https://jzlpelxwzjjpddqcrtpu.supabase.co/auth/v1/callback`

## Files that will change

Roughly (from the zip diff):

- `scripts/patch-native-permissions.mjs` — **the actual auth fix**
- `capacitor.config.ts`
- `src/lib/auth-redirect.ts`
- `src/pages/Auth.tsx`
- `src/App.tsx`, `src/main.tsx`
- `src/components/SplashScreen.tsx` (new)
- `src/components/BottomNav.tsx`, `src/components/ThemeStudio.tsx`, `src/components/chat/GridMenu.tsx`
- `src/contexts/ThemeContext.tsx`, `src/lib/customThemes.ts`, `src/lib/themeEngine.ts` (new), `src/lib/textDensity.ts` (new), `src/index.css`
- `src/pages/Chat.tsx`, `src/pages/Onboarding.tsx`, `src/pages/Settings.tsx`
- `public/favicon.ico`, `public/apple-touch-icon.png`, `public/pwa-192x192.png`, `public/pwa-512x512.png`, `public/icon-1024.png`, `public/duospace-logo-full.png`, `resources/icon.png`
- `package.json` (only if the `cap:patch-permissions` script isn't already there)

## Out of scope

- Executing `npx cap sync` / building the APK/IPA (only you can do that outside Lovable).
- Editing your Supabase or Google Cloud dashboards (you must do this manually per the checklist).
- Any backend/edge-function or database changes.
