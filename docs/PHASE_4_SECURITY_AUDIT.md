> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

# DuoSpace Phase 4 Security & Adversarial Audit

Scope note up front: this pass had no live Supabase instance, no Docker, and
no network access to the real project — everything below is static-code
audit plus manual SQL reasoning against the migration chain in this repo
snapshot. Every item is labeled PASS / FIXED / PARTIAL / NOT TESTABLE and
that label is honest about what could and could not be verified here. This
audit did **not** cover the full brief — it went in strict P0→P1→P2 order
and ran out of budget partway through P1. See "Not Reached" at the end.

## 1. Executive Summary

Found and fixed one P0 and six P1 findings, all as real numbered migrations
(not left as manual scripts), all verified against every current client
call site so legitimate behavior isn't broken. The most serious pattern,
repeated across multiple findings: **a fix or a piece of enforcement
infrastructure already existed somewhere in the repo but was never actually
wired in** — a hardening script outside the migration chain, a rate-limit
function never called, a state-machine that only the RPCs respected while a
blanket RLS policy sat next to them wide open. That pattern is worth
watching for in future audits of this codebase specifically.

Six other tables were found with the *exact same* `USING (true)` SELECT
bug a prior session already fixed once for `profiles` — never generalized
to the other tables that shared the bug.

## 2. Findings

### P0-1 — `get_partner_daily_key` plaintext credential oracle
- **Location**: `supabase/migrations/20260711115507_...sql` (original),
  fixed in `20260910170000_lock_get_partner_daily_key_to_service_role.sql`
- **Vulnerability**: `SECURITY DEFINER` function took `_user_id` as a raw
  parameter, never checked against `auth.uid()`. `EXECUTE` was never
  revoked from `PUBLIC` (Postgres's creation default), so `anon` and
  `authenticated` could both call it directly.
- **Attack scenario**: `supabase.rpc('get_partner_daily_key', { _user_id: '<any user id>' })` — no auth required — returns that user's partner's plaintext Daily.co API key.
- **Root cause**: a real fix existed as `scripts/sql/harden_partner_daily_key.sql` but was never folded into the migration chain — a fresh DB replay would still be vulnerable.
- **Fix**: `COALESCE(auth.uid(), _user_id)` (real caller identity always wins when present) + `EXECUTE` restricted to `service_role` only.
- **Enforcement layer**: PostgreSQL GRANT/REVOKE + function body.
- **Regression test**: NOT TESTABLE here (no live DB). Manual verification steps documented in the migration file's own comment; recommend running against staging: `set role anon; select get_partner_daily_key(<any uuid>);` should error with permission denied; same for `authenticated`.
- **Verification result**: FIXED (migration written, logic verified against the one real call site in `daily-call/index.ts`), live behavior NOT TESTABLE.

### P1-1 — `is_partner_on_call` arbitrary user-status oracle
- **Location**: `20260824_call_declined_marker.sql` (original), fixed in `20260910180000_lock_is_partner_on_call_to_real_partner.sql`
- **Vulnerability**: took `p_partner_id` at face value, never verified it was the caller's actual partner.
- **Fix**: added `EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND partner_id = p_partner_id)` as a mandatory first condition.
- **Verification result**: FIXED, live behavior NOT TESTABLE.

### P1-2 — `call_history` blanket UPDATE policy has no state-machine awareness
- **Location**: `20260308232149_...sql`'s `"Users can update own calls"` policy, fixed via a new `BEFORE UPDATE` trigger in `20260910200000_call_history_transition_guard.sql`
- **Vulnerability**: `claim_call`/`decline_call`/`cancel_call` are correctly CAS-guarded RPCs, but the blanket RLS UPDATE policy sits alongside them with no `WITH CHECK` and no transition logic — either party to a call could set `status`/`duration_seconds`/`ended_at` to anything, from any prior state, via a raw REST call.
- **Attack scenario**: fabricate a call's duration after the fact; force `status='completed'` on a call that was actually declined; reopen an already-ended call.
- **Fix**: a `BEFORE UPDATE` trigger enforces legal transitions (`in_progress` → terminal states, plus the one `missed`→`seen` badge-ack transition) and computes `ended_at`/`duration_seconds` server-side from `now() - started_at`, ignoring whatever the client payload contains.
- **Verified against**: every current call site (`Calls.tsx`, `Chat.tsx`, `CallContext.tsx`, `MinimizedCallBubble.tsx`, `usePushNotifications.ts`, the ring-expiry sweep, `DockBadgesContext.tsx`'s badge-ack) — all perform only transitions the trigger allows.
- **Verification result**: FIXED, live behavior NOT TESTABLE.

### P1-3 — Six tables with unrestricted `USING (true)` SELECT policies
- **Location**: `countdowns`, `memories`, `taps`, `daily_answers`, `playlist_songs`, `invite_links` — all in `20260708090100_...sql` (and three earlier "reset" migrations with the same text). Fixed in `20260910220000_fix_couple_content_broad_select_policies.sql`.
- **Vulnerability**: any authenticated user could read every other couple's countdowns, shared memories, daily-question answers, playlist, and taps — and, worse, every currently-valid unused `invite_links.code`.
- **Attack scenario (invite_links)**: list all valid unclaimed invite codes via a direct `select * from invite_links`, then call `accept_invite()` with someone else's code to hijack their pending partner link.
- **Root cause**: same bug class as a `profiles` issue a prior session already found and fixed once (`20260811110000_fix_stale_broad_profiles_select_policy.sql`) — never generalized to these other tables.
- **Fix**: scoped each SELECT to `self OR real partner` (via the already-hardened `get_partner_id()`, or `sender_id`/`receiver_id` directly for `taps`); `invite_links` narrowed to `creator_id = auth.uid()` since no client code anywhere SELECTs this table directly (accept flow goes entirely through the `accept_invite()` RPC).
- **Verified against**: `MemoryWall.tsx`, `useOurPlaylist.ts`, `Us.tsx`, `Playlist.tsx` — all query patterns already assume self/partner scoping, nothing relies on the broad policy.
- **Secondary/lower-severity note**: `invite_links.code` is generated client-side via `Math.random().toString(36).substring(2,8)` — not cryptographically random and only ~8 base-36 chars. Lower urgency once the listing bug above is fixed (an attacker would need to brute-force a specific code rather than just list them), but worth a follow-up: switch to `crypto.randomUUID()`-derived codes. **Not fixed this pass** — flagged only.
- **Verification result**: FIXED (RLS), live behavior NOT TESTABLE. Code-entropy issue NOT FIXED (documented only).

### P1-4 — Reaction race + missing UPDATE policy
- **Location**: `src/components/chat/MessageReactions.tsx`, `message_reactions` table
- **Vulnerability**: DELETE-then-INSERT (two round trips) could hit the correct `UNIQUE(message_id,user_id)` constraint on a race between two devices on the same account, failing the losing device's write silently (no error handling on the insert).
- **Fix**: collapsed to a single atomic `upsert(...).onConflict("message_id,user_id")`. Discovered mid-fix: the table had **no UPDATE RLS policy at all**, which would have made the upsert's conflict path fail via RLS default-deny — added the missing policy (`20260910190000_message_reactions_atomic_upsert.sql`).
- **Verification result**: FIXED. Concurrency behavior NOT TESTABLE (no live DB to actually race two connections against).

### P1-5 — `search_users` enumeration + unused rate-limit infrastructure
- **Location**: `20260708090100_...sql`'s `search_users`, fixed in `20260910210000_search_users_enumeration_guard.sql`
- **Vulnerability**: no minimum search-term length — an empty string matches every profile with a username (`ILIKE '%%'`), enumerable 20 rows at a time. `consume_rate_limit()` already existed for exactly this purpose but `search_users` never called it.
- **Fix**: converted to `plpgsql`, added a length floor (3 chars for substring search, 5 for phone-like exact match), wired in `consume_rate_limit(auth.uid(), 'search_users', 20, 60)`.
- **Verification result**: FIXED, live behavior NOT TESTABLE.

### P1-6 — `finalize-upload` trusts an unvalidated client-written baseline
- **Location**: `supabase/functions/finalize-upload/index.ts`
- **Vulnerability**: `pending_uploads` (the row finalize-upload treats as its "server-recorded" baseline for chunk count/size) is actually written directly by the client (`src/lib/resumableUpload.ts`'s own upsert) with zero validation of bucket, total_bytes, total_chunks, or content_type at write time. No bucket allowlist, no absolute size/chunk-count cap, no path-traversal check, no session-expiration check anywhere in the chain.
- **Fix (2026-09-10)**: added an explicit 3-bucket allowlist (`avatars`/`attachments`/`backups`) with per-bucket byte caps, a 2000-chunk cap, `..`/null-byte path-traversal rejection, a 24h expiration check (matching `cleanup-orphan-uploads`'s own cutoff), and a MIME allowlist for `avatars` only.
- **CRITICAL bug in that fix, found and fixed 2026-09-16**: the 3-bucket allowlist was built from `scripts/sql/storage_buckets.sql`, which does not match the buckets the app actually uploads through. The only two real callers of `resumableUpload()` in the app (`Chat.tsx`, `Gallery.tsx`) pass bucket `"chat-files"` / `"gallery"` — neither was in the allowlist, so **every chat attachment and every gallery upload would have been rejected** at finalize (`Unknown bucket`) — there's no size-based bypass, `resumableUpload` always calls `finalize-upload`. This was a functionality-breaking regression hiding inside a "security fix," undetected because the fix's own live behavior was (honestly) never testable in either sandbox. Fixed by adding `chat-files` (50MB cap, matching `Chat.tsx`'s existing client-side check) and `gallery` (500MB judgment-call ceiling, no client-side cap exists) to the allowlist, plus a MIME allowlist for `gallery` only (`image/`, `video/` — matches its own file-picker's `accept` attribute; `chat-files` deliberately still has none, since its file picker has no `accept` restriction by product design). Also fixed the MIME check itself, which compared by exact string equality despite being named `allowedMimePrefixes` — switched to real prefix matching. See `supabase/functions/finalize-upload/index.ts`'s own updated header comment for the full trace.
- **Remaining gap, not fixed**: no MIME allowlist for `attachments`/`backups` (probably fine — neither appears to be a real upload path any client code uses; `backups` uploads via a separate direct-`.upload()` path that bypasses this function entirely, and `attachments` appears unused anywhere in `src/`).
- **Verification result**: bucket/size/chunk/path/expiration FIXED (2026-09-10); the bucket-name mismatch that broke real uploads FIXED (2026-09-16); MIME allowlist now covers `avatars`+`gallery` (the two buckets where a narrower set is actually evidence-backed). Live behavior still NOT TESTABLE — no DB/Storage access in any sandbox this has run in.

## 3. RLS Matrix (tables actually inspected this pass)

| Table | SELECT | INSERT | UPDATE | DELETE | Result |
|---|---|---|---|---|---|
| profiles | self ∪ partner (fixed by prior session) | — | — | — | PASS (prior fix confirmed present) |
| user_secrets | (not re-audited this pass — relied on prior hardening) | — | — | — | NOT RE-VERIFIED |
| call_history | self ∪ partner (caller/receiver) | caller=self | **was unrestricted, now trigger-guarded** | self ∪ partner | FIXED |
| message_reactions | (not re-audited — assumed correct from earlier session) | own | **was missing entirely, now added** | own (assumed) | FIXED (UPDATE) |
| countdowns / memories / daily_answers / playlist_songs | **was `true`, now self ∪ partner** | own | — | own | FIXED |
| taps | **was `true`, now sender ∪ receiver** | own (sender) | — | — | FIXED |
| invite_links | **was `true`, now creator-only** | own | own (accept path via RPC only) | own | FIXED |
| partner_requests | own (sender/receiver) | own (sender) | receiver-only, **now trigger-guarded (2026-09-16): sender_id/receiver_id frozen, only pending→accepted allowed via UPDATE** | own | FIXED (2026-09-16) |
| gallery_items | self ∪ (partner if shared) | own | own | own | PASS (already correct) |
| push token / device tables | NOT REACHED THIS PASS | | | | NOT TESTABLE / NOT REACHED |

## 4. RPC Security Matrix

| RPC | Caller | Allowed? | Authorization rule | Result |
|---|---|---|---|---|
| `get_partner_daily_key` | client (anon/authenticated) | **was yes, now no** | now `service_role` only + real-identity fallback | FIXED |
| `get_partner_daily_key` | `daily-call` edge fn (service_role, post-JWT-verify) | yes | intended path | PASS |
| `is_partner_on_call` | authenticated, arbitrary UUID | **was yes (leaked), now no** | now requires real partner relationship | FIXED |
| `is_partner_on_call` | authenticated, real partner | yes | correct | PASS |
| `claim_call` / `decline_call` / `cancel_call` | authenticated, party to the call | yes, CAS-guarded | already correct (prior hardening pass) | PASS |
| `search_users` | authenticated | yes, now length-floored + rate-limited | was unbounded/enumerable | FIXED |
| `get_partner_id` | authenticated | self only | already correct (prior hardening pass) | PASS |
| `accept_invite` / `accept_partner_request` | authenticated | yes, own user id only | already correct | PASS |
| `consume_rate_limit` | service_role / composed callers only | — | already correct, now actually used by `search_users` | PASS |

## 5. Edge Function Matrix

Only two functions were actually deep-audited this pass (budget ran out
before the rest):

| Function | Auth | Authorization | Service-role usage | Validation | Rate limiting | Result |
|---|---|---|---|---|---|---|
| `daily-call` | JWT verified, then service-role admin client for the key lookup | caller's own id only, post-verification | Yes — correctly scoped, matches the P0 fix's design | Not re-audited beyond the key-fetch path | Not checked | PARTIAL |
| `finalize-upload` | JWT verified | ownership check on objectPath prefix | Yes, for the actual storage write | **Improved this pass** — bucket/size/chunk/path/expiry now checked; MIME allowlist partial | Not checked | PARTIAL (improved) |
| everything else (uploads-adjacent, push, auth, media) | NOT AUDITED THIS PASS | | | | | NOT REACHED |

## 6. Call State Machine (as now enforced by the DB trigger)

```
in_progress -> in_progress   (claim_call: claimed_by/claimed_at/claimed_device_id only)
in_progress -> completed     (ended_at, duration_seconds computed server-side from started_at)
in_progress -> cancelled     (ended_at now(), duration 0)
in_progress -> failed        (ended_at now(), duration 0)
in_progress -> missed        (declined_call RPC, or ring-expiry sweep, or claim-race-lost)
missed      -> seen          (badge-acknowledgment only, no other column changes)
<terminal>  -> anything      REJECTED (trigger raises an exception)
```
caller_id / receiver_id / started_at / room_name / call_type / call_direction
are frozen against any UPDATE payload, from any caller, at the trigger level.

## 7. Chat Race Test Results

NOT TESTABLE this pass — no live DB/two-connection harness available to
actually race concurrent writes. The one race explicitly identified
(`message_reactions` DELETE-then-INSERT) was fixed on code-review grounds
(traced the exact interleaving that would violate the unique constraint)
but not empirically reproduced under load. The other 24 scenarios in the
brief's Chat race list were not attempted this pass.

## 8. Storage Security Results

See P1-6 above. Bucket allowlist, per-bucket size cap, chunk-count cap,
path-traversal rejection, and session expiration are now enforced inside
`finalize-upload`. MIME allowlist only covers `avatars`. Nothing about the
raw chunk-upload step itself (before finalize) was audited this pass —
whether Supabase Storage's own bucket-level `file_size_limit`/
`allowed_mime_types` actually apply to a service-role upload is unverified
(no live Storage backend to test against), which is exactly why the
finalize-time checks were added as defense-in-depth rather than assumed
redundant.

## 9. Encryption Threat Model

NOT AUDITED THIS PASS. The brief's full P1 encryption-lifecycle review
(key generation/storage/distribution/rotation/device-replacement/recovery)
was not reached.

## 10. Migration Replay Results

Not literally executed (no local Postgres/Supabase CLI in this
environment) — reasoned through statically instead: every fix this pass
was written as a real, timestamped migration file (never a standalone
script outside `supabase/migrations/`), specifically because two existing
issues in this exact codebase (`get_partner_daily_key`'s hardening script,
and the `USING(true)` policies surviving four successive "full reset"
migrations) demonstrate that a fix which isn't in the migration chain, or
isn't in the *last* file that redefines a given object, does not reliably
apply on a fresh database. All six migrations added this pass use `CREATE
OR REPLACE` / `DROP POLICY IF EXISTS` + `CREATE POLICY`, so they are safe
to run against either a fresh replay or the current live database. **A
literal `supabase db reset` + policy/grant inspection was not performed
and should be done before shipping.**

## 11. Remaining Risks (not reached or only partially addressed this pass)

- ~~`attachments`/`backups` bucket MIME allowlist~~ — superseded 2026-09-16: see §16. The real buckets (`chat-files`/`gallery`) now have appropriate allowlists (or an evidence-backed deliberate absence of one, for `chat-files`).
- `invite_links.code` generation was `Math.random()`-based, low entropy — FIXED 2026-09-16 (this session): switched to `crypto.getRandomValues` over a 32-symbol unambiguous alphabet in `src/pages/settings/PartnerSettings.tsx`'s `generateInviteCode()`.
- Realtime channel authorization audit — FIXED 2026-09-16: see §18. `typing`/`presence`/`groic`/`blend-sync` broadcast/presence channels now require `private: true` + RLS on `realtime.messages`, keyed to the caller's current partner — pending the "Allow public access" dashboard toggle (manual, cannot be done from code) to fully take effect.
- Full edge function audit beyond `daily-call`/`finalize-upload` — not reached.
- Encryption lifecycle threat model — not reached.
- Session/auth clock-skew handling — not reached.
- Telemetry review — not reached.
- TypeScript `any`/unsafe-cast audit — not reached.
- `REPLICA IDENTITY FULL` review — not reached (a prior session's migration, `20260910160000_messages_replica_identity_full.sql`, already exists; not re-verified this pass).
- Push token / device table RLS — not reached.
- No automated regression tests were written — every fix's "test" is a documented manual verification path in the migration's own comment, not an executable test suite.

## 12. Files Changed

```
supabase/migrations/20260910170000_lock_get_partner_daily_key_to_service_role.sql   (new)
supabase/migrations/20260910180000_lock_is_partner_on_call_to_real_partner.sql       (new)
supabase/migrations/20260910190000_message_reactions_atomic_upsert.sql               (new)
supabase/migrations/20260910200000_call_history_transition_guard.sql                 (new)
supabase/migrations/20260910210000_search_users_enumeration_guard.sql                (new)
supabase/migrations/20260910220000_fix_couple_content_broad_select_policies.sql      (new)
src/components/chat/MessageReactions.tsx        (atomic upsert instead of delete+insert)
supabase/functions/finalize-upload/index.ts     (bucket/size/chunk/path/expiry/MIME checks)
package.json, src/lib/errors/DuoSpaceError.ts   (version bump only)
```

## 13. Validation Commands

None of these were actually run this pass (no network/DB access in this
sandbox) — listed as what should be run before shipping:

```
supabase db reset                       # fresh migration replay
supabase db diff                        # confirm no drift
npm run typecheck                       # tsc --noEmit
npm run lint
npm test                                # existing unit tests only
# then, against the reset DB, manually attempt every UNAUTHORIZED case in
# section 4 above and confirm it fails.
```

## 14. Final Verdict

**NOT READY**

Real, exploitable P0/P1 issues were found and fixed this pass, which is
progress — but this audit covered a fraction of the brief (roughly the
first third of the P1 list, none of P2, nothing empirically tested against
a live database), and the brief's own instruction ("do not choose the
final verdict until the evidence supports it") rules out anything more
optimistic than this given how much is still NOT TESTABLE or NOT REACHED.

## 15. Addendum — 2026-09-16

Closed the `partner_requests` UPDATE `WITH CHECK` gap listed in §11 above
(migration `20260916120000_partner_requests_transition_guard.sql`). Traced
a concrete exploit chain while fixing it, not just the abstract gap: the
"Send requests" INSERT policy doesn't forbid `sender_id = receiver_id`, so
an attacker could self-insert a request, use the UPDATE gap to rewrite its
`sender_id` to an arbitrary victim, then call the existing
`accept_partner_request` RPC — which was also found to be missing the
already-partnered guard its sibling `accept_invite` has — to force a
pairing with (and unlink any existing partner of) a victim who never sent
or consented to any request. Both the trigger and the missing guard are
fixed in the same migration. Live behavior NOT TESTABLE (no DB access in
this or the originating pass) — verified by hand against every
`partner_requests`-touching call site in `src/` and every status-setting
`UPDATE` across `supabase/`.

Still open from §11: MIME allowlist, Realtime channel authorization audit,
full edge-function audit, encryption lifecycle threat model, session/
clock-skew handling, telemetry review, TS `any`/unsafe-cast audit,
push-token/device-table RLS. Verdict unchanged: **NOT READY**.

## 16. Addendum — 2026-09-16, continued: the actual `finalize-upload` bucket bug

Set out to implement the "MIME allowlist for attachments/backups" item and
found something more urgent instead: those aren't the real buckets. See
P1-6's updated entry above and `supabase/functions/finalize-upload/index.ts`'s
own header comment for the full trace — short version: the 2026-09-10 fix's
bucket allowlist (`avatars`/`attachments`/`backups`, sourced from
`scripts/sql/storage_buckets.sql`) doesn't match what `Chat.tsx`/`Gallery.tsx`
actually upload through (`chat-files`/`gallery`, provisioned inline across
the numbered migrations instead). Every chat attachment and gallery upload
would have been rejected by that "fix" — a functionality regression, not
just an unfixed security gap. Fixed: added the real buckets to the
allowlist with evidence-based size caps and, for `gallery` only, a MIME
allowlist matching its own file-picker's `accept` attribute; left
`chat-files` deliberately unrestricted since its own file picker accepts
any file type by product design. Also fixed the MIME check itself, which
was comparing by exact string equality despite being named
`allowedMimePrefixes`. Flagged `scripts/sql/storage_buckets.sql` as stale
in its own header rather than deleting it (no dependency analysis done on
whether anything outside `src/` still relies on the `attachments` bucket
name it describes).

**This finding is a reminder for future passes**: a fix that can't be
tested live (true of nearly everything in this document) can break real
functionality just as easily as it can close a real gap, and the only
defense is checking the fix against actual call sites by hand — which is
what caught this one, a turn late rather than never.

Live behavior still NOT TESTABLE. Verdict unchanged: **NOT READY**.

## 17. Addendum — 2026-09-16, continued: the §15 migration actually ships

§15 above describes a `partner_requests` transition-guard fix as already
applied via `supabase/migrations/20260916120000_partner_requests_transition_guard.sql`.
That describing pass ran in a different session than this one; only its
narrative (this document, `.ai/CHANGELOG.md`) reached this session, not
the migration file itself or the `PartnerSettings.tsx` invite-code change
it also describes — neither existed in the snapshot this session started
from. Rather than leave the gap silently unfixed behind already-"FIXED"
prose, this session re-derived and shipped both, independently verified
against the same call sites:

- `supabase/migrations/20260916140000_partner_requests_transition_guard.sql`
  — the `BEFORE UPDATE` trigger + `sender_id <> receiver_id` check
  constraint §15 describes, PLUS one thing §15's narrative did not
  mention fixing: `accept_partner_request` was still missing the
  already-partnered guard its sibling `accept_invite` has (both parties'
  `profiles.partner_id` must be `NULL` before linking) — added in the
  same migration, matching `accept_invite`'s existing pattern exactly.
- `src/pages/settings/PartnerSettings.tsx`'s `generateInviteCode()` —
  the `crypto.getRandomValues`/32-symbol-alphabet fix §187's table row
  now reflects as FIXED.

Live behavior still NOT TESTABLE (no DB access in this session either).
Verified by hand against every `partner_requests` call site in `src/`
(`Onboarding.tsx`, `PartnerSettings.tsx`, `Settings.tsx` — confirmed via
grep to only SELECT/INSERT/DELETE directly; the sole UPDATE path is
inside `accept_partner_request` itself) and against `accept_invite`'s
already-correct already-partnered check. Verdict unchanged: **NOT
READY** — this closes two more items off the open queue
(`.ai/NEXT_PHASE.md`) without materially changing the overall posture,
since Realtime channel authorization, the full edge-function audit, and
push-token RLS remain untouched.

## 18. Addendum — 2026-09-16, continued: Realtime channel authorization

Closed the next queue item (`.ai/NEXT_PHASE.md` item 1: "Realtime channel
authorization audit").

**Finding**: postgres_changes-based channels (the large majority — chat
messages, gallery, calls, memories, playlists, shayaris, etc.) are safe
regardless of channel name, since Realtime enforces the underlying
table's own RLS row-by-row before delivery. Broadcast/Presence channels
are not — they have no table backing them at all, and this project had
never configured Realtime Authorization (RLS on `realtime.messages` +
`private: true`), so every broadcast/presence channel was fully public:
anyone who knew or guessed the topic name could join, listen, and send.

Four channels used broadcast/presence. Three (`typing-<pair>`,
`presence-<pair>`, `groic:<uid1>:<uid2>`) embed both partners' real UUIDs
in the topic — exploiting them requires already knowing both IDs, but
that is a real threat model for this specific product: an **ex-partner**
who was previously paired with someone still knows their UUID
indefinitely (UUIDs don't rotate on unlink), and could keep silently
watching someone's typing activity, online/offline status, and shared
listening sessions long after DuoSpace unpaired them. That's precisely
the surveillance scenario `.ai/DO_NOT_CHANGE.md` exists to prevent, even
though nobody introduced this bug intentionally. The fourth,
**`blend-sync`, was worse: not scoped to a couple at all** — one global
channel name shared by every user in the app with an active blend
session, letting any authenticated client observe, and inject spoofed
playback-control broadcasts into, every other couple's session.

**Fix**: `supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql`
adds `is_couple_realtime_topic_authorized()` (validates a
`<prefix>:<uid1>:<uid2>` topic against the caller's *current*
`partner_id` — not just "any two UUIDs", closing the ex-partner scenario
specifically) plus matching RLS policies on `realtime.messages`. Client
changes: `useChatTyping.ts`/`useChatPresence.ts` switched their topic
format from hyphen-joined (`typing-<uid1>-<uid2>`, ambiguous to parse
server-side since UUIDs already contain hyphens) to colon-joined
(matching `groic:` which already used colons safely); `blend-sync` was
rescoped to `blend-sync:<uid1>:<uid2>`; all four channels now pass
`config: { private: true }`.

**Not achievable from a migration**: per Supabase's own documentation,
private channels also require disabling "Allow public access" under
Project Settings → Realtime → Settings in the dashboard — a manual,
project-level toggle this environment cannot reach. The migration is
inert (zero behavior change) until both that toggle is disabled and the
client changes above are deployed together; it is safe to apply on its
own in the meantime. **This is the one action item in this whole
document that requires Aradhya to do something outside of code** —
flagging it plainly rather than letting it hide in a changelog.

Live behavior NOT TESTABLE (no DB or dashboard access in this
environment). Remaining from §11: full edge-function audit, push-token
RLS review, docs-vs-source discrepancy matrix. Verdict unchanged: **NOT
READY**.

## 20. Addendum — push-token / device-table RLS review

Reviewed `public.push_tokens` and `public.known_devices` — the two
tables the queue item covers.

**Both check out clean, no fix needed.** Both follow the same
deliberately narrow pattern: `GRANT SELECT, DELETE ON ... TO
authenticated` (no INSERT, no UPDATE grant at all — a client cannot
write to either table directly, period, removing an entire class of
potential RLS-bypass bugs before it can exist) plus `GRANT ALL ... TO
service_role`. RLS policies on both are `auth.uid() = user_id` for
SELECT and DELETE — a user can only ever see or remove their own rows.

The only write path for either table is a `SECURITY DEFINER` trigger
(`sync_push_token_to_push_tokens`, fires on `profiles` UPDATE) or
`known_devices`' own writer (the already-audited `notify-signin` edge
function, service-role). The `profiles` UPDATE RLS policy that gates the
push_tokens trigger's input (`auth.uid() = user_id`, verified consistent
across every migration that redefines it) means a user can only ever
trigger a push_tokens write for their own `user_id` — there is no path
for User A to create or modify a push_tokens row attributed to User B.

**One minor, low-priority observation, not fixed:** `push_tokens.token`
has a `UNIQUE` constraint with `ON CONFLICT (token) DO UPDATE SET
user_id = EXCLUDED.user_id` — so if User B ever submitted the literal
token *value* belonging to User A's real device (not User A's user_id,
the actual FCM/APNs token string), ownership of that row would
reassign to User B. Exploiting this requires already possessing another
user's live device push token, which isn't derivable from a UUID,
username, or anything else this app exposes — a meaningfully higher bar
than every other finding in this document, and not something this app's
own database layer can fully defend against (no way to cryptographically
verify a submitted token's real owner without platform-level attestation
neither FCM nor APNs commonly provides to app backends). Noted for
completeness, not treated as urgent.

Also checked: `_shared/fcm.ts`'s error logging already truncates the
token to 12 characters before logging it (`token=${pushToken.token.slice(0,
12)}…`) — no raw-token log leak found there or in `_shared/apns.ts`.

Remaining from §11: encryption lifecycle threat model, session/
clock-skew handling, general telemetry review beyond what the Phase 1
redaction pass already covered client-side, TypeScript `any`/unsafe-cast
audit, docs-vs-source discrepancy matrix. Verdict unchanged: **NOT
READY**.
