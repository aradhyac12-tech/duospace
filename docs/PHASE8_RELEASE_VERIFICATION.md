# Phase 8 Release Verification Matrix

> **Phase 8.5 addendum:** this matrix predates Phase 8.5 (source-level
> integrity closeout). Phase 8.5 did not redo this matrix — it closed
> specific gaps this matrix and `docs/SUPABASE_FINAL_AUDIT.md` had already
> identified, plus found one new one (`finalize-upload` trusting
> client-supplied `totalChunks`) that neither document's scope covered
> (edge-function trust boundary, not an RLS policy). See
> `docs/PHASE8_5_FINAL_REPORT.md` for the complete list. Row-level notes
> below are updated in place rather than duplicated into a new table.
>
> Phase 8.5 also achieved this doc chain's first **AUTOMATED TESTED**
> result: `scripts/check-rls-coverage.mjs` was rewritten (to actually honor
> DROP POLICY history and check `storage.objects`, which the old version
> silently skipped) and then **actually executed** against this repo's real
> migrations in-sandbox — a genuine `node` run, not a static read. It found
> and this phase fixed one real gap (`apns_push_log` had zero active
> policies). Everything else in this matrix remains STATICALLY VERIFIED —
> this script only proves policy *presence*, not that clauses are correctly
> scoped.

Status model: STATICALLY VERIFIED · AUTOMATED TESTED · LIVE SUPABASE TESTED ·
REAL ANDROID TESTED · REAL IOS TESTED · REQUIRES DAILY.CO · REQUIRES
APNs/FCM · REQUIRES PRODUCTION ENVIRONMENT · BLOCKED BY ENVIRONMENT

| Feature | This session's work | Status |
|---|---|---|
| **AUTH** | Not touched — no findings surfaced against it while working the rest of the schema | STATICALLY VERIFIED (pre-existing, unchanged) |
| **PAIRING** | Removed non-atomic client fallback in `acceptRequest()` (Phase 8G) | STATICALLY VERIFIED — cross-account race/timeout scenarios (both-have-partners, simultaneous acceptance, RPC timeout) are LIVE SUPABASE TESTED / BLOCKED BY ENVIRONMENT |
| **CHAT** | Fixed `messages` UPDATE RLS regression + trigger gap (Phase 8I) | STATICALLY VERIFIED — BLOCKED BY ENVIRONMENT for a live cross-account UPDATE attempt via PostgREST |
| **SCHEDULED CHAT** | Added the missing pg_cron job (P0 #3) | STATICALLY VERIFIED — REQUIRES PRODUCTION ENVIRONMENT (Vault secrets + pg_cron/pg_net extensions) to confirm the job actually fires; BLOCKED BY ENVIRONMENT this session |
| **CALLS** | Fixed one confirmed JS/native duplicate-notification path (Phase 8J) | STATICALLY VERIFIED for the trace; REAL ANDROID TESTED / REAL IOS TESTED / REQUIRES APNs/FCM all outstanding |
| **GALLERY** | Fixed resumable-upload RLS chunk-path bug, wired into Gallery.tsx (Phase 8F). **Phase 8.5**: fixed `finalize-upload` trusting the client-supplied `totalChunks` (a client could set it to `0` and finalize an empty object at any owner-matching path, including overwriting an existing file via `upsert: true`) — server now uses the tracked `pending_uploads.total_chunks`/`total_bytes` and rejects mismatches; also renamed the misleading `publicUrl` return field to `pseudoPublicUrl` since the bucket is private (see `docs/RLS_SECURITY_MATRIX.md`) | STATICALLY VERIFIED — REQUIRES PRODUCTION ENVIRONMENT for a real large-file/poor-network upload test and for confirming the new totalChunks-mismatch rejection against a real deployed function |
| **LOCATION** | Fixed battery listener leak (Phase 8K) | STATICALLY VERIFIED — mount/unmount listener-accumulation check is a straightforward automated/manual browser test, not attempted this session (no test runner access) |
| **MUSIC** | Fixed `playlist_songs` cross-partner RLS exposure (part of P0 #2) | STATICALLY VERIFIED — BLOCKED BY ENVIRONMENT for live cross-account test |
| **RELATIONSHIP** | Fixed `countdowns`/`memories`/`taps`/`daily_answers` cross-partner RLS exposure (P0 #2) | STATICALLY VERIFIED — BLOCKED BY ENVIRONMENT for live cross-account test |
| **BACKUP** | Added cross-device restore (`manualKey`) end to end (P0 #1). **Phase 8.5**: `applyRestore()` now checks the Supabase `error` field on every message batch and the gallery upsert and stops immediately on failure — previously a failed write could still reach `setStatus("done")`. See `docs/BACKUP_RESTORE_INTEGRITY.md`. | STATICALLY VERIFIED — REQUIRES PRODUCTION ENVIRONMENT for a real device-A → device-B round trip and for a real failing-write scenario against live Supabase |
| **SECURITY** | `profiles` recursion regression, `storage.objects` unscoped UPDATE/surprise-assets gaps (Phase 8D); stale `profiles` broad-SELECT policy + missing owner-column indexes (Backend Hardening Pass). **Phase 8.5**: locked `messages.sender_id`/`receiver_id`/`created_at` immutable for every client update including the sender (previously sender-exempt, an open question the prior fix left explicit); removed `invite_links`' residual broad SELECT policy entirely after confirming no client code depends on it (RPC-only acceptance); added explicit deny-all policies to `apns_push_log` for consistency (found by actually running the coverage script, not a security hole on its own — see `docs/RLS_SECURITY_MATRIX.md`) | STATICALLY VERIFIED — BLOCKED BY ENVIRONMENT for confirming the recursion error actually occurred/is resolved live, and for confirming the new trigger exception actually raises against a real sender-initiated identity-field UPDATE |
| **NOTIFICATIONS** | Excluded call-lifecycle types from the generic push toast (Phase 8J) | STATICALLY VERIFIED — REQUIRES APNs/FCM for a live foregrounded-call-push test |
| **NATIVE** | Full source trace, no rewrites (Phase 8J) | STATICALLY VERIFIED — REAL ANDROID TESTED / REAL IOS TESTED outstanding, see `docs/NATIVE_CALL_AUDIT.md` |
| **NAVIGATION** | Not touched | STATICALLY VERIFIED (pre-existing, unchanged) |

## Build/CI gates

| Gate | Status |
|---|---|
| DEPENDENCY INSTALL | **BLOCKED** — no network access in this sandbox (`npm ci` fails at the registry, not from anything in the repo) |
| TYPECHECK | BLOCKED (depends on install) |
| LINT | BLOCKED (depends on install) |
| TESTS | BLOCKED (depends on install) |
| PRODUCTION BUILD | BLOCKED (depends on install) |
| CI config itself | FIXED — `\|\| true` bypass on `tsc -b --noEmit` removed, so once install works, a real typecheck failure will actually fail CI |

See `docs/PHASE8_RELEASE_DECISION.md` for what this means for the release
gate, and `docs/ENVIRONMENT_VERIFICATION.md` for the full list of fixes and
remaining live-environment checks.
