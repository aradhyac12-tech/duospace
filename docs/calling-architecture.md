# DuoSpace calling architecture (current, authoritative)

There is exactly **one** calling provider. No provider switch, env flag,
per-device override or fallback exists.

| Concern | Owner |
|---|---|
| Auth, partner relationship, call history/state persistence, push tokens | **Supabase** |
| Call control: ring / accept / reject / cancel / end | **DuoSpace WebSocket signaling** (`infrastructure/signaling`, self-hosted) |
| Media | **LiveKit Cloud** (Build plan, free tier) |
| Connectivity when direct paths fail | **LiveKit Cloud managed TURN** |
| Wake a backgrounded/killed device | **FCM** (Android) / **APNs + PushKit/CallKit** (iOS) |
| UI | Existing DuoSpace Calls / Chat / incoming-call UI (unchanged) |

**Infra-layer migration note (this revision):** media/SFU/TURN moved from a
self-hosted LiveKit + coturn container pair to LiveKit Cloud. Nothing
else changed — same signaling gateway, same Supabase migration, same
`livekit-token` edge function code, same authorization rules, same call
state machine, same reconnect logic, same UI. `infrastructure/livekit`
and `infrastructure/coturn` no longer contain a deployable config; see
their `README.md` files.

Supabase Realtime is **not** in the normal call lifecycle. It remains only as
labelled recovery/persistence infrastructure.

## Identity (one id end to end)

- `callId` = `call_history.id`. The caller generates it and sends it in the INSERT.
- `sessionId` = `call_history.session_id`. The database generates it, and every signaling message must carry it (the gateway refuses mismatches).
- `roomName` = `duo-call-<callId>`. It is derived. `livekit-token` derives it server-side; the stored `room_name` is never trusted, and the client refuses a token for any other room.
- Telemetry traces carry `callId`; cleanup (`cancelOutgoingCall`, `signalCallTerminated`, history update) is keyed by `callId`.

## Outgoing

1. `signalingBridge.ensureReady()`: an authenticated socket (short-lived ticket from `signaling-ticket`), 5s bound.
2. `createOutgoingCallRoom()` inserts `call_history` (`provider='self_hosted'`, enforced by DB trigger).
3. `CALL_OFFER` goes over the socket. The gateway validates sender, partnership, call, session and ring window, then delivers or reports `RECIPIENT_OFFLINE`; push wakes the callee in that case.
4. `joinCall(callId)`:
   - `livekit-token` (≤15s)
   - `room.connect` (≤20s)
   - mic publish (≤12s)
5. `waitForRemoteAudioReady` (≤8s), then connected.

On any failure after step 2, the caller releases media, cancels over signaling and persistence (`join_failed`), and shows the existing error UI.

## Incoming

Socket `CALL_OFFER` or push, then the existing incoming UI. On Accept: `claim_call` → `CALL_ACCEPTED` over the socket → `joinCall(callId)` (token only after the claim; `livekit-token` refuses otherwise). Accept failure releases media, marks history `failed`, and terminates over signaling.

## Authorization (`livekit-token`)

- Identity comes from the verified Supabase JWT only.
- Call facts come from the service-role RPC `signaling_get_call_facts`, the same source the gateway uses.
- A token is issued only if **all** of these hold:
  - the user is a participant
  - the users are currently mutual partners
  - the provider is `self_hosted`
  - the status is `in_progress` and the call is not declined
  - a receiver holds the claim
  - a caller is still within the ring window or the call was answered
- Room is derived; TTL 300s default, clamped 60–900s. Rules live in `supabase/functions/_shared/livekitAuthz.ts` (unit-tested).

## Connection bounds (no endless "Connecting…")

`SelfHostedCallEngineAdapter` has these bounds and guards:
- **Stage timeouts:** token 15s, connect 20s, mic publish 12s. Each has a classified error.
- **Reconnect watchdog:** 30s.
- **Duplicate-join guard.**
- **Join-generation guard:** `leaveCall()` during a join aborts it (`JoinCancelledError`, no error UI).
- **Unexpected disconnect:** error state and full cleanup.

Telemetry stages: `signaling_ready`, `token_requested`, `token_ready`, `livekit_connect_started`, `livekit_connected`, `participant_joined`, `remote_track_received`, `remote_audio_ready`, `call_connected`.

## Signaling robustness (gateway)

- **Connection:** short-lived ticket auth, origin allowlist, one socket per user (a new socket replaces the old; a replaced socket's in-flight messages are rejected `STALE_CONNECTION`), app ping every 15s, TCP ping/terminate every 30s.
- **Messages:** schema validation, msgId de-duplication, session validation, rate limit, typed ACKs (`DELIVERED` / `RECIPIENT_OFFLINE` / `DUPLICATE` / `REJECTED`+reason). Retryable rejections are retried under the same msgId.
- **Offline peers:** offline offers are replayed on reconnect while still ringing.

## TURN

The relay is **LiveKit Cloud's managed TURN** — Cloud mints and expires TURN credentials per session and terminates its own TLS; there is no TURN certificate, domain, or port to manage on your own infrastructure anymore. `infrastructure/coturn` and `infrastructure/livekit`'s old TURN config are removed (see their `README.md` files) — they predate this migration and were never a second TURN path.

`npm run check:calling` validates the signaling gateway's production env statically: placeholders, localhost/private hosts, wss, no obsolete `VITE_CALL_PROVIDER`, and flags any leftover `LIVEKIT_*` vars in that file (they no longer belong there — see below). It does not and cannot validate LiveKit Cloud connectivity. **Only a real two-device call proves media actually connects.**

## Required production configuration

- **Frontend build:** `VITE_SIGNALING_URL=wss://…`. Required: without it, calls fail with `NOT_CONFIGURED`, and there is no fallback.
- **Supabase secrets (`livekit-token`):** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — from your LiveKit Cloud project (Settings → Keys), `SUPABASE_SERVICE_ROLE_KEY` (the platform provides it), optional `LIVEKIT_TOKEN_TTL_SECONDS`. These are the **only** place LiveKit credentials live — never in `infrastructure/deployment/.env*`, never behind `VITE_`.
- **Signaling server (self-hosted, unchanged):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SIGNALING_ALLOWED_ORIGINS`, ticket secret (see `infrastructure/deployment`). Still needs its own host + TLS — LiveKit Cloud does not replace this piece.

## Native

Android (Telecom/ConnectionService, CallStyle notifications, foreground services) and iOS (CallKit/PushKit, `AVAudioSession`) are provider-agnostic. Media runs in the WebView's WebRTC, which LiveKit uses exactly as before. No native changes were required. **Not verified on devices.**
