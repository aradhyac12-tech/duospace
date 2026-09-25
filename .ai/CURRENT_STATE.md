> **Phase 2D (2026-09-23):** BLOCKED at the model artifact (all authoritative sources 403 here; no devices). Added grounding validator, versioned manifest gate, MODEL_MANIFEST.json (BLOCKED), and a real-model evaluation runner. Users still get RULE_BASED. Production local AI: NOT READY. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.

> **Phase 2C (2026-09-23):** merged photos + LiveKit-Cloud zips with Phase 2B; AI now routed by RelationshipAIService (LOCAL/E2E_CLOUD/RULE_BASED/UNAVAILABLE). Users get RULE_BASED today: local model has no artifact (HF 403), E2E cloud blocked (no attested TEE). See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

> **Phase 2B (2026-09-23):** Phase 2A hardened (local-rule-v1 outputs had been
> rejected by the validator; share un-revoke hole fixed on real Postgres).
> local-model-v1 implemented behind RelationshipAIProvider but NEVER executed
> (weights unreachable); Android/iOS unsupported; default remains
> local-rule-v1; no cloud AI. Production AI: NOT READY. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

> **Calling (2026-09-23):** self-hosted only — WebSocket signaling + LiveKit
> + embedded TURN; Daily fully removed. Requires VITE_SIGNALING_URL and the
> LiveKit/signaling deployment. Not verified on real devices.
> See docs/calling-architecture.md.

> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

> **Phase 2A note (2026-09-23).** Added since the Phase 1.6 box below:
> relationship AI / compatibility is **PARTIALLY IMPLEMENTED** now — the
> box below says "NOT IMPLEMENTED (by design)"; that's now only true of
> DuoPulse/DuoAutoAnswer/compatibility-score/multimodal inference, all
> still on `.ai/DO_NOT_BUILD.md`. Values Reflection, Expectations, and
> Communication Reflection (self-report only, local rule-based provider,
> explicit per-item partner sharing) are implemented in source, same as
> everything else in this file: **NOT VERIFIED** at runtime — no `npm ci`
> in this sandbox for this phase either. See
> `docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md`.

> **Phase 1.6 note (2026-09-20).** The sections below were written on
> 2026-09-16 and are partly stale. Where they conflict with this box, this box
> and the source win. Statuses: `npm ci` **BLOCKED** (and would FAIL: lock stale,
> KI-20) · lint/tsc/tests/build **BLOCKED** · `check:rls` **PASS** (presence only) ·
> `check:lock` **FAIL** · Android/iOS builds **BLOCKED / NOT VERIFIED** ·
> production verification **NOT VERIFIED** (never performed) · frontend, auth,
> OAuth, passkeys, QR, E2E chat, calls, Daily, native calling, push, music,
> location: implemented in source, **NOT VERIFIED** at runtime ·
> mood / face / peek: implemented, now behind the sensor registry and (for
> saving) `MOOD_PROCESSING` consent · lip reading: implemented, partner-face
> caveat (KI-23) · relationship AI / compatibility / DuoPulse / DuoAutoAnswer:
> **NOT IMPLEMENTED** (by design) · analytics/telemetry: local ring buffer only,
> no backend (KI-30) · local storage: software AES-GCM, **not** hardware-backed
> (KI-25).

Factual current-state snapshot as of the 2026-09-16 stabilization pass.
STATUS values follow the source doc's own convention: PASS / FAIL / PARTIAL /
BLOCKED / NOT IMPLEMENTED / NOT VERIFIED. "Last verified" is the pass that
actually produced the evidence, not this write-up date, where that's known.

## Repository / build tooling

- Source-only static audit: PASS (this pass — full file inventory done,
  667 files, no `.git`, no `node_modules`, no `android/`/`ios/` committed)
- `npm ci`: FAIL — BLOCKED BY ENVIRONMENT (registry returns 403, no network
  egress from this sandbox)
- `npm run lint` / `tsc` / `npm test` / `npm run build`: NOT RUN this pass —
  BLOCKED BY ENVIRONMENT (dependent on `npm ci` above)
- Verification method: direct `npm ci` attempt in this sandbox, this pass

## Security / RLS

- Last verified: `docs/PHASE_4_SECURITY_AUDIT.md` (most recently modified
  doc in the repo before this pass, static-code + manual SQL audit, no live
  DB)
- Status: PARTIAL. One P0 and six P1 findings fixed as real migrations
  since the prior baseline (partner Daily.co key oracle, call-status
  spoofing, six tables with `USING (true)` SELECT policies including
  `invite_links`, a reaction race, `search_users` enumeration, upload
  finalize validation gaps). All fixes: FIXED (code/migration written),
  live behavior NOT TESTABLE (no DB access in that pass or this one).
- Remaining, still not addressed: encryption lifecycle threat model,
  session/clock-skew handling, telemetry review (beyond the Phase 1
  client-side redaction pass), TypeScript `any`/unsafe-cast audit,
  docs-vs-source discrepancy matrix.
- Fixed 2026-09-16 (edge-function audit, §19): `send-push` had no
  recipient authorization for client-JWT callers — any authenticated
  user could have sent an arbitrary, real-looking push notification to
  any other user by user_id alone. Fixed: non-internal callers may now
  only target their own current partner. Every other edge function
  reviewed (QR pairing x4, WebAuthn x4, `livekit-token`,
  `send-voip-push`, `complete-signup`, `set-email-password`,
  `notify-signin`, `send-email`, cron functions, music-search proxies)
  had no findings requiring a fix.
- Fixed 2026-09-18 (push-token/device-table RLS review, §20):
  `push_tokens` and `known_devices` both reviewed clean — no client
  INSERT/UPDATE grant on either table at all (only SELECT/DELETE of own
  rows), the only write path is a SECURITY DEFINER trigger keyed off the
  user's own already-correctly-RLS'd `profiles` row. One minor,
  low-priority observation noted (token-value reassignment via `ON
  CONFLICT`, requires already possessing another user's live device
  token) but not fixed — the bar to exploit it is meaningfully higher
  than everything else in this document and not something the DB layer
  alone can fully close.
- Fixed 2026-09-16: `partner_requests` UPDATE policy had no `WITH CHECK`
  (receiver could rewrite `sender_id` on a pending request). Traced to a
  concrete exploit chain — self-insert a request, rewrite its sender_id
  to a victim, call the existing `accept_partner_request` RPC (also
  missing the already-partnered guard its sibling `accept_invite` has) to
  force a pairing with, and unlink, an uninvolved victim. Both fixed in
  `supabase/migrations/20260916120000_partner_requests_transition_guard.sql`;
  see `docs/PHASE_4_SECURITY_AUDIT.md` §15. Live behavior NOT TESTABLE (no
  DB access this pass either) — verified by hand against every
  `partner_requests` call site in `src/` and `supabase/`.
  **Note (this session):** that migration file did not reach this
  session's snapshot — re-derived and shipped as
  `20260916140000_partner_requests_transition_guard.sql` instead
  (functionally equivalent, plus the invite-code entropy fix). See
  `docs/PHASE_4_SECURITY_AUDIT.md` §17.
  **Update 2026-09-21:** this guard was NOT on the live project until today — the
  exploit above was live. Now applied and tested with rolled-back SQL tests; see
  `docs/SUPABASE_PRODUCTION_RECONCILIATION.md`.
- Fixed 2026-09-16 (same session, next queue item): Realtime channel
  authorization. `typing-<pair>`/`presence-<pair>`/`groic:<uid1>:<uid2>`
  broadcast/presence channels had no server-side gate at all (broadcast/
  presence aren't backed by table RLS) — anyone knowing both UUIDs could
  listen, which matters specifically because an ex-partner keeps knowing
  their former partner's UUID forever. `blend-sync` was worse: one
  global, unscoped channel for every active blend session app-wide.
  Fixed: `supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql`
  adds RLS on `realtime.messages` keyed to the caller's *current*
  partner_id; all four channels now use a colon-delimited
  `<prefix>:<uid1>:<uid2>` topic and `private: true`. **Requires a manual
  dashboard step this environment can't do**: disabling "Allow public
  access" under Realtime Settings — flagged prominently, not buried. See
  `docs/PHASE_4_SECURITY_AUDIT.md` §18.
- Fixed 2026-09-16 (same day, next queue item): set out to add a MIME
  allowlist for the `attachments`/`backups` buckets and found something
  more urgent — those aren't the buckets the app actually uploads
  through. `finalize-upload`'s 2026-09-10 bucket allowlist was built from
  a stale script (`scripts/sql/storage_buckets.sql`) that doesn't match
  `Chat.tsx`/`Gallery.tsx`'s real bucket names (`chat-files`/`gallery`),
  meaning every chat attachment and gallery upload would have been
  rejected at finalize — a functionality-breaking regression hiding
  inside a "security fix." Fixed the allowlist to the real buckets with
  evidence-based size/MIME rules (also fixed the MIME check itself, which
  compared by exact string despite being named `allowedMimePrefixes`);
  see `docs/PHASE_4_SECURITY_AUDIT.md` §16. Live behavior NOT TESTABLE (no
  DB/Storage access in any sandbox this has run in).
- This pass: heuristic static secrets grep across `src/`, `supabase/`,
  `native-plugins/` — no hardcoded API keys/passwords/tokens found; the one
  `service_role` string match in `src/integrations/supabase/client.ts` is a
  comment explaining the anon key is intentionally public, not a leaked
  secret (read directly, confirmed). `invite_links` code generation
  (`PartnerSettings.tsx`) still uses `Math.random().toString(36)` —
  low-entropy, flagged by the prior audit, not yet fixed as of this repo
  snapshot.
- `dangerouslySetInnerHTML` usage: one occurrence, in `src/components/ui/chart.tsx`
  (shadcn's chart CSS-variable injection, not user content) — not flagged
  as an issue.

## Android

- Native project (`android/`): NOT IMPLEMENTED / NOT COMMITTED by design —
  generated via `npm run cap:add:android`. Cannot be verified without
  running that command, which itself needs `npm ci` first (BLOCKED).
- Custom native source (`native/android/`, `native-plugins/*/android/`):
  present, real Kotlin, most recently touched files in this snapshot
  (CallOngoingService.kt, DuoSpaceConnectionService.kt, audio-engine
  plugin, CrashLogger.kt) — reviewed for structure only, not compiled.
- Build / real-device verification: BLOCKED BY ENVIRONMENT (no Android
  SDK in this sandbox) / NOT VERIFIED (no hardware access, ever, from this
  environment)

## iOS

- Native project (`ios/`): NOT IMPLEMENTED / NOT COMMITTED by design —
  generated via `npm run cap:add:ios`.
- Custom native source (`native/ios/`, `native-plugins/*/ios/`): present,
  real Swift, `CallKitManager.swift` and `callkit-bridge`'s Swift plugin
  among the most recently touched files — reviewed for structure only.
- Build / real-device verification: BLOCKED BY ENVIRONMENT (no macOS/Xcode
  in this sandbox) / NOT VERIFIED

## Calling

- Prior sessions (per memory and `docs/CALL_CONNECTION_AUDIT_V2_REPORT.md`,
  `docs/NATIVE_CALL_AUDIT.md`) did substantial work here: single global
  CallContext, Android Telecom/ConnectionService and iOS CallKit/PushKit
  implemented from scratch, a `call_history_transition_guard` DB trigger
  added this cycle to stop client-side status spoofing.
- This pass did not re-audit calling beyond what `PHASE_4_SECURITY_AUDIT.md`
  already covered (the `call_history` RLS/trigger finding).
- Live/real-device call verification: NOT VERIFIED (same environment
  constraint as above)
- **Self-hosted calling (Phase 4, 2026-09-20):** WebSocket gateway is the
  call-control layer (offer/accept/reject/cancel/end/timeout, authorized
  against Supabase, typed acks); LiveKit = media; embedded TURN =
  fallback (UNVERIFIED); Supabase = persistence/auth/authorization data;
  push = offline wake-up; Realtime = labelled recovery only. Daily default,
  untouched. Source-level only — see KI-33 and
  `docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md`.

## AI safety / product scope

- No cheating/lying/deception-detection code exists in this snapshot
  (confirmed: no matches for such logic in `src/`). DuoAutoAnswer is
  specification-only, matching the brief's freeze — no implementation
  found.
- Existing assistive features that touch faces/audio (`LipReadingOverlay`/
  `useLipReading`, `MoodDetector`, `PeekGuard`) are visual/mouth-shape or
  face-presence heuristics for the device owner's own use (unlock guard,
  muted-call captions, mood self-logging), not partner surveillance or
  deception claims — this reading is based on file/hook naming and prior
  session notes, not a full re-audit of their logic this pass.

## Documentation accuracy

- `README.md` and the prior final report both reference `.ai/` as if
  already populated — it was not, until this pass created it. That is the
  one confirmed documentation/reality discrepancy found this pass; a full
  discrepancy matrix against every doc in `docs/` was NOT completed this
  pass (50 documents — out of scope for this pass's budget).

## What this pass actually did

1. Full file/directory inventory (667 files, extensions, native/,
   native-plugins/, supabase/migrations, supabase/functions, docs/)
2. Diffed file mtimes against the prior baseline to identify what changed
   since the last stabilization snapshot (list in `CHANGELOG.md`)
3. Read the two most-recently-modified audit docs in full to avoid
   re-deriving or contradicting already-honest findings
4. Attempted `npm ci` — confirmed BLOCKED BY ENVIRONMENT
5. Ran a heuristic secrets grep and a few targeted pattern checks
   (dangerouslySetInnerHTML/eval, TODO/FIXME count, service_role string,
   invite code generation, partner_requests policy text)
6. Created this `.ai/` directory (did not exist before)

## Calling migration — Phase 2 (2026-09-16, continued)

Phase 1 (self-hosted calling architecture scaffold) is described earlier
in this repo's history/CHANGELOG. Phase 2's first pass audited that
scaffold end-to-end and found it was NOT actually reachable for
self-hosted outgoing calls — `Calls.tsx`/`Chat.tsx` created the room by
hardcoding Daily's edge function regardless of the `CALL_PROVIDER` flag.
That pass fixed the incoming/accept half (`CallContext.tsx` now correctly
branches by provider) and wrote (but did not wire in) the outgoing fix.
A second pass wired `src/lib/callEngine/createOutgoingCallRoom.ts` into
both `Calls.tsx` and `Chat.tsx` as an isolated, additive branch —
confirmed by diff to leave the existing Daily code path untouched. Full
findings: `docs/calling-architecture-v2.md`'s "Phase 2" section.
**Self-hosted calling is now wired end-to-end in both directions by
static analysis — still completely unverified at runtime** (no
Supabase/LiveKit/device access in any pass so far). Daily remains the
hard default; self_hosted stays opt-in-only until the physical-device
procedure in that doc's §18 actually runs.

Also fixed this pass: `beginCallLatencyTrace` was silently always
stamping `provider: "daily"` regardless of which engine was active (a
2-line miss in `CallContext.tsx`, now fixed) — the Phase 1
provider-comparison telemetry had never actually been populated for
self-hosted calls until this fix.

## Phase 1 — Privacy, Consent & Local-First Intelligence Foundation (2026-09-17)

Full detail: `.ai/PHASE_STATUS.md`, `docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md`.

- Data classification, consent management, privacy gate, AI insight
  contract + safety validator, local processor interface, local
  encrypted storage (software AES-GCM — NOT hardware Keystore/Keychain-
  backed, see `.ai/SECURITY_MODEL.md`), one new Supabase migration
  (`user_consents`/`ai_insights` + RLS + 3 enforcement triggers), one new
  settings UI page, 4 test suites (written, not executable — no `npm ci`
  in this sandbox, consistent with every prior pass).
- No relationship-AI feature was built — this phase is infrastructure
  only, per its own brief's feature freeze.
- Two small real bugs found and fixed incidentally: sign-out wasn't
  clearing the new consent cache or wiping secure-storage data.
- This phase's own starting snapshot was missing ~32 of the `.ai/` files
  prior phases had created (only `CHANGELOG.md`/`CURRENT_STATE.md`/
  `NEXT_PHASE.md` existed) — logged as `.ai/KNOWN_ISSUES.md` KI-01, a
  recurring pattern across this whole project, not unique to this pass.
- Status: PARTIAL. Everything above is real, hand-verified-against-source
  code — nothing has been compiled, linted, or run. Production readiness
  is unchanged (NOT READY) — this phase doesn't claim otherwise.

## Calling migration — remediation pass (2026-09-18)

A source-level audit found real P0 bugs in the Phase 2 work: (1)
package-lock.json never actually gained a livekit-client entry — `npm ci`
is broken until `npm install` runs in a networked environment; (2) all
four call_history insert sites (Calls.tsx/Chat.tsx × daily/self_hosted)
omitted the `provider` field, silently recording every self-hosted call
as Daily in the database — fixed, with a regression test. The audit's
third P0 ask (make the WebSocket signaling gateway the primary
call-lifecycle transport) surfaced an architectural correction instead of
a straight fix: a persistent client WebSocket cannot wake a backgrounded/
killed mobile app — that's a platform constraint, not a bug, and this
app's real incoming-call mechanism is (and must remain) push-notification
-driven. Full reasoning and what WAS still hardened (signaling ticket
instead of raw JWT in the WS URL, message validation, rate limiting,
connect timeout, LiveKit token status check, the actually-missing
coturn.conf file, pinned image versions) is in
docs/calling-architecture-v2.md's "Remediation phase" section. Deferred:
actually wiring the signaling gateway into CallContext.tsx's accept/
cancel flow for post-wake coordination — a real, scoped, but nontrivial
change to production-critical code, left for its own focused pass.

## Phase 1.5 — Production Verification (2026-09-19)

Full detail: `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md`.

- **New P0 found**: `package.json`/`package-lock.json` out of sync for
  `livekit-client` — confirmed via direct grep (zero references in the
  lockfile) and corroborated by `npm ci`'s own behavior. Blocks `npm ci`
  in ANY environment, not just this sandbox, until `npm install` is run
  somewhere with real registry access. See `.ai/KNOWN_ISSUES.md` KI-07.
- **New privacy-integration gap found**: `MoodDetector`,
  `useBackgroundMoodDetection`, `LipReadingOverlay`/`useLipReading`, and
  `PeekGuard` do not call the Phase 1 `privacyGate`/`consent` system at
  all — the new `CAMERA_ANALYSIS`/`MICROPHONE_ANALYSIS` toggles in
  `PrivacyAISettings.tsx` are currently decorative with respect to these
  four existing features. Not fixed this pass (retrofitting working
  features needs its own careful pass, not a drive-by edit).
- Restored 6 governance `.ai/` files from real prior content.
- Confirmed clean (hand-verified, not live): Realtime authorization logic
  ties to current `partner_id`; privacy-gate fail-closed behavior;
  secure-storage's honest documentation.
- Reaffirmed NOT VERIFIED — MANUAL DASHBOARD CHECK REQUIRED for the
  Realtime "Allow public access" setting.
- TypeScript safety: 183 `any`/`as any` occurrences sampled, judged
  systemic (broken generated Supabase types) rather than individually
  risky; 3 redundant casts removed; one low-severity call-duration
  observation in `MinimizedCallBubble.tsx` noted, not fixed.
- `npm ci`/lint/`tsc`/test/build: still BLOCKED BY ENVIRONMENT, same as
  every prior pass — confirmed again, not assumed.
- Production status: **NOT READY**, unchanged.

## Calling migration — Phase 3, signaling actually wired (2026-09-19)

Built and wired src/lib/signalingEngine/callSignalingBridge.ts into the
real self_hosted call-control flow: CallContext.tsx, Calls.tsx, Chat.tsx,
IncomingCallOverlay.tsx now send/receive CALL_OFFER/CALL_ACCEPTED/
CALL_REJECTED/CALL_CANCELLED over the signaling gateway for outgoing
invite, accept, reject, and both cancellation checkpoints. Safe to have
wired into these production-critical files because it's gated two ways —
self_hosted-only, and dormant unless VITE_SIGNALING_URL is actually set
(no real deployment has it set) — so nothing about today's actual call
behavior changed; this is inert scaffolding until infrastructure/signaling
is deployed. call_history+Realtime+push remains the sole authoritative
path, unconditionally, for both providers. Full writeup:
docs/calling-architecture-v2.md's "Calling Phase 3" section, including a
stated simplification (sessionId = callId, not a true generation counter
— a real gap if reconnect-within-a-call is ever exercised against a live
server).

## Launch flow / local caches (2026-09-19 pass)

- On-device persisted data added this pass: (1) call-history METADATA cache
  (`src/lib/callHistoryCache.ts`, via secureStorage — AES-GCM at rest,
  per-user, wiped by `secureWipeAll` on sign-out, `room_name` dropped);
  (2) two non-sensitive plain-storage flags: `duo-onboarded-<userId>` and
  `duo-location-permission-granted`. Chat message plaintext is still
  memory-only (`Chat.tsx` `messageCache`) — unchanged.
- Status: code written, syntax-checked only. Build/tests/on-device behavior:
  NOT VERIFIED (BLOCKED BY ENVIRONMENT — no `npm ci`).

## Round 2 additions (2026-09-19, later)

- New on-device persisted data: decrypted chat cache (`src/lib/chatCache.ts`,
  secureStorage, latest 60 non-disappearing messages, flag `PERSIST_CHAT_CACHE`).
  This SUPERSEDES the earlier line above saying chat plaintext is memory-only.
- Android `DuoSpaceLocationService` is no longer a foreground service (no
  notification); background location is best-effort.
- Status: code written; Kotlin not compiled, nothing run on a device. NOT VERIFIED.

## E2E cross-device fix (2026-09-20)

Root-caused and fixed "messages unable to decrypt on different platform"
(reported directly by Aradhya): the ECDH identity keypair was generated
fresh, per device, any time local IndexedDB was empty — meaning opening
the same account on a second platform (e.g. website after the APK)
silently overwrote `profiles.public_key` with a new key no other device
held the matching private key for, breaking decryption both ways.

Fixed: one identity keypair per account now, synced via a new
`user_e2e_identity_keys` table (owner-only RLS). Any device signing into
the account adopts the existing canonical key instead of minting a new
one; race-safe via `INSERT ... ON CONFLICT DO NOTHING` + re-fetch. See
`supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`
and `src/hooks/useE2E.ts`'s `resolveAccountIdentityKey()` for the full
writeup, and `.ai/KNOWN_ISSUES.md` KI-10 for the security trade-off this
accepts (private key now readable by `service_role`, not purely
device-local anymore — stated plainly, not hidden).

One-time cost: any two devices that already had *different* local keys
before this fix will converge on only one of them (whichever wins the
first-registration race) — the other device loses access to whatever
only its own old key could decrypt. Unavoidable once keys have already
diverged; not a bug in the fix itself.

Live behavior NOT TESTABLE — no DB access in this environment, same as
every other change in this project's history. New test file:
`src/test/e2eAccountWideKey.test.ts` (written, unexecuted — see
`.ai/TEST_STATUS.md`).

## Merge + Map location-timeout fix (2026-09-20)

Base is the E2E snapshot (strict superset of redesign-final-3 — see
CHANGELOG 2026-09-20 "Merge" for the file-by-file comparison).

Map no longer shows "Location Access Required" for a GPS timeout. Only a
real permission denial gets the blocking screen; timeouts / services-off
show "Still looking for your location…" + **Try again** until a first fix
lands, and never cover the map once a fix exists. `useLiveLocation` now
recovers from timeouts itself (coarse one-shot fix, then a low-accuracy
watcher restart after 3 consecutive timeouts) and `retryPermission()` really
retries on web. Classification lives in `src/lib/locationErrors.ts`.

Status: code written, type-checked only against stubs, pure logic executed
in Node. Real-device / browser behavior NOT VERIFIED. `.ai/TEST_STATUS.md`
lists the new (unrun) vitest file.

## Notification + push-location pass (2026-09-20, later)

Media services can no longer post Media3's automatic (possibly blank "DuoSpace")
notification. Push-triggered location now goes through one debounced helper
called from both FCM services. Open, documented gaps: KI-12 (no runtime request
for "Allow all the time"; killed-process fixes aren't uploaded; FCM single-
service routing assumption). All UNVERIFIED — Kotlin not compiled, no device.

## Send-flow + screenshot-block pass (2026-09-19)

Text send no longer bounces off a "Securing connection…" toast: the bubble
shows immediately, the send waits for key exchange, and never sends plaintext.
`useE2E` falls back to a device-local key if the account-key table is missing
(KI-13 — migration should still be applied). Android builds now set
FLAG_SECURE in MainActivity (patched in by `patch-native-permissions.mjs`,
checked by `verify-android-build.mjs --native`), so screenshots and screen
recording are blocked app-wide (KI-15). Logic executed in Node against mocks;
nothing compiled, no device run. NOT VERIFIED on device.

## Surprise import / library / rendering pass (2026-09-20, v3.11.0)

Surprise code (HTML/CSS/JS) now renders like a normal page inside the sandboxed frame (global
scripts, working `@import`, autoplay recovery, storage shims, link forwarding), a whole .zip or any
mix of html/css/js can be imported into the three fields (JS stays empty when there is none, local
media embedded as data: URIs with budgets and a per-file report), and uploads can be saved to a
private `surprise_library` table. The conversation list no longer downloads surprise bodies.
Verified in headless Chromium + isolated tsc only; NOT verified on a device or against a live DB.
Migration `20260920110000_surprise_library.sql` is written but NOT applied anywhere (KI-17).

## Partner unlink (2026-09-20)
Two-sided unlink (partner must approve) + stuck-confirm-dialog fix: implemented
in source, **NOT VERIFIED** (no DB/build/device). See
`docs/PARTNER_UNLINK_CONSENT.md` and KI-42. Migration
`20260920150000_partner_unlink_consent.sql` must be applied, then `send-push`
deployed, then the app build.

