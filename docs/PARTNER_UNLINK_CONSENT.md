# Partner unlink now needs the partner's approval

Date: 2026-09-20. Status: **implemented in source — NOT VERIFIED** (no
database, `node_modules`, or device was available; nothing here was executed).

## Two problems fixed

1. **The unlink confirmation dialog stayed open after a successful unlink.**
   Root cause: `ConfirmActionDialog` never closed itself after `onConfirm`
   finished, and every caller assumed it did. `PartnerSettings.unlinkPartner`
   reset the page state and toasted, but `showUnlinkConfirm` stayed `true`.
   The same bug affected "Turn off App Lock?" (`SecuritySettings`).
   Fix: the dialog closes itself after `onConfirm` settles. A handler resolves
   `false` to keep it open for a retry (`Settings.handleSignOut` does this on
   failure, preserving its old retry behavior). Throwing also keeps it open.
2. **Either person could end the pairing alone.** `unlink_partner(uuid)` was
   executable by every signed-in user and cleared both sides at once. Worse,
   `profiles` allows `UPDATE` of one's own row with no column restriction, so a
   client could also just set `partner_id = NULL` directly. A consent step that
   only exists in the UI would have been cosmetic, so it is enforced in the DB.

## Flow

1. A taps **Unlink** → warning dialog ("Ask to unlink?", with an *Approval* row
   saying B must allow it) → `request_unlink()`.
2. B is notified: realtime (`unlink_requests`) and a push (`unlink_request`).
   `UnlinkRequestHost` (mounted in `AppLayout`) shows **Allow unlink / Keep us
   linked**; closing it means "decide later" and the ask is also listed on the
   Partner screen.
3. B taps Allow → `respond_unlink(id, true)` clears BOTH profiles in one
   transaction. Decline → nothing changes. A gets a toast and a push
   (`unlink_approved` / `unlink_declined`).
4. A can withdraw with **Cancel request** (`cancel_unlink`).
5. After an approved unlink each device forgets the cached partner and reloads
   (deferred until any active call ends), so Chat/Map/Groic/theme sync don't
   keep the ex-partner in memory.

Special cases (all in `request_unlink`): if the partner had already asked, both
want out and it completes immediately; if the link is already one-sided there
is nobody to consent, so the caller's dangling link is cleared. Requests expire
after 7 days; asking again makes a fresh one.

## Database (`20260920150000_partner_unlink_consent.sql`)

- `unlink_requests`: RLS `SELECT` for requester/receiver only; **no** client
  `INSERT/UPDATE/DELETE` grant or policy — the RPCs are the only writers. One
  open request per requester (partial unique index). In the realtime publication.
- RPCs (SECURITY DEFINER, `auth.uid()` based): `request_unlink()`,
  `respond_unlink(uuid, boolean)` (receiver only; refuses expired / handled /
  no-longer-linked), `cancel_unlink(uuid)` (requester only). They return
  `{ error: CODE }` instead of raising, matching the QR-claim RPCs.
- `unlink_partner(uuid)` revoked from `authenticated` (service_role keeps it).
- `guard_profiles_partner_id` `BEFORE UPDATE OF partner_id` rejects writes when
  `current_user` is `authenticated`/`anon`. Every legitimate writer is a
  SECURITY DEFINER function (runs as the owner) or an edge function
  (`service_role`). No client code writes `partner_id` (grep of `src/`).
- Push trigger via the existing `private.dispatch_push`; never blocks the write.

## Deploy order

1. Apply the migration. 2. Deploy the `send-push` edge function (new types
`unlink_request|unlink_approved|unlink_declined` in `_shared/pushTypes.ts` and
`_shared/fcm.ts` — without it the pushes get a 400). 3. Ship the app build.
An **old app build** can no longer unlink at all once the migration is applied;
it shows its normal "Failed to unlink" toast.

## Manual test matrix (run against a real project before trusting this)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | A: Unlink → Send request | Dialog closes; A sees "Waiting…"; still linked on both; B gets push + dialog |
| 2 | B: Allow unlink | Both profiles' `partner_id` NULL; both apps reload to "not linked"; A gets push |
| 3 | B: Keep us linked | Still linked; A sees a declined toast; A can request again |
| 4 | B closes dialog | Ask stays pending; card on Partner screen; dialog returns after restart |
| 5 | A: Cancel request | Row `cancelled`; B's dialog disappears live |
| 6 | Both tap Unlink at once | Completes immediately, no deadlock |
| 7 | Client runs `update profiles set partner_id = null` | Rejected (42501) |
| 8 | Client calls `unlink_partner` RPC | Permission denied |
| 9 | Client inserts/updates `unlink_requests` directly | Rejected |
| 10 | A (not receiver) calls `respond_unlink` on own request | `NOT_FOUND` |
| 11 | Answer after 7 days | `EXPIRED` |
| 12 | Approve after link already ended elsewhere | `NOT_LINKED`, row `expired` |
| 13 | Unlink request while offline | Toast, dialog stays open, retry works |
| 14 | QR / invite / partner-request linking still works | Unchanged (SECURITY DEFINER paths) |
| 15 | Approve during an active call | Reload waits until the call ends |

## Known limits

- If a partner never answers, the requester can't unlink (asks expire after 7
  days and can be repeated, but there is no override). That is the requested
  behavior; an "unresponsive partner" escape hatch is a product decision.
- Realtime plus the foreground push nudge and visibility re-check keep this
  live; a fully offline partner sees the request on next open.
- New tests: `src/test/partnerUnlink.test.ts`, `src/test/confirmActionDialog.test.tsx`
  — written, **not run**.
