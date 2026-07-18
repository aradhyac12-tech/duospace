## Goals

1. Fix Google sign-in "403. That's an error. We're sorry, but you do not have access to this page."
2. Remove Apple sign-in from the UI entirely (no Apple device available); replace that slot with QR sign-in as the secondary option.
3. Fix "Unable to contact the server" on the QR display/scan screens (edge functions not reachable on the BYO Supabase project).
4. Rebuild native (Capacitor) so camera permission works for the QR scanner on device.also all permissions should be asked after a splash screen only 
5. I will provide you the apk icon and i want you to make that default icon while other icons available or create a perfect icon for DUOSPACE 

## Diagnosis (based on current state)

**Google 403** — Google's "you do not have access to this page" 403 on the OAuth consent screen almost always means one of:

- The OAuth Client's **Authorized redirect URI** in Google Cloud Console does not exactly include `https://jzlpelxwzjjpddqcrtpu.supabase.co/auth/v1/callback` (Supabase's callback — not the app URL).
- The OAuth consent screen is in **Testing** mode and the signing-in Google account is not on the test users list.
- Wrong Client ID/Secret pasted into Supabase Providers → Google (mismatch between what Google issued and what Supabase sends).

None of these are code — they're Google Cloud Console + Supabase Dashboard settings. I'll give you the exact values to paste.

**QR "Unable to contact the server"** — network log confirms `POST /functions/v1/qr-anon-issue → Failed to fetch`. This is a **transport failure to a function that isn't deployed** on your BYO Supabase project. All QR edge functions (`qr-anon-issue`, `issue-qr-token`, `redeem-qr-token`) live in this repo under `supabase/functions/` but were never pushed to `jzlpelxwzjjpddqcrtpu`. I cannot deploy to your project from here — you have to run `supabase functions deploy` yourself. I'll produce a single copy-paste script.

**Apple** — remove from `Auth.tsx` UI + any provider handler. Replace the slot with the existing QR sign-in entry point so the alternate sign-in method is still there.

**Native camera** — `capacitor.config.ts` + iOS `Info.plist` / Android `AndroidManifest.xml` already have camera entries (per earlier setup). What's missing is the sync + rebuild after the auth changes. This is a local user command, not something I run.

## Changes I will make (frontend only — auth-scoped)

1. `**src/pages/Auth.tsx**`
  - Remove the "Continue with Apple" button and its `signInWithOAuth({ provider: "apple" })` handler.
  - Replace that slot with a "Sign in with QR code" button that opens the existing `QRSignInScanner` (already imported/used elsewhere).
  - Keep Google button, email/password, and existing QR-invite flow untouched.
2. `**src/components/auth/QRSignInDisplay.tsx` + `QRSignInScanner.tsx**` — no logic change, but improve the error message so when the edge function 404s (not deployed) users see `"QR sign-in isn't available yet — the server component hasn't been deployed."` instead of the generic network message. Purely presentational.
3. No changes to `edgeFunction.ts`, `client.ts`, `useAuth.tsx`, or any chat/call/other feature code.

## What you must do (I cannot do these from Lovable on a BYO Supabase project)

### A. Fix Google 403 — Google Cloud Console

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → your OAuth 2.0 Client ID (Web application).
2. Under **Authorized redirect URIs**, ensure this exact value is present (add if missing, save):
  ```
   https://jzlpelxwzjjpddqcrtpu.supabase.co/auth/v1/callback
  ```
   Not your app URL. Not `/oauth/callback`. Exactly `/auth/v1/callback` on the Supabase host.
3. Under **Authorized JavaScript origins**, add:
  ```
   https://id-preview--8d9c3eda-6653-478e-bc47-b4ffd4636f5f.lovable.app
   http://localhost:8080
  ```
   (plus your published domain when you publish).
4. Go to **OAuth consent screen**. If Publishing status = **Testing**, either:
  - Click **Publish app** (moves to Production — anyone can sign in), OR
  - Add the Google accounts you're testing with under **Test users**.
5. Copy the **Client ID** and **Client secret** from the credential page.
6. In Supabase Dashboard → Authentication → Providers → **Google**: enable, paste Client ID + Client secret, save.
7. In Supabase Dashboard → Authentication → URL Configuration:
  - **Site URL**: your app's canonical URL (preview URL for now, published URL later).
  - **Redirect URLs** (add each):
    ```
    https://id-preview--8d9c3eda-6653-478e-bc47-b4ffd4636f5f.lovable.app/**
    http://localhost:8080/**
    duospace://**
    ```
    The `duospace://` entry is required so Capacitor native returns to the app after OAuth.

### B. Deploy edge functions to your Supabase project

From your local checkout of this repo:

```bash
# one-time
npm i -g supabase
supabase login
supabase link --project-ref jzlpelxwzjjpddqcrtpu

# deploy the auth-related functions
supabase functions deploy qr-anon-issue --no-verify-jwt
supabase functions deploy issue-qr-token
supabase functions deploy redeem-qr-token --no-verify-jwt
supabase functions deploy notify-signin
supabase functions deploy webauthn-login-options --no-verify-jwt
supabase functions deploy webauthn-login-verify --no-verify-jwt
supabase functions deploy webauthn-register-options
supabase functions deploy webauthn-register-verify
supabase functions deploy set-email-password
```

`--no-verify-jwt` on `qr-anon-issue`, `redeem-qr-token`, `webauthn-login-*` is required because those are called before the user has a session.

### C. Native rebuild for camera

```bash
git pull
npm install
npm run build
npx cap sync ios      # or android
npx cap run ios       # or android
```

The Info.plist / AndroidManifest already have `NSCameraUsageDescription` and `<uses-permission android:name="android.permission.CAMERA"/>` from the previous setup — no edits needed, just a sync + rebuild.

## Credentials checklist — where each value goes


| Credential                 | Where you get it                   | Where it goes                                                      |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Google OAuth Client ID     | Google Cloud Console → Credentials | Supabase Dashboard → Auth → Providers → Google → **Client ID**     |
| Google OAuth Client Secret | Google Cloud Console → Credentials | Supabase Dashboard → Auth → Providers → Google → **Client Secret** |
| Supabase project URL       | already saved                      | already in `src/integrations/supabase/client.ts`                   |
| Supabase anon key          | already saved                      | already in `src/integrations/supabase/client.ts`                   |


No Apple credentials needed anymore (removed).

## Out of scope

Chat, calls, gallery, Groic, backups, and any non-auth code stay untouched.