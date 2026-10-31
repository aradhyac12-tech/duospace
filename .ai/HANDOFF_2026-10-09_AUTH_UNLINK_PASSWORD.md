# Handoff 2026-10-09 — unlink prompt, password + OTP, code-based reset

## Changed
- Unlink has TWO options on the Partner screen: (1) Request unlink (partner must Allow; instant) and (2) Stop sharing & unlink in 14 days (no approval). New migration 20261009100000_restore_request_unlink.sql restores request_unlink() — APPLY IT (supabase db push).
- Unlink: ScheduledUnlinkHost now shows ONE prompt when the partner stopped sharing (which already starts the 14-day unlink): "Okay" / "Stop sharing" (Stop sharing = same single stop_sharing RPC, behind re-auth). PartnerSettings keeps the button visible to the receiver ("Stop sharing"). Legacy request/approve dialog untouched (RPC is retired server-side).
- Password for OAuth users: new Onboarding "Create a password" step (only if account has an email and no password), PasswordOtpForm (password + confirm -> emailed 6-digit code -> saved), one-time PasswordPromptHost popup for existing users (shown once per account), Settings > Security "Add / Change password" row.
- UPDATE: Add/change password now uses Supabase's own email (auth.reauthenticate() + updateUser({password, nonce})) so codes go through the Gmail SMTP; set-email-password is no longer used by this form (still used by the QR add-email dialog). Dashboard: Authentication > Providers > Email > turn ON "Secure password change" (otherwise the code isn't enforced server-side).
- (older) set-email-password edge fn: uses the account's own email when it has one, stamps user_metadata.has_password. REDEPLOY: `supabase functions deploy set-email-password`.
- useReauth: password method if email provider OR has_password.
- Reset password: Auth.tsx forgot flow is now email -> 6-digit code + new password (verifyOtp type recovery + updateUser). No deep link needed. Old link flow still works if the email contains it.

## Manual (Supabase dashboard) steps — REQUIRED
- Auth > Email Templates: paste supabase/templates/magic_link.html ("Magic link"), recovery.html ("Reset password"), reauthentication.html. They use {{ .Token }} so the emails show a code instead of "Your sign-in link".
- Resend_api_key + EMAIL_FROM secrets must be set (set-email-password sends via Resend).

## Not verified
- No node_modules in sandbox: only syntax-checked, not built/tested on device.

## Crash fix
- DS-UNKNOWN-001 `ReferenceError: ProviderBadge is not defined` (Groic/Music screen): MusicUI.tsx used <ProviderBadge> but it was never defined; added it back (uses the existing PROVIDER_LABEL/PROVIDER_DOT).
