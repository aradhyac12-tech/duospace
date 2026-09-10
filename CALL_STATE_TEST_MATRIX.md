# DuoSpace Call State Test Matrix

Companion to the production-hardening pass in `20260808150000_call_hardening.sql`
and `supabase/functions/send-voip-push`. Every scenario below traces the
actual code path (file + function), not a hypothetical one.

## call_history.status values found in code

The column is plain `text` with no CHECK constraint (predates this pass;
left alone per "don't rewrite stable existing logic unnecessarily" — see
Known Limitations). Values actually written, by whom:

| Status | Written by | Guarded? |
|---|---|---|
| `in_progress` | `startCall()` insert (Chat.tsx/Calls.tsx) | insert-time only |
| `completed` | `endCall()` (Chat.tsx/Calls.tsx) | **now** `.eq("status","in_progress")` (was unguarded — fixed this pass) |
| `missed` | `decline_call()` RPC (30s auto-timeout or manual decline) | atomic CAS, `claimed_by IS NULL` |
| `cancelled` | `cancel_call()` RPC (caller backs out pre-answer) | atomic CAS, `claimed_by IS NULL` |
| `seen` | `FloatingDock.tsx` (missed-call badge read-receipt) | `.eq("status","missed")` — only touches already-terminal rows, not part of the live race window |

`claimed_by`/`claimed_at`/`claimed_device_id` are a separate axis from
`status` — a call can be `in_progress` AND claimed (mid-connect) or
`in_progress` AND unclaimed (still ringing everywhere). This is what makes
"connected" not a distinct `status` value: "connected" = `in_progress` +
`claimed_by IS NOT NULL`, tracked in-memory client-side (`callState` in
`useDailyCall.ts`) rather than persisted, since Daily's own WebRTC
connection state is the actual source of truth for audio/video being live
— persisting a `connected` DB status would just be a second, potentially
stale copy of that.

## Forbidden simultaneous states — verified

| Combination | How it's prevented |
|---|---|
| connected + cancelled | `cancel_call()`'s `WHERE claimed_by IS NULL` — cannot cancel once claimed |
| connected + missed | `decline_call()`'s `WHERE claimed_by IS NULL` — cannot decline once claimed |
| ended + connected | `endCall()` now requires `status='in_progress'` to transition to `completed` (fixed this pass — was previously unguarded) |
| declined + connected | same as "connected + missed" — declining IS the missed transition |
| cancelled + connected | same as "connected + cancelled" |

All four RPCs (`claim_call`, `cancel_call`, `decline_call`) are single
atomic `UPDATE ... WHERE ... RETURNING`, not check-then-update. Postgres's
normal row-level locking on `UPDATE` serializes any two of them racing on
the same row: the second to reach the lock re-evaluates its `WHERE`
against the first's already-committed result, so it either legitimately
also matches (impossible here, since the first one's write always negates
the second's guard) or safely returns `false`/no-op. This is standard
Postgres MVCC behavior, not custom code — nothing extra was needed for
this guarantee once every writer used the same atomic-CAS shape.

## Scenario matrix

| Scenario | Expected result | Verification |
|---|---|---|
| Normal call (A calls B, B answers, talks, hangs up) | `in_progress` → claimed → `completed` | LOGICALLY VERIFIED |
| Caller cancels before answer | `in_progress` → `cancelled` via `cancel_call()`, VoIP `cancel` push ends ringing elsewhere | LOGICALLY VERIFIED |
| Recipient declines | `in_progress` → `missed` via `decline_call()` | LOGICALLY VERIFIED |
| Recipient misses (30s timeout, no action) | Same as decline — `IncomingCallOverlay`'s timer calls the same `handleDecline()` | LOGICALLY VERIFIED |
| Recipient answers | `claim_call()` succeeds, Daily token fetched (now authorized — see `authorizeRoomAccess`), `setCurrentCallId` | LOGICALLY VERIFIED |
| Two devices answer simultaneously | Exactly one `claim_call()` UPDATE wins (atomic CAS); loser sees `claimed !== true`, shows "answered elsewhere" toast, never calls `daily-call` | STATICALLY VERIFIED (SQL logic traced); REQUIRES TWO REAL DEVICES for a true concurrency test |
| Answer + cancel race (caller cancels, recipient answers ~same instant) | Whichever `UPDATE` commits first wins the row; the other's `WHERE claimed_by IS NULL` (cancel) or the claim's own `WHERE status='in_progress'` fails, deterministically, in Postgres — no dual-write possible | STATICALLY VERIFIED |
| Answer + expiry race (call's 40s `expires_at` passes right as Answer is tapped) | `claim_call()`'s `WHERE ... expires_at > now()` fails past expiry — the call cannot be claimed even if the tap technically preceded the deadline by the time the write reaches Postgres | LOGICALLY VERIFIED; REQUIRES REAL DEVICE for exact-boundary timing |
| Cancel + decline race | Mutually exclusive by construction — cancel is caller-only (`caller_id=auth.uid()`), decline is receiver-only (`receiver_id=auth.uid()`); whichever RPC's `UPDATE` commits first flips `status`, the other's `WHERE status='in_progress'` then fails | STATICALLY VERIFIED |
| Duplicate incoming push (same call, delivered twice) | `apns_push_log` UNIQUE(call_id, push_token_id, event_type) blocks a second *server* dispatch; `CallKitManager.reportIncomingCall`'s new `currentCallId == callId` guard (this pass) blocks a second CallKit UI even if a duplicate somehow still reaches the device | LOGICALLY VERIFIED; REQUIRES Xcode+REAL DEVICE to see actual duplicate PushKit delivery |
| Duplicate cancel push | Same `apns_push_log` idempotency key, different `event_type` bucket (`cancel`) | LOGICALLY VERIFIED |
| Network loss (mid-call) | Daily/WebRTC's own reconnect handling (`useDailyCall.ts`'s "sustained poor-network audio fallback", pre-existing) — `call_history.status` stays `in_progress` throughout, no state-machine interaction | NOT RE-AUDITED this pass (pre-existing, not in scope) |
| Reconnect after network loss | `daily-call`'s `get-token` action is called again if a fresh token is needed — now authorized via `authorizeRoomAccess` (this pass), so a legitimate reconnect for a still-open call still succeeds | LOGICALLY VERIFIED |
| App killed (recipient, mid-ring) | iOS: PushKit relaunches the app in the background specifically to handle the VoIP push — `reportIncomingCall` still fires. Android: FCM high-priority + full-screen intent (pre-existing, not touched) | REQUIRES REAL DEVICE + Xcode/Android |
| iOS backgrounded | CallKit's system-level incoming-call UI is OS-owned, independent of app foreground state — this is the entire reason CallKit/PushKit exist | REQUIRES REAL DEVICE + Xcode |
| Android backgrounded | Pre-existing ConnectionService + full-screen notification, not touched this pass | REQUIRES ANDROID DEVICE |
| Device logout | `signOutAndClearPushTokens()` (Settings.tsx, this pass) invalidates this device's tokens before `auth.signOut()` — a subsequent call to the signed-out account no longer rings this device | LOGICALLY VERIFIED |
| Token rotation | `push_tokens` UNIQUE(user_id, device_id, token_type) lets a rotated token upsert in place (`usePushNotifications.ts`'s `voipTokenUpdated` handler); old token string simply stops being referenced, no explicit cleanup needed since it's replaced, not duplicated | LOGICALLY VERIFIED |

## Legend
- **LOGICALLY VERIFIED** — traced end-to-end through the actual code/SQL in this repo; internally consistent, not executed.
- **STATICALLY VERIFIED** — the specific guarantee (e.g. atomicity) is a direct, checkable property of the SQL as written (single `UPDATE...WHERE...RETURNING`, no read-then-write), not merely asserted.
- **REQUIRES REAL DEVICE / Xcode / ANDROID DEVICE / APNs** — cannot be exercised in this sandbox (no Xcode, no physical iPhone/Android hardware, no live Apple Developer credentials, no network egress for `supabase db push`/`functions deploy`).

## Known limitations (honest, not papered over)

1. **No CHECK constraint on `call_history.status`.** A typo'd status string anywhere in the app would silently insert bad data — RLS/RPCs don't validate the *value*, only the *transition guards* (`WHERE status = 'in_progress'`). Not added this pass because `'seen'` is a legitimate, pre-existing value outside the 10 the audit named, and enumerating it correctly needs a decision from whoever owns the missed-call-badge UX, not an assumption made here.
2. **Android's Telecom/ConnectionService side was not independently re-audited for a CallKit-UUID-equivalent duplicate-call guard.** The task's item 7 named CallKit specifically; Android's FCM path already has its own dedup (existing `send-push`), and Android wasn't reported as broken. Flagging as a gap rather than silently assuming parity.
3. **`answered_elsewhere`/`isAnswered` native logic is unverified on a real device.** The architecture (server-side device exclusion + client-side `isAnswered` guard, two independent layers) is sound on paper; only Xcode + two physical iPhones can confirm CallKit actually behaves as documented for this exact sequence.
4. **`authorizeRoomAccess`'s room-name matching uses `ilike '%/' || roomName` .** This assumes `call_history.room_name` always stores a URL ending in `/<roomName>` (true for every insert path in this repo today) — if a future code path ever stores a bare room name with no leading URL, the `room_name.eq.${roomName}` half of the `.or()` already covers that case, but it's worth re-checking if Daily's room-naming scheme ever changes.
