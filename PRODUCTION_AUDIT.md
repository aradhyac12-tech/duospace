# DuoSpace Production Audit — Scoped Session

**Scope note (read first):** The 23-phase brief supplied requires live Supabase
project access (Security/Performance Advisor, EXPLAIN ANALYZE, pg_stat_statements,
Realtime Authorization config), a working npm/build/device toolchain, and load
testing infrastructure. None of that is reachable from this sandbox —
`npm ci` fails with `403 Forbidden` (no registry egress), there is no Supabase
CLI/DB connection, and there's no device/profiler. This is the same standing
limitation as every prior session on this repo. Everything below is static
source + migration-file analysis only. Items needing live verification are
labeled **UNVERIFIED**, not assumed to pass.

This session focused on Phase 5 (Realtime audit) since it's fully verifiable
statically and is where the highest-confidence real bugs were found, plus a
security pass on secret handling (Phase 14, quick and high value).

## Fixed this session

### P1 — Duplicate presence channel subscription (Chat + Us both track the same channel)
- **Where:** `src/pages/Us.tsx` and `src/hooks/useChatPresence.ts`
- **Problem:** Both independently opened `supabase.channel('presence-${pair}')`
  with identical presence key/config. Since `ChatCallsShell` keeps Chat mounted
  persistently and Us.tsx mounts on its own route, having both alive at once
  meant two separate client subscriptions joining/tracking/listening on the
  *same* presence channel — double `track()` calls, double join/leave event
  handling, double teardown paths to keep in sync.
- **Fix:** `Us.tsx` now calls the existing `useChatPresence(user, partnerId)`
  hook instead of duplicating the channel logic. One subscription owns the
  channel; both consumers read the same `partnerOnline` boolean.
- **Why safe:** Behavior is identical — same channel name, same presence key,
  same online/offline logic. Removes a redundant subscription only.
- **Verification:** bracket-balance sweep on both files (clean), manual read
  confirming `partnerOnline` usage sites in Us.tsx unchanged. No live
  websocket test possible (**UNVERIFIED** against a running app).

### P1 — Unfiltered `partner-requests-rt` channel (global fan-out)
- **Where:** `src/pages/settings/PartnerSettings.tsx`
- **Problem:** `supabase.channel("partner-requests-rt")` subscribed to
  `event: "*"` on the entire `partner_requests` table with **no filter** —
  every INSERT/UPDATE/DELETE on that table, for *any* pair of users anywhere
  in the app, re-ran `loadRequests()` (a query + a follow-up profile lookup)
  for every user with Partner Settings open. This is exactly the "broad
  table subscription" / "refetch on unrelated events" anti-pattern the brief
  flags — a real scale problem (Phase 19 concern) even though it isn't a data
  leak, since `loadRequests()` itself is correctly scoped to
  `receiver_id = user.id`.
- **Fix:** Scoped the channel name per user and added
  `filter: 'receiver_id=eq.${user.id}'` so only requests addressed to this
  user trigger a refetch.
- **Why safe:** `loadRequests()` only ever displays pending requests where the
  current user is the receiver, so this filter matches existing behavior
  exactly — it removes irrelevant fan-out, not real events. Note: this does
  not cover realtime updates for requests the user *sent* (sender-side status
  change) — that was never covered by this hook before either; flagging as a
  known gap, not introduced by this fix.
- **Verification:** bracket-balance sweep (clean). Live realtime behavior
  **UNVERIFIED** (no running app/websocket in this sandbox).

## Audited clean, no fix needed
- `useDockBadges` (`dock-msgs`/`dock-calls` channel names) — confirmed single
  call site (`DockNavRow.tsx`), consistent with the finding from a prior
  session; not a duplicate-subscription risk.
- `useChatRealtimeMessages` (`messages-rt-${user.id}`), `useCallHistory`,
  `useImportedMessages`, `useChatTyping` — all channel names are scoped per
  user or per sorted pair, one owning hook each, no duplicates found.
- Secrets: `.env` contains only the Supabase project URL/ID and the
  **publishable** key (`sb_publishable_...`) — not a secret. Grepped every
  Edge Function for `SERVICE_ROLE_KEY` usage — all reads go through
  `Deno.env.get(...)` server-side; none are ever sent to the client or logged
  in a response body. No hardcoded service-role/JWT/API secrets found in
  `src/`.
- No `@ts-ignore`/`@ts-nocheck` in `src/` or `supabase/functions/`.

## Not done this session (needs live access — UNVERIFIED)
- Phases 0–1 live database inspection (Security/Performance Advisor, RLS
  policy correctness beyond reading migration SQL, index usage, table sizes).
- Migration files show repeated `CREATE INDEX IF NOT EXISTS` for the same
  index name across several migrations (e.g. `idx_messages_sender`,
  `idx_messages_receiver`, `idx_messages_created` each appear 4x) — this is
  consistent with idempotent incremental migrations and is **not** evidence
  of actual duplicate indexes in the live DB, but it can't be confirmed
  without connecting to the live Postgres catalog. Flagged as P3
  cleanup-candidate, not acted on — the brief explicitly says not to create
  speculative migrations.
- Phases 2, 8, 9–13, 15–23 (query EXPLAIN plans, call latency measurement,
  N+1 sweep beyond spot checks, storage/Edge Function live behavior, auth
  session live testing, load testing, native Android/iOS build verification)
  all require tooling this sandbox doesn't have.

## Recommendation
**CONDITIONAL GO** on the two fixes above (low-risk, source-verified,
behavior-preserving). Everything else in the 23-phase brief remains
**UNVERIFIED** and needs to be run against the live Supabase project and a
real build/device, as in every prior session on this repo.
