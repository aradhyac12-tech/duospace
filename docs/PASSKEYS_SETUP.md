# Passkeys (APK / iOS / web) — setup

## What was wrong

1. The APK/IPA runs the UI from a synthetic WebView origin (`https://localhost`
   on Android, `capacitor://localhost` on iOS). A browser-style
   `navigator.credentials.create/get` can never succeed there for a real
   relying-party domain, and the old edge-function code either minted an RP ID
   of `localhost` or threw "WebAuthn is not configured". Result: no passkey
   could be added and none could be used to sign in.
2. Native builds now use the OS credential APIs (Android Credential Manager /
   iOS AuthenticationServices) through `@capgo/capacitor-passkey`
   (`src/lib/webauthn.ts`). The web build still uses `@simplewebauthn/browser`.
3. The edge functions now take the RP ID and the accepted origins from secrets
   (`supabase/functions/_shared/webauthnOrigin.ts`), including Android's
   `android:apk-key-hash:…` origin, instead of echoing request headers.

## One-time configuration (cannot be done from code)

Pick the real domain you control — below it is `duospace.app`. If yours differs,
change it in **all three** places: `capacitor.config.json`
(`plugins.CapacitorPasskey.origin` + `domains`), the Supabase secret
`WEBAUTHN_RP_ID`, and the two files hosted on that domain.

1. **Supabase secrets**
   ```
   supabase secrets set WEBAUTHN_RP_ID=duospace.app
   supabase secrets set WEBAUTHN_ANDROID_CERT_SHA256="AA:BB:...,CC:DD:..."   # same fingerprints as assetlinks.json
   ```
   Optional: `WEBAUTHN_ORIGIN` (extra https origins, comma-separated).
2. **Host on the domain** (HTTP 200, no redirect, `Content-Type: application/json`):
   - `https://duospace.app/.well-known/assetlinks.json` — from `docs/passkey-association/assetlinks.json.template`
   - `https://duospace.app/.well-known/apple-app-site-association` (no extension) — from the `.template` next to it
   Fingerprint: `keytool -list -v -keystore <your.keystore> -alias <alias>` → SHA256.
   If Google Play App Signing is on, use the *Play* app-signing certificate fingerprint too.
3. **Deploy edge functions**: `supabase functions deploy webauthn-register-options webauthn-register-verify webauthn-login-options webauthn-login-verify`
4. **Rebuild** the native apps (`npm install`, `npx cap sync`). The plugin's sync hook
   writes the Android `asset_statements` and the iOS Associated Domains entitlement
   (`webcredentials:duospace.app`). iOS also needs the Associated Domains capability
   enabled for the App ID in the Apple Developer portal.

## Requirements / limits

- Android 9+ with Google Play services; iOS 16+.
- Passkeys created on the web at the same RP ID work in the apps and vice versa.
- Existing passkeys registered when the RP ID was `localhost` can't be used; re-add them.
- Email/password, OAuth and QR sign-in are unaffected and remain the fallback.

## Quick diagnosis

| Symptom | Cause |
|---|---|
| "Passkeys aren't configured on the server" | `WEBAUTHN_RP_ID` secret not set |
| Android: "no credentials available" / instant failure | `assetlinks.json` missing, wrong package, or wrong fingerprint |
| iOS error 1004 | AASA missing/wrong Team ID, or Associated Domains not enabled |
| "Verification failed" / origin mismatch | `WEBAUTHN_ANDROID_CERT_SHA256` doesn't include the signing cert of that build |
