# Phase 3F — Live RLS Verification (2026-09-26)

## Environment
| Item | Value |
|---|---|
| Staging project | `duospace-staging`, ref `otaficrlkiscaihdwxnt`, region ap-northeast-1, free plan ($0/month), created for this phase with the owner's approval |
| Production project | `Duospace`, ref `jzlpelxwzjjpddqcrtpu` — **read-only** schema/catalog queries and the security advisor only. No writes, no users, no data read. |
| Postgres | Supabase-managed Postgres 17 (real platform roles, real `auth` schema, real default privileges) |
| Test users | TEST_USER_A `aaaaaaaa…0a`, TEST_USER_B `bbbbbbbb…0b` (linked partners), TEST_USER_C `cccccccc…0c` (stranger); emails `*@example.invalid`; created in `auth.users` on staging; profiles created by the real signup trigger |
| Secrets | none written to the repo or this report |

## How identities were exercised (and the limit of it)
Every test ran through the Supabase MCP SQL endpoint inside a transaction as `SET LOCAL ROLE authenticated` (or `anon`) with `request.jwt.claims = {"sub": <user>, "role": ...}` — the same mechanism PostgREST uses, so `auth.uid()`, RLS policies, grants, triggers and constraints are the real ones. **Not exercised:** the HTTP path (PostgREST/GoTrue) with real issued JWTs — the sandbox cannot reach `*.supabase.co` (network allow-list). HTTP-level auth/session tests are therefore BLOCKED (see §H).

## Key discovery: nothing Phase 3A–3E related is deployed
Production's migration history ends at `message_push_alert_levels`; **none** of the eight `relationship_shares` migrations exist in production. Share/withdraw/partner features backed by that table cannot work against production until deployed. Staging was therefore built as *production's current dependency state + the new migrations* — the real deployment (upgrade) path.

## Migration results (staging)
| Step | Result |
|---|---|
| Bootstrap: profiles / partner_requests / their RLS, signup trigger, `guard_profiles_partner_id`, `get_partner_id`, `private.apply_unlink` — DDL copied verbatim from production | PASS |
| 20260922100000 relationship_shares | PASS |
| 20260922100100 unlink_revokes (replaces production's `apply_unlink` with the same body + revoke call — compared line by line) | PASS |
| 20260923130000 permanent_revoke | PASS |
| 20260925180000 / 190000 / 200000 | PASS |
| **Upgrade path**: a non-conforming legacy MEMORY share (`position.hidden = "smuggled private text"`) inserted by A under RLS after 200000 — **accepted** (proves the D3 hole on real Postgres) | reproduced |
| 20260925210000 hardening on that database | PASS — hidden-payload row withdrawn, valid row kept, constraints added |
| 20260926100000 trigger search_path (new, §K) | PASS; trigger behaviour re-verified unchanged (4 checks) |
| Clean install of all 108 repository migrations | **PARTIAL/BLOCKED** — not applied: 708 KB would have to pass through the MCP tool; the sandbox has no direct DB connection. Smallest unblock: `supabase db push` against the staging ref from a machine with network access. |

## Two-user RLS matrix (real Supabase Postgres)
66 PASS, 1 FAIL (a real defect, fixed — §K), 1 invalid test discarded (see W3).

| Group | Tests | Result |
|---|---|---|
| Read isolation: A own history; B only live partner shares; B not revoked; C nothing; anon nothing | R1–R5 | 5 PASS |
| Insert: valid share to partner; to non-partner; forged owner; stranger→A; anon; hidden `position` (D3); duplicate live item; fabricated dates normalised by server | I1–I8 | 8 PASS |
| B/C attacks on A's rows: edit, withdraw, delete, delete-all | U1–U4 | 4 PASS (0 rows affected) |
| A tampering with own rows: redirect recipient, rewrite payload, transfer ownership, un-revoke, extend expiry | U5–U9 | 5 PASS (all DENIED by trigger) |
| Relationship manipulation: A sets own `partner_id`; C inserts 2nd profile claiming A; C deletes own profile; C reads A's profile; B reads partner's profile | P1–P5 | 5 PASS |
| Privileged functions: `revoke_relationship_shares_between`, `private.apply_unlink` as authenticated / anon; `get_partner_id(A)` as C returns NULL | F1–F4 | 4 PASS |
| Withdraw & visibility | W1, W2, W4 | 3 PASS |
| **Duplicate withdraw with the app's exact query in a separate request** | W3b | **FAIL → defect F1** |
| Same with the fix | W4b | PASS |
| D1 correction: old withdrawn, corrected re-shared, B sees only corrected; old item re-shareable only as a new row | D1a–c | 3 PASS |
| Reverse direction B→A: share, read, stranger blocked, A cannot withdraw/delete B's | BA1–5 | 5 PASS |
| Delete-all: list → withdraw all → re-list empty → B sees none → B's own share untouched | DA1–5 | 5 PASS |
| Concurrency: share appearing after withdraw caught by verify re-list; concurrent duplicate blocked (unique index) | CC1–3 | 3 PASS |
| Unlink: every live share revoked both ways; neither reads the other; can't share to ex; own history kept; re-revoke no error (fixed query) | UL1–6 | 6 PASS |
| Relink: no resurrection; cannot un-revoke; fresh share works | RL1–3 | 3 PASS |
| Partner switch without unlink RPC (defence in depth): old recipient loses access; new partner can't read old shares | PS1–2 | 2 PASS |
| Post-fix trigger regression | SP1–4 | 4 PASS |
W3 (same duplicate withdraw inside one transaction) returned "1 row" only because `now()` is constant within a transaction; discarded as an invalid test and redone as W3b.

## E. Delete / withdraw / reconciliation
Server mechanics PASS (DA, UL, RL). The client's offline behaviour (never treating a failed list as empty) is covered by unit tests (`phase3eHardening.test.ts`) — on-device network interruption NOT VERIFIED.

## F. Consent race
Consent is stored on the device, not the server, so the server cannot enforce it. Verified: the undo path (revoke right after share) takes effect immediately for the partner (W1/W2), and a share created during a withdraw is caught by the verify step (CC2). The client-side re-check is unit/code-reviewed. **PARTIAL** — a real two-device timing test needs devices.

## G. Concurrency
Server: unique active-item index and immutability trigger make duplicate/overlapping writes safe (I7, CC3, U5–U9). Client queue: code + unit tests. **PARTIAL** (no multi-device run).

## H. Authentication / session isolation
DB-level identity isolation: PASS (every row above). HTTP sign-in/out, token refresh, expiry and account switching: **BLOCKED** (no network path to Supabase Auth from the sandbox). Client code: Settings sign-out runs `secureWipeAll` (per-user key deleted); memory is keyed and encrypted per user id, so B's session cannot decrypt A's store. Not verified on a device.

## I. Network / privacy
Phase 3E observed-network test still passes (private AI paths: zero calls). Live traffic capture against staging: BLOCKED (same network limit).

## J. Service-role exposure
Client code (`src/`): no `service_role` key, no `auth.admin`, no hard-coded JWTs (test fixtures only). 26 edge functions use `SUPABASE_SERVICE_ROLE_KEY` server-side (out of scope for this phase; listed as follow-up). Production advisor: 20 SECURITY DEFINER RPCs callable by `authenticated` — expected app RPCs; two that take a user id were checked: `accept_partner_request_v2` delegates to `accept_partner_request`, which enforces `auth.uid() = p_user_id`; `complete_qr_pending_link` is a no-op stub. No impersonation found.

## K. Defects found and fixed
| # | Severity | Defect | Fix | Regression |
|---|---|---|---|---|
| F1 | Medium | `revokeShare` re-revoking an already-revoked share (after unlink auto-revoke, or from another device) hit the immutability trigger and threw `REVOKE_FAILED`; correcting/deleting a still-locally-shared memory then failed until the next reload. Phase 3E's claim "revoke is idempotent" was wrong. | `.is("revoked_at", null)` on the update; if no row, look up the owner's row and still clear the local shared flag. Live revokes unchanged. | `src/test/revokeShareIdempotent.test.ts` (3; fails without the fix); staging W4b, UL6 |
| F2 | Low | Linter 0011: `enforce_relationship_share_immutability` had a mutable search_path. | Migration `20260926100000_relationship_shares_trigger_search_path.sql`; behaviour re-verified (SP1–4). | PGlite suite includes it |

## Production observations (not changed — owner decision)
Advisor on production: `location_push_credentials` RLS enabled with no policy (deny-all; INFO), 3 functions with mutable search_path, 3 trigger functions executable via RPC, leaked-password protection disabled. None relate to relationship memory; none were modified.

## Status
| Area | Status |
|---|---|
| Live RLS (DB level, real Supabase) | PASS |
| Live RLS via HTTP/real JWTs | BLOCKED |
| Migrations (upgrade path) | PASS |
| Migrations (clean install of all 108) | BLOCKED |
| Delete / withdraw / unlink / relink | PASS (server) |
| Consent race / concurrency | PARTIAL |
| Auth session isolation | PARTIAL (DB) / BLOCKED (HTTP) |
| Service-role exposure (client) | PASS |
| Deployment of relationship features to production | NOT DEPLOYED |

## Production deployment (2026-09-26, owner-approved)
Applied to production `jzlpelxwzjjpddqcrtpu`, in order, with the exact SQL verified on staging: 20260922100000, 20260922100100, 20260923130000, 20260925180000, 20260925190000, 20260925200000, 20260925210000, 20260926100000 (8 migrations; `lock_get_partner_id_to_self` was already effective in production — `get_partner_id` already had the `_user_id = auth.uid()` lock).
Pre-checks: `relationship_shares` did not exist; production `private.apply_unlink` matched the body the new version extends (only the revoke call added); its callers `request_unlink` / `respond_unlink` unchanged.
Post-checks (read-only): RLS enabled; 4 policies (all `TO authenticated`); 8 check constraints (2 NOT VALID by design); 4 indexes incl. unique active item; immutability trigger with pinned search_path; `revoke_relationship_shares_between` and `private.apply_unlink` not executable by `authenticated`/`anon`; unlink revokes shares; table empty.
Smoke test (inside a transaction that was ROLLED BACK — nothing persisted): a non-existent authenticated identity read 0 rows and an insert was DENIED 42501.
Security advisor after deploy: identical to before deploy (no new findings).
Note: Supabase default privileges give `authenticated` table-level TRUNCATE; PostgREST does not expose TRUNCATE, and this is the same for every table in the project (not changed).
Production is now **PASS at DB level** for relationship sharing. HTTP-level/device verification still BLOCKED.
