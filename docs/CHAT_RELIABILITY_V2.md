# Chat Reliability v2 — audit + implementation report

Scope actually implemented in this pass: **Phase A (discovery), Phase B
(stable client-generated identity), Phase C (idempotent server insert),
and the parts of Phase D (client reconciliation) that were reachable from
that identity** — the direct text/media send path, its retry path, its
offline-recovery rehydration, the realtime INSERT handler, and the
fetchMessages() optimistic-reconciliation block.

**Everything else in the original 46-section brief (receipts, typing,
presence, channel-lifecycle audit, ordering/tie-breakers, pagination
races beyond the reconciliation fix above, delete-event replica identity,
virtualization/render-perf profiling, RLS/SECURITY DEFINER audit, keyset
pagination, and the full test suite) was NOT implemented in this pass.**
That is a multi-week effort across a ~2,000-line Chat.tsx and a dozen
Supabase migrations, not something that can be done responsibly in one
sitting — and per the brief's own section 37 ("do not fake testing"),
claiming broader coverage than what's below would be exactly the kind of
unverified claim this effort exists to avoid. This document only reports
what was actually inspected and changed.

## A. Findings

| Severity | File | Problem | Impact |
|---|---|---|---|
| High | `src/pages/Chat.tsx` (`attemptSendText`, `attemptSendMedia`) | `supabase.from("messages").insert(...)` carried no idempotency key. `clientId` (`pending-<uuid>`) existed only in memory/IndexedDB, never sent to the server. | A retry after a lost HTTP response (server actually inserted the row, client never saw the 2xx) created a second canonical message. Violates Invariant 1/2. |
| High | `src/pages/Chat.tsx` (pending-text rehydrate effect) | Offline-queued text sends were deliberately *not* auto-resent on reconnect, specifically because there was no safe idempotent insert path — instead relied on a "same content within a 5-minute window" heuristic to decide whether a queued send already went through. | Exactly the "content + timestamp proximity" identity anti-pattern the brief calls out; could misfire on legitimately repeated text (three "okay"s within 5 minutes) and either silently drop a real duplicate cleanup or leave a genuinely-sent message stuck as "failed". |
| Medium | `src/hooks/useChatRealtimeMessages.ts` (`hasOptimisticTwin` in the INSERT handler) | Optimistic/realtime reconciliation matched on `sender_id + receiver_id + message_type + content`, not a stable ID. | Two legitimately identical in-flight messages could match the wrong optimistic bubble against one incoming row, silently suppressing a message that no other code path was going to (re-)insert — potential silent message loss, not just a cosmetic duplicate. |
| Medium | `src/pages/Chat.tsx` (`fetchMessages()` optimistic-reconciliation block, ~line 454) | Same content-based heuristic as above, used when reconciling optimistic bubbles against a full refetch (pagination/reconnect resync). | Same failure class as above, triggered on reconnect/pagination instead of on a single realtime event. |
| High | `src/pages/Chat.tsx` (`handleSend`'s `sendDedup` guard) | Double-tap protection keyed by `${user.id}-${text.slice(0,20)}-${Date.now()}`, held for the full network round trip. `Date.now()` in the key meant two real taps almost never collided — the guard was close to a no-op against the exact thing it was built for (brief section 7's own named example of the anti-pattern). | Double-tap / duplicate-submit was effectively unprotected client-side (server-side idempotency below is the real backstop, but the guard itself wasn't doing its job). |
| Low (noted, not fixed — out of scope for this pass) | `src/pages/Chat.tsx` (`fetchMessages()` select list, line ~425) | The explicit column list does not select `is_pinned` or `edited_at`, even though both are read from realtime UPDATE payloads elsewhere. | Pin/edit state may not survive a fresh fetch (page reload) if the realtime UPDATE that set it was missed. Independent of this pass's scope; flagged for follow-up. |
| High | `src/components/chat/MessageReactions.tsx` (`useReactionsChannel`) | The `message_reactions` postgres_changes listener had no `filter` at all. This exact codebase already established, for the sibling `messages` channel (`useChatRealtimeMessages.ts`'s own "FIX BUG-02" comment), that RLS alone does not scope postgres_changes delivery in this project — an unfiltered listener receives every row change table-wide. The `reactions-convo-${pair}` channel name never actually scoped anything server-side. | Every reaction (message_id, user_id, emoji) on every OTHER couple's conversation was delivered to this client too — a metadata leak of the same class already fixed for `messages`, just not carried over to reactions. |
| Medium | `src/components/chat/MessageReactions.tsx` (`useReactionsChannel`, INSERT handler) | `payload.new` was appended to state with no id check. Realtime delivery must be assumed at-least-once, and the listener subscribes while `fetchAll()` is still in flight — a race where a reaction lands in the initial fetch AND arrives as its own INSERT event. | Could show a duplicated reaction (same emoji from the same person rendered twice) on a race or a redelivered event. |
| Medium | `supabase/migrations/…get_partner_id` (SECURITY DEFINER function) | Used throughout this project's RLS policies as `get_partner_id(auth.uid())`, but the function itself never validated that the `_user_id` parameter equals `auth.uid()` — it used its DEFINER privileges to look up any user's `partner_id` given any id. `EXECUTE` is granted to `authenticated`, so any signed-in user could call it directly via RPC with someone else's id and learn who that person's partner is. | Partner-linkage enumeration across the whole user base, bypassing the RLS that would otherwise protect that column on `profiles`. |
| High (pre-flagged, not previously fixed) | `guard_message_update()` trigger (RLS layer for `messages` UPDATE) | A prior migration (`20260811102000_fix_messages_update_rls_regression.sql`) had already found and documented — but explicitly left open pending product confirmation — that its identity-field checks (`sender_id`/`receiver_id`/`created_at`) only run when the updater is NOT the sender. The sender's own UPDATE policy has no field-level restriction beyond `auth.uid() = sender_id`, so the sender could `UPDATE messages SET receiver_id = '<anyone>' WHERE id = <own sent message>` and it would pass both the policy and the trigger untouched. | A sender could redirect one of their own already-sent messages to an arbitrary third-party user id, making it instantly readable to that user under the existing SELECT policy and mixing it into an unrelated conversation. Verified no app code or edge function anywhere updates these three fields before closing this. |
| Low (pre-flagged, not previously fixed) | `useChatRealtimeMessages.ts`'s DELETE listener | Deliberately unfiltered, with an existing code comment explaining why: default REPLICA IDENTITY only puts `id` in a DELETE's old-row payload, leaving nothing to filter on. Same "every client receives every event table-wide" class already fixed for INSERT/UPDATE and for `message_reactions`. | Narrow in practice (a deleted message's bare UUID carries little on its own), but still unnecessary table-wide broadcast + event amplification (every client re-runs delete-handling logic for every conversation's deletes, not just their own). |
| High (user-reported, root-caused from a screen recording) | `src/components/chat/MessageTimeline.tsx` (virtualized row key, `wasSeen`/`skipEnterAnimation` tracking, and the non-virtualized `<AnimatePresence>` path's `key={msg.id}`) | A just-sent message's `msg.id` starts as `pending-<uuid>` and is replaced with the real server id the instant the insert is confirmed (by design — see the identity model below). Every render path used `msg.id` directly as the React key. React treats a key change as "item removed, different item added" — the optimistic bubble unmounts (playing its exit animation under `<AnimatePresence>`) and a "new" one mounts in its place (playing its entrance animation again). The codebase already had a `skipEnterAnimation`/`wasSeen` mechanism built specifically to prevent replaying entrance animations on already-seen messages, but it was keyed by the same unstable `msg.id`, so it never caught this case. | User-visible: a message you just sent visibly disappears for a few frames and then reappears — confirmed frame-by-frame from a user-submitted screen recording (extracted with ffmpeg), not just a reported perception. |

**How this one was found:** the user reported "it sends and then appears
again" with a screen recording. Extracting frames at native framerate
around the send action showed the bubble actually fade to nothing for
several frames before fading back in — not a subtle layout shift, a real
mount/unmount cycle.

Everything else audited (channel lifecycle, presence, typing, receipts,
ordering, pagination internals, RLS policies, delete-event replica
identity, virtualization) was **read but not modified** in this pass; no
findings are reported for it because it wasn't reviewed to the depth
needed to make a reliability claim either way.

## B. Changes made

- `src/pages/Chat.tsx`
  - Added `toClientMessageId()`, `insertMessageIdempotent()` (shared by
    text + media sends): inserts with `client_message_id` set; on a
    Postgres `23505` (unique_violation) specifically on that column,
    fetches and returns the already-canonical row instead of throwing.
  - `attemptSendText` / `attemptSendMedia` now route their insert through
    `insertMessageIdempotent`, passing `client_message_id` derived from
    the existing `clientId`.
  - Rewrote the pending-text rehydration effect to auto-retry via
    `attemptSendText` (mirroring the existing media-rehydration effect)
    instead of the content/timestamp heuristic — safe now that the
    server is idempotent on the reused `client_message_id`.
  - `fetchMessages()`'s optimistic-reconciliation block now matches
    stale bubbles against fetched rows by `client_message_id` instead of
    content; added `client_message_id` to the fetch's column list (it
    was not previously selected).
  - Replaced `handleSend`'s content+timestamp-keyed `sendDedup` guard
    (module-level `createSendDedup()` Set, locked for the whole network
    round trip) with a `useRef`-based same-tick re-entrancy guard,
    cleared on the next microtask. Catches the same-tap-fires-twice race
    it was meant to catch without being keyed by content — so it can no
    longer suppress a later, genuinely separate send of identical text.
    Removed the now-unused `createSendDedup` import and module-level
    instance (the utility itself is untouched in `networkState.ts` and
    still covered by its own existing tests).
- `src/hooks/useChatRealtimeMessages.ts`
  - INSERT handler's `hasOptimisticTwin` check now matches by
    `client_message_id` instead of content/sender/receiver/type.
- `src/types/chat.ts`
  - Added `client_message_id?: string | null` to the `Message` type.
- `src/components/chat/MessageReactions.tsx`
  - `useReactionsChannel`'s realtime listener now uses two `user_id`-filtered
    postgres_changes listeners (mirroring the existing `messages`-channel
    pattern) instead of one unfiltered listener, closing the cross-couple
    reaction-metadata leak described above.
  - INSERT handling is now deduped by reaction id.
- `src/components/chat/MessageTimeline.tsx`
  - Added `stableMessageKey(msg)`: returns a key derived from
    `client_message_id` (or the pending id's UUID portion) instead of
    `msg.id`, so it stays constant across a message's optimistic →
    confirmed transition.
  - Virtualized path: row `key` and the `seenRowKeysRef`/`wasSeen` check
    (which drives `skipEnterAnimation`) now use `stableMessageKey`
    instead of `msg.id`.
  - Non-virtualized `<AnimatePresence>` path: `MessageBubble`'s `key`
    now uses `stableMessageKey` instead of `msg.id`.
  - `flatIndexByMessageId` (scroll-to-message/search-jump) now builds
    from each row's real `messageId` (a new separate `FlatRow` field),
    not from `row.key` — kept deliberately on the *real* id, since
    lookups only ever target already-confirmed messages. The DOM
    `id="msg-${msg.id}"` `MessageBubble` sets on its own root node is
    untouched (it's a separate prop, not derived from the React key).

**Migrations added this round:**
- `supabase/migrations/20260910140000_lock_get_partner_id_to_self.sql` —
  `get_partner_id(_user_id)` now validates `_user_id = auth.uid()`
  internally (`WHERE ... AND _user_id = auth.uid()`) instead of trusting
  the parameter, closing the partner-enumeration RPC hole. Fully backward
  compatible — every existing RLS call site already passes `auth.uid()`.
- `supabase/migrations/20260910150000_lock_message_identity_fields_for_sender_too.sql` —
  moved `guard_message_update()`'s `sender_id`/`receiver_id`/`created_at`
  checks outside the "non-sender" branch so they're enforced for every
  updater, closing the sender-side field-mutation gap a prior migration
  had already found and explicitly left open.
- `supabase/migrations/20260910160000_messages_replica_identity_full.sql` —
  `ALTER TABLE public.messages REPLICA IDENTITY FULL`, so a DELETE's old-row
  payload carries every column (not just the primary key), enabling the
  DELETE listener fix below. Trade-off (increased WAL volume for
  UPDATE/DELETE on this table) evaluated in the migration's own comment,
  not applied blindly.

**Code change enabled by that migration:**
- `src/hooks/useChatRealtimeMessages.ts`'s DELETE listener now uses the
  same two-listener `sender_id`/`receiver_id` filter pattern as
  INSERT/UPDATE (deduped by id), instead of being unfiltered — closing
  the last unfiltered `messages` realtime listener.

## C. Database changes

- **Migration**: `supabase/migrations/20260910130000_messages_client_message_id_idempotency.sql`
  - **Column**: `public.messages.client_message_id uuid`, nullable (legacy
    rows and any insert path not yet updated to set it — scheduled
    messages, imported history, love letters, surprises, call-event rows
    — remain valid; see brief section 39).
  - **Index**: `idx_messages_client_message_id`, a **unique partial
    index** on `client_message_id WHERE client_message_id IS NOT NULL`.
    Enforces "one client_message_id → one canonical row" at the database
    level, scoped globally (not per-sender) — a client_message_id is
    generated once per send attempt and only ever reused by retries of
    that exact attempt.
  - No RLS changes. No RPC/SECURITY DEFINER function was introduced —
    idempotency is handled by the unique index plus an application-level
    catch-and-fetch on `23505`, which works within the existing
    client-side-insert + RLS architecture without a new server-side
    function or elevated privileges.
  - Forward-only: no existing migration file was modified.

## D. Message identity model

- **`clientId`** (unchanged): `pending-<uuid>`, generated client-side the
  moment a send is initiated. Used as the optimistic bubble's React key
  (`id`) and as the IndexedDB key for offline recovery. Never sent to the
  server as-is.
- **`client_message_id`** (new): the bare UUID portion of `clientId`
  (`clientId.replace(/^pending-/, "")`), sent to the server on every
  insert attempt for that same logical send — including retries and
  reconnect-triggered resends — and enforced unique by
  `idx_messages_client_message_id`.
- **Canonical message ID**: the server-assigned `id` (existing primary
  key), returned on the first successful insert.
- **Retry**: reuses the same `clientId` → same `client_message_id`. If
  the original insert already succeeded, the retry's insert hits the
  unique index; `insertMessageIdempotent` catches that and fetches the
  existing row by `client_message_id` instead of surfacing an error or
  creating a duplicate.
- **Realtime reconciliation**: an incoming INSERT's `client_message_id`
  is compared against `pending-${client_message_id}` in current state —
  an exact match (not a content heuristic) identifies the optimistic
  bubble that this row supersedes.

## E. Reliability scenarios

| Scenario | Status |
|---|---|
| Retry after lost HTTP response | Now handled — idempotent insert returns canonical row |
| Offline-queued text auto-resend on reconnect | Now handled — was previously manual-retry-only |
| Realtime arrives before/after HTTP, for one send | Improved — exact-ID match instead of content heuristic |
| Two legitimately identical messages ("okay"/"okay"/"okay") | Improved — no longer at risk of being conflated by the content-based heuristics that were removed |
| Double tap / duplicate send | Now handled — `handleSend`'s guard was rewritten (see Changes made); the old version rarely blocked anything |
| Pagination + realtime races beyond the reconciliation fix above | Not addressed in this pass |
| Media upload/ack-loss duplication | Improved as a side effect (same `insertMessageIdempotent` path), not independently tested |
| Channel lifecycle / duplicate subscriptions | Audited: `useChatRealtimeMessages`, `useChatTyping`, `useChatPresence` all have correct single-subscribe/single-cleanup lifecycles with properly memoized effect dependencies — no changes needed. `useReactionsChannel`'s lifecycle was also correct; its filtering and dedup were the actual problems, now fixed above. |
| RLS policy audit | Focused audit done — `messages`-adjacent policies and `get_partner_id`; two real gaps found and fixed. Full table-by-table policy audit not done. |
| Message ordering / tie-breakers | Audited — already correct. `groupedTimeline` (what's actually rendered, confirmed in both the virtualized and non-virtualized paths) sorts by `created_at` with a deterministic tie-breaker chain (insertion-order timestamp, then id). No change needed. |
| Delete-event realtime filtering | Fixed — `REPLICA IDENTITY FULL` + filtered DELETE listeners, closing a gap that was previously flagged but left unfixed pending the schema change. |
| Sent-message disappear/reappear flicker (user-reported) | Fixed — `stableMessageKey` decouples the render key from `msg.id`'s optimistic→confirmed transition. Root-caused from a screen recording, not just statically reasoned about. |

## F. Performance

No measurements were taken. No claims are made about send/realtime
latency, render impact, or query cost for these changes.

## G. Security

- RLS: two policy-layer fixes this round (see migrations above) —
  `get_partner_id` locked to self-lookups, and `guard_message_update()`
  extended to block sender-side identity-field mutation. Both verified
  against every current call site in `src/` and `supabase/functions/`
  before applying, and both are backward compatible with existing
  legitimate usage. The rest of the RLS/SECURITY DEFINER surface (105
  occurrences of "SECURITY DEFINER" across migrations, mostly comments/
  reuses of a handful of actual functions) was scanned for missing
  `search_path` — none found missing it. A full manual read of every
  policy on every table was NOT performed; this pass focused on the
  `messages`-adjacent policies and the one widely-reused DEFINER helper.
- Idempotency authorization: enforced by the same RLS as the original
  insert (the fallback SELECT-on-conflict runs as the same authenticated
  user, filtered to their own sent row) — no service-role or elevated
  path introduced.
- Encryption: unchanged. `client_message_id` is separate from
  `content`; the idempotency key does not touch the encrypted payload or
  the encryption protocol.
- Telemetry: one new `logInfo` call on the conflict-resolution path,
  logging only `clientMessageId` (a UUID, not message content).
- No SECURITY DEFINER function was added.

## H. Tests

No test files exist for this pipeline yet, and none were added in this
pass — see "Remaining risks" below.

| Check | Status |
|---|---|
| `npm run lint` | NOT RUN — no `node_modules`, no network access in this environment |
| `npx tsc -b --noEmit` | NOT RUN — same reason |
| `npm test` | NOT RUN — same reason |
| `npm run build` | NOT RUN — same reason |
| Manual static review (brace/paren balance, call-site consistency, RLS read of new column) | STATICALLY VERIFIED |

This environment has no `node_modules` and no network egress, so none of
the required verification commands (brief section 43) could actually be
executed. All of the above is **statically verified by reading the code
only** — it has not been run against a real Supabase project, a real
database, or a device, and none of the specific test scenarios in
section 36 of the original brief (identity, optimistic reconciliation,
retry, offline recovery, pagination, stale updates, delete, identical
messages) have been automated or manually exercised.

## I. Remaining risks / explicitly not verified

- **Not run**: lint, typecheck, unit tests, build — no toolchain
  available in this environment. Before merging, run all four locally or
  in CI.
- **Not tested against a real Supabase project**: the migration has not
  been applied to any database; the unique-index/`23505` behavior is
  based on standard Postgres semantics, not observed.
- **Not tested on a physical device or with real network conditions**:
  none of the network-failure-matrix scenarios (brief section 28) were
  exercised.
- **Double-tap / duplicate-submit protection** (`pendingSendQueue`'s
  in-flight lock) was read but not re-audited or changed in this pass.
- **Everything outside the send/reconcile path** — typing, presence,
  receipts, channel lifecycle, pagination internals beyond the
  optimistic-reconciliation fix, delete-event replica identity, RLS
  policy audit, virtualization/render performance — was not modified and
  should not be assumed fixed by this document.
- **The disappear/reappear animation fix was root-caused from a screen
  recording and static code tracing, not from running the app.** Deploy
  and send a message on a real device to confirm the flicker is gone —
  frame-extraction from a recording is strong evidence for *what* was
  happening, but this specific fix still hasn't been observed working.
