# Supabase production reconciliation — 2026-09-21

Project: `jzlpelxwzjjpddqcrtpu` (Duospace, ap-northeast-1, Postgres 17). Everything here was done and
checked against the LIVE project. "Rolled-back test" = run as the `authenticated` role with simulated JWT
claims inside a transaction that was always rolled back (real data verified untouched afterwards). It is
NOT the same as two real signed-in app clients.

## Live history is not the repo history
The live `schema_migrations` list is a consolidated history (72 entries at the start of this session)
with different names/timestamps from `supabase/migrations/` (88 files). Do not assume that a repo file
is applied because a similar one is. Known divergences found and handled:

| Repo assumption | Live reality | Handling |
|---|---|---|
| `enforce_call_history_transition()` + trigger guard `call_history` | guard is `enforce_call_history_update_rules()` (trigger `enforce_call_history_update_rules_trg`) | `session_id` frozen in the live guard; `20260921110000` makes this idempotent for both shapes |
| `20260916140000_partner_requests_transition_guard` applied | NOT applied — exploit was live | applied 2026-09-21 |
| `surprise-assets` policies "left untouched" | any signed-in user could write/delete in a public bucket | write policies dropped (`20260921110500`) |

## Applied to live on 2026-09-21 (live migration name → repo file)
- `signaling_call_facts_and_session_id` → adapted from `20260920140000` (guard difference above)
- `partner_unlink_consent` → `20260920150000` as written
- `notification_sound_catalog_expansion` → `20260921100000` as written
- `partner_requests_transition_guard` → `20260916140000` as written
- `unlink_consent_function_hardening` → `20260921110200`
- `unlink_clears_accepted_partner_requests` → `20260921110300`
- `surprise_assets_lock_writes` → `20260921110500`
- `unlink_requests_policy_initplan` → `20260921110400`
- `20260921110000` (call_history guard reconcile) and `20260921110100` (REVOKE on
  `enforce_partner_request_transition`) were added to the repo; the reconcile DO block was run on live
  and is a no-op there; the REVOKE was included in the applied `partner_requests_transition_guard`.
All new files are idempotent, so a `db push` over the already-applied live project is safe.

## Edge Functions
- `send-push` v7 (deployed as a flat bundle: `index.ts` + `_shared/*.ts` with `./_shared/` imports —
  the deploy tool cannot resolve `../_shared`). Internal (service-role) callers only; anything else gets
  403. Repo source (`../_shared`) is patched to match. Live check: no auth → 403, bad token → 403.
  Before this, any signed-in user could push to any user id (no `senderId` = no identity check;
  `custom` type skipped the rate limit).
- `diag-service-key`, `diag-firebase-key`: were public, unauthenticated, not in the repo, and returned
  fragments of secrets (service-role key prefix; Firebase private-key header, footer and last 20 body
  characters). Replaced with a 410 stub with JWT verification on. STILL TO DO BY A HUMAN: delete both in
  the dashboard and rotate the Firebase service-account key.
- `signaling-ticket`, `livekit-token`: NOT deployed (need secrets + the self-hosted gateway; Daily is
  still the default call provider).

## Verified (rolled-back tests on live)
Unlink: direct `partner_id` writes blocked (own and other user); `unlink_partner()` not callable by
clients; request idempotent; requester cannot answer own request; decline keeps pair; cancelled and
expired requests cannot be approved; approve unlinks both; crossed requests → `BOTH_REQUESTED`;
outsider sees 0 `unlink_requests` rows, gets NOT_FOUND, cannot insert.
partner_requests: self-request rejected; `sender_id` rewrite frozen; illegal status change rejected;
accept-as-someone-else rejected; accept with an already-linked sender or receiver rejected; legitimate
accept works; after an unlink both people can send a new request and re-link.
Realtime: for all 14 tables in `supabase_realtime`, an outsider account sees 0 rows; couple broadcast/
presence channels are private and `is_couple_realtime_topic_authorized` requires the caller to be
currently linked to the other person.

## NOT verified
- Realtime delivery to a real subscriber (only the RLS visibility that Postgres Changes relies on).
- Truly concurrent (simultaneous) unlink requests — only the crossed-request path.
- A real push through `send-push` v7 after the change (last successful `sent` row before it: 2026-09-20).
  After the next real message, check `notification_history` for a `sent` row.
- Auth configuration, PITR/backups, CAPTCHA, SMTP, JWT expiry — dashboard-only.

## Open decisions / risks
- Storage buckets have no `file_size_limit` / `allowed_mime_types`. Largest object today is 5.6 MB.
  Suggested: avatars 5 MB images, memories 10 MB images, gallery + chat-files 50 MB (no MIME list on
  chat-files: resumable-upload chunks are `application/octet-stream`). Not applied: could break large
  video uploads.
- `avatars` read policy allows `anon`, so anyone with the anon key can list avatar objects.
- `anon` holds full table privileges on `partner_requests` (RLS still blocks; revoking is hygiene).
- Security advisor: leaked-password protection is off (dashboard setting).

## Merged into `duospace-offline-gallery-us-shayari.zip`
That zip adds two migrations (`20260921120000_add_messages_important_flag_and_bypass_dnd`,
`20260921120000_vanish_after_seen`), changes `send-push` / `_shared/fcm.ts` / `_shared/pushTypes.ts`,
and adds the `purge-vanish-messages` function. Checked against live:

- **Live already has both migrations' effects**: `messages.important` exists, `notify_push_on_message()`
  passes `important`, and `delete_expired_messages()` / `cleanup_disappeared_messages()` already use the
  safe CASE cast. Nothing to apply.
- **The `important` migration file was wrong and has been corrected.** It was written from the
  20260824120000 definition of `notify_push_on_message()` and re-added `'preview', NEW.content`, which
  would have silently undone `20260908090000` (E2E ciphertext leaking into push payloads). Live has the
  corrected function (important flag, no preview); the file now matches. Checked by running the corrected
  text in a rolled-back transaction on live.
- **Live `send-push` is v7 = the previous source + the 403 guard. It does NOT have the `/important`
  Do-Not-Disturb bypass** from this zip (`bypassesQuiet` in `send-push/index.ts`, plus the urgent channel
  / time-sensitive changes in `_shared/fcm.ts`). Until it is redeployed, an `/important` message is sent
  with the flag but gets no bypass. The zip's `send-push/index.ts` keeps the bypass AND the 403 guard.
  The Android side needs the `duospace_urgent_message` channel in an app build too.
- **`purge-vanish-messages` is not deployed** on live (it authenticates with the caller's user JWT).

## 2026-09-24 addendum — the "live already has it" claim above went stale
`notify_push_on_message()` was later overwritten on the live project when the older
`20260824120000_add_messages_silent_column_and_respect_in_push` migration was applied (live migration
`20260922173932`) after the important-flag migration. Live then had no `important`/`urgent` in the push
payload and the ciphertext `preview` again. Fixed by `20260924100000_message_push_alert_levels.sql`
(applied live as `message_push_alert_levels`); `send-push` redeployed as v14. See `.ai/CHANGELOG.md`.
