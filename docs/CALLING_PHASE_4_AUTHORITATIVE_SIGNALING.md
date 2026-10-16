# Calling Phase 4 — authoritative WebSocket signaling for self-hosted calls

Status (2026-09-20): **implemented in source, verified only in-process.**
Nothing here has run against a live Supabase project, a real gateway
process, LiveKit, TURN, or a device. See §O/§P/§Q.

## A. Current architecture

| Layer | Role for SELF-HOSTED calls |
|---|---|
| WebSocket gateway (`infrastructure/signaling`) | **Call control**: offer (ring), ringing, accept, reject, cancel, end, ring-timeout, resync. Authenticates, **authorizes every message against Supabase**, validates state, acks the sender. |
| LiveKit | Media transport / SFU. Unchanged. |
| TURN | Connectivity fallback — LiveKit's *embedded* TURN in staging/production. **Unverified.** |
| Supabase | Auth, `call_history` persistence/history, authorization data (`signaling_get_call_facts`, `claim_call`, `decline_call`, `cancel_call`, transition guard). |
| Push (FCM / APNs-VoIP / native call UI) | Offline/background wake-up. Unchanged. The gateway reports `RECIPIENT_OFFLINE`; it never tries to replace push. |
| Daily | Separate provider, default, untouched. Never touches the gateway. |

What the source now demonstrates: for a self-hosted call, ringing and all
call-control are driven by the gateway, each critical event has a typed
result the caller acts on, and no self-hosted flow *awaits* Supabase
Realtime. What it does **not** demonstrate: that any of this works over a
real network (§P).

## B. What changed from the previous ZIP

- **Gateway** (`infrastructure/signaling/src`): new `gateway.ts` (routing +
  authorization core, socket-independent), `callRegistry.ts` (ephemeral call
  state machine), `authorizer.ts` (one service-role RPC); `server.ts` is a thin
  `ws` adapter; protocol gained ack/state/ready/ping frames and `CALL_SYNC`.
- **Database** (`20260920140000_signaling_call_facts_and_session_id.sql`):
  `call_history.session_id` (DB-generated, frozen by the transition guard) +
  `signaling_get_call_facts(uuid)` (service_role only). *(Renamed from
  `…130000`, which collided with `20260920130000_qr_partner_link_fix.sql`.)*
- **`livekit-token`**: authorization extracted to
  `_shared/livekitAuthz.ts`. The room is **derived** (`duo-call-<callId>`);
  the caller-chosen `call_history.room_name` is no longer trusted (a caller
  could previously insert any room name and be minted a token for it).
  Adds provider check, receiver-must-hold-claim, ring-expiry for the caller.
- **Client** (`src/lib/signalingEngine`): `WebSocketSignalingEngine` rewritten
  (fresh ticket per attempt — the old fixed URL made every reconnect after
  120 s fail 401; ready-not-open; backoff; half-open detection);
  `CallSignalingClient` (typed results, same-msgId retry, sessions, stale
  filtering, resync); `callSignalingBridge` is now its React face.
- **App wiring**: `Calls.tsx`, `Chat.tsx`, `CallContext.tsx`,
  `IncomingCallOverlay.tsx`, `useCallOutcome.ts`, `MinimizedCallBubble.tsx`,
  `usePushNotifications.ts`, `createOutgoingCallRoom.ts`. **No JSX/markup
  was changed** (checked by diff).
- **Telemetry**: new stages; real token marks (the accept flow used to mark
  `token_requested/ready` at claim time, before any token existed);
  `remote_audio_playing` fires on the element's `playing` event; and a
  measurement fix — see §N.
- **Infra**: local/staging/production split, required gateway env, corrected
  TURN docs, coturn moved behind an opt-in profile (§ENVIRONMENTS.md).
- **Lockfile**: the uploaded ZIP's lock now agrees with `package.json`
  (`npm run check:lock`, static). Not `npm ci`-verified.

## C. Exact self-hosted OUTGOING flow (Calls.tsx / Chat.tsx)

1. Tap → latency trace, `START_OUTGOING`, call screen up (unchanged).
2. In parallel: busy check, permission prompt, **`ensureReady`** (≤5 s).
3. Await ready. **Not ready → the call fails** with a clear message. No
   Realtime fallback; no implicit switch to Daily.
4. Mint `callId` (UUID) and `roomName = duo-call-<callId>`; INSERT
   `call_history {id, provider:'self_hosted', room_name, …}`. The DB returns
   the authoritative `session_id` (missing ⇒ error: migration not applied).
5. **`offer()`** → gateway authorizes (caller/receiver/provider/partners/
   `in_progress`/unclaimed) → forwards a *server-built* `CALL_OFFER` to the
   callee's socket → acks. `DELIVERED` or `RECIPIENT_OFFLINE` (push rings them)
   proceed; anything else → `cancel_call` + failure. The DB insert also fires
   the existing push triggers.
6. If cancelled meanwhile → `cancelOutgoingCall`. Else `joinCall` →
   `livekit-token` (authorized) → LiveKit connect → publish → wait for remote
   audio → connected.

## D. Exact self-hosted INCOMING flow

1. `CALL_OFFER` arrives on the socket → client drops it unless recipient is
   me, sender ≠ me, callId/session valid, not a duplicate.
2. Overlay `onOffer`: ring window not lapsed, not already handled →
   `hydrateIncomingCall` (dedupe, state machine, **the existing UI**) →
   `ringing()` ack to caller. In the background it re-reads the row and
   dismisses the ring if the row isn't the call the wire claimed (caller,
   provider, `in_progress`, unclaimed, session). Native push/CallKit/Telecom
   handling untouched.
3. **Accept**: `claim_call` (atomic) → `CLAIM_WON` → `CALL_ACCEPTED` over the
   socket **in parallel with** token fetch + LiveKit join (the token requires
   the claim). A definitive gateway refusal (call over / wrong session)
   aborts the join through the existing cancelled-accept path; a transport
   failure is logged and does **not** abort (claim won; the caller still sees
   the participant appear).
4. Wait for remote media → connected.

Recovery (labelled, never awaited): if the socket is down when the Realtime
INSERT arrives, the overlay rings from it immediately
(`realtime-recovery-socket-down`); if the socket is up but no offer follows in
2 s it rings anyway (`…no-offer`). Cold-start poll unchanged. Recovered calls
register their `session_id` so accept/reject still travel over the socket.

## E. Cancel / reject / end

- **Reject**: `decline_call` first (atomic authority) → only if it returned
  true → `CALL_REJECTED` (reason `user` | `timeout`). Caller's ringing stops
  immediately via `useCallOutcome`'s socket listener.
- **Cancel** (caller): `cancelOutgoingCall` = `cancel_call` first. Won →
  `CALL_CANCELLED`. Refused (callee already claimed) → converted to
  `CALL_ENDED`. The gateway independently refuses `CALL_CANCELLED` once the
  call is `ACCEPTED`, and the client converts that refusal into an end too.
- **End**: the page's existing DB finalization runs, then
  `signalCallTerminated` → `CALL_ENDED`; the peer tears down its provider
  session (`leaveCall`) and does **not** write the DB again.
- **Timeout**: gateway-originated `CALL_TIMEOUT` (40 s = `expires_at`) to both.
- **Failure handling**: each send returns `DELIVERED | RECIPIENT_OFFLINE |
  DUPLICATE | REJECTED(reason) | QUEUED | TIMEOUT | FAILED`; retried under the
  same `msgId` (gateway idempotent), waits for reconnect, bounded deadline.
  The DB write already happened, so the peer's Realtime recovery still sees it.

## F. WebSocket authentication

Unchanged model: short-lived (120 s) HS256 ticket from the `signaling-ticket`
edge function; the gateway verifies it before the upgrade. New: the client
fetches a **fresh ticket for every connection attempt**, and the socket
counts as ready only after the gateway's `ready` frame (authenticated +
registered), not on bare `open`.

## G. WebSocket authorization (new)

Per message: sender is caller or receiver of the call; `recipientId` is the
*other* participant; `sessionId` equals `call_history.session_id`; provider is
`self_hosted`; OFFER needs a current mutual partnership, `in_progress`,
unclaimed, ring window open; ACCEPT needs the sender to actually hold the
claim in Supabase; every event is validated against the state machine
(unknown call, stranger, wrong session, accept-after-terminal, reject-after-
accepted, cancel-after-accepted/ended, end-from-stranger, client-sent
`CALL_TIMEOUT` all refused with a typed reason). Client-claimed
`senderId/ts/payload/roomName/provider/state` are never trusted: the gateway
stamps identity and builds the forwarded message. Facts come from one
`SECURITY DEFINER` RPC granted to `service_role` only, computed from the
existing `profiles.partner_id` model (no second relationship system).

## H. LiveKit authorization

`authorizeLiveKitToken`: caller/receiver only · `provider='self_hosted'` ·
`status='in_progress'` (no historical tokens) · receiver needs
`claimed_by = self` · caller can't join after an unclaimed ring lapsed · room
**derived from the call id**. Secrets remain server-side. Client, gateway and
edge function derive the room identically (parity test).

## I. Supabase's remaining responsibilities

Authentication; `call_history` persistence/history; the atomic transitions
(`claim_call`, `decline_call`, `cancel_call`, guard trigger); authorization
data for the gateway and `livekit-token`; analytics; push triggers;
Realtime **only** as the labelled recovery path.

## J. Push notification responsibilities

Unchanged: FCM / APNs-VoIP / native Telecom+CallKit wake a backgrounded or
killed device. `RECIPIENT_OFFLINE` is the gateway telling the caller "push is
the path". Native background decline updates the DB directly and announces it
on `duospace-call-native-decline`; a live socket then also tells the caller.

## K. Daily responsibilities

Everything Daily did. Daily never touches the gateway: with the default
provider (or `VITE_SIGNALING_URL` unset) the bridge creates no transport,
fetches no ticket and opens no socket; the hook does no network work on
mount (asserted in `callSignalingBridge.test.ts`, not run — §P).

## L. Prewarming (self-hosted only)

On sign-in: open the signaling socket. In idle time: load the LiveKit SDK
chunk; wake the `livekit-token` isolate with an *empty* request that fails 400
after auth and mints nothing. Deliberately not done: microphone/camera/
permissions, fake call records, LiveKit connections, long-lived credentials.

## M. Reconnection

Engine: backoff + fresh ticket per attempt; app-level server `ping` every
15 s and a 40 s client watchdog for half-open sockets; `online`/visibility
nudges skip the backoff. Client: after a reconnect it sends `CALL_SYNC` per
live call; the gateway answers with the call's state and the client
synthesizes any *missed* terminal event once (legal order: accept then end);
nothing is recreated and media is never touched. A callee that was offline
when the offer was sent gets it replayed on connect if still ringing. Old
sessions/calls can't affect new ones (callId + sessionId + state checks on
both sides — tested with old accept/cancel/end after a new call and after
reconnect).

## N. Telemetry

Stages: `call_button_tapped` (= *call_button_pressed*), `call_session_created`,
`signaling_ready`, `invite_sent`, `invite_received`, `ringing_displayed`,
`accept_pressed` (aliases the incoming trace's tap), `accept_sent`,
`token_requested`, `token_received` (+ legacy `token_ready`),
`livekit_connect_started`, `livekit_connected`, `remote_track_received`,
`remote_audio_attached`, `remote_audio_playing`, `connected`. Ring-time
stages happen before an incoming trace exists, so they're stashed by callId
and appear as *negative* offsets from `accept_pressed`. Derived metrics
(incl. **`acceptToRemoteAudioPlayingMs`**) are computed only from marks that
exist; missing ⇒ omitted/null, never estimated.

**Measurement bug found and fixed:** `telemetry.logInfo` flattens a metrics
object to `{raw: JSON truncated at 200 chars}` *after* key-name redaction, so
the per-call latency object arrived cut off and every `token*` key was
`[redacted]`. The full summary now travels as a compact `name=ms` line in the
log *message* (not truncated, not key-redacted). Verified through the real
telemetry ring buffer (`callLatencyPhase4.test.ts`).
Known gap: the accept flow still marks `connected` after a bounded wait even
if remote audio never played (source is labelled `remote-audio-timeout`);
`remote_audio_playing` is simply absent then.

## O. Tests run (in-process, local vitest-compatible shim — NOT real vitest)

164 tests passed: gateway/protocol/rate-limit 68 (new), engine 11,
`CallSignalingClient` 21, architecture 12, protocol/room-name parity 6,
LiveKit authz 8, latency 5 (all new), plus 33 pre-existing (shape validator
15, percentiles 4, provider-field 2, state machine 12). The architecture test
runs the **real gateway + real client + real LiveKit authz** with **no
Realtime object anywhere**: offer → ring → claim → accept → caller receives
acceptance → same `roomName`; reject/cancel/end; stale-cancel race
converted to end; strangers/non-partners/Daily rows refused; WebSocket
unavailable ⇒ `FAILED`/`TIMEOUT` (never success); not configured ⇒
`NOT_CONFIGURED`. Strict `tsc` is clean on the gateway core and the client
signaling modules; the React files pass a syntax-level `tsc` (a duplicate
`callRef` it found was fixed).

## P. Tests NOT run

Real vitest / `npm ci` / project `tsc` / eslint / build (npm returns 403 here);
`createOutgoingCallRoom.test.ts` (needs `vi.mock`) and `callSignalingBridge.test.ts`
(needs Testing Library + `vi.mock`) — rewritten, unrun; every React component
and hook under a renderer; the migration and `signaling_get_call_facts`
against Postgres; the gateway as a process, with `ws`/`jose`; docker/compose;
LiveKit; TURN; `livekit-token` under Deno; any device.

## Q. Remaining blockers

See `.ai/KNOWN_ISSUES.md` KI-33…KI-41. Headline: nothing verified end-to-end;
migration must be applied and gateway env set; TURN unverified; caller UI
doesn't yet consume `CALL_ACCEPTED`; one socket per user; single gateway
instance; gateway has no lockfile.

## R. Physical-device test matrix (Phase 5 prerequisites)

| # | Caller | Callee | Network | Check |
|---|---|---|---|---|
| 1 | Android | Android | same Wi-Fi | offer→ring, accept, audio, end both ways |
| 2 | iOS | Android | Wi-Fi ↔ LTE | as 1 + cancel/reject/timeout |
| 3 | Android | iOS | LTE ↔ LTE (CGNAT) | as 1; TURN relay actually selected |
| 4 | any | any | callee app **backgrounded** | push rings; accept over socket after wake |
| 5 | any | any | callee **killed** | push/native path; recovery session registration |
| 6 | any | any | kill Wi-Fi mid-call 10 s, restore | no duplicate UI/media; end still propagates |
| 7 | any | any | airplane-mode callee at offer time | `RECIPIENT_OFFLINE`; late connect replay |
| 8 | any | any | caller cancels as callee taps Accept (×20) | never a cancelled connected call |
| 9 | any | any | gateway stopped | call fails clearly; Daily unaffected |
| 10 | any | any | Daily provider | full regression |

## S. Exact next phase

**CALLING PHASE 5 — REAL DEVICE + REAL NETWORK LATENCY BENCHMARKING.** Measure
tap→invite received, invite→accept, accept→token, token→LiveKit connected,
LiveKit→remote track, remote track→remote audio, and total
accept→remote-audio-playing (`acceptToRemoteAudioPlayingMs`) — Daily vs
self-hosted, on real devices/networks (matrix above). Prerequisites: apply the
migration; deploy gateway (single instance) + LiveKit (+ TURN, verified via
the checklist); run real `npm ci`/vitest/tsc/lint. No architecture changes
before then.
