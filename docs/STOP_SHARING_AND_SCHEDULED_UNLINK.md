# Stop sharing + 14-day scheduled unlink

Date: 2026-10-02. Status: **implemented in source — NOT VERIFIED.** No database,
`node_modules` or device was available. Only `node scripts/check-rls-coverage.mjs`
was run (passes). Nothing else here was executed — the new tests are written, not run.

## What was asked
1. An **immediate, unilateral "Stop sharing"**.
2. A **delayed, unilateral unlink after 14 days**.

The existing consent-based unlink (`request_unlink` / `respond_unlink` /
`cancel_unlink`, 20260920150000) is **unchanged** and still the fast path when
both people agree. The 14-day unlink is the escape hatch when they don't.

## Stop sharing — `20261002110000_stop_sharing.sql`
- `sharing_state` (row exists ⇔ stopped). Own-row `SELECT` only; the partner can't read it.
- `stop_sharing()` flips the switch first, then deletes my `locations` row, blanks my
  device status on `profiles`, and revokes the `relationship_shares` **I own**. Idempotent.
- `resume_sharing()` removes the row. Revoked shares stay revoked (revoke is permanent by design).
- Enforced in the DB, so it also covers the service-role `location-push-upload` function
  and native one-shot writes: `locations` writes are dropped (`RETURN NULL`, so offline
  queues don't retry forever), device-status columns are blanked, new `relationship_shares`
  raise `SHARING_STOPPED`.
- Not covered on purpose: chat/calls/gallery/playlist (the relationship continues), and
  presence (`last_seen_at`/`tracking_state`/`app_visibility`) because push routing reads it.
- The setting survives an unlink: stopped stays stopped for any future partner until resumed.
- **No push to the partner** — product decision for you to confirm; their Map shows its
  existing "unavailable/stale" state.

## Scheduled unlink — `20261002120000_scheduled_unilateral_unlink.sql`
- `scheduled_unlinks`: `execute_at` is **server-set** (`now() + 14 days`), immutable, clients read-only.
  One live schedule per requester. In the realtime publication.
- `schedule_unlink()` (idempotent, keeps the original date), `cancel_scheduled_unlink(id)`
  (**requester only** — the partner cannot block or cancel it).
- The **other person is told** (push `unlink_scheduled`) and sees the date on the Partner screen.
  A scheduled unlink is never secret.
- Completion goes through the same `private.apply_unlink()` as the consent path (profiles,
  accepted `partner_requests`, `relationship_shares`). `apply_unlink` is re-declared on top
  of 20260922100100 with one extra step: it voids any leftover schedule for the pair.
- Runs three ways, so it lands on time without relying on one: pg_cron every 5 min
  (guarded, no-ops if the extension is missing), `process_my_due_unlink()` when either
  person opens/foregrounds the app, and realtime/push nudges.
- A schedule only acts while the **same two people still point at each other**; otherwise
  it is `void` and touches nothing, so it can never sever a new pairing.
- Wrap-up on each device (clear cached partner + local conversation data + reload) reuses
  `useFinishUnlink`, once per schedule, including when it completed while the app was closed.

## Files
- SQL: the two migrations above (additive; no existing migration edited).
- Edge: `_shared/pushTypes.ts`, `_shared/fcm.ts` (+ `unlink_scheduled`, `unlink_completed`).
- App: `lib/scheduledUnlink.ts`, `hooks/useSharingState.ts`, `hooks/useScheduledUnlink.ts`,
  `components/ScheduledUnlinkHost.tsx` (mounted in `AppLayout`), `PartnerSettings.tsx`
  (UI + two confirm dialogs), `LocationContext.tsx` (`sharingActive` now follows the state),
  `usePushNotifications.ts` (routing + foreground nudge).
- Tests: `src/test/scheduledUnlink.test.ts` (helpers + static SQL checks).

## Deploy order
1. Apply both migrations. 2. Deploy `send-push` (without it the two new pushes get a 400,
but writes are never blocked). 3. Ship the app build. Old app builds keep working; they just
don't show the new controls (and an old build keeps sending location, which the DB drops
while sharing is stopped).

## Manual test matrix (run on a real project before trusting this)
| # | Scenario | Expected |
|---|----------|----------|
| 1 | A taps Stop sharing | Partner's Map loses A's location/battery at once; A still linked; chat/calls fine |
| 2 | A (stopped) keeps app open / background | No `locations` row reappears; native + push-upload writes dropped |
| 3 | A calls `update profiles set battery_level=50` while stopped | Stored as NULL |
| 4 | A shares a reflection while stopped | `SHARING_STOPPED` error |
| 5 | A Resume | Location/battery flow again; old shares stay revoked |
| 6 | A stops sharing, then unlinks and links someone new | Still not sharing until Resume |
| 7 | A schedules unlink | Row `scheduled`, `execute_at` ≈ now+14d; B gets push + sees date; still linked |
| 8 | A schedules twice | Same row/date returned |
| 9 | B tries to cancel A's schedule via RPC | `NOT_FOUND` |
| 10 | B inserts/updates `scheduled_unlinks` directly, or sets `execute_at` | Rejected |
| 11 | A cancels | `cancelled`; B's card disappears live |
| 12 | Set `execute_at` to the past (SQL as postgres), run `execute_due_unlinks()` | Both profiles `partner_id` NULL; shares revoked; row `executed`; B pushed |
| 13 | Same, but without cron: open app after due time | `process_my_due_unlink()` completes it; both reload to "not linked" |
| 14 | Both devices closed at completion, then opened | Each wraps up once (cache cleared, one toast) |
| 15 | A and B unlink by consent while a schedule is live | Schedule becomes `void` |
| 16 | A schedules, they unlink, A links with C, due time passes | Row `void`; A–C untouched |
| 17 | Consent flow (request/allow/decline) | Unchanged |
| 18 | Offline: Stop sharing / Schedule / Cancel | Toast, dialog stays open, retry works |

## Known limits / things to look at
- `sharingActive` defaults to "sharing" until the first read of `sharing_state` returns;
  the DB triggers cover that gap, but the native watcher may start for a moment.
- The Map's behaviour when the partner's `locations` row is **deleted** (vs. stale) was not
  read in detail — check test 1 on a device.
- `request_unlink` rows pending at the moment a schedule completes are left to expire
  (`respond_unlink` already answers `NOT_LINKED` for them).
- The UI shows both options together; whether "Schedule" should be hidden until a consent
  request has gone unanswered for a while is a product call.
