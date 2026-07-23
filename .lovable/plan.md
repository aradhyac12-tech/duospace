## Auth-only fix plan

1. **Stop the bad OAuth redirect**
  - Update the Google OAuth start flow so web preview uses the current app origin callback (`/auth/callback`) and native builds use `duospace://auth`.
  - Add a guard that rejects invalid callback targets like `null` or `http://localhost:3000` before OAuth starts, with a clear error instead of sending the browser to a dead URL.
2. **Make OAuth callback session handling robust**
  - Create a shared callback finalizer that handles both callback styles:
    - PKCE `?code=...` via `exchangeCodeForSession`
    - implicit/hash `#access_token=...&refresh_token=...` via `setSession`
  - Use it from both `/auth/callback` on web and Capacitor `appUrlOpen` on native.
  - After a session is installed, navigate to the protected app route instead of leaving the user on a callback/loading state.
3. **Fix native deep-link registration in code/docs where possible**
  - Keep `duospace://auth` as the native OAuth redirect URI.
  - Ensure the Capacitor flow opens Google in the system browser and closes it after the app receives the deep link.
  - Add a native configuration checklist in the project docs/comments for the exact Supabase allowed redirect URL and Android/iOS deep-link entries; if native platform folders are absent, the codebase cannot patch them directly yet.
4. **Remove Google button lag/double-click behavior**
  - Ensure the Google button enters loading immediately, disables while redirecting/opening browser, and does not get stuck if OAuth initiation fails.
  - Avoid extra session polling where the Supabase callback can complete directly.
5. **Fix QR edge function reachability from the app side**
  - Improve QR diagnostics so the UI distinguishes: function not deployed, CORS/preflight failure, and HTTP function errors.
  - Confirm `qr-anon-issue` and `redeem-qr-token` remain JWT-disabled in `supabase/config.toml` and use compatible CORS headers.
  - Add the exact deploy/config note needed for your existing Supabase project, because the current network signal is a transport-level `Failed to fetch` to `qr-anon-issue`, which usually means the function is not deployed or CORS is rejecting the preview origin before the function body runs.
6. **Verify in preview**
  - Run the web callback path locally with representative callback URLs and verify it installs/handles sessions without navigating to `null` or `localhost:3000`.
  - Verify `/auth` renders and the Google button/QR flows show correct states and errors.
7. **Add a new function in the manual log in the magic links and otp forget password links are not sending on the email it just shows the pop up of confimation link send to your email solve that add proper function where confirmation links recives and redirects to app properly with proper log in then forgot password and otps and device log in alert should also be received** 

**Out of scope:** unrelated chat/calls/features, data model changes, or changing your Google/Supabase provider credentials.