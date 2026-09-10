# Supabase Final Backend Audit

> **Phase 8.5 addendum (source-level integrity closeout, not a re-audit):**
> closed the `invite_links` "low-priority residual" noted under RLS below
> (removed the policy entirely rather than leaving the enumeration surface
> open), found and fixed a real issue outside this audit's table-by-table
> RLS scope (`finalize-upload` trusted client-supplied `totalChunks`,
> allowing a zero-chunk finalize that could overwrite an existing storage
> object at any owner-matching path), closed the `messages` sender-identity
> question left open by the RLS fix below, and fixed an `apns_push_log`
> policy-consistency gap found by actually *executing* the rewritten
> `scripts/check-rls-coverage.mjs` rather than reading it. These are
> incremental, in the same spirit as everything else in this audit
> (source-correct, live-verification-still-outstanding) — not a basis to
> revise the scores or the 58/100 total below, which reflect what's still
> unconfirmed live, not what's fixed in source. Full detail:
> `docs/PHASE8_5_FINAL_REPORT.md`.

## Scores

Every deduction below cites the specific evidence, per the task's
instruction not to award points for unverified claims.

| Category | Score | Rationale |
|---|---|---|
| Schema integrity | 7/10 | Well-normalized, no missing primary keys, reasonable constraint coverage on newer tables (`UNIQUE(user_id, question_date)`, etc.). **-3**: none of `countdowns`, `memories`, `taps`, `daily_answers`, `playlist_songs`, `shayaris`, `mood_logs`, `code_surprises`, `blend_invites` have a foreign-key constraint on their owner column (`creator_id`/`user_id`/`added_by`/`sender_id`) — referential integrity is enforced only by RLS + application logic, not the database. One dead function (`cleanup_disappeared_messages`) found. |
| RLS | 6/15 | **Major deduction**: found a CRITICAL, previously-undetected issue this session — `profiles` had a stale `USING(true)` SELECT policy coexisting with the correctly-scoped one since April, meaning *every profile field including `phone_number` has been bulk-readable by any authenticated user this entire time*, undetected across at least two prior remediation passes on this same codebase. That this survived a dedicated RLS audit once already is the reason this category can't score higher even though it's now fixed. 6 more tables (`countdowns`, `memories`, `taps`, `daily_answers`, `playlist_songs`, `invite_links`) had the same `USING(true)` pattern, fixed earlier this session. All fixes are source-correct but **zero** have a live cross-account confirmation. |
| Storage | 7/10 | Buckets correctly classified public vs. private; `storage.objects` policies fixed this session (stale unscoped UPDATE, unscoped `surprise-assets` INSERT/DELETE). **-3**: the `surprise-assets` fix assumes a folder-ownership convention with no confirmed current upload call-site to validate it against; no MIME-type or size limits enforced at the policy level for any bucket. |
| Auth | 5/10 | Passkey (WebAuthn) and email/password flows have EDGE Function-backed implementations with what appears to be reasonable challenge/OTP expiry (`webauthn_challenges_gc`, `email_change_otps_gc`). **Cannot score higher**: redirect URLs, CAPTCHA/bot protection, rate limits, and OAuth configuration are all Dashboard-only settings not visible from source, and no CAPTCHA verification step is visible in `complete-signup`. |
| Realtime | 6/10 | 9 tables correctly identified as realtime-enabled via `ALTER PUBLICATION`; Supabase's realtime-respects-RLS default behavior should apply automatically given RLS is now correctly scoped everywhere. **-4**: entirely unverified live (no way to confirm the publication actually matches migration history, or that a subscription genuinely filters per-row for a real second account). |
| Edge Functions | 7/10 | Consistent structured logging, no secret/content leakage found in the functions sampled, service-role-gated internal calls (`deliver-scheduled-messages` checks the Authorization header). **-3**: CORS configuration and rate-limiting were not individually audited across all 18 functions given session scope — spot-checked, not exhaustive. |
| Cron | 2/5 | 3 jobs total. `delete-expired-messages` looks correct. `deliver-scheduled-messages` was entirely missing and added this session (Vault-backed, correct pattern). `cleanup-orphan-uploads` is **confirmed likely broken** (dead auth pattern, never fixed in this specific snapshot) — flagged, not silently ignored, but also not fixed, which is why this scores low rather than moderate. |
| Secrets | 4/5 | No VITE_*-exposed secrets found (checked). Vault used consistently for server-side cron auth where it matters. **-1**: `user_secrets` grants the owning client direct `SELECT` on `daily_api_key` and `google_drive_refresh_token` — live third-party credentials, not app data — which is a design-level exposure surface even though RLS correctly scopes it to the owner (see RLS matrix). |
| Performance | 6/10 | Added 9 missing indexes this session, directly justified by the RLS predicates that now actually filter on those columns. `messages` and `scheduled_messages` already well-indexed with partial indexes. **-4**: the `0003 auth RLS initplan` pattern (`get_partner_id(auth.uid())` evaluated per-row rather than once via a scalar subquery) is present across every partner-scoped policy and unaddressed; full Performance Advisor unavailable. |
| Data integrity | 5/10 | Good `UNIQUE`/`CHECK` constraint usage where present (invite codes, device tokens, message reactions). **-5**: the missing FK constraints noted under Schema integrity are a data-integrity gap specifically, not fixed this session — no live database to confirm whether adding them now would violate existing rows (task rule: don't add constraints that could break existing valid production records without that confirmation). |
| Observability | 3/5 | Consistent per-function log prefixing and error context; no secret/content leakage found. **-2**: no request-ID/correlation pattern, no structured logging, cron failures are effectively invisible outside manually checking `cron.job_run_details`. |

**Total: 58/100**

## Evidence-based, not vibes-based

Every deduction above cites a specific migration, table, or absence found
by reading the actual `supabase/migrations/*.sql` files and `src/` — not
inferred from the existence of a prior audit's summary claims. This
matters because this repo's own `AUDIT_FIXES_SUMMARY.md` (from an earlier,
separate audit round) claims a `7.8/10` baseline while citing migration
files that don't exist in this snapshot — see
`docs/SUPABASE_PROJECT_CONFIGURATION.md`/earlier Phase 8 docs. This 58/100
is not being compared against that number, for the same reason: it isn't
trustworthy as a baseline.

## Final Backend Decision

## **BACKEND CONDITIONALLY READY**

Per the task's own criteria:

> BACKEND CONDITIONALLY READY: Source-level architecture is complete with
> no known critical blocker, but live Supabase/Dashboard/device
> verification remains.

Not **BACKEND BLOCKED**, because every P0/P1 confirmed this session (the
`profiles` PII exposure being the most severe) has a source-level fix
committed as a migration, and no remaining known critical blocker exists in
source.

Not **BACKEND PRODUCTION READY**, because none of the following — required
by the task's own bar for that tier — have happened:

- Migrations have not been validated against a real Postgres instance
  (`supabase db reset`/`supabase db lint` — this sandbox has no Supabase
  CLI/Docker access to run either).
- RLS has not been validated live (every fix this session is a correct
  *reading* of the policy SQL, not a confirmed two-account PostgREST test).
- Security Advisor / Performance Advisor have not been run — every
  disposition in `SUPABASE_RLS_FINAL_MATRIX.md` Section 5 is a source-level
  best-effort guess at what they'd say, explicitly marked as such.
- Edge Functions are not confirmed deployed.
- `cleanup-orphan-uploads` is a **known, not-hypothetical** probable
  failure left unfixed in this specific snapshot.
- Production Dashboard configuration (redirect URLs, CAPTCHA, Vault
  secrets, FCM/APNs/Daily.co credentials) is entirely unverified.

## Path to BACKEND PRODUCTION READY

1. Run `supabase db reset` (or apply this migration chain to a scratch
   project) and `supabase db lint` — confirm the full chain, including all
   migrations added this session, replays cleanly from zero.
2. Apply to the real `jzlpelxwzjjpddqcrtpu` project (or a staging clone);
   run Security Advisor and Performance Advisor; resolve or explicitly
   justify every finding against the source-level dispositions already
   drafted in `SUPABASE_RLS_FINAL_MATRIX.md`.
3. Two real authenticated test accounts, not service_role: confirm
   cross-account RLS denial on every table marked "REQUIRES LIVE SUPABASE"
   in the matrix — the `profiles`/`invite_links`/`countdowns`-class tables
   especially, since those are exactly where the confirmed issues were.
4. Fix `cleanup-orphan-uploads`'s broken Vault auth (same pattern as
   `deliver-scheduled-messages` — should be a five-minute follow-up
   migration, just not done this session to keep this pass's diff
   reviewable).
5. Confirm Vault secrets, pg_cron/pg_net, and all 18 Edge Function
   deployments + secrets via the Dashboard.
6. Decide on the `user_secrets` client-readability question (Section
   6/Secrets finding) — ship as-is if the threat model accepts it, or
   restrict `SELECT` and add a masked-value RPC if not.
7. Confirm whether the FK-less owner columns reflect a deliberate
   "RLS is the only boundary we want" design choice or should get FKs —
   check existing data for orphans first if the latter.

## Remaining risks if shipped as-is (CONDITIONALLY READY, not fully verified)

- `cleanup-orphan-uploads` will keep silently failing to clean up orphaned
  upload chunks, which is a storage-cost/hygiene issue, not a security one.
- Any RLS fix in this pass could theoretically have a live-environment
  surprise (e.g., an `EXISTS`/subquery performance cliff, or a policy
  interaction with `service_role`-based Edge Function calls this session
  didn't trace) that only a real cross-account test would catch.
- `user_secrets` credential exposure to the client remains until a product
  decision is made.
