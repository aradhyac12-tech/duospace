# Admin console (v3.21.0 → v3.21.1)

Source: `supabase/migrations/20261003100000_admin_console.sql` + `20261003170000_admin_console_hardening.sql`, `supabase/functions/admin-user-action/`, `src/components/admin/*`, `src/pages/settings/AdminSettings.tsx`, `src/lib/admin/adminApi.ts`, `src/components/{UserNoticeHost,AppUpdateHost,BlockedGate}.tsx`.
**Status (2026-10-03):** database side APPLIED to the live "Duospace" Supabase project (`jzlpelxwzjjpddqcrtpu`): `admin_console` (applied earlier, version 20261002203828), then `admin_console_hardening` and `admin_console_pin_est_fee_bps_search_path` (applied 2026-10-03). Verified on the live DB: rates seeded; fee maths 706 / 1055 / 4485 for a ₹299 payment (Razorpay / Razorpay subscription / Play); `admin_revoke_sessions` executable by `service_role` only; the re-created couples / transactions / summary / rates functions run as the admin; a non-admin is refused. **NOT done:** edge function `admin-user-action` is NOT deployed (so Block / Verify buttons will fail until it is), app NOT rebuilt, nothing run on a device, the other 11 test-matrix cases NOT run. Live data at that moment: 1 connected couple, 5 payment rows (all pending).
Note: applied DB versions are timestamped at apply time, so they differ from the file names here (same as the earlier migrations). The hardening file is idempotent, so a later `supabase db push` replaying it is safe.

## What it is
The old Admin screen (search + grant/revoke Founder/Beta) is now a 7-tab console, opened from Settings → Admin (still visible only to the `ADMIN` plan):

| Tab | Does | Backend |
|---|---|---|
| Overview | user/couple/paying counts, 14-day sign-ups | `admin_overview()` |
| Users | search + filters (connected, no partner, one-way, unverified, blocked, paid, Founder/Beta); each row shows **who the person is connected to**; detail sheet: grant/revoke, verify email, block/unblock | `admin_list_users()`, `admin-user-action` |
| Couples | every connected pair side by side (+ one-way links flagged) | `admin_list_couples()` |
| Access | granted Founder/Beta list **with each holder's partner**; search + give access | `admin_list_grants()`, existing `grant_entitlement` / `revoke_entitlement` |
| Payments | payments / refunds / failed / pending, totals per currency, estimated commission | `admin_payments_summary()`, `admin_list_transactions()` |
| Announce | important updates, offers, announcements (audience + optional push + expiry); app-update (latest / minimum version) | `admin_publish_announcement()` etc., `app_update_config` |
| Updates | upload an APK/IPA, publish / unpublish / delete, mark Required (OTA, v3.22.0; see `docs/OTA_APP_UPDATES.md`) | `admin_create_app_release()` etc., `app_releases`, bucket `app-releases` |
| Activity | audit log of every admin action | `admin_list_audit()` |

## "You've been granted access" card
A trigger on `entitlements` (`notify_user_on_complimentary_grant`) fires for every `founder_grant`/`beta_grant` insert (not self-grants, not purchases, not the bootstrap admin row): it writes a `user_notices` row and sends a push (`send-push`, type `custom`). In the app, `UserNoticeHost` (mounted in `AppLayout`) shows the celebration card ("An admin has granted you Beta/Founder access … Enjoy!") live via realtime, or on next open/foreground, and marks it seen. Revoking writes a gentler "access has ended" notice (no push). The card also nudges `useEntitlement` to re-read the plan.

## Security model (unchanged principles)
- Every admin RPC starts with `private.assert_admin()` = caller's effective plan is `ADMIN` (single allowlisted account, see `20260930100000`). A modified client gets an error, not data.
- RLS enabled on every new table. Clients have **no** write access to any of them; reads are own-row only (`user_moderation`, `user_notices`, dismissals) or via audience-filtered RPC (announcements). `app_update_config` is world-readable (version numbers + store links only).
- `service_role` is used only inside `admin-user-action`, and only **after** the caller passed the Postgres admin check as themselves. Never in client code.
- Scope is account metadata. The console cannot read messages, media, calls or locations, and cannot act as a user. Partner-link visibility is admin-only, shows no content, and every action lands in `admin_audit_log`.
- `ADMIN` still cannot be granted or blocked from here; paid plans still cannot be granted.

## Deploy order
1. `supabase db push` (staging first) - applies `20261003100000_admin_console.sql`. It needs `private.dispatch_push` + Vault secrets (already required by other push triggers) for the grant push; without them the card still works, only the push is skipped.
2. `supabase functions deploy admin-user-action` (default `verify_jwt = true` is correct).
3. Regenerate `src/integrations/supabase/types.ts` if you want typed RPCs (the console works without it).
4. Build the app. Then run the matrix below.

## Decisions (v3.21.1) — what was researched, what was chosen, why
Research: Supabase docs (managing users, signing out), a supabase/auth PR, Google Play Console fee page, Razorpay pricing pages. Secondary sources are marked.

| Question | Finding | Decision |
|---|---|---|
| Does a ban end a session? | **No.** Supabase: "a temporary ban only blocks sign-in … does not revoke existing sessions"; access tokens are stateless JWTs valid until `exp` (default 3600 s), even after sign-out or user deletion. | Block = ban **+ delete the user's sessions** (`admin_revoke_sessions`, service_role only) **+** the `BlockedGate` screen. Residual window = the token's remaining life (≤ 1 h). |
| Close that window fully? | Only by checking block status on every request (RLS) or `session_id` against `auth.sessions` on sensitive operations; or by shortening JWT expiry. | **Not done in code.** RLS across the chat/media tables can't be validated without a database here, and a mistake would break messaging for everyone. **Owner action (optional):** shorten *JWT expiry* in the Supabase dashboard (Auth → sessions/JWT settings); shorter = smaller window, more refresh traffic. A blocked person can only reach their own partner's data anyway, so severity is low. |
| Google Play commission | Subscriptions are **15 % effective** (10 % service + 5 % billing fee when using Play Billing; unchanged since Jan 2022). | Seeded `google_play = 15 %`. Assumes Google returns its fee on refunds (unverified) → `retained_on_refund = false`. |
| Razorpay commission | **2 % + 18 % GST = 2.36 %**; the fee on a refunded payment is generally **not** returned. Razorpay Subscriptions add ≈ 0.99 % + GST (third-party source, **confirm in your dashboard**). | Seeded `razorpay = 2.36 %` (retained on refund), `razorpay_subscription_extra = 1.17 %`. v3.21.0 used 2 % and ignored the kept fee on refunds — both fixed. |
| Where do rates live? | They depend on the owner's contracts and change. | **Editable table** `commission_rates`, edited in Payments → "Commission rates used for estimates" (audited). Totals stay estimates. |
| Refund from the console? | Money-moving action; needs provider API credentials and idempotency work that can't be tested here. | **No.** Refund in Play Console / Razorpay. The console now shows each payment's provider transaction id to search for. |
| More admins / team roles? | (Judgment, no external source.) ADMIN is intentionally one allowlisted account by DB trigger. | **Keep it single.** For a solo owner, extra roles add attack surface with no user. When a real teammate exists, add a *separate* read-only "support" role (view users/couples, verify email) rather than widening ADMIN. |

## Other v3.21.1 changes
- **Grant card copy fixed.** v3.21.0 listed perks I had not checked ("higher media & music limits", "priority AI and support") — not enforced (`docs/DUOSPACE_FEATURE_AUDIT.md`). The card now shows `PLAN_MARKETING.PRO.highlights`, which `marketing.test.ts` restricts to ENFORCED benefits. Founder/Beta are Pro-*level*: today that means higher AI limits + everything in Plus.
- **Couples tab** shows a pair whose 14-day unlink is counting down (from "Stop sharing"; irreversible) — they are still connected until it executes.
- Rebased on your `duospace-v3_21_0-full-updated.zip` (stop-sharing/unlink, re-auth, chat-only mode, Pro sales resumed). None of those files were changed; admin files were identical in that zip.

## Deploy order (updated)
1. ~~Apply the migrations~~ — DONE on Duospace (see Status). Not applied to `duospace-staging` (that project is INACTIVE).
2. `supabase functions deploy admin-user-action` — **STILL TO DO** (the new version calls `admin_revoke_sessions`).
3. Check Payments → commission rates against your real Razorpay / Play terms.

## Manual test matrix (NOT RUN)
1. Non-admin account: Settings has no Admin row; calling any `admin_*` RPC returns "admin only".
2. Users tab: a linked couple shows each side pointing at the other; unlink one side → shows "One-way".
3. Grant Beta to a user with the app open → card appears live; "Enjoy!" closes it; it does not return after restart; their plan now reads BETA. Repeat with app closed → push, card on open.
4. Grant Founder to someone whose partner is on Plus: partner's plan is unaffected.
5. Revoke → gentle notice, plan returns to FREE (or their partner-derived plan).
6. Block: user sees the blocked screen within seconds and cannot sign in ("blocked by an admin"); their old refresh token no longer works (sessions deleted); unblock restores sign-in. Blocking yourself / the admin is refused.
7. Verify email on an unverified account → can sign in.
8. Announcement with audience "solo" is seen only by users without a partner; dismissal is permanent; "hide" removes it for everyone.
9. App update: set latest above the installed version → dismissible card on Android; set minimum above installed → blocking screen; unset (0.0.0) → nothing.
10. Payments: with seeded `payment_transactions` rows (paid / refunded / failed) the summary and filters match; a refunded Razorpay row adds its fee to "kept on refunds", a refunded Play row does not; changing a rate changes totals.
11. Couples: start "Stop sharing" on a linked account → that pair shows the countdown banner; it still appears as Connected.
12. Grant card shows only the two lines from `PLAN_MARKETING.PRO.highlights`.

## Not done / by design
- **Team members with roles** (video, item 8): deliberately not built — see Decisions.
- **Refund / cancel from the console**: not built. Refunds happen in Google Play Console / Razorpay; the console shows them once the webhook records them.
- **Commission** is an estimate from editable rates (`commission_rates`), not provider settlement data.
- **Block enforcement**: Auth ban stops sign-in and token refresh; an already-issued access token (≤ 1 h) still passes RLS until it expires. `BlockedGate` hides the app immediately, but it is a client screen. Hard server-side cutoff would need `user_moderation` checks added to RLS across tables (not done; RLS not touched).
- Push for announcements is capped at 1,000 devices per publish; the in-app card has no cap.
