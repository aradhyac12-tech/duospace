# Phase 8.5 Final Report — Source-Level Integrity Closeout

## 1. Executive summary

Phase 8.5 was scoped as a closeout, not a redesign: close specific
source-level integrity gaps left open by the Phase 8 remediation and the
parallel Backend Hardening Pass, and make the release evidence internally
consistent. No UI redesign, no Phase 9 features, no broad architectural
changes were made, per the task's explicit constraints.

Mid-session, a newer repository upload (`duospace-backend-hardening.zip`)
arrived containing a substantially larger, independent audit (the "Backend
Hardening Pass" — `AUDIT_FIXES_SUMMARY.md`, `docs/SUPABASE_FINAL_AUDIT.md`,
`docs/SUPABASE_RLS_FINAL_MATRIX.md`, `docs/SUPABASE_SCHEMA_INVENTORY.md`,
and others) that had already fixed most of what this phase's instructions
originally targeted (the `profiles` stale-policy PII exposure, the
`countdowns`/`memories`/`taps`/`daily_answers`/`playlist_songs` broad-SELECT
exposure, the `storage.objects` stale-UPDATE and `surprise-assets` gaps,
missing owner-column indexes). This phase adopted that upload as the new
canonical base, ported forward the fixes already made against the prior
base that hadn't been superseded, and used the remaining scope to close
what neither prior pass had covered.

**Net new fixes this phase, not present in either prior pass:**

1. `finalize-upload` edge function trusted client-supplied `totalChunks` —
   a real, confirmed destructive-overwrite path (empty-object finalize at
   any owner-matching path, including overwriting an existing file).
2. `messages.sender_id`/`receiver_id`/`created_at` were still mutable by
   the sender (not just receivers) — closed an explicit "needs product
   input" comment left by the earlier RLS fix, based on a full grep of
   every legitimate client update site.
3. `invite_links`' residual broad-ish SELECT policy — previously flagged
   as "low-priority, not fixed" by the Backend Hardening Pass — removed
   entirely after confirming no client code needs it.
4. `apns_push_log` had RLS enabled with zero policies — found by actually
   **running** a rewritten `scripts/check-rls-coverage.mjs` against the
   real migrations, this doc chain's first AUTOMATED TESTED result rather
   than a static read. Not a security hole (practically equivalent to
   deny-all already), but inconsistent with this schema's own established
   convention; fixed for consistency and to make the coverage script pass
   without a special-cased allowlist entry.
5. `useCloudBackup.ts`'s `applyRestore()` didn't check Supabase write
   errors — a failed message/gallery write could still result in
   `setStatus("done")`. Fixed: checks every write, stops immediately,
   identifies which batch failed.
6. `docs/RLS_SECURITY_MATRIX.md` — created (the specifically-referenced,
   previously-missing file) as a reconciliation document pointing at the
   more comprehensive `SUPABASE_RLS_FINAL_MATRIX.md` rather than
   duplicating it, plus this phase's own findings.
7. `docs/BACKUP_RESTORE_INTEGRITY.md` — created, covering exactly the
   cases the task specified (validation, message/gallery write behavior,
   partial failure, wrong key/account, corrupted payload, same/cross-device
   restore, and the gallery-binaries-not-included gap).

## 2. Changes made

| File | Change |
|---|---|
| `src/hooks/useCloudBackup.ts` | `applyRestore()` now checks the `error` field on every message batch and the gallery upsert; stops immediately and throws a descriptive error identifying the failing batch/table instead of silently continuing |
| `supabase/functions/finalize-upload/index.ts` | Validates `objectPath`'s owner segment against the caller; uses server-recorded `pending_uploads.total_chunks`/`total_bytes` instead of trusting the client's claim; rejects mismatches; renamed response field `publicUrl` → `pseudoPublicUrl` |
| `src/lib/resumableUpload.ts` | `ResumableUploadResult.publicUrl` → `pseudoPublicUrl` (+ doc comment explaining why the value is kept URL-shaped despite the bucket being private) |
| `src/pages/Gallery.tsx` | Updated the one call site consuming `resumableUpload`'s result to the renamed field |
| `supabase/migrations/20260811105000_lock_message_identity_fields_fully.sql` | New — locks `sender_id`/`receiver_id`/`created_at` immutable for every client update, sender included |
| `supabase/migrations/20260811106000_invite_links_rpc_only_select.sql` | New — drops the residual `invite_links` SELECT policy entirely |
| `supabase/migrations/20260811112000_apns_push_log_explicit_deny_policies.sql` | New — explicit deny-all policies for `apns_push_log`, matching this schema's server-only-table convention |
| `scripts/check-rls-coverage.mjs` | Rewritten (from a `.ts` file that could never actually run in this repo's CI — no TS runner present) as plain Node ESM, matching every other script in the directory. Now replays CREATE/DROP POLICY in file order instead of just counting CREATE POLICY occurrences, strips comments before matching, and explicitly tracks `storage.objects` (previously invisible to the script entirely, since it's never created via `CREATE TABLE`) |
| `.github/workflows/ci.yml` | Added a real, unsuppressed `node scripts/check-rls-coverage.mjs` step |
| `package.json` | Added `"check:rls"` npm script |
| `docs/BACKUP_RESTORE_INTEGRITY.md` | New |
| `docs/RLS_SECURITY_MATRIX.md` | New |
| `docs/PHASE8_RELEASE_VERIFICATION.md`, `docs/PHASE8_RELEASE_DECISION.md`, `docs/SUPABASE_FINAL_AUDIT.md`, `docs/SETTINGS_SECURITY_QA.md` | Addended/corrected in place to reflect this phase's fixes, without disturbing the existing (accurate) superseding chain between them |

## 3. Confirmed source-level fixes

All of the following are STATICALLY VERIFIED against source in this
repository, this phase:

- `finalize-upload` no longer trusts client-supplied `totalChunks` or an
  unverified `objectPath` for its final (RLS-bypassing, `service_role`)
  storage write.
- `messages.sender_id`/`receiver_id`/`created_at` are immutable for every
  client-side UPDATE, confirmed against all 5 real update call sites in
  `src/pages/Chat.tsx` (none of them touch these fields).
- `invite_links` has no client-reachable SELECT policy at all; acceptance
  is confirmed (via source) to go exclusively through the `accept_invite`
  SECURITY DEFINER RPC.
- `apns_push_log` now has explicit, self-documenting deny-all policies
  matching the rest of the schema's server-only-table convention.
- `useCloudBackup.ts`'s restore path cannot reach `status: "done"` after a
  failed Supabase write (checked directly in the both call sites,
  `restore()` and `importJSON()`, which both route thrown errors to the
  existing `status: "error"` catch path).

One of the above is additionally **AUTOMATED TESTED**, not just
statically read: `scripts/check-rls-coverage.mjs` was actually executed
in-sandbox against this repository's real `supabase/migrations/` (49
files) and, after the `apns_push_log` fix, passed — confirming every live
public table plus `storage.objects` has RLS enabled and at least one
currently-active named policy. See its own header comment and
`docs/RLS_SECURITY_MATRIX.md` for exactly what this claim does and does
not cover (presence, not correctness of scoping).

## 4. New issues found

| Severity | Finding | Status |
|---|---|---|
| P1 (real, not theoretical) | `finalize-upload` zero-chunk finalize could overwrite an arbitrary owner-matching storage object | Fixed this phase |
| P2 | `messages` sender could still mutate `sender_id`/`receiver_id`/`created_at` (no confirmed exploit path found via UI, but no legitimate need for it either) | Fixed this phase |
| P2 | `invite_links` residual SELECT policy allowed live-code-guessing enumeration (impractical given code entropy, but unnecessary) | Fixed this phase |
| P3 (consistency, not a hole) | `apns_push_log` had implicit rather than explicit deny-all | Fixed this phase |
| P3 | `finalize-upload` concurrent/duplicate-call race (two near-simultaneous finalizes could both pass the `pending_uploads` check before either completes) | **Not fixed** — flagged. A real fix needs an atomic claim (`DELETE ... RETURNING`) which would change retry/resume semantics; needs product confirmation before implementing, per "do not introduce destructive rollback assumptions unless the architecture supports them" |
| P3 | No maximum file size enforced anywhere in the resumable upload path | **Not fixed** — flagged per the explicit instruction not to invent arbitrary maximums without product input |
| P3 | Gallery backup restore only restores metadata, not binary files, and the UI doesn't say so | **Not fixed** (documentation gap, not code) — see `docs/BACKUP_RESTORE_INTEGRITY.md` §4 |
| REVIEW REQUIRED | `search_users()` (SECURITY DEFINER, used for partner search) was not re-read line-by-line this phase to confirm it returns only minimal fields | Not investigated this phase — outside the explicit scope list |
| REVIEW REQUIRED | `email_change_otps` was not re-verified this phase beyond confirming it's deny-all by design (per the Backend Hardening Pass's own matrix) | Not investigated this phase |

## 5. Backup integrity

See `docs/BACKUP_RESTORE_INTEGRITY.md` in full. Summary: write-integrity
gap fixed (§5 above); gallery binaries were never part of the backup and
this is now documented rather than silently implied otherwise; restore
remains best-effort/non-atomic by architecture (two separate REST calls,
no server-side transaction spanning both) — stated explicitly rather than
overclaiming atomicity.

## 6. RLS matrix summary

See `docs/RLS_SECURITY_MATRIX.md` (reconciliation doc) and
`docs/SUPABASE_RLS_FINAL_MATRIX.md` (the authoritative, comprehensive
table-by-table matrix produced by the Backend Hardening Pass). Every table
in this schema has RLS enabled and at least one active, correctly-scoped
policy as of this phase, confirmed both by human read and by an actual run
of the rewritten coverage script.

## 7. Message authorization

`messages` UPDATE is now fully locked down: receivers can only touch
`is_read`/`disappear_at`/`deleted_by_receiver`; senders can touch content,
metadata, pin state, reply linkage, and their own soft-delete flag, but not
identity/ordering fields; nobody (sender included) can move
`sender_id`/`receiver_id`/`created_at` once a message is written.

## 8. Storage security

`finalize-upload`'s trust boundary is now closed: `objectPath` ownership is
checked explicitly (not just inferred from the chunk-upload RLS barrier,
which doesn't protect the function's own `service_role` final write), and
`totalChunks`/reassembled size are cross-checked against the
server-recorded `pending_uploads` row rather than trusted from the client.
`storage.objects` bucket policies themselves (stale UPDATE, surprise-assets
scoping) were already fixed by the Backend Hardening Pass — confirmed
consistent, not re-fixed.

## 9. Resumable upload

Retry/resume/chunk-dedup logic was reviewed and found sound (unchanged).
Two gaps flagged, not fixed (see §4): concurrent-finalize race, no max
file size. `totalChunks` trust issue fixed (see §8).

## 10. CI

`scripts/check-rls-coverage.mjs` rewritten and wired into `.github/workflows/ci.yml`
as a real, unsuppressed step (no `|| true`). Confirmed to actually run and
pass against this repo's real migrations in-sandbox. The existing 5-step
gate (`npm ci && lint && tsc && test && build`) was not weakened —
confirmed no `|| true` was reintroduced anywhere in this file.

## 11. Documentation consistency

Corrected: `docs/SETTINGS_SECURITY_QA.md`'s restore-failure row (was
labeled "unchanged hook behavior" for all failure modes; split into
network-level, genuinely unchanged, and write-level, changed this phase).
Addended in place, without disturbing the existing accurate superseding
chain: `docs/PHASE8_RELEASE_DECISION.md`, `docs/PHASE8_RELEASE_VERIFICATION.md`,
`docs/SUPABASE_FINAL_AUDIT.md`. Created the specifically-referenced,
previously-missing `docs/RLS_SECURITY_MATRIX.md`.

**Not fully audited this phase, given the doc set's size** (~30 markdown
files across two merged sessions' work): a complete line-by-line pass of
every doc listed in the original Phase 8.5 instructions
(`ENVIRONMENT_VERIFICATION.md`, `PHASE8L_DEAD_CODE_CLEANUP.md`,
`NATIVE_CALL_AUDIT.md`, `CALL_GALLERY_QA.md`, `CHAT_UI_QA.md`,
`RELATIONSHIP_FEATURE_QA.md`). These were spot-checked for obvious
contradiction with this phase's specific code changes (none of which touch
chat UI, call UI, gallery UI, or relationship features) and none were
found. A dedicated documentation-audit pass would be needed to make a
stronger claim than that.

## 12. Environment limitations

Unchanged from every prior session on this repository: no npm
registry/network access (`npm ci` blocked), no live Supabase connection, no
Daily.co runtime, no real Android/iOS device. `scripts/check-rls-coverage.mjs`
is the first exception — pure Node `fs` + regex, no network or dependency
needed, so it could actually run.

## 13. Remaining release tests

Everything already listed in `docs/PHASE8_RELEASE_DECISION.md`'s "Path to
READY FOR UI CONTINUATION" and `docs/SUPABASE_FINAL_AUDIT.md`'s "Path to
BACKEND PRODUCTION READY" still applies, plus, specific to this phase:

- Confirm `guard_message_update()` actually raises on a sender-initiated
  identity-field UPDATE attempt (REQUIRES LIVE SUPABASE).
- Confirm `finalize-upload` actually rejects a `totalChunks` mismatch and
  an owner-mismatched `objectPath` against a real deployed function
  (REQUIRES LIVE SUPABASE).
- Confirm a real failed write mid-restore now correctly surfaces
  `status: "error"` with the batch-identifying message, against live
  Supabase rather than just the source-level try/catch wiring
  (REQUIRES LIVE SUPABASE).
- Re-run `npm run check:rls` after a real `npm ci` succeeds, as a sanity
  check that this sandbox's Node behavior matches production tooling.

## 14. Final decision

**BLOCKED / CONDITIONALLY READY / READY FOR UI CONTINUATION status is
unchanged by this phase: BACKEND CONDITIONALLY READY**, per
`docs/SUPABASE_FINAL_AUDIT.md` (the authoritative status document as of
the Backend Hardening Pass), now further narrowed by this phase's fixes.
No known source-level P0/P1 remains uncovered by a fix in source. Every
remaining gap is live/device/production-environment verification, listed
in full in `docs/SUPABASE_FINAL_AUDIT.md`'s "Path to BACKEND PRODUCTION
READY" plus §13 above. **READY FOR UI CONTINUATION remains correctly
unreachable** given this environment: `npm ci` has never succeeded against
this code, no live Supabase confirmation exists for any RLS fix across any
of the three passes now layered on this repository, and no real device has
tested the call stack. This is a classification of the environment, not a
verdict on the code.

Per the phase instructions: **STOP after Phase 8.5.** No UI redesign, no
Phase 9 work, was started.
