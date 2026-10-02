# QR partner link — "shows success but doesn't link" (2026-09-20)

## Symptom
Scanning the partner's QR showed "Linked ✓" but the two accounts were not partners.

## Root causes (all confirmed by reading the repo; #3 also confirmed against the live DB function bodies)
1. **Signed-in ↔ signed-in scan linked nobody.** The QR shown by "Show my QR" is a `signup_invite`
   token. `redeem-qr-token` returned `{kind:"signup_invite"}` and did nothing else; the scanner
   screens (PartnerSettings, Onboarding) then toasted "Linked ✓" unconditionally.
2. **Deferred link (someone signs up after the scan) could never complete.**
   `complete_qr_pending_link(_user_id)` searched `redeemed_by_user_id = _user_id`, but that column is
   the *scanner*, while the caller is the *issuer* → always NULL. Auth.tsx also called it (and
   `link_partners`) right after `signUp()`, when "Confirm email" leaves no session → the calls ran as
   `anon`, which has no EXECUTE grant → swallowed as "auto-link skipped".
3. **Security: `link_partners(_a,_b)` was callable by any signed-in user with arbitrary ids** (live
   grants: `authenticated: EXECUTE`, no ownership check). It also unlinked only one side of a
   pre-existing pair.

## What changed
| Where | Change |
|---|---|
| `supabase/migrations/20260920130000_qr_partner_link_fix.sql` | `link_partners` guarded + service-role only; new `claim_qr_partner_link(_token)`; `complete_qr_pending_link` → no-op; `qr_pairing_tokens.claimed_by_user_id` |
| `functions/redeem-qr-token` | signed-in scanner + `signup_invite` → link on the spot (`kind:"partner_linked"`), pre-checks so a refused link doesn't burn the QR, token handed back if the link fails; records the right `pending_partner_for` for the two deferred cases |
| `functions/check-qr-token-status` | reports `linked_partner` for `signup_invite` so the QR-showing phone can tell "linked" from "scanned" |
| `src/lib/qrPartnerClaim.ts` (new) | remembers the raw token; claims it once a session exists |
| `App.tsx` | `ProtectedRoutes` claims a pending link on sign-in |
| `QRSignInScanner/Display`, `Auth`, `Onboarding`, `PartnerSettings`, `DevicesSettings` | success copy only when the server confirmed a link; refresh after linking; no more `link_partners` from the client |

## DEPLOY STATUS (2026-09-20)
Migration applied, `redeem-qr-token` redeployed and `check-qr-token-status` deployed (first time) on jzlpelxwzjjpddqcrtpu — see KI-32 for what was verified. Still needed: ship the app build and run the two-phone test below.

## DEPLOY ORDER (was required — client-only can't fix this)
1. Apply the migration (SQL Editor, or `supabase db push`).
2. Deploy `redeem-qr-token` and `check-qr-token-status`.
3. Ship the app build.

## Not verified
Nothing here has run on a device, and no request has hit the deployed functions yet. The migration was applied and its catalog state checked; its logic paths beyond NOT_SIGNED_IN have not been exercised.
The JS claim logic was executed in Node against mocks (19 checks). Two-phone test plan:
- A: Onboarding/Settings → "Show my QR". B (signed in): Settings → "Scan partner's QR". Expect "Linked ✓" on B,
  and "Linked ✓" on A within ~2 s; Settings on both shows the partner.
- A signed out shows QR; B signed in scans → "Scanned ✓" → A signs up + confirms email on the same phone →
  "Linked ✓" appears on first launch.
- B scans a QR while already paired to someone else → clear "already linked" error, A's QR still works.
Known limit: the deferred claim is remembered per-device (localStorage, 48 h). If the confirmation email is
opened in a different browser/phone than the one that signed up, link from Settings instead.
