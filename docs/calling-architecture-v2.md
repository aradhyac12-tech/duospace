> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

# DuoSpace Calling Architecture v2 — Phase 1

> **Superseded in part by Phase 4 (2026-09-20):** for self-hosted calls the
> WebSocket gateway is now the authoritative call-control layer, not a
> best-effort parallel signal, and it authorizes every message. Read
> `docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md` first; statements below
> about signaling being supplementary or unauthorized are historical.

Status: **architecture scaffold, Daily remains the default and only
production-verified path.** This document describes what Phase 1 of the
Daily → self-hosted (LiveKit) migration built, what it deliberately did
not build yet, and what is and is not verified.

## Current architecture (before this phase)

- `src/hooks/useDailyCall.ts` — Daily.co calling, directly. One hook, one
  `DailyCall` object app-wide (see its own header comment for why —
  Daily only allows a single instance per page).
- `src/contexts/CallContext.tsx` — single app-wide instance of the call
  hook, shared via React context so Chat.tsx/Calls.tsx don't each create
  their own. Owns the `call_history` row lifecycle (claim/decline/cancel
  RPCs), push-notification wiring, native CallKit/Telecom bridging,
  session recovery.
- `supabase/functions/daily-call` — creates Daily rooms + meeting tokens.
  Key resolution: caller's own key → partner's key → platform fallback.
- Supabase `call_history` table — the call's durable record and stable
  identifier (`id` doubles as "call id" everywhere).
- Supabase Realtime on `call_history` — how ringing/accept/cancel state
  actually propagates today. This IS the signaling transport currently.

## New architecture (this phase)

```
UI (Calls.tsx, Chat.tsx, CallStage, MinimizedCallBubble, ...)
        │
        ▼
CallContext.tsx  (unchanged app-wide singleton pattern)
        │
        ▼
useCallEngine()                    ← src/lib/callEngine/useCallEngine.ts
        │
        ├── DailyCallEngineAdapter      (= useDailyCall(), untouched)
        │
        └── SelfHostedCallEngineAdapter (new, LiveKit-based, opt-in)
                    │
                    ├── SignalingEngine (WebSocketSignalingEngine)
                    │        │
                    │        ▼
                    │   infrastructure/signaling (Call Gateway, new)
                    │
                    └── LiveKit Room client
                             │
                             ▼
                        infrastructure/livekit (SFU, new)
                             │
                             ▼
                        infrastructure/coturn (TURN, new)

Supabase: unchanged as the persistent data layer (call_history + two new
columns: `provider`, `ended_reason`). NOT used as the self-hosted path's
signaling transport (STEP 5) — that's WebSocketSignalingEngine/Call
Gateway. Daily's path is untouched and still uses Supabase Realtime for
its own ring/accept/cancel flow, exactly as before.
```

### Core design principle, honored

`CallContext.tsx` now calls `useCallEngine()` instead of `useDailyCall()`
directly. It has zero knowledge of which provider is active. The default
resolves to `DailyCallEngineAdapter`, which is a literal 1:1 pass-through
of the existing `useDailyCall()` hook — **no behavioral change on the
Daily path.**

## CallEngine API (`src/lib/callEngine/types.ts`)

Modeled on `useDailyCall.ts`'s existing return shape, not the migration
brief's aspirational list — per the brief's own instruction to preserve
existing UI behavior rather than invent a new one. `joinCall` /
`leaveCall` / `toggleAudio` / `toggleVideo` / `toggleScreenShare` /
`switchCamera` / `listCameras` / `cycleCamera` / `reattachRemoteVideo` /
`waitForRemoteAudioReady`, plus the existing state fields
(`callState`, `networkQuality`, `callError`, `callDuration`, ...).

## DailyAdapter design

`src/lib/callEngine/DailyCallEngineAdapter.ts` — a one-line identity
wrapper around `useDailyCall()`. `useDailyCall.ts` itself was not
touched. Nothing about Daily calling's watchdogs, cleanup, reconnect
logic, or error handling changed.

## SelfHostedAdapter design

`src/lib/callEngine/SelfHostedCallEngineAdapter.ts` — LiveKit-based,
same lazy-SDK-load-once pattern as Daily's adapter (bundle-size
discipline). Fetches a short-lived token from the new `livekit-token`
edge function, connects a `livekit-client` `Room`, wires
mute/camera-toggle/participant-tracking/network-state to the same
`CallEngine` shape.

**Not implemented this phase** (flagged, not guessed at):
- Screen share (no-op stub)
- `cycleCamera` (no LiveKit-native front/back-cycle equivalent to
  Daily's `cycleCamera()`)
- Auto audio-only downgrade on sustained poor network
- Fallback-to-Daily on failure (see "Fallback strategy" below)

**NOT RUNTIME-VERIFIED** — no network egress or live LiveKit/signaling
deployment has ever been reachable from any sandbox this project has
used. This adapter typechecks against the same interface
`DailyCallEngineAdapter` does and mirrors its behavioral contract as
closely as LiveKit's client API allows, but has not connected to a real
room.

## Signaling architecture

`src/lib/signalingEngine/types.ts` defines the event vocabulary
(`CALL_OFFER`, `CALL_RINGING`, `CALL_ACCEPTED`, `CALL_REJECTED`,
`CALL_CANCELLED`, `CALL_BUSY`, `CALL_ENDED`, `PARTICIPANT_READY`,
`NETWORK_CHANGED`, `RECONNECT_REQUEST`, `CALL_TIMEOUT`) and message
shape (sender/recipient/callId/ts/sessionId — every message
self-describing enough to validate and to discard if stale).

`WebSocketSignalingEngine` (client) talks to
`infrastructure/signaling` (server) — a small authenticated WebSocket
relay. The server verifies the connecting client's Supabase access
token (never trusts a client-claimed user id), stamps every relayed
message with the server-verified sender id and server timestamp, and
routes by `recipientId` to that user's live socket if one exists. It
holds no call state across a restart — `call_history` remains the
durable record.

**Known gap, flagged not fixed**: the gateway does not check that
`recipientId` is actually the sender's partner before routing — see
`infrastructure/signaling/src/server.ts`'s own doc comment for why this
is lower-severity than it sounds (misdirected notification, not call
access) but should still be closed before production traffic.

**NOT RUNTIME-VERIFIED.**

## LiveKit architecture

`infrastructure/livekit/livekit.yaml` — config template with TURN
enabled by default (STEP 12: never P2P-only). `SelfHostedCallEngineAdapter`
is the only client-side consumer.

## TURN architecture

`infrastructure/coturn/README.md` — shared-secret (`use-auth-secret`)
credential model documented; app-side short-lived credential minting is
flagged as a follow-up rather than implemented (LiveKit's own `turn:`
config block, pointed at this coturn instance, covers Phase 1's actual
need).

## Token / security model

- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` never leave
  `supabase/functions/livekit-token` (server-side Deno env only).
- The frontend never receives a LiveKit API secret — only a short-lived
  (`LIVEKIT_TOKEN_TTL_SECONDS`, default 600s), room-and-identity-scoped
  access token, minted per call.
- Authorization: `livekit-token` requires the caller to be `caller_id` or
  `receiver_id` on the named `call_history` row (RLS-scoped Supabase
  client, same trust model as `claim_call`/`decline_call`) before minting
  anything.
- The signaling server derives identity from a verified Supabase JWT
  (`SUPABASE_JWT_SECRET`), never a client-claimed user id.
- `VITE_`-prefixed env vars are build-time-public by Vite's own design —
  `infrastructure/deployment/.env.example` calls this out explicitly so
  a secret never accidentally gets that prefix.
- Nothing here has been penetration-tested or run against a live
  deployment.

## Startup latency instrumentation

`src/lib/callLatency.ts` gained four additive stages
(`provider_selected`, `engine_initialized`, `ice_connected`,
`sfu_connected`) and a `provider` field on each trace. Existing Daily
traces are unaffected — Daily's adapter never marks the new stages
(same reasoning as the file's pre-existing "Daily doesn't expose
ICE-level events" note), so nothing about today's Daily latency logging
changed shape or behavior.

`src/lib/callLatencyPercentiles.ts` adds a pure P50/P75/P90/P95 helper
(STEP 11) for whatever aggregation layer eventually consumes a batch of
`call.latency` telemetry events — no such aggregation pipeline is wired
up yet; this is the math piece, not a dashboard.

**First remote audio remains the primary KPI**, per the brief — not
"joined". This was already true of the existing Daily instrumentation
(`waitForRemoteAudioReady`, `first_remote_audio` mark) and is preserved
identically; `SelfHostedCallEngineAdapter` marks the equivalent LiveKit
moment (`RemoteTrack.attach()` on an audio track).

## Database changes

One additive migration
(`supabase/migrations/20260916130000_call_history_provider_column.sql`):
- `call_history.provider` (`daily` | `self_hosted`, default `daily`,
  frozen after insert by the existing transition-guard trigger)
- `call_history.ended_reason` (free text, same trust tier as the
  existing `cancel_reason` column — descriptive only, not authoritative)

No new tables — `call_history.id` remains the one stable call
identifier across both providers, per the brief's explicit instruction
not to create a duplicate call/room table.

## Mobile / Capacitor changes

**None this phase.** `SelfHostedCallEngineAdapter` runs the same
browser/WebView-hosted WebRTC path Daily's client already uses inside
the Capacitor WebView — no native Kotlin/Swift changes were made or are
believed necessary for the core connect/mute/camera path. NOT VERIFIED
on a physical device or inside an actual Capacitor build (no Android
SDK, no Xcode, no device in this sandbox, consistent with every prior
session's stated limitation). The existing native CallKit/Telecom
incoming-call bridge (`native/android/CallBridge.kt`,
`native/ios/CallKitManager.swift`) was not touched and continues to
forward accept/decline into JS exactly as before — `useCallEngine()`
sits below that bridge, not athwart it, so it should Just Work once a
call is accepted, but this has not been exercised.

## Provider selection / feature flag

`src/lib/callProviderConfig.ts` — `daily` (hard default) /
`self_hosted` (opt-in, per-device `localStorage` override or
`VITE_CALL_PROVIDER` build flag) / `auto` (scaffolded type, resolves to
`daily` — not implemented, see below). No product-facing settings UI
toggle exists; this is a dev/QA escape hatch only, documented in
`infrastructure/deployment/README.md`.

## Fallback strategy

**Not implemented this phase**, and not silently bolted on. Real
fallback needs the *active engine* to be able to change mid-attempt,
which conflicts with `useCallEngine()`'s current "resolve once per
mount" design (a React Hooks constraint — you cannot conditionally call
a different hook after a failure). The concrete recommendation for a
later phase: either (a) collapse both adapters into class-based engines
behind one stable hook so switching is a plain method call, not a hook
swap, or (b) implement retry-with-different-provider at the
`CallContext.tsx` call-site level instead of inside the engine
resolver. Documented here rather than guessed at in code.

## Local development

See `infrastructure/deployment/README.md`.

## Production deployment

Not attempted — `infrastructure/deployment/docker-compose.yml` and the
individual service READMEs are the starting point, all explicitly
NOT RUNTIME-VERIFIED.

## Future Daily removal plan (not this phase)

1. Verify `SelfHostedCallEngineAdapter` end-to-end on real devices across
   representative networks (Wi-Fi, cellular, carrier-grade NAT).
2. Implement the fallback strategy above and prove it doesn't create
   duplicate active sessions (STEP 20/21).
3. Implement app-minted short-lived TURN credentials (coturn README's
   flagged follow-up).
4. Close the signaling gateway's same-couple authorization gap.
5. Run both providers side-by-side in production behind the feature flag
   long enough to compare P50/P75/P90/P95 startup and first-audio
   latency (STEP 10/11) under identical real-world conditions.
6. Only once self-hosted matches or beats Daily on the primary KPI
   (tap → first remote audio) across that comparison: flip the default,
   keep Daily as the fallback for one more release, then remove
   `DailyCallEngineAdapter` and `useDailyCall.ts`.

## Tests added

- `src/test/callProviderConfig.test.ts` — provider resolution precedence
  and malformed-override handling.
- `src/test/signalingEngine.test.ts` — `SignalingMessage` shape
  validation (well-formed / missing fields / non-string ts / stale
  sessionId is a shape-valid but state-machine concern, documented as
  such).
- `src/test/callLatencyPercentiles.test.ts` — percentile math, empty
  batch, non-finite filtering.
- `infrastructure/signaling/test/signaling.test.ts` — server-side
  message validation, and `SessionRegistry`'s stale-connection
  replacement semantics (STEP 21: a late-closing old socket must not
  evict a newer connection for the same user).

## Known limitations

- `SelfHostedCallEngineAdapter` and the entire `infrastructure/`
  directory are NOT RUNTIME-VERIFIED — no network egress, Docker, live
  Supabase project, LiveKit deployment, or physical device was reachable
  in the environment this phase was built in.
- No automated two-peer connection test exists for the self-hosted path.
- Signaling gateway: one live socket per user (no multi-device
  fan-out) — a deliberate Phase 1 simplification, matching this
  codebase's existing "single slot, not a list" 1:1-calling assumption
  elsewhere (`DuoSpaceConnectionService.kt`), but a real limitation if a
  user is signed in on two devices simultaneously.
- No fallback-to-Daily-on-failure.
- `cycleCamera` and screen share are unimplemented on the self-hosted
  path.

## Things that require physical-device testing

- Actual call setup/first-audio/first-video latency numbers for either
  provider on real hardware/networks — nothing in this phase produces a
  single real measurement, only the instrumentation to eventually take
  one.
- Capacitor/WebView behavior for the self-hosted LiveKit client
  specifically (backgrounding, audio routing, Bluetooth/headset
  behavior, proximity sensor, screen lock) — inherited assumptions from
  Daily's already-verified behavior in the same WebView, not
  independently confirmed for LiveKit's client.
- TURN relay behavior across real NAT types (carrier-grade NAT, Wi-Fi →
  cellular handover).

## Things that cannot be verified in the current environment

- Anything requiring network egress: `npm install` of the new
  dependencies (`livekit-client`, and `infrastructure/signaling`'s `ws`
  / `jose`), any Docker build, any live connection test, any Supabase
  migration `db push`/`db reset`, any edge function deploy.
- JWT verification in `infrastructure/signaling/src/auth.ts` against a
  real Supabase-issued token (no live project's JWT secret available
  here).

---

# Phase 2 — making the self-hosted path actually connect end-to-end

Status headline, upfront, per Phase 2's own instruction not to say
"production ready" without every check actually occurring:

**Incoming/accept-side self-hosted calling is wired through the CallEngine
abstraction. Outgoing/caller-side self-hosted calling is now ALSO wired,
as of this update** — `Calls.tsx` and `Chat.tsx` both branch on
`activeProvider` at their room-creation step and call
`createOutgoingCallRoom("self_hosted", ...)` instead of unconditionally
hitting Daily's edge function. **This closes the #1 blocking item this
document previously called out.** Nothing in this phase has been
exercised against a live Supabase/LiveKit/signaling deployment; this is
still static analysis + unit tests, not a real call — see "Known risks"
below, which now reflects the wiring having actually happened.

## 1. Audit findings — the implementation map

```
CALL INITIATION → SIGNALING → AUTH → TOKEN → PROVIDER → ROOM → ICE → MEDIA → REMOTE AUDIO → CALL HISTORY
```

Traced end-to-end for both directions:

**Outgoing (caller), as of this update:** `Calls.tsx`/`Chat.tsx`'s
`startCall` now branches on `call.activeProvider` at the room-creation
step. For `daily`: byte-identical to before Phase 2 — untouched, same
code path, same `create-and-token` call, same insert-overlaps-with-join
latency optimization. For `self_hosted`: a separate, parallel branch
calls `createOutgoingCallRoom("self_hosted", ...)`, which inserts (and
awaits) the `call_history` row FIRST — required because `livekit-token`
authorizes by looking that row up — then calls `joinCall(callId, ...)`.
This is new code, added by directly editing both files (see Section 5) —
not the "leave it as an unwired helper" deferral this document originally
described. **NOT RUNTIME-VERIFIED** — see Section 17.

**Incoming (callee), as of this phase:** `CallContext.tsx`'s
`acceptIncomingCallImpl` and `rejoinRecoveredCall` now branch on
`call.activeProvider`. For `daily`: unchanged, identical to before this
phase. For `self_hosted`: skips the Daily token fetch entirely and calls
`call.joinCall(callId, undefined, ...)` — `SelfHostedCallEngineAdapter`
fetches its own LiveKit token via `livekit-token`, keyed on that `callId`,
which by this point in the flow already has a `call_history` row (the
caller inserted it to make the phone ring at all). **This half of the
path is structurally correct** — genuinely NOT the same "silently would
fail" state the outgoing half is in — but still not runtime-verified.

**Why the two halves are asymmetric:** `call_history`'s row must exist
before `livekit-token` can authorize anything (it looks the call up by
id). The callee always receives a `callId` for an already-existing row —
trivial to route through the abstraction correctly. The caller's own flow
creates that row concurrently with/after requesting a room — fine for
Daily (whose room creation doesn't depend on `call_history` at all) but
backwards for self-hosted. Fixing it requires reordering
`Calls.tsx`/`Chat.tsx`'s insert-before-join for the self_hosted branch
specifically — see `createOutgoingCallRoom.ts`'s own doc comment for the
exact, already-written recipe. Not applied this phase — see
"Known risks" below.

## 2. What was already implemented (start of this phase)

Everything Phase 1's own document above describes: the `CallEngine`
abstraction, both adapters, `SignalingEngine` types + WS client (still
unused by either adapter — see "Signaling flow" below), `livekit-token`,
`infrastructure/`, latency stage additions, provider config, initial
tests.

## 3. What was missing / broken, found this phase

1. **`beginCallLatencyTrace` never received a provider argument** at
   either of its two call sites in `CallContext.tsx` — every trace,
   Daily or self-hosted, was silently stamped `provider: "daily"`. The
   provider-comparison telemetry Phase 1 built existed but produced no
   real self-hosted data. **Fixed.**
2. **Incoming/accept path was Daily-only** regardless of the feature
   flag (see above). **Fixed.**
3. **Outgoing/caller path was Daily-only** regardless of the feature
   flag (see above). **Fixed as of this update** — see Section 5 for
   exactly what changed in `Calls.tsx`/`Chat.tsx`.
4. **No reconnect handling** in `SelfHostedCallEngineAdapter` —
   `ConnectionStateChanged` set an error flag on disconnect but never
   transitioned `callState`, ran a timeout watchdog, or cleaned up. A
   real disconnect would leave the UI showing a stale "joined" call
   indefinitely. **Fixed** — mirrors `useDailyCall.ts`'s own 30s
   reconnect-timeout pattern exactly (same duration, same shape).
5. **No token-expiry handling** — nothing decoded or tracked the
   LiveKit token's own `exp` claim, so an expiry-caused disconnect would
   surface as a generic connection error instead of something
   actionable. **Fixed** (detection + classification; NOT a silent
   refresh — see `SelfHostedCallEngineAdapter.ts`'s own comment on why
   that wasn't attempted unverified).
6. **Camera acquisition blocked first audio** — `joinCall` awaited
   `setMicrophoneEnabled` AND `setCameraEnabled` sequentially before
   `callState` ever became `"joined"`, meaning first-audio for a video
   call was gated behind camera setup. **Fixed** (STEP 13 "audio
   first" — mic awaited alone, camera publishes async).
7. **No WebRTC-level diagnostics** — nothing distinguished ICE/TURN/
   media-startup latency from each other. **Added** (`webrtcDiagnostics.ts`,
   dev-only, STEP 12).
8. **SignalingEngine/`infrastructure/signaling` remain unused** by
   either adapter — see "Signaling flow" below. Not a bug (Phase 1's own
   doc already said this), but reconfirmed still true this phase.

## 4. Files created this phase

- `src/lib/callEngine/webrtcDiagnostics.ts` — ICE candidate type / RTT /
  jitter / packet loss / TURN-relay-in-use detection via LiveKit's
  `Track.getRTCStatsReport()`. Dev-only, never reaches production users
  or the CallEngine interface.
- `src/lib/callEngine/createOutgoingCallRoom.ts` — the provider-aware
  outgoing-room helper. Written, tested, **and wired into both
  `Calls.tsx` and `Chat.tsx`** as of this update.
- `src/test/webrtcDiagnostics.test.ts`, `src/test/createOutgoingCallRoom.test.ts`

## 5. Files modified this phase

- `src/contexts/CallContext.tsx` — provider argument on both
  `beginCallLatencyTrace` calls; provider branch in
  `acceptIncomingCallImpl` and `rejoinRecoveredCall` (token fetch +
  `joinCall`'s first argument).
- `src/lib/callEngine/SelfHostedCallEngineAdapter.ts` — reconnect
  watchdog, token-expiry detection/classification, audio-first join
  ordering, dev-only diagnostics polling, `leaveCall` reordered above
  `joinCall` so the new reconnect-timeout path can call it directly.
- `src/pages/Calls.tsx` — provider argument on `beginCallLatencyTrace`;
  `roomPromise`/`discardRoom` gated so a self_hosted attempt never
  creates (and has to discard) a real Daily room; a new, fully separate
  `if (activeProvider === "self_hosted") { ... }` branch inserted right
  after the shared busy-check/permission/watchdog logic and before the
  existing Daily `try {}` block — calls `createOutgoingCallRoom`, then
  `joinCall`, mirroring the Daily branch's cancellation/success/error
  handling as closely as the different insert-then-join ordering allows.
  The pre-existing Daily code was not edited — only wrapped by an early
  `return` in the new branch, confirmed by diff to be byte-identical to
  its pre-Phase-2 form.
- `src/pages/Chat.tsx` — same shape of change as `Calls.tsx`, adapted to
  this file's simpler control flow (no state machine to dispatch into
  here, unlike `Calls.tsx`) — self-hosted branch added inside the
  existing shared `try {}` block, `return`s before reaching the
  untouched Daily code below it.

`useCallEngine.ts`, `types.ts`, `DailyCallEngineAdapter.ts`,
`livekit-token/index.ts`, `infrastructure/*` — inspected this phase,
**not modified**.

## 6. Signaling flow (STEP 5/6 — verified against actual code, not assumed)

DuoSpace's real ring/accept/reject/cancel signaling — for **both**
providers, unchanged by this or the prior phase — is `call_history` rows
plus Supabase Realtime, exactly as it was before Phase 1. This is the
thing that makes a phone actually ring. `SignalingEngine`/
`WebSocketSignalingEngine`/`infrastructure/signaling` is a separate,
lower-latency **alternative** to that mechanism that Phase 1 built but
**nothing in the app currently calls** — not `DailyCallEngineAdapter`
(uses Daily's own signaling once in a room, plus the same
`call_history`-based ring/accept as everything else), not
`SelfHostedCallEngineAdapter` (uses LiveKit's own internal
client-server signaling once `room.connect()` is called — LiveKit's SFU
protocol handles its own SDP/ICE negotiation over the connection it
establishes; DuoSpace's custom `SignalingEngine` was never meant to
replace that, only `call_history`/Realtime's ring-and-accept role). This
was somewhat unclear in Phase 1's own doc and is clarified here: **two
distinct kinds of "signaling"** exist in this architecture — call-intent
coordination (ringing/accept/reject/cancel — `call_history`/Realtime
today, `infrastructure/signaling` as an unused future alternative) and
WebRTC session negotiation (SDP/ICE — handled internally by Daily's SDK
and by LiveKit's SDK respectively, never by DuoSpace's own code either
way). `infrastructure/signaling` remains real, buildable, tested
infrastructure for a future latency-optimization pass — it is not
currently load-bearing for any call, self-hosted or otherwise.

## 7. LiveKit flow

`SelfHostedCallEngineAdapter.joinCall(callId)` → `livekit-token`
(authorizes against `call_history`, mints a scoped token) →
`new LiveKit.Room()` → `room.connect(url, token)` → mic published
(awaited) → camera published (not awaited, STEP 13) → remote
participant/track events wired → `callState: "joined"`. Reconnect and
token-expiry handling added this phase (see Section 3). **Not
runtime-verified.**

## 8. Token flow

Unchanged from Phase 1 — see the original "Token / security model"
section above. Re-audited this phase against STEP 4's 10-point checklist
(auth required / identity from auth / authorization via `call_history`
ownership / room not client-selectable / short TTL / secrets server-side
/ minimal permissions / no secrets to frontend / explicit errors /
CORS handled) — all ten hold by inspection; none newly verified at
runtime.

## 9. TURN flow

Unchanged from Phase 1. `infrastructure/livekit/livekit.yaml`'s `turn:`
block points at `infrastructure/coturn`; `webrtcDiagnostics.ts`'s
`usingTurnRelay` field (new this phase) is the mechanism that will
eventually give real evidence of whether TURN is actually being used by
a live call, once one exists to observe.

## 10. Provider-selection flow

Unchanged (`callProviderConfig.ts`, `daily` hard default). What changed
this phase is how far a `self_hosted` selection actually reaches: it now
reaches correctly through the incoming/accept path; it does not yet
reach correctly through the outgoing path (Section 1).

## 11. Call-state flow

`CallEngineState` stays exactly `"idle" | "joining" | "joined" | "error"`
for both adapters — deliberately NOT expanded to the full
`IDLE/INITIALIZING/READY/RINGING/.../ENDED` state machine STEP 17
describes, because `CallContext.tsx` type-checks and branches on exactly
these four string literals in multiple places (`call.callState === "idle"`
etc.) and `useDailyCall.ts` itself is pinned to the same four values —
widening the type risks silently breaking those checks for a change with
no user-visible benefit (STEP 21's absolute UI-preservation constraint
extends, in spirit, to not touching the state contract the UI already
depends on). Instead, `SelfHostedCallEngineAdapter` now expresses
"reconnecting" the same way Daily always has: `callState` stays `"joined"`
while `networkQuality` degrades and a watchdog runs underneath — full
parity with Daily's existing behavior, not a new concept.

## 12. Latency instrumentation

Extended, not replaced, per instruction. The Phase 1 stage list already
covers everything STEP 11's T0–T17 list asks for that this JS-only
architecture can actually observe (see the original doc's own reasoning
for exclusions — ICE/DTLS sub-stage granularity beyond what LiveKit's
public `ConnectionStateChanged` exposes was not fabricated). What
changed this phase is that the `provider` field now actually gets
populated (Section 3, item 1) — meaning the P50/P75/P90/P95 comparison
`callLatencyPercentiles.ts` was built for is, for the first time, capable
of actually distinguishing the two providers' data, once real calls
happen.

## 13. Security findings (STEP 19)

Grepped `src/` and `infrastructure/` for `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `TURN_SECRET`, `SERVICE_ROLE`,
`SUPABASE_SERVICE_ROLE_KEY`: zero real values found anywhere — only
comment-mentions of the *names* in `src/` (explaining why they're absent)
and placeholder values (`devkey`, `devsecret_replace_me`, `replace_me`)
in `.env.example`/`livekit.yaml`/READMEs. No production secret is
committed. Frontend code has no path to any server-only secret — clean.

## 14. Mobile findings

Unchanged from Phase 1 — no native code touched, no device available to
test.

## 15. Tests run

`vitest run` was not executed in this pass either (no Node/npm-install
capable network egress in this sandbox — same standing limitation as
every prior phase). Added/reviewed by static analysis and manual
tracing only:
- `src/test/createOutgoingCallRoom.test.ts` — provider branching,
  ordering contract (insert-before-return for self_hosted), error on
  missing callback, room-naming shape.
- `src/test/webrtcDiagnostics.test.ts` — stats-report parsing against
  hand-built fake `RTCStatsReport` maps (relay vs host candidate,
  missing track, no selected pair yet).
- All Phase 1 tests (`callProviderConfig`, `signalingEngine`,
  `callLatencyPercentiles`, `infrastructure/signaling`) unchanged,
  presumed still passing by inspection (their subjects weren't touched)
  but not re-executed.

## 16. Tests not runnable here

Everything requiring an actual `npm install` (no `livekit-client`/
`vitest`/etc. resolution has ever happened in this sandbox — imports
are typechecked by inspection against the packages' documented public
APIs, not compiled), any integration test against a live Supabase
project, any real LiveKit/signaling/TURN connection, any Android/iOS
build.

## 17. Known risks

- **Outgoing self-hosted calling is now wired but has never run.** The
  `Calls.tsx`/`Chat.tsx` branches, `createOutgoingCallRoom.ts`, and
  `SelfHostedCallEngineAdapter` together form a plausible, statically-
  checked, unit-tested-at-the-edges path — none of it has connected to a
  real `call_history` row, `livekit-token` invocation, or LiveKit server.
  Treat it as "should work" evidence, not "works" evidence, until the
  device-test procedure below actually runs.
- The two new branches in `Calls.tsx`/`Chat.tsx` were verified by diff to
  leave the existing Daily code path byte-identical — but that only rules
  out regression risk to Daily from THIS change; it doesn't substitute
  for actually running the Daily path again after this edit.
- Reconnect/token-expiry logic in `SelfHostedCallEngineAdapter` has
  never observed a real LiveKit `ConnectionStateChanged` event — the
  state-string comparisons (`"reconnecting"`, `"failed"`, etc.) are
  written against LiveKit's documented `ConnectionState` enum values,
  not confirmed against a live SDK instance.
- `webrtcDiagnostics.ts`'s `RTCStatsReport` field reads (`candidateType`,
  `currentRoundTripTime`, `jitter`, `packetsLost`, `nominated`/`selected`)
  are standard per the W3C spec but browser population of these fields
  varies in practice; degrades to `null`/`"unknown"` rather than throwing
  when a field is absent, but has not been checked against a real browser
  connection.

## 18. Exact physical-device testing procedure

1. Deploy `infrastructure/` per its own README; deploy `livekit-token`
   with real secrets.
2. Two devices, both logged into DuoSpace, both with
   `duospace_call_provider_override = "self_hosted"` set.
3. Device A calls Device B. Confirm: B's phone rings (this part is
   already `call_history`/Realtime, unaffected by provider) → B accepts →
   both devices reach `callState: "joined"` → audio flows within a few
   seconds → toggle mute/camera on each side → let the call run long
   enough to cross the LiveKit token's TTL (`LIVEKIT_TOKEN_TTL_SECONDS`,
   default 600s) and confirm it does NOT drop the call unless a real
   network interruption also occurs → force a network drop (airplane
   mode toggle) on one device and confirm the 30s reconnect watchdog
   either recovers or fails cleanly, not silently.
4. Repeat with `daily` (the default) to confirm nothing regressed.
5. Pull `webrtcDiagnostics.ts`'s dev-console output during step 3 and
   confirm `usingTurnRelay` reflects reality (true on a
   cellular-to-cellular call across networks that block direct UDP,
   false on same-LAN Wi-Fi).

## 19. Exact next phase

1. Run the physical-device procedure above — this is now the ONLY
   blocking item; both call directions are wired.
2. Only after that: decide whether `infrastructure/signaling` is worth
   integrating as a ring/accept latency optimization, given
   `call_history`/Realtime already works for both providers today (see
   Section 6) — it is not a correctness blocker, only a possible latency
   one, and should be evaluated with real P50/P95 data from
   `callLatencyPercentiles.ts` first rather than integrated speculatively.
3. Consider consolidating `Calls.tsx`'s and `Chat.tsx`'s now-duplicated
   self-hosted branches into one shared hook once the duplicated logic
   has actually been proven correct against a live call — premature to
   merge before that.

---

# Remediation phase — P0/P1 audit fixes

Following a source-level audit, this pass fixed the following confirmed
issues. **The audit's own most important instruction bears repeating: do
not consider self-hosted calling "implemented" merely because the pieces
exist — it is implemented only when CALLER → signaling → CALLEE → accept
→ authorized LiveKit token → same room → WebRTC → remote audio is the
actual, demonstrated runtime path.** That full path remains
NOT RUNTIME-VERIFIED after this pass, same as every prior phase — nothing
here touched a live Supabase/LiveKit/signaling deployment.

## P0-1: Dependency reproducibility — CONFIRMED BROKEN, NOT FIXABLE HERE

`package.json` declares `livekit-client`; `package-lock.json` has zero
entries for it (confirmed by parsing both files programmatically this
pass). **`npm ci` will fail** until this is resolved. This cannot be
fixed correctly without running `npm install` against a real registry —
no network egress exists in the environment this and every prior pass on
this repository has run in. Hand-editing `package-lock.json` with
fabricated integrity hashes was considered and rejected: a wrong hash
fails `npm ci` anyway, just more confusingly, and risks installing
unintended content if somehow accepted. **Action required before any
build**: run `npm install` (not `npm ci`) once in a networked
environment — this single command both installs correctly and rewrites
the lockfile to match, after which `npm ci` will work going forward.
`infrastructure/signaling` has no lockfile at all yet either — this is
expected for never-yet-installed scaffolding (not a mismatch, since
there's nothing to be inconsistent WITH), and resolves the same way:
`npm install` there once, from a networked environment.

## P0-2: Provider persistence — FIXED

Confirmed the exact bug the audit described: all four `call_history`
INSERT call sites (`Calls.tsx` ×2 — Daily and self_hosted branches,
`Chat.tsx` ×2 — same) omitted `provider`, relying on the column's
`'daily'` default. This meant a self-hosted call was recorded as Daily in
the database regardless of which engine actually ran it — exactly the
"corrupts provider analytics" finding. All four now set `provider`
explicitly. Added `src/test/callHistoryProviderField.test.ts` — a
source-level invariant check (not a behavioral unit test; these insert
calls live inside closures with no seam for one) that fails if any
`call_history` insert in either file is missing an explicit `provider`
key, and fails loudly (not silently passing) if its own detection regex
ever stops matching.

## P0-3: WebSocket signaling connected to the real call lifecycle — ARCHITECTURAL FINDING, PARTIALLY ACTIONED

This is the audit's own "most important fix," and it deserves a direct
answer rather than a claimed one: **a persistent client-held WebSocket
cannot be the PRIMARY channel for reaching a backgrounded or killed
mobile app.** This is not an implementation gap — it is how iOS and
Android work. Neither platform lets a web-layer socket stay open
indefinitely once the app is suspended; this is exactly why VoIP/CallKit
push (`native/ios/CallKitManager.swift`, `native/android/
CallRingingService.kt`, `usePushNotifications.ts`) exists at all, and
tracing this app's actual incoming-call path confirms it's the real
mechanism today: `usePushNotifications.ts`'s own comment states plainly
that a native push action "already reported this call as accepted" and
that on open, "`IncomingCallOverlay`'s active-call check... picks up the
still-ringing `call_history` row and renders the answer UI itself." No
`.channel()`/`postgres_changes` subscription anywhere in the app is what
triggers the incoming-call UI while backgrounded — push is. (The
`postgres_changes` subscriptions that DO exist —
`useCallHistory.ts`, `DockBadgesContext.tsx` — refresh the call list and
missed-call badge, not the ring itself.)

Given that, "connect the WebSocket gateway to the real call lifecycle" as
literally specified (make it the PRIMARY signaling transport, replacing
`call_history`+push) would mean replacing a mechanism specifically built
to survive backgrounding with one that cannot — a regression, not a fix,
if applied to the "wake the callee" step. What the WS gateway CAN
legitimately be, and what remains true and valuable about the audit's
underlying goal (Supabase off the latency-critical path), is the
**post-wake coordination channel**: once both devices are already active
in a call attempt (the callee's push already landed, `IncomingCallOverlay`
is on screen), CALL_ACCEPT/CALL_REJECT/CALL_CANCEL could flow over the WS
gateway instead of a Supabase `cancel_call`/`claim_call` RPC + Realtime
round trip, for a real latency win on that narrower step.

**Actioned this pass**: the signaling protocol, server, and security
model (P1-4 through P1-10 below) were hardened to be genuinely ready for
that integration. **Not actioned this pass**: actually wiring
`WebSocketSignalingEngine` into `CallContext.tsx`'s accept/cancel flow.
That is a real, additional, unverified change to the same
production-critical accept/cancel paths already modified twice in this
migration — doing it in this pass, on top of everything else, without
any way to test a live two-device call, was judged too much unverified
change to production-critical code in one pass. This is the single
largest deferred item — see "P1 findings still open" and "Exact next
phase" below. `call_history` + Supabase Realtime remains the sole
signaling transport for both providers, unchanged, same as every prior
phase — which is also, concretely, why self-hosted calling is not yet
"Supabase off the critical path" despite the infrastructure existing.

## P1 findings fixed

- **P1-6/10 (message validation, rate limiting)**: `isWellFormedMessage`/
  `isWellFormedSignalingMessage` (both the server and client copies, kept
  in sync) now reject unrecognized event types and non-UUID
  `callId`/`recipientId` (previously accepted ANY string), and bound
  `sessionId` length. `infrastructure/signaling/src/server.ts` now caps
  inbound frame size at 8 KiB before parsing and rate-limits both
  connection attempts (per IP) and per-user message throughput via a new
  `rateLimit.ts` — explicitly documented as single-instance/in-memory
  only, with Redis named as the documented (not implemented) path for
  multi-instance deployment, per the audit's own instruction not to
  overengineer this now.
- **P1-7 (token in URL)**: added `signaling-ticket` edge function —
  clients now exchange their real Supabase session for a short-lived
  (120s), purpose-scoped ticket before opening the signaling WebSocket,
  rather than passing their actual session token as a URL query param.
  `infrastructure/signaling/src/auth.ts` updated to verify the ticket's
  `purpose` claim instead of treating any valid Supabase token as
  sufficient (closes replay of a real leaked Supabase token here too).
- **P1-8 (connect timeout)**: `WebSocketSignalingEngine.connect()`
  previously had no upper bound. Added a 10s timeout that rejects,
  closes the socket, and resets state cleanly (verified by code review
  not to trigger an unwanted auto-reconnect for the timed-out attempt).
- **P1-9 (stale-socket races)**: already handled by the existing
  `SessionRegistry` (Phase 1) — reviewed this pass, confirmed correct
  (a late-closing old socket cannot evict a newer one for the same user;
  covered by `infrastructure/signaling/test/signaling.test.ts`).
- **P1-11 (LiveKit token authorization)**: `livekit-token` previously
  authorized a token request against ANY `call_history` row the
  requester was a party to, including long-completed/cancelled/failed/
  missed calls — a stale or replayed request for an old `callId` got
  real (if pointless) access to that historical room. Now requires
  `status === "in_progress"`.
- **P1-13 (coturn config)**: `docker-compose.yml` has referenced
  `../coturn/turnserver.conf` since Phase 1 — the file never existed
  (only a code block inside the README). Created the actual file.
- **P1-14 (LiveKit dev config)**: `.env.example`'s `LIVEKIT_URL` now
  documents explicitly that `localhost` means "the device itself" for a
  physical Android/iOS device on a LAN, not the dev machine, and gives
  the four distinct cases (desktop browser / physical device on LAN /
  staging / production) their own guidance instead of one ambiguous
  placeholder.
- **P1-15 (pinned versions)**: `livekit/livekit-server:latest` and
  `coturn/coturn:latest` replaced with specific tags
  (`v1.8.4`/`4.6.2-r1`) — chosen from training-time knowledge WITHOUT
  live registry access to confirm current availability; flagged
  explicitly in the compose file to verify before deploying, per the
  audit's own "do not fabricate" instruction.

## P1 findings still open

- **The WS gateway is still not wired into any real call's accept/cancel
  flow** — see P0-3 above. This is the most significant open item.
- **P1-16/17/18/19 (call startup architecture, CallController, real
  prewarming, audio-first for the signaling-connected path)**: not
  actioned — these all presuppose the WS gateway is actually load-bearing
  for call setup, which it is not yet (P0-3). Revisit once P0-3's
  deferred wiring lands.
- **P1-20 (telemetry semantics)**: NOT renamed this pass.
  `callLatency.ts`'s `first_remote_audio` stage is, in the self-hosted
  adapter, marked at `track.attach()` on an inbound audio `RemoteTrack` —
  which is "the browser/WebView told WebRTC to route this audio to an
  output device," not confirmed speaker playback (the same caveat
  applies to Daily's own `first_remote_audio` mark, unchanged since
  before this migration). The audit is correct that this name overstates
  what's actually measured. Renaming it was not done this pass because
  the stage name is now referenced across `callLatency.ts`,
  `SelfHostedCallEngineAdapter.ts`, `useDailyCall.ts`, and
  `callLatencyPercentiles.ts`'s consumers — a rename is a real,
  multi-file, currently-untested change for a naming-accuracy fix, not a
  functional one, and was deprioritized behind the P0 items above given
  the size of this pass already. Flagged here explicitly rather than
  silently left mislabeled.
- **P1-21 (WebRTC diagnostics)**: `webrtcDiagnostics.ts` (previous phase)
  already covers candidate type/RTT/jitter/packet loss/bitrate. Reconnect
  count and network-transition tracking were not added this pass.
- **P1-22 (network handover)**: not actioned beyond the reconnect
  watchdog already in `SelfHostedCallEngineAdapter` (previous phase). No
  explicit ICE-restart-on-network-change logic was added.
- **P1-25 (fallback)**: still correctly left disabled, per the audit's
  own conditional instruction ("If not [safe], leave automatic fallback
  disabled and document the exact reason") — the reasoning in the
  original Phase 1 doc's "Fallback strategy" section still holds and was
  not revisited this pass.

## Files created this pass

`src/test/callHistoryProviderField.test.ts`,
`infrastructure/coturn/turnserver.conf`,
`infrastructure/signaling/src/rateLimit.ts`,
`infrastructure/signaling/test/rateLimit.test.ts`,
`supabase/functions/signaling-ticket/index.ts`,
`src/lib/signalingEngine/signalingTicket.ts`.

## Files modified this pass

`src/pages/Calls.tsx`, `src/pages/Chat.tsx` (explicit `provider` on both
insert sites each), `src/lib/signalingEngine/types.ts`,
`infrastructure/signaling/src/types.ts` (tightened validation, kept in
sync), `src/lib/signalingEngine/WebSocketSignalingEngine.ts` (connect
timeout), `infrastructure/signaling/src/auth.ts` (ticket verification),
`infrastructure/signaling/src/server.ts` (size cap + rate limiting),
`supabase/functions/livekit-token/index.ts` (status check),
`infrastructure/deployment/docker-compose.yml` (pinned versions),
`infrastructure/deployment/.env.example` (LiveKit URL guidance),
`src/test/signalingEngine.test.ts`,
`infrastructure/signaling/test/signaling.test.ts` (both updated for the
tightened validation).

## Tests run

None executed (`vitest run` requires the P0-1 dependency fix first — see
above; no network in this environment regardless). All additions/changes
reviewed by static analysis and manual tracing only.

## Exact next phase

1. Run `npm install` in a networked environment to fix P0-1 — nothing
   else can be build-verified until this happens.
2. Decide, deliberately, whether to wire `WebSocketSignalingEngine` into
   `CallContext.tsx`'s accept/cancel flow for the post-wake coordination
   role described in P0-3 above — this is a real, scoped, but
   non-trivial change to production-critical code that deserves its own
   focused pass with the ability to test against a live two-device call,
   not a rushed addition on top of an already-large remediation pass.
3. Run the physical-device test procedure (§18, earlier in this
   document) — still the only way anything calling-related in this
   repository gets past "should work" to "works."
4. Only after 1–3: revisit P1-20 (telemetry rename) and the remaining
   open P1 items above.

---

# Calling Phase 3 — WebSocket signaling actually wired

Following three consecutive audit passes flagging the same gap
(WebSocketSignalingEngine existed but nothing in the app ever opened a
connection or sent a message over it), this phase built and wired the
real bridge. **Read this section's own honesty qualifiers carefully — a
lot changed, none of it has run against a real server.**

## What actually changed

- `src/lib/signalingEngine/callSignalingBridge.ts` (new) — the
  call-control bridge. Exposes `sendInvite`/`sendAccept`/`sendReject`/
  `sendCancel`/`sendEnd`/`onMessage`/`ensureConnected`, mapped onto the
  existing `CALL_OFFER`/`CALL_ACCEPTED`/`CALL_REJECTED`/`CALL_CANCELLED`/
  `CALL_ENDED` wire protocol (kept as-is rather than renamed to this
  phase's brief's exact vocabulary — see the file's own doc comment for
  the full naming-equivalence table and reasoning).
- Wired into: `CallContext.tsx` (one bridge instance per session, exposed
  via context), `Calls.tsx` and `Chat.tsx`'s self_hosted outgoing branches
  (`sendInvite` right before `joinCall`, `sendCancel` at both existing
  cancellation checkpoints), `IncomingCallOverlay.tsx` (`sendAccept`/
  `sendReject` in the existing accept/decline handlers, plus a NEW inbound
  listener effect for `CALL_CANCELLED`/`CALL_REJECTED` that performs the
  exact same dismiss actions and `dispatchCallEvent` call the existing
  Realtime-driven cancel detection already does).

## Why this was safe to wire into production-critical files this time

Every one of these call sites is gated the same two ways:
1. **Provider gate**: only ever active when `activeProvider === "self_hosted"`
   (or, for the bridge's own internals, when a userId exists) — Daily's
   path touches none of this.
2. **Configuration gate**: `resolveSignalingUrl()` (Phase "remediation")
   returns `null` unless `VITE_SIGNALING_URL` is set at build time. **No
   real deployment of this app has that set** — `infrastructure/signaling`
   isn't deployed anywhere. So every `send*` call and the inbound listener
   are complete no-ops in every environment this code runs in today; the
   feature activates only once someone actually deploys the signaling
   server and sets that variable.

This is what makes "wire it into real call-control code, unverified" a
defensible thing to have done rather than reckless: the code is inert
today by construction, not by promise. The three prior passes' shared
hesitation (don't build blind, unverifiable changes into production call
flow) was about **behavior that would actually run** — this doesn't, yet.

## Authority model — this is never the only path

Every dispatch the inbound listener performs is the *exact same*
`dispatchCallEvent(...)` call the pre-existing Realtime-driven path
already makes for that scenario. `call_history` + Supabase Realtime +
push notifications remain fully intact, unconditionally running for
both providers, exactly as before this phase. If the signaling bridge
never connects, connects but is slower, or a deployed server misbehaves,
**nothing about today's actual working call flow changes** — this is
purely an optional, potentially-faster parallel path, never a
replacement. `callStateMachine.ts`'s existing transition guards make a
redundant/duplicate dispatch from both paths landing near-simultaneously
a safe no-op on the second one, not a bug.

## Known simplification, stated plainly

`sessionId` (the field meant to let a receiver discard a stale/replayed
message from an old call attempt — see `signalingEngine/types.ts`'s own
doc comment) is set to the `callId` itself throughout this wiring, not a
true monotonic generation counter that changes across reconnects within
the same call. This is sufficient to distinguish different call attempts
(each has a different `callId`) but NOT sufficient to distinguish two
different signaling connection generations within the same ongoing call
attempt — a real gap if this bridge's reconnect behavior is exercised
against a live server and produces duplicate/stale in-generation
messages. Flagged here rather than silently accepted; closing it properly
needs a real per-attempt counter threaded through
`callSignalingBridge.ts`, not implemented this phase.

## Tests added

`src/test/callSignalingBridge.test.ts` — the dormant-by-default safety
property (every method is a safe no-op with zero `WebSocketSignalingEngine`
instantiation when unconfigured), the configured-and-connects path
against a fake engine, and specifically a regression test for the
connect-timing bug this phase's own code review caught and fixed
(`onMessage()` registered before `ensureConnected()` resolves must still
receive messages once the real engine exists — an earlier draft of
`callSignalingBridge.ts` delegated `onMessage` straight to
`engineRef.current?.subscribe`, which would have silently dropped exactly
this ordering). Not executed — same standing `npm ci` blocker as every
other test in this repository (see the Remediation phase section above).

## What remains true and unchanged from the Remediation phase's finding

Push notifications remain the sole mechanism that wakes a backgrounded or
killed device — nothing in this phase touched that, and nothing should.
The signaling bridge's real, honest role is the same as previously
scoped: a potentially-faster coordination channel for devices that are
already active in a call attempt, never a replacement for push.
