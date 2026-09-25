ID | SEVERITY | AREA | TITLE | STATUS

## KI-01 — P2 — Documentation — `.ai/` files repeatedly missing from uploaded snapshots
Multiple times across this project's history, a freshly uploaded snapshot
has been missing `.ai/` files that a prior pass created and documented as
complete (most recently: the entire Scientific + Product Specification
phase's 19 spec files and final report; also `PROJECT_CONTEXT.md`,
`DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`, `NATIVE_PROJECTS.md`,
`DO_NOT_BUILD.md`). This phase's own required-reading list (§1 of the
brief) references ~35 `.ai/` files; only 3 existed at the start of this
phase. Likely cause: the export/deployment pipeline between sessions
doesn't always carry every delivered file forward. Recommend checking
that pipeline directly rather than assuming the next session will
silently reconstruct what's missing (it can, from conversation history,
but that's a workaround, not a fix). STATUS: OPEN, recurring — but
partially mitigated 2026-09-19: `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`,
`IMPLEMENTATION_RULES.md`, `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, and
`FUTURE_ROADMAP.md` were all restored from real prior-session content
(not fabricated — genuinely authored history, flagged in each file's own
header as restored and worth spot-checking against current source). The
19 scientific-spec files and their final report were NOT restored this
pass (larger, lower-urgency for this specific production-verification
phase) — still missing as of this pass.

## KI-02 — P2 — Security — `secureStorage.ts` is not hardware-backed
Android Keystore / iOS Keychain integration would need a native Capacitor
plugin — real native development requiring a toolchain and physical
device this environment doesn't have. Current implementation is software
AES-256-GCM with an IndexedDB-held key — see `.ai/SECURITY_MODEL.md` for
the full honest assessment of what this does and doesn't protect against.
STATUS: OPEN, tracked for a session with native-build capability.

## KI-03 — P3 — Testing — `secureStorage.ts`'s IndexedDB path is untested
jsdom (this project's test environment) doesn't implement IndexedDB; the
crypto primitive itself is tested, the persistence integration isn't. See
`.ai/TEST_STATUS.md`. STATUS: OPEN — would need either a real
browser-based test runner or a `fake-indexeddb` dependency added and
verified in an environment with network access.

## KI-04 — P3 — Consistency — Existing mood/face features not re-audited against new data classification
`MoodDetector`/`useBackgroundMoodDetection`/`MoodHistory`,
`LipReadingOverlay`/`useLipReading`, `PeekGuard` all predate this phase's
`DataClassification`/`PrivacyGate`/`ConsentFeature` system and haven't
been checked against it — flagged previously in `.ai/MOOD_SPEC.md` (if
present in your snapshot) and repeated here since it remains open.
STATUS: AUDITED 2026-09-20 (source read + read-only live-DB catalog query;
nothing changed, nothing run). Findings:
1. **None of the six call `PrivacyGate.canProcess()` or `hasConsent()`**
   (grep across MoodDetector, useBackgroundMoodDetection, MoodHistory,
   LipReadingOverlay/useLipReading, PeekGuard/usePeekDetection: zero hits).
   `FEATURE_CAPABILITIES.MOOD_PROCESSING` is `false`, so simply routing the
   existing mood feature through the gate would switch it off for everyone.
2. **Opt-in does exist, but only as a device-local flag** (`localStorage`
   `mood-detection-enabled`; background auto-detect is a second, separate
   flag, off by default). It is not a `user_consents` record, so it is not
   cross-device, not server-auditable, and revocation is not enforced by the
   gate.
3. **Lip reading, face recognition/enrollment and Peek Guard are on-device
   only**: no `supabase.from/rpc/storage`, `fetch` or upload in
   `useLipReading`, `LipReadingOverlay`, `PeekGuard`, `usePeekDetection`,
   `faceRecognition`, `FaceEnrollmentDialog`; snapshots/profiles go to
   IndexedDB/localStorage (`peekSnapshot.ts`, `peekEventLog.ts`,
   `faceRecognition.ts`). Consistent with DEVICE_ONLY. Not re-verified at
   runtime.
4. **Mood is the real gap.** `mood_logs` is classified SENSITIVE and lives on
   Supabase. Live RLS (checked): insert/update/delete own only, but SELECT is
   "own OR partner" (`user_id = get_partner_id(auth.uid())`), so the partner
   can read every row, including the `features` jsonb (camera-derived
   `mouth_curve`, `brow_raise`, `eye_openness`, `mood_probabilities`, …) and
   `feedback`. The raw facial-measurement values are arguably more sensitive
   than the mood label and the partner UI probably does not need them.
   Background auto-detect writes these silently every ~2 h (max 6/day).
   (The `features` column DOES exist live — the caveat in
   `20260731050000_add_mood_logs_features_column.sql` that it was never
   applied is stale.)
Options, each a product decision — none applied: (a) stop sending `features`
for background reads / stop persisting raw values at all; (b) hide `features`
from the partner (column-level revoke or a partner-facing view);
(c) mirror the two local opt-ins into `user_consents` (MOOD_PROCESSING) and
gate on it, with the capability flag flipped deliberately; (d) accept as-is
and document it in the in-app privacy copy. Recommended: (a) or (b) first,
then (c).
UPDATE 2026-09-20 — option (a) APPLIED (source-level, not compiled/run):
`MoodDetector.tsx` and `useBackgroundMoodDetection.ts` no longer write
`mouth_curve`, `mouth_open`, `brow_raise`, `eye_openness` into
`mood_logs.features` (nothing in the client reads them; `MoodHistory` selects
only mood/confidence/valence/detected_at). The scoring math is unchanged.
SCRUB RUN 2026-09-20 on the live project: 37 of 47 `mood_logs` rows had the four raw keys; all 37 were stripped (label, confidence, valence, probabilities untouched). NOT done: (b), (c), (d) — deliberately left: (c) would switch the mood feature off for everyone, and (b) is much less important now that raw facial values are gone.
Original note (superseded): existing rows still hold old raw values. Optional
one-off scrub, NOT run (it edits user data — your call):
`UPDATE public.mood_logs SET features = features - 'mouth_curve' - 'mouth_open' - 'brow_raise' - 'eye_openness' WHERE features ?| array['mouth_curve','mouth_open','brow_raise','eye_openness'];`

## KI-05 — P3 — Consent lifecycle — No consent export path
The phase brief's §24 asks for export alongside deletion; deletion exists
implicitly (RLS DELETE on `ai_insights`, and consent is revocable), but
no export flow (for either consent records or insights) was built this
phase. STATUS: FIXED 2026-09-20 (source-level, not compiled/run):
`exportPrivacyData()` in `src/lib/privacy/consent.ts` returns the user's own
`user_consents` + `ai_insights` rows (user_id = self only; partner-shared
insights excluded) as JSON, throwing on any query error instead of emitting a
partial file; `PrivacyAISettings.tsx` has an "Export my consent & AI data"
button using the existing `saveOrShareFile`. Deletion of insights is still the
separate future action noted in consent.ts.

## KI-07 — P0 (new, 2026-09-19) — package.json / package-lock.json out of sync for livekit-client
`package.json` declares `livekit-client: ^2.7.0`; `package-lock.json`
(lockfileVersion 3) contains zero references to it or any of its
transitive dependencies anywhere — confirmed by direct grep, not
inferred. Consistent with `npm ci`'s actual behavior in this sandbox: its
very first network request is for `livekit-client` itself (before
attempting to fetch anything else), the signature of a package that
isn't resolvable from the lock file at all. Likely cause: the LiveKit
self-hosted-calling scaffold (`infrastructure/signaling/`,
`src/lib/callEngine/`) was added to `package.json` directly without ever
running `npm install` in an environment with real network access. Per
this phase's own instruction, NOT hand-fixed here — fabricating lockfile
entries by hand would produce a file that looks resolved but isn't,
which is worse than the current honestly-broken state. Fix: in an
environment with real npm registry access, run `npm install` (or
`npm install livekit-client@^2.7.0` specifically) and commit the
regenerated `package-lock.json`. Until that happens, `npm ci` cannot
succeed in ANY environment with network access either, not just this
sandbox — this is a repository-state bug, not purely an environment
limitation. STATUS: OPEN, P0, needs a real npm environment.

## KI-08 — P3 (new, 2026-09-19) — TypeScript `any`/`as any` is widespread but appears systemic, not individually risky
183 occurrences (36 `: any`, 147 `as any`) across `src/`. Sampled broadly
rather than individually classified all 183 (would be disproportionate
effort for the likely finding): the large majority trace to one root
cause already documented in `src/integrations/supabase/appClient.ts`'s
own comment — the generated Supabase `Database` type currently has no
table keys (schema metadata unavailable), so every `.from()`/`.rpc()`/
Realtime-payload access needs a cast to compile at all. This is a
TypeScript-compile-time-only workaround; it does not bypass RLS or any
database trigger, which remain the actual runtime enforcement layer
regardless of client-side typing looseness. Spot-checked several
call-status/reaction/call-history-adjacent occurrences specifically
(since those touch already-security-audited tables) — found no case
where the cast hides an actual authorization bypass. One low-severity,
unrelated-to-the-cast observation noted while sampling: 
`MinimizedCallBubble.tsx`'s `handleEnd()` lets the client set its own
`call_history.duration_seconds`/`ended_at` values when ending a call —
scoped to a call the user was legitimately part of and already
`in_progress` (RLS + the existing transition guard still apply), so this
is a minor self-reported-data-integrity concern, not a cross-account
vulnerability; not fixed this pass. Real fix for the systemic `any`
issue: regenerate Supabase TypeScript types
(`supabase gen types typescript`) once real Supabase CLI/DB access
exists — blocked by the same environment constraint as everything else.
Three redundant `as any` casts in `src/lib/privacy/consent.ts` (left over
from before it switched to the already-`any`-typed `appClient.ts`) were
found and removed this pass as a trivial cleanup. STATUS: OPEN as a
systemic pattern (not urgent); the one MinimizedCallBubble observation
is a separate, also-not-urgent, P3 note.

## KI-10 — P1 (new, 2026-09-20) — E2E private key now syncs via Supabase; service_role can read it
Fix for "messages unable to decrypt on different platform" (see
`supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`
and `src/hooks/useE2E.ts`'s `resolveAccountIdentityKey()`) intentionally
changes the E2E threat model: the private key now syncs through a new
`user_e2e_identity_keys` table (RLS'd to the owning user only — no other
end user, including a partner, can ever read it) so every device/platform
signing into the same account shares one real keypair instead of each
generating its own and silently breaking every other device. The
trade-off: previously a private key never left its device at all, so
even a fully compromised Supabase project (stolen `service_role` key, or
direct database/dashboard access) could not decrypt historical messages
without also compromising a specific physical device. That property is
now given up — `service_role` can read this table. A stronger version
(wrap the private key with a key derived from something only the
legitimate user can reproduce — a recovery passphrase, or the login
password captured transiently at sign-in) would restore it but needs new
user-facing UX not built here. STATUS: accepted trade-off, explicitly
documented rather than hidden; revisit if a stronger guarantee is wanted.

## KI-11 — P3 (new, 2026-09-20) — E2E key resolution adds one Supabase round-trip per app launch
`resolveAccountIdentityKey()` always checks the server for the account's
canonical key before falling back to a local/fresh one, even when this
device already has a correctly-cached local copy — a deliberate
simplicity choice (avoids tracking a separate "have I already migrated
under the new scheme" flag) at the cost of one lightweight extra read on
every app open. Not a heavy-infrastructure startup cost, but a real,
avoidable network round-trip; worth optimizing to a true local-first fast
path once the one-time cross-device migration window has clearly passed
for real users. STATUS: open, low priority.

## KI-12 — P1 (new, 2026-09-20) — Location on message/call arrival: three real gaps (NOT VERIFIED on device)
Requested check: "location pulling should happen when a text message arrives
and when a call arrives". Traced by reading the code; nothing was run.
1. **"Allow all the time" is never requested.** `ACCESS_BACKGROUND_LOCATION`
   is declared in the manifest (scripts/patch-native-permissions.mjs) but no
   Kotlin or JS code ever asks for it at runtime (grep: only comments/manifest).
   On Android 10+ a fix requested from a background process (i.e. the
   push-triggered ONE_SHOT) returns nothing unless the person has manually
   set Location -> "Allow all the time" in system Settings. While the app is
   in the foreground, fixes work regardless. STATUS: BUILT 2026-09-20,
   UNVERIFIED (never compiled or run on a device). New Android plugin methods
   `checkBackgroundPermission()` / `requestBackgroundPermission()` (separate
   `backgroundLocation` alias, requested only after foreground is granted),
   `src/lib/backgroundLocationPermission.ts`, and `BackgroundLocationPrompt.tsx`
   (a disclosure dialog mounted from `LocationAccessGate` once foreground is
   granted; "Not now" suppresses it for 14 days). iOS already asks for "Always"
   inside its plugin, so it is untouched. The dialog copy is a DRAFT for the
   product owner to review — it also has to satisfy Google Play's prominent
   disclosure rule. Needs a real Android 10, 11+ and 9 device check.
2. **Killed-process pushes get a fix but no upload.** A push that wakes a fully
   dead process starts `DuoSpaceLocationService`, which obtains the fix, but
   `LocationFixBridge.listener` is null (no WebView/plugin yet) so the fix is
   logged and dropped — nothing writes it to Supabase. Already documented as
   an accepted gap in docs/BACKGROUND_LOCATION_NATIVE.md. STATUS: open. Real
   fix: a native Supabase upsert using the stored session's access token
   (must NOT refresh tokens natively — refresh-token rotation could race the
   JS client and sign the person out).
   UPDATE 2026-09-20 — BUILT, UNVERIFIED on a device. Did NOT use the session
   token (expires ~1 h, cannot be refreshed safely natively). Instead a
   per-device, write-only credential: (a) migration
   `location_push_credentials` APPLIED live (service-role only: RLS on, zero
   policies, anon/authenticated grants revoked — verified by catalog query;
   only a SHA-256 hash of the secret is stored); (b) edge functions
   `location-push-register` (verify_jwt=true; issues/rotates the secret) and
   `location-push-upload` (verify_jwt=FALSE on purpose — the caller is a dead
   app with no session; auth is credential id + secret compared as hashes in
   constant time; 8 s min interval per credential; coordinates validated;
   fix must be <10 min old and <2 min in the future; generic 401 on any auth
   failure) both DEPLOYED live; the upload endpoint has NOT been exercised
   (no network from the sandbox); (c) native: `PushUploadCredentialStore.kt`,
   plugin methods `set/getPushUploadCredentialUser/clearPushUploadCredential`,
   and `DuoSpaceLocationService.uploadFixNatively()` — push-triggered one-shots
   always upload natively (service stays alive until the request finishes);
   watcher fixes upload at most once a minute, since a frozen WebView can't run
   the JS write; (d) JS: `src/lib/locationPushCredential.ts` registers after
   sign-in (replaces another user's credential on an account switch, clears on
   settled sign-out, never during auth loading), wired from LocationContext.
   Double writes (JS + native) are harmless: the locations monotonic guard
   trigger keeps the newest fix. Limits: Android only (iOS cannot wake a
   terminated app from an ordinary message push); still needs "Allow all the
   time" (gap 1); needs a rebuilt APK with the new plugin methods, and the
   person must open the app once after updating so it can register.
3. **FCM routing assumption.** Three services declare `MESSAGING_EVENT`
   (CallNotificationService, DuoSpaceMessagingService, Capacitor's push
   plugin) with no `android:priority`. Several comments in this repo assume
   FCM delivers each message to ALL of them. As far as I know, Android resolves
   that intent to ONE service (priority, then manifest order), so only one of
   them sees a given push. UNVERIFIED — needs a device test. Mitigation
   applied: the location trigger now lives in one shared debounced helper
   (`DuoSpaceLocationService.requestFixForPush`) called from BOTH custom
   services, so a fix is requested whichever one receives the push. NOT
   mitigated: if only CallNotificationService receives everything, chat pushes
   would not render a notification (that logic is in DuoSpaceMessagingService)
   and Capacitor's `pushNotificationReceived` would not fire while foregrounded.
   Quick test: background the app, have your partner send a text — a
   notification should appear.

## KI-09 — NOT VERIFIED — MANUAL DASHBOARD CHECK REQUIRED — Realtime "Allow public access" project setting
The Realtime-authorization migration (`20260916150000_realtime_authorization_couple_channels.sql`)
adds RLS on `realtime.messages` and the client marks the relevant
channels `private: true` — but per Supabase's own documentation,
enforcing that also requires disabling "Allow public access" under
Project Settings → Realtime → Settings in the dashboard, a manual,
project-level toggle no migration or code change can set or verify
programmatically. Whether this has been done is unknown as of this pass
— no dashboard access in this environment. Do not treat the Realtime
channel fix as fully closed until Aradhya confirms this toggle is off.
STATUS: NOT VERIFIED — MANUAL DASHBOARD CHECK REQUIRED.

## KI-06 — P0 (carried forward, unchanged) — Nothing in this project has ever been build/lint/test/device verified
Every claim of "FIXED" across every pass means hand-verified against
source, never compiled or run. See `.ai/TEST_STATUS.md`,
`docs/PHASE_4_SECURITY_AUDIT.md`. This is the standing blocker on any
"production ready" claim, independent of anything this specific phase
did or didn't do. STATUS: OPEN, requires an environment with network/DB/
device access that none of these sandboxes have had.

## KI-13 — P1 (new, 2026-09-19) — Apply `20260920100000_e2e_account_wide_identity_key.sql` to the live Supabase project
`useE2E` now falls back to a device-local key when `user_e2e_identity_keys` is
missing, so sending works either way — but the cross-platform decryption fix
only takes effect once that migration is applied (Supabase Dashboard -> SQL
Editor -> paste the file -> Run). Whether it has been applied is unknown (no
dashboard access). While it is missing, the console shows the warning
"user_e2e_identity_keys unavailable (migration not applied?)". STATUS: APPLIED to the live project (jzlpelxwzjjpddqcrtpu) on 2026-09-19 — confirmed the table
was missing beforehand and exists with owner-only RLS afterwards. See CHANGELOG
"Supabase migrations applied" and KI-16 for what was deliberately NOT applied.

## KI-14 — P2 (new, 2026-09-19) — Remaining plaintext fallbacks when E2E is not ready
`Chat.tsx` scheduled messages (`handleSchedule`) and love letters
(`handleSendLoveLetter`) still use `e2eReady ? await encrypt(x) : x`, i.e. they
would store plaintext if invoked before the key exchange completes. The main
text send, pending-text replay and edit paths were fixed 2026-09-19.
STATUS: FIXED 2026-09-20 (source-level, NOT compiled/run — see KI-06). Both
handlers now use the same pattern as the main send path: wait for
`e2eReadyRef` (6 s), encrypt via `e2eEncryptRef`, and refuse to proceed unless
`isEncrypted(enc)`. Encryption now happens BEFORE the composer is cleared /
the love-letter dialog is closed, so a slow key exchange loses nothing — the
person just taps again. Grep confirms no other `ready ? encrypt(x) : x`
fallbacks remain in `src/`.

## KI-15 — (new, 2026-09-19) — Android screenshots / screen recording are blocked (FLAG_SECURE)
Intentional, always-on, not user-toggleable on Android. Side effects: Recents
thumbnail is blank, Cast/mirroring show black, own bug-report screenshots are
impossible. Does not stop a second camera photographing the screen. NOT
VERIFIED on a device.

## KI-16 — P1 (new, 2026-09-19) — Local migrations deliberately NOT applied to the live DB
Found by diffing the repo against the live project. Do not apply these blindly:
- `20260910140000_lock_get_partner_id_to_self.sql` — would silently break
  `purge_mutually_cleared_imported_chat()`, which calls `get_partner_id(NEW.owner_id)`
  (owner may not be the caller). Needs an internal no-check helper first.
- `20260910180000_lock_is_partner_on_call_to_real_partner.sql` — would drop the
  `expires_at` condition the live function already has (regression). Needs merging.
- `20260910200000_call_history_transition_guard.sql` + the function redefinition
  inside `20260916130000_...provider_column.sql` — live already has its own guard
  trigger (`enforce_call_history_update_rules_trg`); a second guard with a
  different allowed-status list could block valid call updates.
  Resolved 2026-09-21 without adding a second guard: `session_id` was added to the live
  guard `enforce_call_history_update_rules` (repo file `20260921110000`).
- `20260916140000_partner_requests_transition_guard.sql` — also replaces
  `accept_partner_request` with a stricter version (refuses if either side is
  already linked); a product-behaviour change, needs an explicit decision.
  **APPLIED LIVE 2026-09-21** (as written; the exploit it closes was live until then —
  see `docs/SUPABASE_PRODUCTION_RECONCILIATION.md`). Accepting now fails with a clear
  error if either person already has a partner, so the unlink→re-link flow is required.
- `20260910220000_fix_couple_content_broad_select_policies.sql` — live already has
  equivalent policies under different names; invite_links is RPC-only on live.
Already live under different names (skipped): expire_stale_calls sweep,
messages client_message_id idempotency, guard_message_update sender lock.
STATUS: OPEN.

## KI-17 — P1 (new, 2026-09-20) — Apply `20260920110000_surprise_library.sql` to the live Supabase project
The editor's "Save to library" / "Save uploads to my library" (default ON) / Library button call
`public.surprise_library`. Until that migration is applied, the import itself still works but the
library save shows "Imported, but couldn't save to your library" and the Library list errors.
Apply via SQL Editor (it is idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS). After applying,
confirm with two accounts that account B cannot select account A's rows (owner-only RLS, no
partner policy) — NOT TESTED live. STATUS: APPLIED 2026-09-20 to the live
project (jzlpelxwzjjpddqcrtpu) via Supabase MCP as migration `surprise_library`
(table was confirmed missing beforehand; `update_updated_at_column()` dependency
confirmed present). Verified afterwards by catalog query: RLS enabled, exactly
four policies (select/insert/update/delete), each `owner_id = auth.uid()`, no
partner policy, one updated_at trigger. STILL NOT TESTED: the two-account
cross-read check (needs two real signed-in sessions) and the in-app "Save to
library" flow on a device.

## KI-18 — P2 (new, 2026-09-20) — Surprise media: device behaviour unverified, size trade-offs
(a) Autoplay recovery, `allow="autoplay"`, `upgrade-insecure-requests`, no-referrer and the
Drive/Dropbox/GitHub direct-link rewrites were exercised (where testable) only in desktop headless
Chromium; Android/iOS WebViews may behave differently, and Drive/Dropbox may throttle or refuse
hot-linking regardless of the rewrite. (b) Imported media is embedded in the DB row (≤ ~4.5M chars);
`code_surprises` has no size CHECK (only the editor enforces the cap) — a NOT VALID constraint was
deliberately not added blind. (c) Rows are re-fetched per open (bodies are lazy); a Realtime payload
dropped for size is handled by refreshing when `creator_id` is missing. (d) Remote `<script src>`
tags from an imported page run before the JS field, so an inline script that originally came BEFORE
a remote script and configured it may misbehave. STATUS: OPEN.

## KI-19 — P1 (new, 2026-09-20) — Incoming-call fixes are source-level only

The "can't answer / keeps vibrating / lag" fixes (see CHANGELOG 2026-09-20
"Incoming calls") were made by reading code; nothing was built or run on a
device. Open risks to check on a real Android phone: (a) the answered call now
has its Telecom connection ended silently on in-app accept, so Bluetooth/car
answer controls won't apply to in-app-answered calls (they didn't work before
either — the connection stayed in RINGING); (b) `startService` for
`DISMISS_INCOMING` can be refused when the app is backgrounded — the plugin
still cancels the notification directly; (c) the soft `pushState`+`popstate`
navigation assumes react-router's BrowserRouter picks it up.


---
# Phase 1.6 additions (2026-09-20)

## KI-20 — P1 (updated 2026-09-20, Phase 4) — lockfile now agrees with `package.json` (static check only)
Originally P0: `livekit-client@^2.7.0` was missing from the lock. The
2026-09-20 ZIP's lock now contains it; `npm run check:lock` (offline, static)
reports agreement. **`npm ci` itself has still never been run** (no registry
access in any pass). Do that, plus lint/tsc/tests/build, before trusting it.
Related, still open: `infrastructure/signaling` has its own `package.json`
with **no lockfile**, and its Dockerfile uses `npm install` (KI-39).

## KI-21 — P1 (new) — `mood_logs` lets the partner SELECT camera-derived rows
Policy "View own and partner mood logs". No client code reads the partner's
rows (`MoodHistory` filters to `user_id = self`), but the server permits it.
Tighten to own-rows-only with a new migration once confirmed nothing else
(edge function, view, realtime) depends on it. Not applied here: cannot verify
against the live database.

## KI-22 — P1 (new) — Biometric/photo data at rest is plaintext
Owner face template (`faceRecognition.ts`, IndexedDB `duo-assets/blobs`), Peek
Guard breach snapshots (`peekSnapshot.ts`, JPEG data-URLs that may show a third
party's face) and the peek event log (localStorage) are not encrypted with
`secureStorage`. Never uploaded. Encrypting them needs a key-scope decision.

## KI-23 — P1 (new) — Lip reading analyses the partner's face without telling them
`LipReadingOverlay`/`useLipReading` run MediaPipe on the remote video. It is
user-initiated, on-device and the text is never stored, but the partner is not
informed or asked. Needs a product decision (signal a notice / partner opt-in).

## KI-24 — P1 (new, behaviour change) — Camera-derived mood needs "Save mood readings"
Since Phase 1.6 the Daily Mood / background reads are saved to `mood_logs` only
when `MOOD_PROCESSING` consent is granted (Settings > Privacy & AI > "Save mood
readings"). People who enabled Daily Mood before this change will see the read
but nothing is saved until they grant it (a one-time toast says so). Deliberate:
they never consented to server storage. Confirmed reads only reach the
partner-visible profile after the user taps 👍.

## KI-25 — P1 (new) — All key material is software storage
E2E private keys (`crypto.ts` -> `keystore.ts`) are an extractable JWK in
IndexedDB; `secureStorage`'s AES-GCM master key is stored the same way. Neither
is Android Keystore / iOS Keychain backed. Hardware-backed storage needs a
native plugin and a device to verify it; documented, not faked.

## KI-26 — P1 (new) — Consent is server-side with a 30 s cache
Gate decisions for server/cloud/partner egress fail closed when offline or when
consent can't be read. A revoke on device A can take up to 30 s to be seen on
device B. On-device-only sensor features (Peek Guard) deliberately do NOT depend
on this — they use the local opt-in toggles (see DECISIONS D-1.6-3).

## KI-27 — P2 (new) — whitelabel script targets a file that doesn't exist
`scripts/apply-whitelabel.mjs` patches `capacitor.config.ts`; the repo has
`capacitor.config.json`. The appId/appName patch silently does nothing.

## KI-28 — P2 (new) — Stale RLS script + no CI in repo
`scripts/check-rls-coverage.ts` is an obsolete bun-era duplicate of the `.mjs`
script; its header references a workflow file that does not exist (`.github/`
is absent). No CI configuration is committed.

## KI-29 — P2 (new) — iOS native files need a manual Xcode step
`native/ios/*.swift` are copied by script but must be added to the App target by
hand. `npx cap add ios` alone does not reproduce a working CallKit/PushKit build.

## KI-30 — P2 (new) — Telemetry has no backend
`telemetry.ts::sendToBackend` is a no-op; nothing leaves the device. It is now
consent-gated (fails closed), so wiring a real sink later cannot bypass consent.
The Privacy & AI ANALYTICS/CRASH toggles therefore control a sink that does not
yet exist.

## Fixed in Phase 1.6 (source-level; NOT run — see TEST_STATUS)
- Camera-derived mood was published to the partner-visible profile before the
  user saw it. Now only on confirmation.
- Turning Daily Mood off left `moodBackgroundDetection:true` persisted, so
  turning it back on silently re-armed unattended camera capture.
- `logError(ctx, msg, {accessToken,…})` stringified the object before redaction,
  leaking token/transcript values into the ring buffer (found by the new test).
- `check:rls` failed on an intentional service-role-only table.


## KI-31 — P1 (new, 2026-09-20) — Music "now playing" notification not visible on device (fix is source-level, UNVERIFIED)
Symptom: playing a song showed only the debug toast "notification posted OK
(isPlaying=true)" and no notification. The old code could not tell "posted" from
"shown": it trusted `startForeground()`/`notify()` not throwing.
Changed (`MediaPlaybackService.kt`, `AudioEnginePlugin.kt`, JS): debug toasts removed;
after every post the service checks, ~1.2 s later, that app notifications are enabled,
the channel isn't blocked/missing and the OS lists notification 4271 as active — one
silent re-post for the recoverable cases, otherwise a `notificationIssue` event with a
reason code; JS shows one toast per reason with an "Open settings" button
(`openNotificationSettings`); first native play re-asks for POST_NOTIFICATIONS if still
"prompt" (the app previously asked only once, at sign-in); channel id bumped to
`duospace_now_playing_v2` (the old one could never be repaired because
`ensureNotificationChannel()` returned early when it existed) and the old one deleted.
A notification failure is no longer reported through the playback `error` event (which
made the UI treat it as the song failing).
NOT known: the actual cause on the reporter's device. If, after this build, no toast
appears AND no notification shows, the OS *is* holding it: on Android 11+ a MediaStyle
notification with a session token is shown in the Quick Settings media player and on the
lock screen and is often hidden from the notification list (OEM-dependent). Then run
`adb shell dumpsys notification --noredact | grep -B2 -A30 duospace_now_playing` and
`adb logcat -s DuoSpaceAudio`. Kotlin NOT compiled; nothing run on a device.

## KI-32 — P0 (2026-09-20) — QR partner link "shows success but doesn't link" — SERVER SIDE DEPLOYED, app build + device test outstanding
Root causes and fix: docs/QR_PARTNER_LINK_FIX.md.
DEPLOYED to jzlpelxwzjjpddqcrtpu on 2026-09-20 (at the owner's request, via the Supabase tools):
- migration `qr_partner_link_fix` applied. Verified by catalog query afterwards: `link_partners` now
  EXECUTE for postgres/service_role only (was: authenticated too — any signed-in user could link any two
  accounts); `claim_qr_partner_link` exists (authenticated); `qr_pairing_tokens.claimed_by_user_id` exists;
  an unauthenticated call returns NOT_SIGNED_IN. Live migration-history version differs from the repo
  filename `20260920130000_...` (tool assigns its own timestamp) — same as earlier applied migrations.
- edge function `redeem-qr-token` redeployed (v8 -> v9, verify_jwt=false as before). The previous live
  source was read first and matched the repo original.
- edge function `check-qr-token-status` deployed for the FIRST TIME (v1, verify_jwt=false). It was in the repo
  but never deployed, so the QR-showing phone's 2 s status poll had been failing silently — that phone could
  never learn that its QR was scanned.
NOT DONE / NOT VERIFIED: no request has been sent to either function since deploy (no invoke tool); the
new app build (which sends the new flow and understands `partner_linked`) is not installed anywhere;
no two-phone test. Old app builds keep working for device sign-in, but a signed-in scan from an old build
will still toast "Linked" without linking (the old build ignores the new reply) — install the new build.
Rollback: redeploy the previous redeem-qr-token source (repo history / `.ai` copy); for the DB, restoring
`GRANT EXECUTE ON FUNCTION public.link_partners(uuid,uuid) TO authenticated` would reopen the hole — don't.

## KI-33 — P0 (2026-09-20, Phase 4) — authoritative signaling is NOT verified end-to-end
Implemented and exercised only in-process against fakes (real gateway core +
real client + real LiveKit authz decision; 164 tests under a local
vitest-compatible shim, not real vitest). Never run: the gateway process
(`ws`/`jose`), migration `20260920140000_…` and `signaling_get_call_facts`
against Postgres, `livekit-token` under Deno, LiveKit, any device. **Self-
hosted calling cannot work until that migration is applied and the gateway
has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`** (it exits without them).
The React wiring (CallContext/Overlay/Calls/Chat/useCallOutcome/bubble/push)
was never rendered or type-checked with the project's real types.

## KI-34 — P1 (2026-09-20, Phase 4) — caller UI doesn't consume `CALL_ACCEPTED`
The caller receives `CALL_ACCEPTED` over the socket (tested) but its
ringing→connected UI still derives from the remote participant appearing in
LiveKit. Only reject/timeout/busy/end are socket-driven on the caller's UI.
Wiring accept into the UI was out of scope (no UI changes).

## KI-35 — P1 (2026-09-20, Phase 4) — Realtime remains as a labelled recovery path
For self-hosted calls the Realtime INSERT/UPDATE subscriptions still exist
(callee ring recovery: immediate if socket down, +2 s if no offer;
callee cancel dismissal; caller outcome). No self-hosted flow awaits them and
outcomes are idempotent, but a callee whose socket is down still rings via
Realtime by design. Native background decline writes `status='missed'`
directly (no `declined_at`), so the caller may show "no answer" instead of
"declined", and the gateway may refuse the follow-up `CALL_REJECTED`
(`CALL_TERMINAL`) if its registry no longer holds the call.

## KI-36 — P1 (2026-09-20) — TURN is unverified and earlier docs were wrong
LiveKit's `turn:` block enables its *embedded* TURN; it never pointed at
coturn (the old README said it did), and nothing mints coturn credentials.
coturn is now an opt-in compose profile. No client has been relayed through
any TURN server; run the checklist in
`infrastructure/deployment/ENVIRONMENTS.md`. Image tags (LiveKit v1.8.4,
coturn 4.6.2-r1) and the `--node-ip` / `LIVEKIT_KEYS` mechanisms were written
from training-time knowledge — verify before deploying.

## KI-37 — P2 (2026-09-20) — mixed-provider pairs unsupported
A callee configured for Daily receiving a self-hosted call (or vice versa)
cannot join it. Provider selection is per-device/config, not per-call.

## KI-38 — P2 (2026-09-20) — one gateway socket per user, single instance
A user's second device/tab replaces the first's socket and won't get
WebSocket rings (push only). The gateway's call registry, idempotency cache
and rate limiter are in memory: run one instance.

## KI-39 — P1 (2026-09-20) — gateway holds the service-role key; no lockfile
The gateway needs `SUPABASE_SERVICE_ROLE_KEY` (narrowed to one RPC by code,
not by key scope — the key itself is full-power). `infrastructure/signaling`
has no `package-lock.json` and its Dockerfile runs `npm install`. Generate a
lock with network access and switch to `npm ci`; consider a scoped DB role
instead of the service-role key.

## KI-40 — P2 (2026-09-20) — ring-window mismatch
`IncomingCallOverlay` auto-declines at 45 s (2026-09-20 change) but the DB
`expires_at` is 40 s; the gateway follows the DB (40 s) and sends
`CALL_TIMEOUT`, which dismisses a self-hosted ring at 40 s.

## KI-41 — P1 (2026-09-20) — FIXED for call latency: telemetry redaction/truncation
`logInfo` flattens object extras to a 200-char `raw` string after key
redaction, so call-latency metrics were truncated and every `token*` key was
`[redacted]`. `callLatency.ts` now emits the full `name=ms` summary in the log
message. Any *other* caller passing structured metrics to `logInfo` has the
same problem.

## KI-42 — P2 (2026-09-20) — unlink needs the partner; no override for an unresponsive partner
Unlinking now requires the other partner's approval (`docs/PARTNER_UNLINK_CONSENT.md`).
Requests expire after 7 days and can be re-sent, but if the partner never
answers (or abandons the account) the pairing cannot be ended by the requester.
Product decision needed on an escape hatch. The whole flow is NOT VERIFIED
against a live database.

## KI-43 — P2 (2026-09-20) — shayari favorite / two-person delete only work on your OWN shayaris
Found while adding the Edit button. `public.shayaris` UPDATE and DELETE policies
are both `auth.uid() = user_id`, but `Shayari.tsx` lets either partner tap the
heart or "request/approve deletion" on any card. On the partner's shayaris the
database silently changes 0 rows (no error), the page updates its local state
anyway (heart fills, "Waiting for partner…" shows), and the change disappears on
reload; "Approve Delete" toasts "Shayari deleted" but nothing is deleted. Not
fixed here (scope) — needs a product call (per-viewer favorites? a SECURITY
DEFINER RPC for the approval flow?). NOT VERIFIED against a live DB; read from
the migrations (`20260708090100_...sql`, latest to touch these policies).

## Phase 2B (2026-09-23)
- local-model-v1 has never executed a real inference (weights blocked in the build sandbox); manifest unpinned → model unavailable in every build until hashes are pinned.
- No native local-model runtime on Android/iOS (capability layer → local-rule-v1).
- `npm ci` against the committed lock fails outside the Lovable environment (private registry `resolved` URLs → 403).
- Pre-existing, unrelated: 18 tsc errors; test failures in connectivity, networkQualityClassifier, playHistory.
- Partner Daily-key DB columns still present (see calling migration record).

## Phase 2C (2026-09-23)
- Model artifact unobtainable in build env (HF 403); manifest unpinned.
- E2E cloud AI blocked by design (no attested TEE).
- tsc pre-existing: PhotoViewer DownloadResult narrowing, faceRecognition Float32Array typing (both from photos zip, type-only).

## Phase 2D (2026-09-23)
- Model artifact unobtainable here (all authoritative sources 403); local model cannot run anywhere until pinned.
- 2-timeout/24h slow-device rule is unverified (no latency data).
- No device testing possible (S24 Ultra / low-end / iOS).
