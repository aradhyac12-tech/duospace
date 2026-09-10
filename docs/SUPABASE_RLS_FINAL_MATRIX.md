# Supabase RLS Final Matrix

Verification status legend: **STATICALLY VERIFIED** (read matches expected
access model), **REQUIRES LIVE SUPABASE** (needs an authenticated
cross-account PostgREST test to fully confirm), **CONFIRMED ISSUE** (found
and fixed this session — migration cited), **SAFE**, **INTENTIONAL PUBLIC**.

Every table below has RLS enabled — none were found with RLS disabled
while a policy exists (Advisor item `0007`) or RLS enabled with zero
policies, which would silently deny all access (item `0008`).

| Table | Expected access | Actual policy | Risk | Fix | Migration | Status |
|---|---|---|---|---|---|---|
| `profiles` | self + partner | **Was**: self+partner policy coexisting with a stale `USING(true)` policy that overrode it entirely (any authenticated user could read any profile, including `phone_number`) | **Was CRITICAL** — bulk PII scrape (`phone_number`, `partner_id`, etc.) | Dropped stale `"Authenticated users can view profiles"` policy | `20260811110000_...sql` (this session) | CONFIRMED ISSUE — now STATICALLY VERIFIED, REQUIRES LIVE SUPABASE for final cross-account confirmation |
| `messages` | sender/receiver only, receiver UPDATE limited to read-state | **Was**: a broad `sender_id OR receiver_id` UPDATE policy coexisting with the correctly split ones, plus a trigger gap letting a receiver rewrite `sender_id`/`created_at` | **Was HIGH** | Dropped broad policy, extended trigger guard | fixed in an earlier session on this same repo (`...messages_update_rls_regression.sql`) | CONFIRMED ISSUE — fixed, REQUIRES LIVE SUPABASE |
| `message_reactions` | scoped via parent message's sender/receiver | Correct — `EXISTS` subquery against `messages` | none found | — | — | STATICALLY VERIFIED |
| `scheduled_messages` | owner only (`sender_id`) | `FOR ALL USING/WITH CHECK (sender_id = auth.uid())` | none | — | — | STATICALLY VERIFIED — single clean ALL policy, no gaps |
| `partner_requests` | sender or receiver only | Correct on all 4 commands | none | — | — | STATICALLY VERIFIED |
| `invite_links` | creator (own) + one-at-a-time code lookup | **Was**: `USING(true)` — any authenticated user could enumerate every invite code, creator, and status in the system | **Was HIGH** — full table read | Split into creator-own SELECT + narrowed unused/unexpired-only lookup | fixed earlier this session (`...fix_cross_partner_rls_exposure.sql`) | CONFIRMED ISSUE — fixed. Residual: the "look up one unused unexpired invite" policy still allows enumeration by trial code guessing at the RLS layer (no rate limit there) — codes are high-entropy so impractical, not impossible; flagged as a lower-priority follow-up |
| `qr_pairing_tokens` | server-only | `FOR ALL USING(false)` for both `anon` and `authenticated` — correctly deny-all; all access goes through `complete_qr_pending_link()` (has its own `auth.uid()` check) and the `issue-qr-token`/`redeem-qr-token`/`qr-anon-issue` Edge Functions | none | — | — | STATICALLY VERIFIED, SERVER_ONLY by design |
| `countdowns` | owner + partner | **Was** `USING(true)` | **Was HIGH** | Scoped via `get_partner_id()` | fixed earlier this session | CONFIRMED ISSUE — fixed |
| `memories` | owner + partner | **Was** `USING(true)` | **Was HIGH** | Scoped via `get_partner_id()` | fixed earlier this session | CONFIRMED ISSUE — fixed |
| `taps` | sender + partner + explicit receiver | **Was** `USING(true)` | **Was HIGH** | Scoped | fixed earlier this session | CONFIRMED ISSUE — fixed |
| `daily_answers` | owner + partner | **Was** `USING(true)` | **Was HIGH** (personal Q&A answers) | Scoped | fixed earlier this session | CONFIRMED ISSUE — fixed |
| `playlist_songs` | owner + partner | **Was** `USING(true)` | **Was MEDIUM** | Scoped | fixed earlier this session | CONFIRMED ISSUE — fixed |
| `shayaris` | owner + partner | Correct — already scoped via `get_partner_id()` | none | — | — | STATICALLY VERIFIED |
| `code_surprises` | owner + partner | Correct | none | — | — | STATICALLY VERIFIED |
| `code_surprise_events` | own events + creator of the surprise | Correct — `user_id = auth.uid() OR surprise_id IN (SELECT ... WHERE creator_id = auth.uid())` | none | — | — | STATICALLY VERIFIED |
| `blend_invites` | sender + partner | Correct | none | — | — | STATICALLY VERIFIED |
| `locations` | self + partner, self-only write | Correct | none | — | — | STATICALLY VERIFIED |
| `mood_logs` | self + partner (read), self-only write | Correct | none | — | — | STATICALLY VERIFIED |
| `menstrual_cycles` | self + partner (read), self-only write | Correct | none | — | Health-adjacent data — reviewed with extra care; access model matches intent | STATICALLY VERIFIED |
| `gallery_items` | owner + partner-if-shared | Correct, including the `gallery_shared` global-toggle branch | none in the policy itself | — | (see storage.objects finding below for the underlying files) | STATICALLY VERIFIED |
| `imported_chats` | owner + partner | Correct | none | — | — | STATICALLY VERIFIED |
| `call_history` | caller + receiver, INSERT requires receiver = caller's actual partner | Correct — a prior hardening pass already closed the "call arbitrary user" gap via `receiver_id = get_partner_id(auth.uid())` in the INSERT `WITH CHECK` | none found | — | — | STATICALLY VERIFIED — well-designed, atomic CAS updates in `claim_call`/`decline_call`/`cancel_call` |
| `pending_uploads` | owner only | Correct (note: 5 overlapping policies exist — 4 per-command + 1 `FOR ALL` covering the same ground; redundant, not incorrect) | none (redundancy, not a security gap) | Optional cleanup: drop the 4 narrower policies and keep just the `FOR ALL` one | not applied — cosmetic, flagged in Section 22 findings below | STATICALLY VERIFIED |
| `backup_runs` | owner only | Correct | none | — | — | STATICALLY VERIFIED |
| `notification_history` | recipient only, UPDATE limited to marking read | Correct | none | — | — | STATICALLY VERIFIED |
| `notification_preferences` | owner only (PK = user_id) | Correct | none | — | — | STATICALLY VERIFIED |
| `push_tokens` | owner only | Correct on all 4 commands | none | — | — | STATICALLY VERIFIED |
| `known_devices` | owner only (SELECT/DELETE only — no direct INSERT/UPDATE policy, meaning device registration must go through a SECURITY DEFINER path) | Correct as designed | none | — | Confirm `handle_new_user`/device-registration path is the only writer (not verified beyond a source read — REQUIRES LIVE SUPABASE if this ever throws a permission error in practice) | STATICALLY VERIFIED |
| `blocked_users` | owner only | Correct | none | — | — | STATICALLY VERIFIED |
| `webauthn_credentials` | owner: SELECT/DELETE only | Correct — INSERT/UPDATE presumably happen via `webauthn-register-verify` Edge Function with service_role, not direct client writes | none | — | — | STATICALLY VERIFIED |
| `webauthn_challenges` | server-only | `USING(false)` for both roles — correct, all access via Edge Functions | none | — | — | STATICALLY VERIFIED, SERVER_ONLY |
| `email_change_otps` | server-only | `USING(false)` for both roles | none | — | — | STATICALLY VERIFIED, SERVER_ONLY |
| `rate_limits` | server-only | `USING(false)` for both roles (`consume_rate_limit()` is service_role-only too) | none | — | — | STATICALLY VERIFIED, SERVER_ONLY |
| `user_secrets` | owner only | `FOR ALL USING/WITH CHECK (auth.uid() = user_id)`, `GRANT SELECT` to `authenticated` — note: no explicit `TO authenticated` role clause on the policy itself (RLS logic still holds without it, since `auth.uid() = NULL` for `anon` can't match any row — a defense-in-depth gap, not a demonstrated hole) | LOW (role-clause gap) + **MEDIUM design concern**: this table stores `daily_api_key` and `google_drive_refresh_token` — real third-party credentials, not app data — and grants the owning user direct `SELECT` on them via RLS/PostgREST. A compromised client session (XSS, malicious extension, stolen JWT) can exfiltrate these live credentials, not just app data. Most designs treat this class of secret as write-only from the client (insert/update only, decrypt/use server-side via service_role) specifically to shrink this blast radius | Optional: add `TO authenticated` explicitly for consistency; consider whether `SELECT` needs to be client-reachable at all versus proxying any read-path through a SECURITY DEFINER function that returns only a masked/hint value (the table already has `daily_key_hint` alongside the raw `daily_api_key`, suggesting the hint was meant to be the client-facing value) | not applied this session — REQUIRES PRODUCT DECISION, not treated as a confirmed bug since the current behavior may be intentional | REQUIRES PRODUCT DECISION |

## `storage.objects`

| Bucket | Expected | Actual | Risk | Fix | Status |
|---|---|---|---|---|---|
| `chat-files`, `gallery`, `memories` | owner + partner READ, owner-only WRITE/UPDATE/DELETE | Correct, plus a stale extra unscoped UPDATE policy that was found and dropped in an earlier session on this repo | **Was HIGH** (any authenticated user could UPDATE any object's metadata across 4 buckets) | dropped stale policy | CONFIRMED ISSUE — fixed earlier this session |
| `avatars` | public READ (intentional — avatars are meant to be visible), owner-only WRITE/UPDATE/DELETE | Correct | none | — | INTENTIONAL PUBLIC (read) / STATICALLY VERIFIED (write) |
| `backups` | fully owner-scoped, no partner access | Correct — `FOR ALL` owner-only | none | — | STATICALLY VERIFIED |
| `attachments` | fully owner-scoped | Correct — `FOR ALL` owner-only | none | — | STATICALLY VERIFIED |
| `surprise-assets` | public READ (intentional — surprises are shared via link, recipient may not have an account), owner-folder-scoped WRITE/DELETE | **Was**: INSERT/DELETE had no folder scoping at all (any authenticated user could write/delete any object) | **Was HIGH** | Scoped to `(storage.foldername(name))[1] = auth.uid()::text` | CONFIRMED ISSUE — fixed earlier this session. Caveat: no confirmed current upload call-site for this bucket in `src/` or Edge Functions, so the folder-convention assumption is unverified against real usage — REQUIRES LIVE SUPABASE / a confirmed upload flow |

## Section 5 — Security Advisor items

No live Dashboard access this session. Per-item disposition based on what
source review *can* determine:

| Item | Disposition |
|---|---|
| `0001` unindexed FKs | Addressed for the FKs actually referenced by RLS predicates — see the new index migration (`20260811111000_...sql`) and Section 4 below. Not every FK in the schema was cross-checked against Advisor's exact FK-index heuristic — REQUIRES LIVE SUPABASE |
| `0002` auth.users exposed | `get_user_id_by_email()` is the only function querying `auth.users` directly; EXECUTE is `REVOKE ALL ... FROM public, anon, authenticated` and `GRANT ... TO service_role` only — not client-reachable. No view exposes `auth.users`. FALSE POSITIVE risk / not applicable from source |
| `0003` auth RLS initplan | Every partner-scoped policy calls `get_partner_id(auth.uid())` per-row rather than wrapping `auth.uid()` in a scalar subquery once — this is the standard pattern Supabase's own docs flag as sometimes causing this Advisor warning. Not changed this session (would require rewriting every partner policy to the `(SELECT auth.uid())` idiom) — REQUIRES PRODUCT DECISION whether the performance cost matters at current/expected scale, and REQUIRES LIVE SUPABASE (Performance Advisor) to know if it's actually flagged |
| `0006` multiple permissive policies | Confirmed pattern present *before* this session's fixes on `profiles`, `messages`, `storage.objects` (the exact issue fixed above) — now resolved for those three. `pending_uploads` still has 5 overlapping ALL/per-command policies (redundant, not a security gap) — FIXED for the security-relevant cases, minor redundancy remains elsewhere |
| `0007`/`0008` RLS disabled/no policy | None found — every table read this session has RLS enabled with at least one policy | FALSE POSITIVE risk |
| `0010` security definer view | No views were found in this schema at all (`grep CREATE VIEW` across all migrations: zero results) | NOT APPLICABLE |
| `0011` mutable search_path | None found — every SECURITY DEFINER function sets `SET search_path = public` (or `public, extensions`) | FALSE POSITIVE risk |
| `0012` anonymous sign-ins | Cannot be determined from migrations — this is an Auth Dashboard setting | REQUIRES LIVE SUPABASE |
| `0023`/`0024` sensitive columns / permissive RLS | The `profiles.phone_number` exposure found and fixed this session is exactly this category | FIXED |
| `0025` public bucket listing | `avatars` and `surprise-assets` are intentionally public for SELECT; neither exposes `list()` beyond what SELECT already allows (Supabase Storage `list` is governed by the same SELECT policy) | INTENTIONAL PUBLIC |
| `0028`/`0029` security-definer function executable by anon/authenticated | Reviewed every SECURITY DEFINER function's GRANT/REVOKE statements this session — `get_user_id_by_email` and `consume_rate_limit` correctly restrict to `service_role` only; every client-invokable one (`accept_partner_request`, `accept_invite`, `unlink_partner`, `complete_qr_pending_link`, `claim_call`/`cancel_call`/`decline_call`, `search_users`) validates `auth.uid()` against the identity/ownership it operates on | STATICALLY VERIFIED |

All other numbered items require the live Dashboard and are marked
**REQUIRES LIVE SUPABASE** — not run this session, not claimed as run.
