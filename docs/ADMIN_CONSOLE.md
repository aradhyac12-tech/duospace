# Admin console (v3.21.0)

Source: `supabase/migrations/20261003100000_admin_console.sql`, `supabase/functions/admin-user-action/`, `src/components/admin/*`, `src/pages/settings/AdminSettings.tsx`, `src/lib/admin/adminApi.ts`, `src/components/{UserNoticeHost,AppUpdateHost,BlockedGate}.tsx`.
**Status: source only. Migration NOT applied, function NOT deployed, nothing run on a device.**

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

## Manual test matrix (NOT RUN)
1. Non-admin account: Settings has no Admin row; calling any `admin_*` RPC returns "admin only".
2. Users tab: a linked couple shows each side pointing at the other; unlink one side → shows "One-way".
3. Grant Beta to a user with the app open → card appears live; "Enjoy!" closes it; it does not return after restart; their plan now reads BETA. Repeat with app closed → push, card on open.
4. Grant Founder to someone whose partner is on Plus: partner's plan is unaffected.
5. Revoke → gentle notice, plan returns to FREE (or their partner-derived plan).
6. Block: user is signed out within seconds (BlockedGate) and cannot sign in ("blocked by an admin"); unblock restores sign-in. Blocking yourself / the admin is refused.
7. Verify email on an unverified account → can sign in.
8. Announcement with audience "solo" is seen only by users without a partner; dismissal is permanent; "hide" removes it for everyone.
9. App update: set latest above the installed version → dismissible card on Android; set minimum above installed → blocking screen; unset (0.0.0) → nothing.
10. Payments: with seeded `payment_transactions` rows (paid / refunded / failed) the summary and filters match.

## Not done / by design
- **Team members with roles** (video, item 8): not built. The ADMIN plan is deliberately limited to one allowlisted account by a database trigger; adding more admins means loosening that guarantee, so it needs an explicit decision first.
- **Refund / cancel from the console**: not built. Refunds happen in Google Play Console / Razorpay; the console shows them once the webhook records them.
- **Commission** is an estimate from assumed rates (`private.est_fee_bps`: Play/Apple 15 %, Razorpay 2 %), not provider settlement data.
- **Block enforcement**: Auth ban stops sign-in and token refresh; an already-issued access token (≤ 1 h) still passes RLS until it expires. `BlockedGate` hides the app immediately, but it is a client screen. Hard server-side cutoff would need `user_moderation` checks added to RLS across tables (not done; RLS not touched).
- Push for announcements is capped at 1,000 devices per publish; the in-app card has no cap.
