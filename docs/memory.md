# DuoSpace — Project Memory

A condensed history of what's been found and fixed across this project's
development, organized by topic rather than chronologically. If you're an
engineer (human or AI) picking this codebase back up, read this before
re-investigating something — there's a good chance it's already been
diagnosed and fixed, and the reasoning here explains *why* the code looks
the way it does in non-obvious spots.

## Identity

DuoSpace is a private 1:1 couples app. Also referenced as "Guardian Grace"
(Lovable project name) and "duet sync chat" (an earlier Supabase project
name) — same product throughout. Repo: `aradhyac12/duospace-guardian`.
Logo: a "D" mark, blue-purple gradient, 3-dot motif.

## Supabase project history — important gotcha

There have been **two different Supabase projects** referenced across this
project's history:
- `ffrsohhfqcypnkkbtali` ("duet sync chat") — an earlier project, hardened
  in an early pass (E2E key storage, RLS, OAuth PKCE, etc.)
- `jzlpelxwzjjpddqcrtpu` ("Duospace", ap-northeast-1, created 2026-07-17)
  — the **actual currently-connected/active project**. Has the full
  original migration history plus `user_secrets`/`backup_runs` tables
  that the other project doesn't.

**Always verify which project is live via a direct query before assuming a
migration has landed.** Two migrations were confirmed applied to
`jzlpelxwzjjpddqcrtpu`: `drop_orphaned_gdrive_backup` and
`fix_reactions_unique_and_imported_sender`.

## Edge functions — deployment gotcha

Root cause of a whole class of "edge function fails" bugs (passkey save,
daily-call, music search, etc.): only 3 of 15 edge functions were actually
deployed to the live project — everything else 404'd. All 15 are now
deployed. Deployed copies have `_shared/*.ts` helper code **inlined**
because the deploy tool couldn't resolve cross-function relative imports
— but the repo source still uses normal shared imports, which is correct
for CLI-based (`supabase functions deploy`) deploys. Don't "fix" the repo
source to match the inlined deployed copies.

## Real bugs found and fixed (representative list)

- **`mood_logs` inserts have very likely been failing outright since this
  code was written.** `MoodDetector.tsx` inserts a `features` key into
  every camera-based mood-detection row via `.insert({...} as any)` — the
  `as any` was silencing a real TypeScript error, not a false positive.
  No migration ever added a `features` column, and generated
  `types.ts` confirmed it was never part of the live schema. PostgREST
  rejects inserts with an unknown column, and the call site never checked
  `.error` (only `data`), so this has almost certainly been failing
  silently for every automatic mood detection (the manual mood-picker
  path doesn't send `features` and was likely unaffected). Found
  2026-07-31 while building the mood-history/trends UI, which needed to
  actually read real rows back. Fixed: migration
  `20260731050000_add_mood_logs_features_column.sql` adds the column,
  `types.ts` manually patched to match (flagged inline for a real
  `supabase gen types` regeneration once the migration is actually
  applied), and all four `mood_logs` call sites in `MoodDetector.tsx` now
  check `.error` and `console.error` on failure instead of swallowing it.
  **The migration file exists only in this sandboxed session's
  filesystem — it has not been applied to the live database** (no
  network access here to run `supabase db push`). Mood history will
  look empty/broken until it's actually run against the real project.
- **Peek Guard could only ever lock once per app session.** Nothing in
  `usePeekDetection.ts` ever called `setIsPeeking(false)`, and the
  lock-arming guard requires `!isPeeking` — so after the first lock ever
  fired, `isPeeking` stayed true for the rest of the session and no
  future breach, however real, could re-lock the screen. Found 2026-07-30
  while wiring the Security Dashboard's per-event feedback (which needed
  the lock to actually cycle to log more than one event). Fixed by adding
  a `dismiss()` function the hook now returns, which `PeekGuard.tsx` calls
  at every point the user actually authenticates/dismisses.
- **Partner-request notifications never arrived.** The pending-requests
  query in Settings selected columns that don't exist on the
  `partner_requests` table (it only has
  id/sender_id/receiver_id/status/created_at/updated_at) — the PostgREST
  error was silently swallowed.
- **Location tab couldn't scroll.** Missing `overflow-y-auto`/
  `overscroll-contain` on the outer container, unlike other tab pages.
- **Location tab lag.** A debug-snapshot ticker ran every 5s
  unconditionally, causing full re-renders even when the debug overlay
  was closed. Now ticks every 20s when closed, 5s when open.
- **Music search failures + dead Google Drive backup.** Both fixed
  together: music search moved to the hardened `invokeEdgeFunction`
  wrapper; `GoogleDriveBackup.tsx` + its 4 `gdrive-*` edge functions were
  deleted as orphaned/broken-on-native dead code (migration
  `20260721111940_drop_orphaned_gdrive_backup.sql` drops the related
  columns/table).
- **Reactions bug:** a user could add multiple different emoji reactions
  to the same message, because the DB unique constraint was
  `(message_id, user_id, emoji)` and the client only checked for a
  matching *emoji* before inserting. Constraint changed to
  `(message_id, user_id)`; client now replaces any existing reaction
  instead of adding a second one.
- **WhatsApp import invisible to partner.** The import query filtered to
  only the importing user's `owner_id`, so the partner never saw it even
  though RLS already allowed both. Now fetches/subscribes for both
  partners' `owner_id`.
- **WhatsApp import sender identification.** Added `is_self` column;
  Settings shows a "Which one is you?" picker for multi-sender imports;
  Chat renders "You"/partner's real name instead of the raw export name
  (often just a phone number).
- **WhatsApp import chronological scrambling** (the subtle one): the date
  parser guessed DD/MM vs MM/DD *per line* based on whether the leading
  number was >12 — but a single export uses one consistent format
  throughout, so ~40% of dates in a typical month got silently
  day/month-swapped. Now pre-scans the whole file once to determine a
  file-wide format, then applies it consistently.
- **Voice recording cancelling itself.** The hold-to-record button never
  called `setPointerCapture`, so natural finger drift off the small
  button during a hold fired `pointerleave` almost instantly, cancelling
  the recording before release. Fixed with `setPointerCapture` on
  pointerdown + switching the cancel trigger to `onPointerCancel`.
- **Broken gallery/chat/memory images.** `gallery`/`chat-files`/`memories`
  buckets are private (correct), but code called `getPublicUrl()` on them
  directly — works only on public buckets, so every image 403'd. Fixed
  with `lib/signedStorageUrl.ts`.
- **"[object Object]" call errors.** Daily.co's `call.join()` rejects with
  a plain `{errorMsg: string}`, not a real `Error` — `String(err)` on that
  literally produces the text "[object Object]". Fixed with
  `lib/errorMessage.ts`'s `extractErrorMessage()`.
- **Black-box bug in Vanish Mode.** The dim overlay (up to ~60% black,
  `z-30`, fixed inset-0) had no z-index guard against the composer bar,
  which had no explicit z-index — so Vanish Mode visually covered the
  whole compose bar. Fixed by giving the composer wrapper `relative z-40`.
- **QR scan silently failing.** `QRSignInScanner.handleDecoded` never
  handled the `anon_signup` response kind (returned when scanning a
  partner's not-yet-signed-up QR) — fell through to an access-token check
  and threw "Invalid response" even though decode worked fine.
- **Native Google OAuth returning to the web app instead of the APK.**
  Root-caused via live Supabase auth logs: `/authorize` correctly
  initiates with `duospace://auth` as referer, but `/callback`/`/token`
  show the web Site URL — meaning `duospace://auth` isn't in the Supabase
  Dashboard redirect-URL allow-list. Dashboard config fix, not code.
- **"Stuck on Setting up..."** — the post-auth `needsOnboarding` profiles
  query had no try/catch or timeout; a throw or stall hung forever even
  after a successful sign-in. Fixed with try/catch + 8s timeout.
- **No confirmation email arrives** (no SMTP/email provider configured) —
  worked around with a `complete-signup` edge function that auto-confirms
  + mints a session server-side right after `signUp()`, time-boxed to
  15 minutes post-account-creation.
  **RESOLVED:** Resend SMTP is now configured in Supabase Auth. Signup no
  longer calls `complete-signup` — see `pages/Auth.tsx` handleSignUp; real
  confirmation-email click-through is the flow now.
- **Chat auto-scroll not firing** for finished calls or WhatsApp import
  batches — the scroll effect only watched `messages`, not the merged
  `callHistory`/`importedMessages` that also render in the timeline.

## Structural decisions worth knowing

- **Nav bar:** bottom `FloatingDock` shows exactly 3 destinations (Chat,
  Calls, Settings). The "More" sheet was deliberately removed —
  everything else lives in the in-chat sparkle Hub (`GridMenu.tsx`).
- **Settings order:** Account → Partner → Devices & Sign-in → Security &
  Privacy → Appearance → Anniversary → Data & Backup → Import. Sections
  default collapsed except Account (fixed a real "feels too long" bug).
- **Duplicate UI removed:** `GoogleDriveBackup` (superseded by
  `BackupManager`), a duplicate "Show my QR" button, a standalone
  Username section merged into Account.

## Redesign pass (this engagement) — see `docs/design.md`/`phases.md`

Full token/color system rebuild, Settings default-collapse fix, app-wide
touch-target audit, a contrast regression caught mid-pass (solid
`bg-accent` + wrong-token icon color in ~16+ spots), and an in-progress
haptics wiring pass (113→231 of 300 `onClick` handlers covered). Full
detail in those two files rather than duplicated here.

## Relationship-feature redesign (Us/Memories/Countdown/Mood/Map/Shayari/Groic/Playlist)

Separate, later pass than the token rebuild above — see
`docs/RELATIONSHIP_FEATURE_QA.md` for the full state-by-state audit.
Companion docs to check first if picking this back up:
`docs/UI_REDESIGN_FORENSIC_AUDIT.md`'s Safety Map (RED/YELLOW/GREEN
classifications this pass was gated on) and `docs/error-system.md` (the
typed error registry this pass extended).

**2026-08-10 — Loading-vs-empty gap fixed across Us, Shayari,
MemoryWall, Playlist.** All four fetched their primary list/hub data
with no `loading` state distinct from "genuinely empty" — a slow network
made "No shayaris yet" / "No songs yet" / an empty countdown section
flash on every cold load, and on an actual fetch failure it stuck
around permanently with no indication anything had gone wrong. Added a
`loading` boolean + skeleton (reusing `Shimmer`) shaped to each feature
(quote-card skeletons for Shayari, thumbnail-row skeletons for Playlist,
etc.) and a separate `loadError` state rendered via the shared
`ErrorCard` with a retry action. `MoodHistory.tsx` had the same bug in a
sneakier form: on fetch error it set `rows = []`, which is
indistinguishable from "no check-ins yet" — split into a real error
state instead.

**2026-08-10 — Silent-failure mutations wired into the error registry.**
`Us.tsx` (`sendTap`, `addCountdown`, `deleteCountdown`,
`submitDailyAnswer`, mood update), `MemoryWall.tsx` (`addMemory`,
`deleteMemory`), `Shayari.tsx` (`addShayari`), and `Playlist.tsx`
(`addSong`, `deleteSong`, `sendBlendInvite`, `acceptBlend`,
`declineBlend`, `endBlend`) previously either had no `error` check at
all or checked it without surfacing anything to the person — a failed
insert/delete would just silently no-op the UI. Added typed capture
calls (`DS-US-*`, `DS-MOOD-*`, `DS-SHAYARI-*`, `DS-GROIC-*` — new
modules added to `lib/errors/types.ts`/`registry.ts`) plus a toast for
each. `Groic.tsx`'s existing degraded-search fallback (edge function →
Piped mirrors → static list) already handled its own failure
gracefully; it now also captures `DS-GROIC-001` for telemetry and shows
a quiet inline "showing a curated set" banner instead of only a toast.

**2026-08-10 — Destructive actions without confirmation.** Countdown
delete (`Us.tsx`) and song removal (`Playlist.tsx`) were single-tap
destructive actions with no confirmation step, inconsistent with
Shayari's mutual-consent delete flow and Memory Wall's (now also
confirmed) delete-from-viewer flow. Added `AlertDialog`-based confirms
to both, matching the pattern already used elsewhere in the app.

**2026-08-10 — Deep-link support added, but nothing sends the payload
yet — honest gap.** `Us.tsx` now reads `?focus=mood` /
`?focus=countdown` (opens the matching dialog once, then strips the
query param) and `?memory=<id>`; `MemoryWall.tsx` accepts `focusMemoryId`
and opens/scrolls to that memory once loaded; `Shayari.tsx` reads
`?id=<id>` and highlights/scrolls to that entry. This is the *receiving*
half only. `usePushNotifications.ts`'s `routeForNotificationData()` has
no `case` for taps, new memories, new shayaris, or countdowns reaching
their due date — those events currently generate no push notification
and nothing points at these new query params. Wiring that up means
adding notification types server-side (the `send-push` edge function
and whatever DB trigger fires it) and is backend/business logic, out of
scope for this UI pass and not attempted. Whoever picks up push
notification work next should route those event types at
`/us?focus=...`, `/us?memory=<id>`, and `/shayari?id=<id>`.

**2026-08-10 — MapView.tsx and Groic's core player left almost
untouched, deliberately.** Both were already the most mature files in
this family (Map: full permission/GPS/stale/battery/offline coverage
built earlier; Groic's search degradation and player already solid).
Map got only additive telemetry (`DS-MAP-001`/`002` captured alongside
the existing bespoke inline UI, which was not restructured) and a
`tabular-nums` treatment on its coordinate/distance readouts for
personality distinction from Us/Shayari's serif "intimate number"
treatment. `GroicContext.tsx`, `useLiveLocation.ts`, and the mood
detection pipeline in `MoodDetector.tsx` are RED per the Safety Map —
none of their logic was touched.

## AI Privacy & Emotion Engine — ongoing upgrade (started 2026-07-30)

An AI-assisted pass to bring `usePeekDetection`/`MoodDetector` up to a
flagship-feeling bar without breaking the already-solid pipeline that was
here (temporal consistency gating, adaptive match threshold, blink
liveness, per-user feedback-based distrust calibration — this was not a
greenfield build). See `docs/architecture.md`'s "AI Privacy & Emotion
Engine" section for the current file map. Tracked as Phase 5 in
`docs/phases.md`.

**2026-07-30 — Off-thread detection (peek-guard speed).** Moved
`usePeekDetection`'s hot path off the main thread: `faceDetection.worker.ts`
(new module Worker) now runs MediaPipe FaceLandmarker, fed by
`faceWorkerClient.ts` capturing frames as transferable `ImageBitmap`s.
Landmark math (`buildEmbedding`/`computeEAR`/`computePose`/bbox) was
extracted to `lib/faceMath.ts` so the worker and the main-thread fallback
path (`faceRecognition.ts`, still used by enrollment) compute numerically
identical embeddings — this matters because an owner enrolled via the
main-thread path has to match candidates scored in the worker. Polling
switched from `setInterval` to `requestVideoFrameCallback` (throttled to
`checkInterval`, `setInterval` fallback where rVFC is unsupported).
`lockDelay` default dropped 500ms → 150ms (the real source of truth was
`ThemeContext.tsx`'s `defaultSettings`, not the hook's own fallback —
both are now 150ms; `PeekConfigDialog.tsx`'s slider floor dropped
500→100ms to make the new range actually reachable). Automatic fallback to
the main-thread path on any worker error or on browsers without
`Worker`/`createImageBitmap`. **Not yet verified against a real build** —
no network access in the session that made this change, so `tsc`/`vitest`
were not run; review the diff and run the app's normal typecheck before
trusting it fully.

**2026-07-30 — Mood engine: weighted scoring + wider label set.**
`MoodDetector.tsx`'s single-pass if/else-if threshold cascade (which could
only ever land on one of 5 hardcoded moods, in a fixed priority order) was
replaced with a proper multi-class scorer: `scoreMoods()` computes an
evidence value for 7 moods (added Surprised, Calm) from the same 4
landmark-derived features it already had, `softmaxScores()` turns that
into a genuine probability distribution, and the full distribution is now
stored in `mood_logs.features.mood_probabilities` (previously only the
winning label + a hand-tuned confidence number were kept). Sample
averaging changed from a flat mean to blink-filtered + recency-weighted
(later samples in the 5s window count more, since expressions typically
settle after the first ~1s). Per-user distrust calibration (already
existing) carried over unchanged into the new scorer's `need()` threshold.
**Deliberately did not attempt the spec's full 20-label set** — with only
4 landmark-derived scalars and no per-Action-Unit or gaze data, labels
like Excited-vs-Happy or Confused-vs-Thinking aren't distinguishable from
each other with real signal; forcing them in would produce confident-looking
but meaningless output. If finer-grained emotion is wanted later, it needs
a richer feature set (gaze vector, per-eyebrow asymmetry, or a real FACS
Action Unit model), not just more `if` branches on the same 4 numbers.

**2026-07-30 — Security: second liveness channel + threat score.**
Added a head-pose micro-movement liveness channel (`poseHistoryRef` in
`usePeekDetection.ts`) alongside the existing blink-EAR channel — pose
data (`yaw`/`pitch`) was already computed by `faceMath.ts` for every
detected face but wasn't being used. This matters because it changes a
real security property, not just accuracy: the previous single-channel
(blink-only) liveness gate meant a live stranger who simply didn't blink
within the observation window would never trigger a lock — the code
would defer the "stranger" breach indefinitely. Pose micro-movement fires
far more often than blinks (continuous natural drift vs. ~every 4s), so
it closes most of that gap. For the remaining case — a face that shows
*neither* signal at all — added `staticStrangerTimeoutMs` (config +
`appSettings.peekStaticStrangerTimeoutMs`, default 6000ms, user-tunable
in `PeekConfigDialog`, 0 disables it): after that long with zero movement
on either channel, lock anyway with `reason: "spoof"` rather than
deferring forever. This is a deliberate trade-off, not a guarantee —
picked conservatively (6s, not 1-2s) so a genuinely static background
photo/poster doesn't cause a false lock; a determined attacker holding a
printed photo *and* holding it perfectly still for 6+ seconds is an edge
case this still won't catch, and there's no pixel-level texture/moiré
analysis here (would need raw frame access in the worker, not just
landmarks — noted as a possible follow-up, not attempted this pass).

Also added `computeThreatScore()` — a heuristic (not learned) 0-100
score from stranger count, total face count, spoof-suspected state, and
sustained-breach state, banded into Safe/Low/Medium/High/Critical and
exposed as `threatScore`/`threatLevel` on the hook's return value.
`PeekGuard.tsx` shows a small "HIGH/CRITICAL THREAT" line on the lock
screen when elevated; no full dashboard yet (still Phase 5 planned work,
see `docs/phases.md`).

**2026-07-30 — Battery: dynamic FPS + camera-covered pause + native
backgrounding.** `usePeekDetection`'s polling interval was a fixed
`checkInterval` regardless of what was actually happening in frame — now
`dynamicIntervalRef` is recomputed at the end of every `tick()` from that
tick's own signals (idle/normal/movement/threat tiers, all scaled off the
user's own configured `checkInterval` rather than hardcoded numbers, so a
battery-conscious user's slower baseline stays slower in every tier).
Separately, a per-tick 8x8-pixel brightness sample (its own tiny canvas,
independent of the worker) detects a physically covered lens — 3
consecutive near-black ticks skips the expensive MediaPipe call entirely
until brightness returns, since that's the dominant per-tick cost. Also
added a native-specific pause via Capacitor's `App.appStateChange`
listener (mirroring the existing pattern in `useAppNative.ts`) alongside
the existing `visibilitychange` handling — `visibilitychange` isn't
always reliable inside a native WebView when the screen locks or the app
is swapped to the background, so this closes a real gap on native builds
specifically (web-only builds still rely on `visibilitychange` alone,
which was already correct there). None of this is a trained model — every
threshold (brightness < 6/255 for 3 ticks, tier multipliers, floors) is a
hand-picked heuristic; flag if real-device battery profiling suggests
different numbers.

**2026-07-30 — Settings/dashboard UI (Security Dashboard).** Added
`lib/peekEventLog.ts` (local, never-synced event log — `localStorage` via
the existing `lib/storage.ts` wrapper, capped to 200 events) and
`components/SecurityDashboard.tsx`, opened from a new button in
`PeekConfigDialog`. Every stat shown is either read live from the hook,
computed from real logged events, or explicitly "not enough data yet" —
deliberately did not fabricate CPU%/battery-draw numbers since there's no
standard browser API for either; the dashboard says so instead of faking
a plausible-looking figure. Privacy score is a transparent additive
checklist (each point traceable to one actual setting), not a black-box
number. Added a lightweight "was that accurate?" feedback prompt to
`PeekGuard.tsx` after dismissal (real-alert / false-alarm), which is what
feeds the dashboard's false-positive rate — gated behind a minimum sample
count (3) so it doesn't show a misleading 0%/100% off one data point.
While wiring this up, found and fixed the `isPeeking`-never-resets bug —
see "Real bugs found and fixed" above; the dashboard's "locks today/week"
counts would have been silently capped at 1 without that fix.

**2026-07-31 — Mood history/trends UI.** Added `MoodHistory.tsx`
(today's/30-day positivity score from average `valence`, a 7-day recharts
bar chart, dominant mood, time-of-day breakdown), opened from a new
"Mood history" row in Settings next to the existing Daily Mood toggle
(same pattern as Peek Guard's "Configure" row). While building this,
found and fixed a much more serious pre-existing bug — see "Real bugs
found and fixed" above: `mood_logs` inserts have very likely been failing
outright this whole time because the code sends a `features` column the
live schema never actually had. That fix (migration + `MoodDetector.tsx`
error handling) landed in this same session. **The migration has not
been applied to the live database from here** — run it before expecting
mood history to actually populate.

**2026-07-31 — Debug mode / developer stats.** Added `getDebugSnapshot()`
to `usePeekDetection.ts` (plain function reading live ref values — worker
vs. main-thread-fallback status, current dynamic-FPS interval, camera-
covered state, tick-in-flight — not React state, so it costs nothing for
users who never enable debug mode) and a small always-on corner HUD in
`PeekGuard.tsx` that polls it every 500ms when `appSettings.peekDebugMode`
is on. Toggle lives in `PeekConfigDialog` under a new "Advanced" section.
This is the engineering-facing counterpart to the Security Dashboard —
raw pipeline signals rather than aggregated user-facing stats.

**2026-07-31 — Premium lock/mood animations.** `PeekGuard.tsx`'s lock
screen: backdrop changed from flat `rgba(0,0,0,0.92)` to a radial-gradient
vignette, and the shield icon now has a soft pulsing glow halo (blurred,
scaling, `bg-destructive/25`) behind it instead of just the icon pulsing
alone. `MoodDetector.tsx`'s 5-second capture phase: added a face-scan
overlay — four corner brackets in a slow breathing pulse, plus a
sweeping horizontal scan line — replacing the plain countdown-circle-only
view (the countdown circle itself stayed, just restyled with a border
ring to match). Both use `motion.*` components exclusively, specifically
*so* they inherit `App.tsx`'s existing `<MotionConfig reducedMotion="user">`
for free — did not write any new `prefers-reduced-motion` handling
because the app-wide fix already covers every Framer Motion animation,
and index.css's global `@media (prefers-reduced-motion: reduce)` block
already covers plain CSS animations too. Worth remembering next time
motion work comes up here: neither mechanism needs to be reinvented.

**2026-07-31 — Pixel-level anti-spoof (partial, honestly scoped).** Added
`textureScoreFromGrayscale()` to `faceMath.ts` — Laplacian-variance +
luminance-std-dev over a small grayscale patch, classic cheap
blur/flatness signals repurposed as a weak anti-spoof supplement.
`faceDetection.worker.ts` computes it for the single largest face only,
reading raw pixels via a small reused `OffscreenCanvas` before closing
the `ImageBitmap` (feature-detected — null if `OffscreenCanvas` isn't
available, everything else keeps working). `usePeekDetection.ts` derives
`flatTextureSuspected` from it (both laplacianVar AND lumaStdDev must be
low — deliberately conservative, requiring both reduces false positives
vs. either alone) and feeds it into `computeThreatScore()` as a small
+10 contributor — **not** a lock-gating signal on its own, unlike the
existing `spoofSuspected`/`staticStrangerTimeoutMs` path. Visible in the
debug HUD (`peekDebugMode`) for tuning.

**This is not real anti-spoofing and the code says so in three places**
(faceMath.ts's doc comment, the worker's comment, the hook's comment):
it does NOT catch screen/tablet replay (moiré is a genuine frequency-
domain artifact needing an FFT-based check, not attempted), and does NOT
catch a good-quality well-lit printed photo — only the flat/blurry/low-
quality end of that spectrum. The `laplacianVar < 15 && lumaStdDev < 8`
thresholds are **placeholder guesses, not calibrated against any real
device or lighting condition** — there was no way to validate them in
this sandboxed session (no camera, no test images, no network to fetch
any). Treat these as a starting point for real-device tuning, not a
finished feature. Given that uncertainty, this was deliberately wired as
a minor threat-score input rather than something that can lock someone's
screen or block their own owner-match on its own.

## A meta-note on working in this codebase

This project has been through many rounds of hardening and polish across
many sessions. When something looks unusual — an inlined helper, a
specific opacity value, a seemingly-redundant try/catch — the more likely
explanation is "this was the fix for a specific bug," not "nobody got
around to cleaning it up." Check this file and `phases.md` before
assuming otherwise.

**2026-08-10 — Phase 8: reliability/performance hardening audit.** Full
writeup in `docs/PRODUCTION_UI_HARDENING.md` — read that first for any
future performance work, it has the complete audit with impact/fix/risk
per finding. Summary of what actually changed:

- **Fixed a real P0:** `IncomingCallOverlay` (ring/vibrate/accept UI) was
  mounted only inside `Chat.tsx`, so incoming calls were silently missed
  whenever the person was on Calls/Gallery/Map/Settings — the push
  notification tap handler's forced navigation to `/chat` was a
  workaround for this, not a fix. Moved the overlay and its accept/decline
  logic into `CallContext.tsx` (already the single global call manager —
  see the "Duplicate DailyIframe instances" fix already documented above),
  with `activeCallId`/`isAcceptingCall` promoted from page-local state to
  context so `Chat.tsx`/`Calls.tsx`'s own `endCall()` still resolves the
  right `call_history` row regardless of which page accepted the call.
  **This needs manual QA before shipping** — see the test checklist in
  `PRODUCTION_UI_HARDENING.md` §1.1 — it was verified by hand-tracing
  every reference, not by an actual build/run (see below).
- Fixed a build-breaking duplicate `useMediaPermission` import in
  `Chat.tsx` (unrelated to the above — just a leftover from an earlier
  edit) — this alone would have failed `tsc`/`vite build`.
- `FloatingDock.tsx`'s two badge-count realtime channels were both
  calling one combined `fetchCounts()`, so a call-history event wastefully
  re-ran the unread-message query too, and vice versa. Split into
  `fetchUnreadMessages`/`fetchMissedCalls`, one per channel.
- Added `loading="lazy" decoding="async"` to chat image attachments in
  `MessageBubble.tsx` — matches the convention already used in Gallery,
  just missed here.
- **Identified but deliberately did not fix:** Gallery's `loadGallery()`
  fetches *all* `gallery_items` for both partners with no pagination, and
  resolves a signed URL per item in parallel on every load — will scale
  badly with account age. Also, `useVirtualList.ts` is a fully-built,
  fully-unused hook — neither the chat message list nor the Gallery grid
  is virtualized, and no component in the app uses `React.memo`, so
  `Chat.tsx`'s `partnerTyping` state re-renders the entire (unmemoized,
  ~8-motion.div-per-bubble) message list on every partner keystroke. Both
  are real and worth fixing, but touch enough carefully-tuned existing
  logic (scroll-anchoring, swipe gestures, realtime dedup) that they need
  a session with an actual build/test loop, not a blind edit. Full detail
  and recommended fix in `PRODUCTION_UI_HARDENING.md` §2.
- **Sandbox note for whoever picks this up next:** `npm install` failed
  with a 403 on the npm registry in this session (no network egress
  available) — `typecheck`/`lint`/`test`/`build` could not be run at all.
  Confirm they pass before trusting anything above beyond what's already
  described as manually verified.

**2026-08-21 — P0: fixed a real build-breaking syntax error in
`IncomingCallOverlay.tsx` (BUG-05 in `UI_REDESIGN_BUG_REGISTER.md`).**
A JSX comment was sitting *inside* the `{incomingCall && (...)}`
expression, directly before `<motion.div>` with no operator between them
— confirmed with `tsc --noEmit` (not guessed): this is a hard parse
failure, not a style nit. Since this component is mounted inside
`CallProvider`, which wraps every protected route, this is the most
likely root cause of the reported "partner can't pick up/hang up/go back,
call feels laggy and stuck" — the incoming-call answer UI was never
actually in a buildable state. Fix was a pure comment relocation, zero
logic change. Swept the entire `src/` tree (all 254 `.ts`/`.tsx` files)
with `tsc --noEmit`, syntax-error-only filter — this was the only real
hit. `useDailyCall.ts` and `Calls.tsx`'s hang-up/end-call/back-button
wiring were read in full and are sound (re-entrancy locks, awaited
destroy, camera-release safety net, auto-audio-fallback) — no second
logic bug found. **Still needs a real `npm run build` + device test** to
confirm this compiles clean in the actual toolchain and that call
lag/connect-time is acceptable once the app is actually reachable — a
static sandbox read can prove the parse error and its fix with certainty,
but can't reproduce live WebRTC network behavior.

**2026-08-21 — Chat + Calls micro-detailing pass.** Full writeup in
`docs/DUOSPACE-PHASE-2-5-CHAT-CALLS.md`'s "Session 3." Five GREEN,
presentation-only fixes, all real inconsistencies against patterns
already established elsewhere in the app (not invented decoration):
`TypingIndicator.tsx` was still on the pre-Phase-2 bordered-card bubble
style (`bg-card`/`shadow-sm`/`border`) that every other bubble had moved
off of — switched to the same `surface-2` partner tone.
`VoiceMessagePlayer.tsx`'s play/pause button was the one remaining
CSS-only `active:scale-95` press in Chat — converted to the shared
`quickSpring` Framer whileTap, plus a `DUR_FAST` crossfade between the
Play/Pause glyphs. `MessageStatus.tsx`'s single→double check swap on
read was instant — added the same `DUR_FAST` crossfade. `CallOutcomeScreen.tsx`/
`CallErrorScreen.tsx` had zero press feedback on any of their 5 buttons
combined (haptic fired, nothing visible responded) — added `quickSpring`
whileTap to all of them. No logic/state/callback changes anywhere; no
`CallContext`/realtime/E2E code touched. Same sandbox limitation as
every prior session — no network/Node here, so this was verified by
static read + bracket-balance sweep only, not an actual build. Confirm
with `npm run build` (or just eyeball on a real device) before trusting
the two new `AnimatePresence mode="wait"` swaps in particular.

**2026-08-22 — This zip's starting point already had BUG-05 (`IncomingCallOverlay.tsx`
parse error) and the chat/calls micro-detailing pass applied, but not the
following, which came from later in the same working conversation — all
four applied fresh to this upload:**

1. **BUG-06** — `Calls.tsx`'s `isVoiceCall`/`effectiveCallType`
   temporal-dead-zone `ReferenceError` (read before declared, threw on
   every Calls page mount). Same fix as before: moved the declaration up
   to right after `useCall()`. Full detail in `UI_REDESIGN_BUG_REGISTER.md`
   BUG-06.
2. **BUG-07** — "Failed to send voice message — Missing chunk 0" (also
   affecting photo/file/camera sends, since they share the same upload
   path). Root cause: `finalize-upload`'s chunk download can race ahead
   of storage read-after-write consistency, hitting hardest on small
   single-chunk uploads. Fixed with a short retry-with-backoff around
   each chunk download in the edge function. `UI_REDESIGN_BUG_REGISTER.md`
   BUG-07.
3. **BUG-08** — Hub menu not appearing directly above the hub button
   (visible gap) whenever the dock was hidden (e.g. right after typing).
   Root cause: the panel assumed a fixed `--dock-reserve` gap that
   doesn't hold when the dock's hidden. Fixed by measuring the real
   `#chat-hub-button` position at open time instead of assuming a
   constant. `UI_REDESIGN_BUG_REGISTER.md` BUG-08.
4. **BUG-09** — "Dock behaves like a bouncing bag." The dock's hide/show
   slide and compact-scale step shared `gentleSpring` with the (correctly
   spring-driven) active-tab pill morph, but unlike that pill, these two
   retrigger frequently and in quick reversal during ordinary scroll — a
   spring re-targeted mid-motion reads as jiggling even with low
   overshoot. Switched both to the app's existing non-oscillating
   `standardTransition` tween; left the pill on `gentleSpring`.
   `UI_REDESIGN_BUG_REGISTER.md` BUG-09.

All four verified via `tsc --noEmit` (syntax-only filter) per file plus
a full-tree sweep (0 real syntax errors across all `.ts`/`.tsx` in
`src/`) and bracket-balance checks — no build tooling available in this
sandbox, so no real `npm run build` was run. Also re-ran the
"const read before its own declaration" heuristic sweep across the
whole tree as a follow-up check after BUG-06 turned up that pattern once
already; it flagged 44 files, but manual review showed these are almost
entirely false positives from the heuristic not respecting function/
interface scope (type declarations, differently-scoped same-named
locals, etc.) — the specific hits for `startCall` (Calls.tsx) and
`fetchMessages`/`sendVoiceMessage`/`handleSend` (Chat.tsx) were already
individually checked by hand and confirmed safe (all are references
inside deferred closures, not immediate/dependency-array reads). Did not
attempt to manually clear all 44 given the noise level and scope of this
request — flagging here in case a future session wants to actually work
through that list file-by-file with real scope tracking rather than a
regex heuristic.

**2026-08-22 (later same day) — Revisited BUG-07 ("Missing chunk")
after it was reported as still happening.** Re-traced the entire
pipeline from scratch rather than assuming the first pass just needed
more time: confirmed all four reported send types (voice/image/file via
`Chat.tsx`'s `attemptSendMedia`, camera photo/video via `Gallery.tsx`'s
`saveToGallery`, the latter only above a 6MB threshold) really do share
the one `resumableUpload`/`finalize-upload` pipeline; re-checked storage
RLS policies for `chat-files`/`gallery` across every migration that
touches them (all scope on the object path's first segment only, so the
nested `.tmp/` chunk directory isn't blocked at any depth); re-checked
`withRetry` for silent-failure bugs (none — correctly rethrows). No
second deterministic bug turned up. Rather than treat that as
confirmation the first fix was already sufficient, widened both sides of
it: server-side chunk-download retry went from 4 attempts/~1.45s ceiling
to 6 attempts/~4.75s ceiling, and added a small chunk-count-scaled settle
delay client-side (in `resumableUpload.ts`) before finalize is even
called, so the server retry loop is needed less often in the first
place. Full detail appended to BUG-07 in `UI_REDESIGN_BUG_REGISTER.md`.
Verified via `tsc --noEmit` and bracket-balance on both edited files —
same sandbox limitation as always, no real deploy/build available here,
so this still needs an actual redeploy + real send test to confirm
against Supabase's real storage timing rather than this session's
reasoning about it.

**2026-08-22 (later still) — Found and fixed the REAL dock flicker cause
(BUG-10), from an actual screen recording, not a static screenshot.**
Extracted frames (`ffmpeg -vf fps=8`) and built a cropped filmstrip of
just the dock region — it showed the dock/composer position visibly
flipping between two states on nearly every single sampled frame
throughout ordinary scrolling, which meant BUG-09's fix (spring → tween)
was necessary but not sufficient: a tween can't oscillate at all, so
something was re-triggering the underlying hide/show *decision* at high
frequency. Root cause: a feedback loop between `AppLayout.tsx` (animated
its reserved bottom padding off the dock's full `isVisible`, which
includes scroll-hide) and `useDockCompactReporter`'s scroll listener —
shrinking/growing that padding changes the message list's own height,
shifting its `scrollTop` and firing a genuine native `scroll` event with
no user touch behind it, which the listener can't tell apart from a real
gesture, so it flips the decision back — ad infinitum. Fixed by splitting
`useDockVisibility`'s return into `isVisible` (unchanged, still includes
scroll-hide, drives the dock's own visual state) and a new
`isLayoutCollapsed` (only active/call, photo/video viewer, camera —
deliberately excludes scroll-hide), and pointing `AppLayout`'s padding
animation at the latter. Full trace in `UI_REDESIGN_BUG_REGISTER.md`
BUG-10. NOTE: this fix predates the note below by a separate conversation
turn — applied here to a freshly re-uploaded zip that had regressed to
before this fix (see below).

**2026-08-22/23 — Native background music playback (Audius) + music
provider abstraction — large multi-part feature, not a bug fix.** Full
writeup in `docs/MUSIC_NATIVE_PLAYBACK.md`. Summary: introduced a
provider-agnostic `GroicTrack` model (`src/lib/music/types.ts`) so the
player, queue, and shared listening never branch on provider except
where they genuinely need to; added Audius as a real, free,
native-streamable provider (`supabase/functions/audius-search`,
`src/lib/music/audiusProvider.ts`) while leaving YouTube exactly where it
was (hidden IFrame, discovery/search only — never touched for audio
extraction, per explicit instruction); built `duospace-audio-engine`, a
real Capacitor plugin (`native-plugins/audio-engine/`) with Android
(Media3/ExoPlayer + MediaSessionService foreground service) and iOS
(AVPlayer + AVAudioSession + MPNowPlayingInfoCenter +
MPRemoteCommandCenter) implementations, plus a genuinely functional web
fallback (HTMLAudio + navigator.mediaSession); rewrote `GroicContext.tsx`
as an orchestration layer that delegates to whichever engine a track's
provider needs, added repeat/shuffle, and made shared-listening
provider-aware (a guest re-resolves the same provider track rather than
trusting a host-resolved URL). Extracted the actual state-machine logic
(queue advancement, drift correction, dedup/shuffle) into pure,
unit-tested modules (`queueLogic.ts`, `driftCorrection.ts`,
`queueQuality.ts`) rather than leaving it trapped in the React context —
real vitest tests in `src/test/music*.test.ts`.

**Critical environment note for whoever picks this up next:** this
feature was built across a fresh zip re-upload mid-session. The
re-uploaded zip had diverged from the previous working state — it
already had a *more advanced* fix for the hub-position bug
(`GridMenu.tsx`, properly root-caused against `window.innerHeight`
unreliability on Samsung Internet — do not regress this) than what this
session had previously produced, but was *missing* BUG-10 (dock flicker)
and the entire music feature. Both were reconciled by diffing file-by-
file before touching anything, not by blind overwrite — several other
files in this zip (Shayari export/PDF, `LocationContext`,
`useNativeAuthDeepLink`, background geolocation) are genuinely new
features from outside this conversation and were left untouched.
**No Android SDK, Xcode, or `node_modules`/network were available in this
sandbox at any point** — every native Kotlin/Swift file was written
against the real Media3/AVFoundation APIs but never compiled; every
TypeScript file was verified with `tsc` (syntax-level only, via ad hoc
per-file invocation — no real project-wide typed build was possible
either). Confirm with a real `npm install && npm run build`,
`npx cap sync`, and an actual Android Studio/Xcode build before shipping
any of this.

**2026-08-29 — Splash screen redesign (native + hand-off).** Full brief:
premium minimal splash matching the current design system, logo never
cropped/stretched, correct light/dark handling, immediate hand-off into
the app. Native Android/iOS projects are not checked into this repo
(only `native/android`/`native/ios` source snippets for
Telecom/CallKit), so all native work happened at the config/source-asset
level for correct regeneration on `cap sync`, not by inventing generated
resource paths.

Findings before touching anything: `capacitor.config.json`'s
`SplashScreen.androidScaleType` was `CENTER_CROP` (crops the logo — the
exact bug the brief called out); every shipped logo PNG
(`icon-1024.png`, `duospace-logo-full.png`, `apple-touch-icon.png`) is
flattened onto opaque white with a baked-in soft rim-shading/embossing
that reads fine on light backgrounds but becomes a visible gray halo on
dark ones — no vector or flat-alpha source exists anywhere in the repo;
`index.html` theme-color metas and `manifest.webmanifest` colors were
stale (`#F5F0EB`/`#1A1A2E`) against the real design tokens
(`#F6F6F9` light / `#121316` dark, derived from `index.css`'s
`--background` HSL values); and the existing `SplashScreen.tsx` (a React
overlay shown after native hand-off, not the native splash itself) was
the *only* language-switcher entry point in the whole app
(`src/lib/i18n.ts`'s `setLanguageCode`/`SPLASH_LANGUAGES` had no other
consumer) — removing it per this session's direction (user chose to
drop it now, add a real Settings > Language screen later) is a real
feature regression, not just a visual cleanup; `src/lib/i18n.ts` was
left in place, unused, so that future screen can reuse its data instead
of rebuilding it.

Changes made:
- `capacitor.config.json`: `androidScaleType` → `CENTER` (was cropping);
  `launchAutoHide` → `false` with no fixed `launchShowDuration` — the
  native splash now holds until `useLaunchPermissions()`'s existing
  `SplashScreen.hide()` call fires on mount, instead of a guessed
  1500ms window; `backgroundColor` (top-level `ios`/`android` + plugin)
  corrected to the real dark token `#121316`. Known limitation: Capacitor
  config only supports one `backgroundColor`, not a light/dark pair —
  the generated native resources (below) handle the actual per-theme
  background correctly; this is only the WebView/pre-generation
  fallback color, unavoidable until `cap add` has been run once.
- New `resources/splash.png` + `resources/splash-dark.png` (2732×2732,
  `@capacitor/assets`' expected filenames) and `@capacitor/assets` added
  as a devDependency, wired into `cap:add:ios`/`cap:add:android`/
  `cap:sync` as a new `cap:assets` step — so running the existing
  pipeline regenerates correct, non-cropped, theme-aware native splash
  resources (incl. Android night/`values-night` and iOS dark-appearance
  assets) automatically.
- New derived, splash-safe logo assets: `duospace-splash-mark.png`
  (transparent, mark alone, light-mode) and
  `duospace-splash-mark-dark.png` (mark on a small soft rounded white
  "plate" matching the icon's own card treatment — chosen specifically
  to route around the halo issue above without touching the mark
  itself). Both derived from `duospace-logo-full.png` by keying out its
  near-white background (luminance+saturation threshold, feathered), not
  by hand-editing the brand mark. Mark occupies ~62% of its canvas in
  both variants so light/dark read at the same scale.
- `src/components/SplashScreen.tsx` rewritten: was a ~1.5s effect with
  animated ambient glows, a specular sweep, a progress hairline, a
  tagline, and the language-switcher popover, `object-cover`-cropping
  the icon into a rounded box. Now: reads light/dark synchronously via
  `resolveColorMode` (mirroring `ThemeContext`, independent of its
  effect-driven `<html>` class toggle, so there's no theme flash even
  though this only has ~200ms on screen) — logo mark (uncropped,
  `object-fit: contain`) + "DuoSpace" wordmark, ~180ms hold + ~160ms
  crossfade, still gated on the `ready` (auth) prop so it can never hand
  off onto a blank screen. No spinner, no progress indicator, no
  decorative motion beyond the entrance/exit itself.
- `index.html` theme-color metas and `manifest.webmanifest` colors
  corrected to `#F6F6F9`/`#121316`.

**Not verified in this session — no `node_modules`, no network egress,
no Android SDK/Xcode available in this sandbox.** `npm run build` /
`lint` / `test` and the `cap:sync`/`cap:assets` pipeline were not
actually run; all TypeScript/JSON was hand-reviewed for correctness
only. Confirm with a real install + build + `cap sync` +
Android Studio/Xcode cold-start test before shipping, in particular the
`@capacitor/assets` splash generation step (light/dark night-mode
resource output) and the `SplashScreen.hide()`/`launchAutoHide:false`
timing on a real device.

## Map tile-provider hardening (zoom ceiling, quality, provider resilience)

**Update (2026-09-05): the "CARTO Voyager" tiles referenced throughout this
section were later dropped entirely — see the "Map: CARTO Voyager tiles
broken by CARTO's own Aug 2026 policy change" entry further down. CARTO
started requiring an API key for these on 28 Aug 2026; the section below
is left as-is as history of the original tuning work (retina, zoom
ceiling, attribution), which is all still accurate — only the specific
tile URL/provider for "voyager" has since changed.**

`src/pages/MapView.tsx` uses raw Leaflet (dynamically imported) with three
free, keyless tile providers (OSM street, Esri World Imagery satellite,
CARTO Voyager) — there is no Google/Mapbox API key anywhere in this
project, so "map API" issues here mean *these* providers, not a
misconfigured key. Found and fixed:

- **No `maxNativeZoom` was set per provider**, only a single `maxZoom: 19`
  on both the map and every tile layer. Esri World Imagery's real detail
  tops out around z19 in most regions; without `maxNativeZoom`, Leaflet
  had no distinction between "provider's real ceiling" and "map's zoom
  ceiling," so there was no room to zoom in further with graceful
  upscaling — you just hit z19 and stopped. Each style in `MAP_TILES` now
  carries its own `maxNativeZoom` (street 19, satellite 19, voyager 20),
  and the map/layer `maxZoom` was raised to a shared `MAX_ZOOM = 21`
  constant — Leaflet upscales the last real tile past `maxNativeZoom` up
  to `maxZoom`, so users can zoom in further than any single provider's
  native tiles without hitting blank tiles.
- **No `detectRetina`** — added to every tile layer's options so phones
  with high-DPI screens (i.e., most of this app's actual usage) request
  `@2x` tiles from CARTO/OSM where available instead of upscaled low-res
  ones. (Deliberately did *not* add `crossOrigin: true` — tiles don't need
  it for plain `<img>` display, and turning it on risks the exact
  blank-tile failure mode below if a provider doesn't send CORS headers.)
- **Wrong attribution for satellite/voyager** — the attribution control
  was hardcoded to `"© OSM"` regardless of active style, which is simply
  wrong (and a ToS problem) for Esri/CARTO tiles. Attribution is now
  per-style and swapped correctly on every style change via a shared
  `buildTileLayer()` helper.
- **No resilience against a provider going down/rate-limiting** — these
  are free, keyless, no-SLA tile services; if one blocks/rate-limits the
  app there was previously no fallback, just blank grey tiles. Voyager
  (the only style with a natural substitute) now has a `fallbackUrl`
  (OSM street tiles) and a `tileerror` listener that swaps to it once
  per style-activation and logs `DS-MAP-003` (new registry entry) via the
  existing error manager. Also fixed a subtlety in the fallback itself:
  the fallback URL uses OSM's subdomain scheme, not voyager's — swapping
  URL without also correcting `layer.options.subdomains` would have made
  ~1/4 of the fallback's own tile requests 404.
- Street and satellite don't have a natural substitute provider, so they
  log `DS-MAP-003` on repeated tile failure without a URL swap (no false
  "fixed" claim when there isn't actually a fallback source available).

Not touched, deliberately: the `fitBounds`/`setView` zoom caps used for
auto-recenter (15/16) are UX choices about how close to zoom when
fitting both partners on screen, not the tile-quality/zoom-ceiling issue
above — left as-is.

**Not verified in this session — same sandbox limitation as above** (no
network egress, so the actual tile URLs/attribution requirements were
confirmed from Esri/CARTO/OSM documentation knowledge, not a live
request). Load the map on all three styles on a real device/network and
confirm satellite/voyager tiles actually render past z19/z20 with
upscaling before considering this closed.

## Music: notification only showed for Audius tracks, not YouTube (2026-09-04)

**Symptom:** "no song notification" — no Spotify-style lock-screen/
notification media controls, Bluetooth play/pause/next/previous silently
doing nothing, for most real listening sessions.

**Root cause:** `navigator.mediaSession` (metadata/playbackState/
setPositionState/action handlers) was only ever wired inside
`native-plugins/audio-engine/src/web.ts`, scoped to the native audio
engine's own `<audio>` element — i.e. Audius tracks only. YouTube tracks
(played through the separate hidden IFrame, and the default/"All Music"
search provider, so most actual plays) got no OS-level notification at
all. This was a real gap, not a misunderstanding of the architecture —
see `docs/MUSIC_NATIVE_PLAYBACK.md`'s YouTube/Audius boundary table,
which was accurate about *audio extraction* but didn't extend to
notification/remote-control metadata, which doesn't require touching
YouTube's audio at all.

**Fix:** `GroicContext` is now the single owner of `navigator.mediaSession`
for the whole app; it already knows which engine is live for `current`
(`isNativelyStreamable()`) and already has `play()`/`pause()`/`next()`/
`prev()`/`seek()` (added explicit `play()`/`pause()` — `toggle()` used to
be the only entry point, which is wrong for a MediaSession "play" or
"pause" action specifically since those are one-directional commands, not
toggles) that branch correctly per provider. `web.ts`'s own
metadata/action-handler wiring was removed (kept `playbackState`/
`setPositionState` sync with its own element, which is harmless) so the
two don't race to set the same global. Full detail, including per-platform
reality (what's genuinely fixed vs. still WebView/WebKit-constrained), is
in `docs/MUSIC_NATIVE_PLAYBACK.md`'s new "Lock-screen / notification media
controls" section — read that before touching this again.

**Not touched:** the native Android (`MediaPlaybackService.kt`) and iOS
(`AudioEnginePlugin.swift`) implementations — already correct for the
Audius/native-engine path (real MediaSessionService/MPNowPlayingInfoCenter
notifications, already handling Bluetooth/lock-screen commands via the
platform's own standard MediaSession plumbing). This session's fix is
entirely in the JS orchestration layer (`GroicContext.tsx` +
`native-plugins/audio-engine/src/web.ts`).

## Blank-screen-on-boot fix (missing Supabase env vars)

`src/integrations/supabase/client.ts` called `createClient(SUPABASE_URL,
SUPABASE_PUBLISHABLE_KEY, ...)` directly with values read from
`import.meta.env`, with no guard. If those env vars aren't set at build
time (a fresh clone run without `.env.local`, or a host — Vercel/Netlify/
Cloudflare Pages — with the build env vars not yet configured; Lovable's
own hosting injects them automatically, so this only surfaces off-
platform), `createClient()` throws synchronously ("supabaseUrl is
required."). That throw happens while `client.ts` is being evaluated as
part of the static import graph (`main.tsx` -> `App.tsx` -> `client.ts`) —
before `main.tsx`'s own top-level code (the `createRoot(...).render(...)`
call) ever runs. An import-time throw is not a render-time error, so
`<ErrorBoundary>` never gets a chance to catch it either. Net effect: a
totally blank page with nothing but a console error, on any deploy that
hasn't had its Supabase env vars configured.

**Fix:** `client.ts` now falls back to harmless placeholder URL/key values
so `createClient()` never throws at import time, and exports
`isSupabaseConfigured` (true only when both real env vars are present).
`main.tsx` checks this before rendering `<App/>` — if unconfigured, it
renders a plain, dependency-free `ConfigError` screen (inline styles, no
app CSS/component tree) explaining exactly which env vars are missing and
where to set them, instead of silently booting an app that can't reach a
backend. `App.tsx` and everything downstream is untouched.

**Not verified in this session** — no `node_modules`/network in this
sandbox, so `npm run build`/`tsc` were not actually run; reviewed by hand
for correctness (both files' full contents re-read after editing).

## Follow-up: hardcoded default credentials instead of relying on env vars

The env-var-based fix above still required VITE_SUPABASE_URL/
VITE_SUPABASE_PUBLISHABLE_KEY to be set *somewhere* — Lovable does this
automatically, but local dev needs a `.env` Vite reads at startup, and
Vercel/Netlify/Cloudflare need it set in that host's dashboard before a
build. Three different platforms, three different setup steps for the same
two values, and missing it on any one of them reproduces the original
blank screen.

Since the anon/publishable key is meant to be public in a client bundle by
design (RLS is what actually protects data), `client.ts` now hardcodes the
real project's URL and publishable key as defaults
(`DEFAULT_SUPABASE_URL` / `DEFAULT_SUPABASE_PUBLISHABLE_KEY`, project ref
`jzlpelxwzjjpddqcrtpu`), falling back to `import.meta.env` only as an
override if someone deliberately points a build at a different project
later. This makes the app work out of the box on Lovable, Vercel, and
local with zero platform-specific env var setup. Values were pulled live
via the connected Supabase MCP tool (`get_project_url` /
`get_publishable_keys`), not guessed.

## Map: CARTO Voyager tiles broken by CARTO's own Aug 2026 policy change (2026-09-05)

**Symptom:** the map (specifically the "Voyager" style, one of the three
in the style-cycle button) showed a literal "API KEY REQUIRED" watermark
instead of a map.

**Root cause — not a bug introduced by anything in this repo:** CARTO
began requiring an API key on its free raster basemap endpoint
(`basemaps.cartocdn.com`) on 28 Aug 2026, and states in its own FAQ
(docs.carto.com/faqs/carto-basemaps) that these raster basemaps "are
being retired." Unkeyed requests don't fail/404 — they return a normal
`200 OK` PNG with the "API KEY REQUIRED" text watermarked into the tile
image itself. That's exactly why the `tileerror`-based fallback added in
the "Map tile-provider hardening" session above never triggered: Leaflet
saw a perfectly valid image load, so from its perspective nothing failed.

**Fix:** stopped depending on CARTO's raster tiles entirely (they're
being sunset regardless of any workaround) — `MAP_TILES.voyager` now
points at the same OpenStreetMap standard tiles as `street` (zero
signup, not going away). Since that would otherwise make "Voyager" and
"Street" pixel-identical in the style-cycle button, `buildTileLayer()`
now also applies a pure-CSS warm/pastel filter
(`sepia(0.35) saturate(1.35) hue-rotate(-6deg) brightness(1.03)`) to
Leaflet's own `tilePane` when `voyager` is active — no second tile
provider, no key, no account, and it can't drift out of sync with the
tiles the way a whole separate provider integration could.

**Left as an open choice for the user, not resolved unilaterally:**
CARTO's actual Voyager cartography could be restored by getting a free
key (no account needed, ~1 minute) at carto.com/basemaps/apikey and
appending `?key=...` to the original `basemaps.cartocdn.com` URL — didn't
do this because obtaining that key requires the user's own interactive
step, not something fetchable headlessly. The user also floated a full
Google Maps JS SDK integration as an alternative for a nicer/distinct
third style — flagged but not implemented: it isn't a drop-in tile-URL
swap (Google's ToS doesn't allow bare XYZ tile scraping the way
OSM/CARTO/Esri do), it would mean replacing Leaflet's `L.*` API used
throughout this ~1000-line file with Google's own Map/Marker/Polyline
API (markers, the partner-distance line, `fitBounds`, fullscreen
handling — all of it), and it requires the user's own billing-enabled
Google Cloud project + a properly restricted key, with real ongoing
usage-based cost exposure unlike every other provider this app uses. Pick
this back up only if the user explicitly wants that trade — don't
default into it.
