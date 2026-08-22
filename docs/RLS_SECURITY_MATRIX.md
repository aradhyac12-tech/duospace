# RLS Security Matrix — Phase 8.5

## Why this file is short

`docs/PHASE8_RELEASE_VERIFICATION.md` and one migration comment
(`20260811102000_fix_messages_update_rls_regression.sql`) both reference
`docs/RLS_SECURITY_MATRIX.md` by this exact path — Phase 8.5's instructions
were to create it because it did not exist.

Since then, a separate session (**Backend Hardening Pass** — see
`AUDIT_FIXES_SUMMARY.md`, `FIXES.md`, `docs/SUPABASE_SCHEMA_INVENTORY.md`)
already produced `docs/SUPABASE_RLS_FINAL_MATRIX.md`: a full table-by-table
RLS audit covering every table in this schema, more tables than the
Phase 8.5 instructions' own list (it additionally covers
`message_reactions`, `code_surprise_events`, `notification_history`,
`notification_preferences`, `known_devices`, `blocked_users`,
`webauthn_credentials`, and a real design-level finding on `user_secrets`).
Re-deriving that work independently under a second filename would create
two documents that can silently drift out of sync with each other — a
worse outcome than one document plus a pointer. **`docs/SUPABASE_RLS_FINAL_MATRIX.md`
is the authoritative, current RLS matrix for this repository.** This file
exists to satisfy the specific path every internal reference expects, to
record what Phase 8.5 independently verified or found beyond that
document, and to flag where the two disagree.

STATICALLY VERIFIED against `supabase/migrations/*.sql` unless noted.
`scripts/check-rls-coverage.mjs` (rewritten this phase — see its own
header comment for what changed and why) was actually **run** against this
repository's real migrations, so the specific claim it checks (every table
has RLS enabled and at least one currently-active named policy, including
`storage.objects`) is **AUTOMATED TESTED**, not just read by eye. Everything
about whether individual policy *clauses* are correctly scoped remains
STATICALLY VERIFIED (human-read), not automated — no live Postgres
connection was available this phase.

## Cross-check against `SUPABASE_RLS_FINAL_MATRIX.md`: findings

**Confirmed consistent** with this phase's own independent read of the
migration chain for every table both documents cover: `profiles`,
`messages`, `countdowns`, `memories`, `taps`, `daily_answers`,
`playlist_songs`, `gallery_items`, `locations`, `mood_logs`,
`scheduled_messages`, `partner_requests`, `push_tokens`,
`pending_uploads`, and `storage.objects` all match between the two
reviews — same fixes, same residual notes.

**Gap that document doesn't cover (Phase 8.5 items 6/7 — this is an edge
function boundary, not an RLS policy, so it was out of that pass's
table-by-table scope):** `supabase/functions/finalize-upload/index.ts`
trusted the client-supplied `totalChunks` value as the reassembly loop
bound. A client could set it to `0` and finalize an **empty object at any
`objectPath` that satisfied the (also-too-weak) `pending_uploads`
ownership check** — including overwriting an existing file via
`upsert: true`. This is a real, not theoretical, destructive-overwrite
path that no RLS policy could have caught, since the function runs as
`service_role` and bypasses RLS entirely for its own storage writes.
**CONFIRMED ISSUE, fixed this phase**: the function now uses the
server-recorded `total_chunks`/`total_bytes` from `pending_uploads`
instead of the client's claim, rejects mismatches, and explicitly checks
that `objectPath`'s owner segment matches the caller. See
`docs/BACKUP_RESTORE_INTEGRITY.md`'s sibling concern (write-integrity in
`useCloudBackup.ts`, also fixed this phase, also outside any RLS policy's
reach) for the same class of gap in a different subsystem.

**One additional table-level finding, found by actually running the
coverage script rather than reading policies by eye:** `apns_push_log`
(added `20260808120000_ios_voip_push.sql`) had RLS enabled with **zero**
policies at all — practically equivalent to deny-all for
`anon`/`authenticated` (the same outcome every other server-only table in
this schema states *explicitly* via a `USING (false)` pair), but stated
implicitly here instead of explicitly. Not an access-control hole — but
inconsistent enough with this schema's own convention that the coverage
script correctly flagged it as worth a human look. Fixed this phase
(`20260811112000_apns_push_log_explicit_deny_policies.sql`) by adding the
same explicit deny-anon/deny-authenticated pair used everywhere else for
this pattern — no behavior change, just makes the intent self-documenting
and lets the coverage script pass without a special-cased allowlist entry.

**`messages` sender-side identity fields — resolved, not just flagged:**
`SUPABASE_RLS_FINAL_MATRIX.md`'s `messages` row references the earlier fix
but the migration's own trailing comment left one question explicitly
open: whether the *sender* (not just non-senders) should still be able to
change `sender_id`/`receiver_id`/`created_at`. A grep of every `messages`
UPDATE call site in `src/pages/Chat.tsx` (5 total: read-receipts,
disappearing-message timestamp, sender-side/receiver-side "un-delete", pin
toggle) confirms none of them, for either role, touch those three fields.
This phase's `20260811105000_lock_message_identity_fields_fully.sql` locks
all three as immutable for every client-side update, sender included,
closing the ambiguity per the migration's own recommendation to check
`docs/RLS_SECURITY_MATRIX.md` (this file) for it.

**`invite_links` residual — resolved, not just flagged:**
`SUPABASE_RLS_FINAL_MATRIX.md` correctly flags that the "look up one
unused unexpired invite" SELECT policy still allows code-guessing
enumeration at the RLS layer (impractical given code entropy, not
impossible) as a low-priority residual. This phase confirmed via source
(`src/pages/settings/PartnerSettings.tsx`) that the client never performs
a direct SELECT against `invite_links` at all — acceptance goes exclusively
through the `accept_invite(p_code, p_user_id)` RPC, which is
`SECURITY DEFINER` and does its own internal lookup, bypassing RLS. Since
no legitimate client flow needs SELECT access to this table, the residual
policy isn't just low-risk — it's unnecessary. Removed entirely this phase
(`20260811106000_invite_links_rpc_only_select.sql`), closing the
enumeration surface rather than just accepting it as low-priority.

## What remains REQUIRES LIVE SUPABASE

Everything `SUPABASE_RLS_FINAL_MATRIX.md` already marks as
`REQUIRES LIVE SUPABASE` still applies (cross-account PostgREST
confirmation for the `profiles`/`messages`/`countdowns`/etc. fixes). Added
by this phase:

- Confirm the new `guard_message_update()` trigger actually raises on a
  sender-initiated attempt to change `sender_id`/`receiver_id`/`created_at`
  (previously silently allowed; should now error).
- Confirm `finalize-upload` actually rejects a `totalChunks` mismatch and
  an owner-mismatched `objectPath` against a real deployed instance, not
  just via source reading.
- Re-run `node scripts/check-rls-coverage.mjs` after `npm ci` succeeds in a
  real environment, as a sanity check that this sandbox's Node/file-read
  behavior matches production tooling exactly (no reason to expect
  otherwise, but this phase's run was the first time the script had ever
  actually been executed rather than just read).
