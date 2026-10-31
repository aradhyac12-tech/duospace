# Phase 1.6 — Repository Reconciliation + Privacy Foundation — Final Report

Date: 2026-09-20 · Base: `duospace-redesign-final.zip` + `duospace-theme-update.zip` (theme overlay, merged).

**Verdict: NOT COMPLETE, NOT READY.** The release gate in the brief is not met.
Read `## Blockers` first. Every status below says what was actually done.
Where something could not be run it is BLOCKED or NOT VERIFIED, never PASS.

Environment: Node 22.22, npm 10.9, **no network** (registry returns 403), no
`node_modules`, no Android SDK, no Xcode, no device. A global TypeScript and an
esbuild binary were available and were used for limited checks (see 16, 17).

## 1. Repository inventory
794 files. `src/`: 393 TS/TSX files. `supabase/migrations`: 84 files.
`supabase/functions`: 26 edge functions. `src/test`: 35 files (incl. new).
`.ai/`: 27 files. `native/` (Android Kotlin, iOS Swift, res), `native-plugins/`
(5 local Capacitor plugins), `infrastructure/` (LiveKit signaling server),
`docs/`, `scripts/`. No `android/`, no `ios/`, no `node_modules`, no `.git`,
no `bun.lock`, no `.github/`. Source is authoritative; this phase re-derived
facts from source, not from earlier reports.

## 2. Dependency reconciliation
`package.json` and `package-lock.json` disagree: `livekit-client@^2.7.0` is a
dependency with **no lock entry**; the lock's root version is 3.4.9 vs 3.11.0.
`npm ci` would fail (and `vercel.json` runs it). All 5 local `file:` plugins and
`@capacitor-community/privacy-screen` are consistent (verified statically by
the new `npm run check:lock`). The lock was NOT hand-edited. **BLOCKED:**
regenerate with `npm install --package-lock-only` (needs network), then `npm ci`.

## 3. Package-manager decision — NPM
`vercel.json` installCommand `npm ci`; `netlify.toml` build `npm run build` (npm chosen via the lockfile); `packageManager:
npm@10.9.2`; `engines.node >=22`; lock is npm lockfileVersion 3. There is no
`bun.lock` in this snapshot (the brief said there might be). Nothing supports bun.

## 4. Local-plugin status — PARTIAL
Five plugins: `audio-engine`, `audio-route`, `background-geolocation`,
`callkit-bridge`, `device-status`. Each has package.json (`capacitor` block),
podspec, Android `build.gradle` (own namespace, Kotlin pinned), a registered
Kotlin plugin class and a Swift `CAPBridgedPlugin`. They install as `file:`
links and the lock records them correctly. Gaps: every `main` points at a
`dist/` that is never built (web build uses aliases in `vite.config.ts` and
`tsconfig.app.json`; **`vitest.config.ts` lacked them — added**); `callkit-bridge`
has no README; nothing was built, so Android/iOS integration is NOT VERIFIED.

## 5. `.ai` system — PARTIAL
All 21 required files now exist (5 new: PRODUCT_VISION, NATIVE_CALLING,
DATABASE_CONTRACT, DESIGN_SYSTEM, AI_HANDOFF_TEMPLATE) plus the pre-existing
extras. Updated with Phase 1.6 facts: PHASE_STATUS, KNOWN_ISSUES (KI-20..30),
TEST_STATUS, DECISIONS, PRIVACY_MODEL, CONSENT_MODEL, DATA_CLASSIFICATION,
DO_NOT_CHANGE, NATIVE_PROJECTS, NEXT_PHASE, CHANGELOG, and a correction box atop
CURRENT_STATE. **PARTIAL** because CURRENT_STATE's older body (2026-09-16) was
not re-audited line by line; the box on top supersedes it where they conflict.

## 6. Privacy architecture
`src/lib/privacy/`: `consentFeatures.ts` (vocabulary + `isConsentActive`),
`dataClassification.ts` (7 classes; `POLICY_MATRIX`, 6 destinations, fail-closed
lookup), `privacyGate.ts` (`canProcess`, `requireCanProcess`), `sensorPolicy.ts` +
`sensorGate.ts`, `derivedMoodGate.ts`, `redact.ts`, `secureStorage.ts`. Gate order:
matrix → capability → user → feature consent → destination consent → explicit
share. **Honest limit:** outside the local AI processor, the only production
caller of the gate is the camera-derived-mood save. The gate exists and is
tested; most of the app does not route through it because most of the app
predates it and does not handle classified data.

## 7. Consent architecture — PARTIAL
Server-of-record `user_consents` (RLS, self only). 11 features as required.
`isConsentActive`: missing/not-granted/revoked/stale-version = inactive.
Revocation clears the cache and the telemetry flag. Not verified against a real
database. Cache is 30 s (KI-26). Sign-out wipe is wired only in `Settings.tsx`.

## 8. Camera / microphone audit
Registry: `SENSOR_PURPOSES` — PEEK_GUARD, MOOD_DETECTION, MOOD_BACKGROUND,
FACE_ENROLLMENT, PHOTO_CAPTURE, QR_SCAN, VOICE_MESSAGE, CALL_MEDIA, LIP_READING,
PERMISSION_PROBE, each with purpose, activation, raw/derived handling, server /
partner reach, logging, and known gaps. Runtime enforcement: `cameraBus.acquireCamera(facing,
purpose)` for the 5 bus purposes (automatic ones need their persisted toggle ON,
re-read on every call; user-action ones need `userInitiated`). Static test fails
if a `src/` file opens the camera/mic unregistered (currently none do).
**Not runtime-enforced:** QR scan, voice message, permission probe, call engines,
lip reading (they open media directly; registered for inventory only).
No raw audio/video/frames are logged, uploaded or sent to analytics by any
consumer found. Call media transits Daily/LiveKit by design.

## 9. Existing mood / face / lip / peek audit
- **Daily Mood (foreground):** opt-in toggle; visible 5 s scan. *Defect fixed:*
  the result was written to partner-visible `profiles.mood_text` at once → now only
  after the user taps 👍. Server save now needs `MOOD_PROCESSING` consent;
  `features.source` records provenance. (KI-24, behaviour change.)
- **Background mood:** own toggle, no UI. *Defect fixed:* a stale persisted flag re-armed
  it after Daily Mood was turned off and on. Now consent-checked before the camera opens
  and again before the write.
- **Peek Guard / face enrollment:** on-device only. Template and breach photos are plaintext at rest (KI-22).
- **Lip reading:** on-device, user-initiated, analyses the partner's video without notice (KI-23).
- Not deleted, not redesigned.

## 10. Local storage audit
`secureStorage.ts`: AES-256-GCM (Web Crypto) → Capacitor Preferences; master key
is an extractable JWK in IndexedDB. **Software only — not Android Keystore / iOS
Keychain** (KI-25). `crypto.ts`/`keystore.ts`: E2E private key JWK in IndexedDB
(plaintext JWK; localStorage fallback on web). `idbStore.ts`: plaintext blobs.
Plaintext: `duo-settings`, peek event log, face template, breach photos. Cached chat
and call history use secureStorage. New `ai/localInsightStore.ts` stores validated
local insights through secureStorage (no Supabase).

## 11. Telemetry audit — PARTIAL
`sendToBackend` is a no-op: nothing leaves the device (KI-30). Fixes: free-text
`context`/`message` redacted; **object extras were stringified before redaction and
leaked keyed secrets into the ring buffer (found by the new test, fixed)**; key list
widened (JWK, embeddings, transcripts, coordinates, SDP, PIN/OTP, partner mood/insight);
uploads are consent-gated and fail closed. Call sites that interpolate identifiers
into messages were reviewed by grep; none interpolate message text. Not exhaustively audited.

## 12. Supabase / RLS — PARTIAL
`npm run check:rls`: **PASS** — 42 tables + storage.objects; static replay of 84
migrations. It failed before on `location_push_credentials` (RLS on, no policies,
`REVOKE ALL` from anon+authenticated = intentional service-role-only); the check now
recognises exactly that pattern. Presence check only; policy clauses not verified. No new
tables added. KI-21: `mood_logs` partner-SELECT policy is broader than needed (not
changed; needs a migration decision). Live DB not reachable.

## 13. Native architecture
GENERATED native projects (confirmed). `npm run cap:add:android|ios`, `cap:sync`, and
`scripts/patch-native-permissions.mjs` / `patch-native-kotlin-versions.mjs` do the
patching and copy `native/**`. No signing material in the repo. iOS needs a manual
Xcode-target step (KI-29). `apply-whitelabel.mjs` targets a non-existent `capacitor.config.ts` (KI-27).

## 14. Android — BLOCKED
No SDK/Gradle. Not generated, not built. Application ID `com.duospace.app` (from
`capacitor.config.json`). Permissions, Telecom `ConnectionService`, FCM, deep links,
secure storage: read in source only — NOT VERIFIED.

## 15. iOS — BLOCKED
No macOS/Xcode. Bundle/app ID, PushKit, CallKit, APNs, permissions, deep links: source
only — NOT VERIFIED.

## 16. Tests
Written: `privacyPolicy`, `sensorPolicy`, `aiProvenance`, `telemetryRedaction`
(covering consent, revocation, gate, classification, AI validation, provenance,
telemetry redaction, local storage, sharing authorization, camera/mic enforcement). Existing
tests untouched. **Run under real vitest: NO (BLOCKED).** Run under a throwaway stand-in
runner: 148 cases across 9 files, all passed (details in `.ai/TEST_STATUS.md`). Not covered:
`consent.ts` network/cache paths, `acquireCamera` end to end, `MoodDetector` behaviour;
existing `privacyGate.test.ts` (uses `vi.mock`) was not runnable here.

## 17. Build verification
| Command | Result |
|---|---|
| `npm ci` | BLOCKED (no network); would FAIL — lock stale |
| `npm run lint` | BLOCKED |
| `npx tsc --noEmit` | BLOCKED for the whole project. A standalone strict `tsc` over the changed pure modules + new tests: clean apart from missing ambient types. Edited `.tsx` files: syntax-checked only |
| `npm test` | BLOCKED (see 16) |
| `npm run build` | BLOCKED |
| `npm run check:rls` | PASS (presence) |
| `npm run check:lock` (new) | FAIL — reproduces the lock defect |

## 18. Security issues
KI-20 lockfile (P0). KI-25 software-only key storage. KI-22 plaintext biometrics/photos.
KI-21 partner-readable derived rows. Fixed: telemetry object-extra leak; persisted
background-camera re-arm. No secret was found committed (no keystores, provisioning
profiles, or private keys; `google-services.json` and Supabase anon keys are client config).

## 19. Privacy issues
KI-23 lip reading of partner; KI-24 consent behaviour change; KI-26 consent latency. Fixed:
camera-derived mood published to the partner as the user's own words.

## 20. P0 — 1
KI-20.

## 21. P1 — 6
KI-21, KI-22, KI-23, KI-24, KI-25, KI-26.

## 22. P2 — 4
KI-27, KI-28, KI-29, KI-30.

## 23. Blockers
1. Network: regenerate lock, `npm ci`, lint, tsc, vitest, build.
2. Android SDK / Xcode / devices: native generation and verification.
3. Live Supabase: RLS clause review, applying pending migrations (KI-13/16/17).
4. Owner decisions: KI-21 (tighten mood_logs), KI-22 (encrypt biometrics: key scope), KI-23 (partner notice).

## 24. Exact next phase
**Not yet.** First (a) fix the lock and run the install/lint/tsc/test/build chain green; (b) take decisions on KI-21..24;
(c) re-run this report's gate. Only then: **RELATIONSHIP INTELLIGENCE V1 — VALUES + EXPECTATIONS + COMMUNICATION REFLECTION.**

## Release gate (from the brief)
dependency graph reproducible — **NO** · lock matches package.json — **NO** · local plugins reproducible — PARTIAL ·
`.ai` exists — YES · privacy model matches source — PARTIAL · camera/mic centrally governed — PARTIAL ·
AI output contract exists — YES · privacy gate exists — YES · telemetry redacted — YES (no backend) · no secret
leakage found — YES (static) · tests actually run — **NO (stand-in only)** · build actually runs — **NO** ·
RLS reported accurately — YES · Android/iOS reported accurately — YES (BLOCKED).
