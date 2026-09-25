## 2026-09-24 — /important and /urgent alerts: distinct long ringtones + haptics that get through silent mode and Do Not Disturb

**Symptom:** `/urgent` and `/important` messages "still send like a normal message".

**Root causes (all four were real):**
1. **Live DB trigger regressed.** Live `notify_push_on_message()` was the 20260824 definition — no `important`, no `urgent` in the send-push payload, and `'preview', NEW.content` (E2E ciphertext in push bodies) restored. That migration had been applied on the live project *after* 20260921120000, overwriting it (`CREATE OR REPLACE FUNCTION` migrations clobber each other when applied out of file order). Fixed by `20260924100000_message_push_alert_levels.sql` (also applied live): carries every prior change + `important = important OR urgent` + `urgent`. **Any future edit to this function must be a later-dated migration starting from that body.**
2. No urgent tier: both flags shared one channel and one short sound.
3. Android ignores an app's own `setBypassDnd(true)` (only the person's per-channel "Override Do Not Disturb" counts) and mutes notification sound/vibration on a silent ringer — no channel setting can make a plain notification ring through silent/DND.
4. With the chat open the server skips the push (`recipient_viewing_chat`), and the realtime insert only played the plain ping.

**Fix:**
- `_shared/messageAlert.ts` (new, testable): tier resolution, per-tier channel (`duospace_alert_{important,urgent}_v2`), title (`⚡ Important · X` / `🚨 URGENT · X`), `data.alertLevel`, iOS sound + interruption level. `fcm.ts`/`pushTypes.ts` use it; `urgent` added to the request type.
- Android `MessageAlertService.kt` (new foreground service, `mediaPlayback`): rings a looped tier sound on the **alarm stream** (independent of ringer mode; DND priority mode lets alarms through), vibrates with **alarm audio attributes** (not gated by ringer mode), raises alarm volume while ringing and restores it, and — only if the person granted Do Not Disturb access — lifts the interruption filter for the alert and restores it (persisted, so a killed process still restores). important: 3 bells + 3×700 ms pulses, ≤20 s; urgent: siren + beeps + 2×1500 ms heavy pulses, ≤60 s. Stops on Stop/notification tap/swipe/app resume/timeout. Pushes older than 10 min are shown as normal messages. If the OS refuses the service start, falls back to the audible `_v2` alert channel (never silent). Old `duospace_urgent_message` channel deleted.
- Bridge plugin: `stopMessageAlert`, `previewMessageAlert`, `getMessageAlertStatus`, `openDndAccessSettings` (Android only). `useAppNative` stops a ringing alert when the app becomes active.
- In-app: `lib/messageAlert.ts` + `useChatRealtimeMessages` play the tier sound + long haptic pattern for flagged messages while the chat is open (first tap silences).
- Settings → Notifications: "Important & urgent alerts" card with real-service **Test** buttons, ringer/DND status, and a button for Do Not Disturb access.
- Assets: `alert_{important,urgent}` as m4a/ogg/caf (`scripts/generate-alert-sounds.py`; iOS files ~21 s / 27 s, under Apple's 30 s cap). Manifest/permission (`ACCESS_NOTIFICATION_POLICY`)/file-copy wired in `scripts/patch-native-permissions.mjs` (three-way merged with the CallActionReceiver registration).
- Tests: `src/test/messageAlert.test.ts` (tier logic, payloads, Kotlin↔client vibration patterns, channel ids, assets, migration); catalog test allows the two alert assets.

**Honest limits:** Android "Total silence" / DND with Alarms off still blocks alarm audio unless DND access is granted; the system "alarm vibration" setting can suppress vibration; a force-stopped app receives nothing. iOS: Time Sensitive breaks through Focus but cannot override the silent switch — that needs Apple's Critical Alerts entitlement (server side ready behind `IOS_CRITICAL_ALERTS=true`, do not enable before the entitlement is in the provisioning profile). Kotlin was proofread, not compiled, and nothing has run on a device yet.

**Live changes made this session (project jzlpelxwzjjpddqcrtpu):** migration `message_push_alert_levels` applied; `send-push` redeployed (v14) from this tree, including the call-decline token minting.

## 2026-09-23 (b) — Merged: Mood Detection "always Surprised" fix + Peek Guard auto-unlock

Merged incoming work (`duospace-merged.zip`), built on this session's
Phase 2A output — 7 files, entirely orthogonal to Phase 2A, no
overlap: `lib/moodScoring.ts` gains `sessionBrowBaseline()` (mood
detection previously compared raw browRaise against a fixed 0.15
constant that most people's RESTING eyebrow position already clears,
so "Surprised" fired on nearly every frame at its ×20 weight — now
normalized per-session against the face's own resting position),
wired into both `MoodDetector.tsx` and
`useBackgroundMoodDetection.ts`. Peek Guard gains real auto-unlock
(`usePeekDetection.ts`/`PeekGuard.tsx`/`ThemeContext.tsx`
`peekAutoUnlockOnOwner`/`peekAutoUnlockConsistencyFrames`/
`peekAutoUnlockDelay`, default on): the lock now clears itself the
instant the owner alone is confidently recognized back in frame, no
tap or OS biometric prompt required, with manual dismiss as the
fallback path when that can't confirm. Defaults tightened
(`peekConsistencyFrames` 3→1, `peekLockDelay` 150ms→30ms) for a
faster true-instant lock. `PeekConfigDialog.tsx` exposes the new
sliders. Verified by diff review only — see this session's merge
history; not independently re-verified against a device.

## 2026-09-23 — Phase 2A: Relationship Intelligence V1 (Values, Expectations, Communication Reflection)

First real relationship-AI capability, scoped to the Phase 2A brief.
New `src/lib/relationship/` domain: 30-question Values questionnaire
across all 15 categories, Expectations (preference/expectation/boundary
— boundary only ever user-confirmed, never AI-set), Communication
Reflection (5 prompts, opt-in local retention), a local-only rule-based
`RelationshipAIProvider` behind a provider-neutral interface + registry,
and the full USER INPUT -> LOCAL VALIDATION -> PRIVACY GATE -> AI
PROCESSOR -> SAFETY VALIDATOR -> ENCRYPTED LOCAL STORAGE -> DISPLAY
pipeline. Safety validator (`outputValidator.ts`) extended with
relationship-specific structural rules (user-attributed observations,
hedged explanations, required evidence, non-imperative suggested
actions) and ~15 new prohibited-claim pattern groups (cheating/
attraction, abuse, diagnostic labels, toxicity, relationship-failure,
breakup-necessity, partner-guilt, partner-mental-state, deception,
partner-disrespect verdicts) plus a hard block on any numeric/ratio/
"compatibility" score — no relationship score exists anywhere in this
feature. `FEATURE_CAPABILITIES` flips `AI_PROCESSING`,
`RELATIONSHIP_INSIGHTS`, `SHARED_INSIGHTS` on (only these three; every
other capability stays frozen per `.ai/DO_NOT_BUILD.md`). New explicit,
per-item partner sharing (`sharing.ts`): preview -> hash-bound confirm
-> new `relationship_shares` table (RLS'd, immutable except revoke,
auto-revoked on unlink via `apply_unlink`). New `/reflection` page
(Values/Expectations/Reflect/Insights tabs), reached only from the
existing Hub — no app-shell or nav change. Full report:
`docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md`.
NOT VERIFIED at runtime (standing sandbox limitation, every phase) —
verified via isolated `tsc --noEmit` (stubbed external packages) across
every file this phase touched, which is clean.

## 2026-09-22 (later) — Fix: sent love letters didn't reliably appear in chat

Root cause: `handleSendLoveLetter` in `Chat.tsx` was the one remaining send
path with **no optimistic local echo** — it closed the dialog and inserted
straight into `messages` via a bare `supabase.from("messages").insert(...)`,
with zero local state update. Every other send path (`handleSend` for text,
`attemptSendMedia`) shows a `pending-…` bubble the instant Send is tapped and
only relies on the realtime channel to *reconcile* it afterward; letters had
no bubble at all, so they were entirely dependent on the `postgres_changes`
INSERT event round-tripping back to the sender's own client. Any latency, or
a missed/delayed event, meant the letter had actually sent (row was in the
table) but visibly appeared to do nothing.

Fix: `handleSendLoveLetter` now follows the exact same pattern as
`handleSend` — an optimistic `message_type:"letter"` bubble (`_sendStatus:
"sending"`) is added to `messages` immediately, the insert now goes through
the shared `insertMessageIdempotent` (same `client_message_id` scheme
`useChatRealtimeMessages`'s dedup already understands), and the bubble is
swapped for the canonical row in place on success or marked `"failed"` (using
the same generic `MessageStatus`/`isFailed` UI every other bubble type
already has) on any failure — instead of the letter silently vanishing with
only a toast. NOT verified against a live Supabase project in this sandbox
(no network) — reviewed by hand against `attemptSendText`'s established
pattern; parses clean under `typescript`'s own parser (no bundler/vitest
available here to run a full build).

## 2026-09-22 — Love Letter: real envelope open/close animation

New `components/chat/Envelope.tsx` (shared, controlled: flapOpen /
letterLift / showSeal props — a 3D-flap pocket envelope with a wax seal,
used by both surfaces below) and `components/chat/LetterReader.tsx` (tap a
letter bubble → envelope appears sealed → seal breaks, flap opens, letter
slides out → expands into a full readable letter card; closing reverses the
same sequence before unmounting). `LoveLetter.tsx` composer now plays the
same envelope shut/sealed on Send before the message actually goes out.
Both respect `prefers-reduced-motion` (snap straight to end state).

New `lib/letter.ts`: single source of truth for the `💌 **subject**\n\nbody`
wire format (`buildLetterContent` / `parseLetterContent`), replacing the
inline template literal in `Chat.tsx` and the manual `split("\n")` render in
`MessageBubble.tsx`. Wire format on the wire (and in the DB / encryption) is
unchanged, so existing letters still parse and render correctly. New
`src/test/letter.test.ts` covers round-tripping and the old composer's
literal default-subject string.
NOT verified: no npm/build/vitest run in this sandbox (no network access to
install dependencies) — reviewed by hand (brace/paren balance, prop
threading) instead. Run `npm run verify:lock && npm run build` and
`npm test` before shipping.

## 2026-09-21 (later still) — Gallery, Us (+Memories), Shayari offline

New `lib/localDb/collectionStore.ts` + `idbCollectionBackend.ts`, `lib/screenCache.ts`;
`screenData` switch added to Offline & storage; `gallery` and `memories` buckets
now local-first in `signedStorageUrl.ts`. Fixed empty-on-error in Gallery/albums,
0-streak-on-error in Us, favourite flip on failure in Shayari. Data classification:
per-screen snapshots (COUPLE / PRIVATE) now stored encrypted on-device.

## 2026-09-21 (later) — Settings offline pass

Sign-out no longer depends on the network for identity and no longer wipes before
the session is gone; Settings hub / Profile / Partner screens no longer read a
failed load as "not linked"; server-only actions guarded with `requireOnline`;
couple-theme share deferred until online; new "Offline & storage" card
(Data & Backup). New: `lib/settingsCache.ts`, `lib/offlineGuard.ts`,
`lib/offlineSettings.ts`, `components/settings/OfflineStorageCard.tsx`. Merged
onto the v3.11.1 snapshot (notification-sound sync kept as the user's version).

## 2026-09-21 — Vanish Mode: unseen messages survive, media really deleted

Root causes: (1) `Chat.tsx` fetchMessages filtered rows with
`new Date(disappear_at) > now`; for the sentinel `"vanish"` that is an Invalid
Date, so every vanish message was dropped from every fetch (anyone not in the
chat with a live realtime socket never saw it); (2) turning Vanish Mode off
hard-deleted every vanish row in both directions, seen or not; (3) media files
were never removed from storage (storage RLS only lets an uploader delete their
own files) and were also cached on-device by `mediaCache.ts`.

Changes: new sentinel `vanish_after_seen` (unseen messages are kept, deleted
once read + chat left); `lib/vanishPlan.ts` (pure rules, tested in
`src/test/vanishPlan.test.ts`), `lib/vanishPurge.ts` (server call + client
fallback), `lib/vanishMedia.ts`; `mediaCache.ts` ephemeral registry +
`deleteLocalMedia`; DELETE handler in `useChatRealtimeMessages.ts` wipes local
media; vanish messages only marked read while the page is visible; cloud backup
skips vanish rows. New edge function `purge-vanish-messages` and migration
`20260921120000_vanish_after_seen.sql` (sweep now CASE-guards the timestamptz
cast). Deploy the migration and the function before shipping the client.
NOT verified: no build / vitest / device / live-DB run in the authoring sandbox
(only the pure planner was executed).

## 2026-09-21 — Notification sounds: selection fixed, applied everywhere, 16 new sounds (v3.11.0 → 3.11.1)

See `docs/NOTIFICATION_SOUNDS.md` (root causes, changes, deploy order, what is
NOT verified). Local-first pref store + sync hook, picker rewrite (never locked),
chosen sounds now played in-app (chat ping, incoming-call ring), 12+12 catalog
with 16 new synthesized sounds in 3 formats, migration relaxing the id CHECKs to
a shape check, Android silent call-visual channel + non-alerting group summary,
`isIncomingRinging` plugin method, parity test `notificationSoundCatalog.test.ts`.
Apply the migration before shipping the client.

## 2026-09-21 — Offline-first launch, message store, media cache, outbox

See `docs/OFFLINE_FIRST.md` (root causes, changes, privacy trade-offs, what is
NOT verified). New: `lib/connectivity.ts`, `lib/persistedSession.ts`,
`lib/mediaCache.ts`, `lib/localDb/*`; rewritten `lib/chatCache.ts`; changed
`AuthContext`, `useE2E`, `useSessionGuard`, `useCallHistory`, `Chat.tsx`,
`signedStorageUrl.ts`, `client.ts` (offline fast-fail + REST read timeout),
`secureStorage.ts` (exported, memoised master key), sign-out/unlink wipes.
Data classification updated (history + media now on-device).

## 2026-09-16 — Stabilization pass (partial, scoped)

Ran against the uploaded snapshot (`Helllloo-updated.zip`), no network/DB/
device access available in this sandbox.

### Done

- Full repository inventory (667 files) and mtime-based delta against the
  prior baseline snapshot, to identify what had changed since the last
  stabilization pass without inventing history.
- Read `docs/PHASE_PRE_IMPLEMENTATION_STABILIZATION_FINAL_REPORT.md` and
  `docs/PHASE_4_SECURITY_AUDIT.md` (most recently modified audit docs)
  in full before writing anything new, to avoid contradicting or
  duplicating already-honest prior findings.
- Attempted `npm ci` — confirmed BLOCKED BY ENVIRONMENT (403 from the
  package registry; no network egress in this sandbox).
- Heuristic secrets scan (`src/`, `supabase/`, `native-plugins/`): no
  hardcoded API keys/passwords/tokens found. Confirmed the one
  `service_role` string match is a comment, not a leaked value.
- Checked `dangerouslySetInnerHTML`/`eval` usage: one instance, shadcn's
  `chart.tsx`, CSS-variable injection only — not an issue.
- Created `.ai/` (did not exist in any prior snapshot despite being
  referenced by `README.md` and the prior final report) with
  `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `NEXT_PHASE.md`,
  `IMPLEMENTATION_RULES.md`, `DO_NOT_CHANGE.md`, `NATIVE_PROJECTS.md`,
  this file.
- Fixed one of the explicitly-still-open findings from
  `docs/PHASE_4_SECURITY_AUDIT.md` (P1-3's secondary note): invite-link
  code generation in `src/pages/settings/PartnerSettings.tsx` switched
  from `Math.random().toString(36)` to `crypto.getRandomValues` over a
  32-symbol unambiguous alphabet (~40 bits of entropy per 8-char code).
  Code change only — no migration needed, `invite_links.code` was already
  a plain text column. NOT TESTABLE live (no DB access), reviewed by hand
  against the one call site.

### Explicitly not done this pass (see `.ai/NEXT_PHASE.md` for the queue)

- `partner_requests` UPDATE policy `WITH CHECK` gap — needs a trigger
  (same pattern as `call_history_transition_guard`), left for a session
  with the ability to test it, since it's schema-level and this pass
  didn't have DB access to verify a trigger's behavior.
- Attachments/backups MIME allowlist, Realtime channel audit, full
  edge-function audit, push-token RLS review, exhaustive docs-vs-source
  discrepancy matrix (50 files in `docs/`, only spot-checked).
- No build/lint/typecheck/test run (BLOCKED BY ENVIRONMENT, see above).
- No live Supabase or real-device verification of anything, this pass or
  any prior one recorded in this repo.

### Production readiness

Unchanged from the prior pass's own verdict: **NOT READY**. This pass
closed one small, low-severity, previously-flagged gap and added the
missing `.ai/` context layer; it did not change the security posture
enough to revisit that verdict, and did not re-run enough of the checklist
to justify doing so either way.

## 2026-09-16 — Scientific + Product Specification phase

Ran against the same snapshot as the stabilization pass above, same
sandbox (no network for code/build, but web search available for
research this time).

### Done

- Researched and cited real scientific literature for the core
  relationship-science, deception-detection, and emotion-recognition
  claims this phase depends on (Reis et al. on perceived partner
  responsiveness; Gottman's Four Horsemen, including the contested
  "90%+ divorce prediction accuracy" statistic; Bond & DePaulo 2006 on
  human lie-detection accuracy (~54%, near chance); Barrett et al. 2019
  on the unreliability of facial-expression-to-emotion inference; Finkel
  et al. 2012 on the lack of evidence for compatibility-matching
  algorithms, with the nuance that DuoSpace's already-paired-couple case
  differs from that critique's target but doesn't escape its deeper
  lesson).
- Researched EU AI Act Article 5(1)(f) (emotion recognition), GDPR
  biometric special-category treatment, India's DPDP Act 2023 + 2025
  Rules, and Kyrgyzstan's Law on Personal Data — flagged Kyrgyzstan as
  the weakest-covered jurisdiction and recommended local counsel there
  specifically. All regulatory content marked explicitly as not legal
  advice.
- Wrote `docs/DUOSPACE_SCIENTIFIC_PRODUCT_SPECIFICATION_FINAL_REPORT.md`
  and 19 new `.ai/*.md` spec files (scientific foundation, relationship
  science, compatibility/values/expectations/conflict-repair/trust/mood
  specs, multimodal AI spec, local AI architecture, AI output contract,
  consent model, relationship memory spec, relationship health spec,
  DuoAutoAnswer spec, calling latency spec, competitive analysis,
  regulatory review, future roadmap, do-not-build list).
- Updated `.ai/NEXT_PHASE.md` to point at Phase B (data/consent
  architecture), gated on closing the still-open security queue from the
  prior pass first.
- No code was changed. No frozen feature was implemented.

### Explicitly not done this pass

- No real-numbers calling-latency measurement (needs a live build/device,
  see `.ai/CALLING_LATENCY_SPEC.md`).
- No exhaustive per-dimension field definitions for every compatibility/
  values/expectations dimension — the structure and rules are specified,
  individual dimension write-ups are left for Phase F.
- No re-audit of existing mood/lip-reading/face-detection code
  (`MoodDetector`, `useLipReading`, `PeekGuard`, etc.) against the new
  specs — flagged as a to-do in `.ai/MOOD_SPEC.md` and
  `.ai/LOCAL_AI_ARCHITECTURE.md` rather than assumed compliant.
- No user research, no A/B data, no IRB-reviewed study — this is a
  literature synthesis and product specification, not primary research.

## 2026-09-16 — Security queue item 1: partner_requests transition guard

Closed the first item on the security queue blocking Phase B
(`.ai/NEXT_PHASE.md`).

### Done

- Added a `BEFORE UPDATE` trigger on `partner_requests`
  (`supabase/migrations/20260916120000_partner_requests_transition_guard.sql`)
  freezing `sender_id`/`receiver_id` and restricting UPDATEs to the one
  real `pending → accepted` transition — same pattern as the existing
  `call_history_transition_guard`.
- While tracing the exploit this closes, found `accept_partner_request`
  was also missing the already-partnered guard its sibling
  `accept_invite` has — fixed in the same migration (same function,
  same exploit chain).
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (table row + Remaining Risks
  list + new §15 addendum) and `.ai/CURRENT_STATE.md` to reflect the fix
  rather than leaving stale "flagged, not fixed" language in place.
- Removed the item from `.ai/NEXT_PHASE.md`'s blocking queue.

### Not done

- Live/DB verification (still no DB access in this sandbox — same
  BLOCKED BY ENVIRONMENT as every prior pass). Verified by hand against
  every `partner_requests` call site instead.
- The rest of the security queue (MIME allowlist, Realtime auth audit,
  full edge-function audit, push-token RLS, docs-vs-source matrix) —
  next up, per `.ai/NEXT_PHASE.md`.

## 2026-09-16 — Security queue item 2: finalize-upload bucket allowlist (found a bigger bug than expected)

Set out to do the queued "MIME allowlist for attachments/backups" task
and found the allowlist itself was wrong in a way that mattered much more.

### Done

- Discovered `finalize-upload`'s bucket allowlist (`avatars`/`attachments`/
  `backups`, added 2026-09-10) doesn't match the buckets the app's real
  upload code uses. The only two callers of `resumableUpload()` anywhere
  in `src/` (`Chat.tsx`, `Gallery.tsx`) pass `"chat-files"` / `"gallery"`
  — neither bucket was in the allowlist, so every chat attachment and
  gallery upload would be rejected at finalize with `Unknown bucket`.
  There's no size-based bypass; every upload goes through this path.
- Fixed `supabase/functions/finalize-upload/index.ts`'s `ALLOWED_BUCKETS`
  to include the real buckets: `chat-files` (50MB, matching `Chat.tsx`'s
  own existing client-side cap) and `gallery` (500MB — a judgment-call
  ceiling, flagged as such; no client-side cap exists to match against).
  Kept the original `avatars`/`attachments`/`backups` entries rather than
  deleting them (no dependency analysis done on whether anything else
  relies on them).
- Added a MIME allowlist for `gallery` (`image/`, `video/` — matches its
  file-picker's own `accept` attribute). Deliberately left `chat-files`
  unrestricted — its file picker has no `accept` attribute at all by
  product design (users can send any file type).
- Fixed the MIME-check logic itself: it compared by exact string equality
  despite the field being named `allowedMimePrefixes` — switched to real
  `startsWith` prefix matching (kept `avatars`' list as exact strings,
  which still works correctly under prefix matching).
- Flagged `scripts/sql/storage_buckets.sql` as stale in its own header
  (it describes a bucket set that doesn't match reality) rather than
  deleting it.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (P1-6 entry + new §16
  addendum), `.ai/CURRENT_STATE.md`, and `.ai/NEXT_PHASE.md`.

### Not done

- Live/Storage verification — no DB or Storage access in this sandbox,
  same as every prior pass. The 500MB gallery ceiling and the "no MIME
  restriction on chat-files" choice are both judgment calls grounded in
  what the client code actually does, not confirmed against a live
  upload.
- Did not investigate whether `attachments` is used anywhere outside
  `src/` (edge functions, native plugins) before leaving it in the
  allowlist — flagged, not resolved.

## 2026-09-16 — Security queue: Realtime channel authorization

Closed the next queue item. Started from a snapshot missing the
scientific-spec `.ai/` files and final report (noted at the top of
`.ai/NEXT_PHASE.md` — same "session got the narrative but not all the
artifacts" pattern documented in `docs/PHASE_4_SECURITY_AUDIT.md` §17,
this time affecting the scientific-spec phase's output instead of the
partner_requests migration).

### Done

- Found: broadcast/presence Realtime channels (unlike postgres_changes
  channels, which are RLS-gated automatically) had no server-side
  authorization at all — this project never configured Realtime
  Authorization (RLS on `realtime.messages` + `private: true`), so every
  broadcast/presence channel was fully public by default.
- Three channels (`typing-<pair>`, `presence-<pair>`,
  `groic:<uid1>:<uid2>`) embed both partners' UUIDs in the topic name —
  exploitable by anyone who already knows both IDs, which includes an
  **ex-partner indefinitely** (UUIDs don't rotate on unlink) — a real
  surveillance-adjacent risk specific to this product.
- `blend-sync` was worse: one single, unscoped, global channel name for
  every active blend session app-wide — any authenticated client could
  observe or inject spoofed events into any other couple's session.
- Fixed via `supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql`
  (RLS on `realtime.messages`, keyed to the caller's *current*
  `partner_id` — not just any two UUIDs) plus client changes to
  `useChatTyping.ts`, `useChatPresence.ts`, `GroicContext.tsx` (x2
  channels), and `Playlist.tsx` — all four now use a colon-delimited
  `<prefix>:<uid1>:<uid2>` topic (unambiguous to parse, unlike the old
  hyphen-joined format) and `private: true`.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (§18 addendum + Remaining Risks
  line), `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`.

### Flagged, not done (can't be done from code)

- Disabling "Allow public access" under Supabase Realtime Settings — a
  dashboard-only project setting. The migration + client changes are
  inert without it. This is called out explicitly in §18 rather than
  left implicit — it's the one action item in this whole effort that
  needs Aradhya to do something outside of a code deploy.
- Live/Realtime verification — no DB or dashboard access in this sandbox.

## 2026-09-17 — Phase 1: Privacy, Consent & Local-First Intelligence Foundation

Full report: `docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md`.

### Done

- `src/lib/privacy/`: `dataClassification.ts` (7-tier enum + absolute
  deny rules), `consent.ts` (feature-specific consent, server-of-record,
  fail-closed, cached), `privacyGate.ts` (capability -> deny-rules ->
  consent -> destination pipeline), `redact.ts` (key-pattern + JWT-shape
  log redaction — wired into `telemetry.ts`'s `formatExtra()`, covering
  both the stored ring-buffer event and the dev-console echo, not left as
  an unused utility), `secureStorage.ts` (software AES-256-GCM local
  storage — explicitly documented as NOT hardware Keystore/Keychain-
  backed, see Known Issues).
- `src/lib/ai/`: `types.ts` (`AIInsight` contract), `outputValidator.ts`
  (structural + prohibited-phrase + per-source-confidence-ceiling
  validation), `localProcessor.ts` (`LocalAIProcessor` interface +
  `runLocalProcessor()` wrapper that runs the privacy gate and the
  validator automatically).
- `supabase/migrations/20260917100000_privacy_consent_ai_foundation.sql`:
  `user_consents` + `ai_insights` tables, 7 RLS policies, 3 triggers
  (`touch_user_consents_updated_at`, `enforce_ai_insight_consent` —
  DB-layer consent verification at insert time, `enforce_ai_insight_immutability`
  — only lifecycle/correction/sharing fields may change post-creation).
- `src/pages/settings/PrivacyAISettings.tsx` + routing in `App.tsx` +
  entry in `Settings.tsx`'s list — one new page, existing components/
  tokens only, no redesign.
- 4 new test suites: `outputValidator.test.ts`, `redact.test.ts`,
  `privacyGate.test.ts`, `secureStorageCrypto.test.ts`. Written and
  reasoned through carefully; NOT executable in this sandbox (`npm ci`
  still 403s — confirmed again this pass).
- Found and fixed two small real gaps while implementing this phase:
  `signOutAndClearPushTokens()` in `Settings.tsx` now also calls
  `clearConsentCache()` and `secureWipeAll(user.id)` — previously neither
  existed to call, but leaving them unwired once they did exist would
  have been its own small bug.
- Restored 13 `.ai/` files this phase directly needed
  (`DATA_CLASSIFICATION.md`, `CONSENT_MODEL.md`, `PRIVACY_MODEL.md`,
  `SECURITY_MODEL.md`, `ARCHITECTURE.md`, `AI_SAFETY_SPEC.md`,
  `LOCAL_AI_ARCHITECTURE.md`, `AI_OUTPUT_CONTRACT.md`,
  `RELATIONSHIP_MEMORY_SPEC.md`, `TEST_STATUS.md`, `KNOWN_ISSUES.md`,
  `DECISIONS.md`, `PHASE_STATUS.md`) after finding only 3 `.ai/` files
  existed in this phase's starting snapshot (`KNOWN_ISSUES.md` KI-01).

### Explicitly not done

- No relationship-AI feature — out of scope for this phase by design.
- Hardware-backed (Keystore/Keychain) secure storage — needs native
  development + a physical device, neither available here (KI-02).
- `secureStorage.ts`'s IndexedDB-dependent integration path untested —
  jsdom doesn't implement IndexedDB; the crypto primitive is tested
  directly instead, honestly scoped in the test file's own header (KI-03).
- Live verification of the new migration/triggers/RLS — no DB access.
- `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`,
  `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, and the 19 scientific-spec
  files were NOT recreated this pass (out of scope for this phase's own
  work, and expensive to re-derive from memory again) — flagged in
  `.ai/NEXT_PHASE.md` for Phase 2 to actually resolve at the source
  (fix the export pipeline) rather than paper over again.

## 2026-09-18 — Security queue: push-token / device-table RLS review

Closed the last remaining specifically-named item on the security queue.

### Done

- Reviewed `public.push_tokens` and `public.known_devices` in full.
  **Both clean — no fix needed.** Neither table grants `authenticated`
  clients INSERT or UPDATE at all (only SELECT/DELETE of their own
  rows), removing an entire class of potential bugs by design; the only
  write path for either is a SECURITY DEFINER trigger or an already-
  audited service-role edge function, both correctly scoped to the
  acting user's own `auth.uid()`.
- Noted one minor, low-priority observation (not fixed): `push_tokens`'
  `ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id` would
  reassign a token row's ownership if a different user ever submitted
  the same literal token value — but exploiting that requires already
  possessing another user's live device push token, a meaningfully
  higher bar than anything else found in this audit, and not something
  the database layer alone can fully close (no token-attestation
  mechanism FCM/APNs commonly exposes to app backends).
- Also spot-checked `_shared/fcm.ts`/`_shared/apns.ts` logging — tokens
  are already truncated before being logged, no raw-token leak found.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (§20 addendum),
  `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`. Also corrected a stale
  line in `.ai/CURRENT_STATE.md` that still listed the full
  edge-function audit as "remaining" despite it having been completed
  (§19) in an earlier session whose docs update didn't fully carry
  forward into that specific line.

### Remaining on the queue

Encryption lifecycle threat model, session/clock-skew handling, a
general telemetry review beyond Phase 1's client-side redaction pass,
TypeScript `any`/unsafe-cast audit, and the docs-vs-source discrepancy
matrix. Live/DB verification remains blocked in every sandbox this
project has run in.

## 2026-09-19 — Phase 1.5: Production Verification

Full report: `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md`.

### Done

- **New P0 found**: `package.json` declares `livekit-client: ^2.7.0`;
  `package-lock.json` has zero references to it anywhere — confirmed by
  direct grep and corroborated by `npm ci`'s own request order. Not
  hand-fixed (would mean fabricating lockfile entries, explicitly
  against this pass's own instruction) — documented with the exact real
  fix (`npm install`, run somewhere with registry access) instead.
- **New integration gap found**: re-checked the four pre-existing
  mood/face features against the Phase 1 privacy system for the first
  time (genuinely not done before) — none of them call
  `privacyGate`/`consent` at all, so the corresponding new settings
  toggles don't actually control them yet. Flagged, not fixed (needs its
  own careful pass, not a drive-by edit to shipped features).
- Restored 6 governance `.ai/` files from real prior-session content:
  `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`,
  `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, `FUTURE_ROADMAP.md`.
- TypeScript safety sampled (183 `any`/`as any` occurrences) — majority
  traced to one systemic, already-documented cause (broken generated
  Supabase types), judged JUSTIFIED as a class rather than exhaustively
  classified one-by-one; 3 redundant casts in `consent.ts` removed as a
  real, trivial fix; one low-severity, unrelated observation noted in
  `MinimizedCallBubble.tsx` (client-supplied call duration), not fixed.
- Confirmed `npm ci` still BLOCKED BY ENVIRONMENT (ran it again, same
  403 — this time on `livekit-client` specifically, which is itself
  informative, see the P0 finding above).
- Re-confirmed (hand-verification, not live testing) that Realtime
  authorization ties to current `partner_id`, the privacy gate's
  fail-closed behavior, and secure storage's honest non-hardware-backed
  documentation — all still accurate.
- Wrote `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md` with
  the full Production Readiness Matrix (A–G) and 20-question Final Gate,
  every answer backed by an explicit PASS/FAIL/BLOCKED/NOT VERIFIED
  status and, where relevant, the exact external verification procedure
  needed.
- Updated `.ai/CURRENT_STATE.md`, `.ai/PHASE_STATUS.md`,
  `.ai/KNOWN_ISSUES.md` (KI-07, KI-08, KI-09 added; KI-01 updated),
  `.ai/TEST_STATUS.md`, `.ai/NEXT_PHASE.md`.

### Explicitly not done

- No live build/lint/test/RLS-attack/device verification — same
  environment constraints as every prior pass, confirmed again rather
  than assumed.
- No calling-latency instrumentation or measurement — would need a live
  app.
- No chat-reliability live reconnect/retry testing.
- 19 scientific-spec files + their final report not restored (out of
  scope for this specific verification pass).
- No consent/insight export implementation (judged optional per the
  brief's own phrasing, deferred to Phase 2 or a dedicated pass).

### Final status

**NOT READY.** Closer in two concretely-documented ways than before this
pass; the standing blocker (nothing in this project has ever actually
been executed in any sandbox) is unchanged.

## 2026-09-19 — Launch-flow fixes + Chat/Calls skeletons

Scope: four user-reported issues on the APK. No network/`npm ci`/device
access in this sandbox — see "Not verified".

### Changed

- **"Location access required" flashing on launch** —
  `src/components/LocationAccessGate.tsx`. `useLiveLocation`'s permission
  state starts at `"unknown"` (async native check) and the gate treated
  anything but `"granted"` as blocked, so it rendered the full-screen
  requirement for the duration of that check even with permission already
  granted. `"unknown"` is now a distinct checking state that never shows the
  requirement screen: known-granted devices (flag `duo-location-permission-granted`,
  written only on a confirmed `granted`, cleared on confirmed `denied`/`prompt`)
  render the app immediately; first-ever launch shows a blank themed surface;
  a 4s timeout falls back to the normal gate. `denied`/`prompt` still hard-block —
  the mandatory-location decision is unchanged.
- **"Setting up..." on every launch** — `src/App.tsx` (`ProtectedRoutes`).
  The profile/onboarding check gated the whole app on a network round trip
  every launch. Confirmed onboarding is now remembered per user
  (`duo-onboarded-<userId>`); the check still runs in the background and
  overrides the cache if the server says otherwise. A request *error* is no
  longer read as "not onboarded" when the account is already known-onboarded.
- **Chat skeleton** — new `src/components/skeletons/MessageListSkeleton.tsx`
  replaces the "Loading messages…" text in `MessageTimeline.tsx`. Also
  `Chat.tsx`: a resolved "no partner linked" state now clears
  `messagesLoading` (it previously stayed true forever, which was invisible
  behind the text and would have been an endless skeleton).
- **Calls skeleton + instant paint** — new
  `src/components/skeletons/CallHistorySkeleton.tsx`; `Calls.tsx` gets
  `historyLoading` so "No calls yet" no longer flashes before data arrives.
  New `src/lib/callHistoryCache.ts` persists the last call list (metadata
  only, `room_name` dropped) via `secureStorage` (AES-GCM, per-user, removed
  by `secureWipeAll` on sign-out) and paints it immediately on launch while
  the normal fetch refreshes it.

### Deliberately NOT done

- Chat messages are still NOT persisted across launches. `Chat.tsx`'s
  `messageCache` is memory-only by design (decrypted E2E plaintext); this
  change does not alter that. Chat shows the skeleton on a cold launch.
- The ~0.3s branded hand-off `SplashScreen` (once per cold start) is
  unchanged.

### Not verified

- `npm run build`, `npm test`, lint and any on-device behavior were NOT run
  (no dependencies installable here). Edited files were only syntax-checked
  with the TypeScript transpiler. No new automated tests were added.

## 2026-09-19 (later) — Round 2: launch loading, "Setting up...", notifications

Input: `duospace-redesign-final-2-updated.zip` (round-1 fixes + a separate
edit to `MediaPlaybackService.kt`, left as-is). No `npm ci`/Android SDK/device
in this sandbox — see "Not verified".

### Why round 1 didn't fully work

- **"Setting up..." still shown**: the remembered flag only exists after one
  successful check on this install, so the first launch after updating, cleared
  WebView storage, or any launch where the profile request timed out (8s) still
  blocked. Fix (`src/App.tsx`): accounts older than 24h are treated as
  onboarded immediately; the background check still corrects it.
- **Visible "scrolling" load in Chat**: two causes. (1) `Chat.tsx`'s cold-start
  jump was marked done on call-history rows alone (they arrive before messages,
  which wait on E2E + decrypt), so the messages that followed got a *smooth*
  scroll. Now the first jump waits for `messagesLoading === false`, and every
  scroll within `SETTLE_WINDOW_MS` (2.5s) of it is instant. (2) Nothing was
  persisted, so every cold launch showed skeleton -> messages. Added
  `src/lib/chatCache.ts` (see below). Calls rows also lost their per-row
  stagger delay (`CallHistoryRow.tsx`).

### Chat cache — deliberate privacy exception (owner's request)

`src/lib/chatCache.ts` persists the latest 60 decrypted messages through
secureStorage (AES-GCM at rest, per-user key destroyed by `secureWipeAll` on
sign-out). Never persisted: any message with `disappear_at`, optimistic/failed
bubbles, local blob previews. `PERSIST_CHAT_CACHE = false` disables it entirely.
This is the first place decrypted E2E plaintext touches disk; the key lives in
IndexedDB on the same device (software AES, not hardware-backed — see
secureStorage.ts). Transport E2E is unchanged.

### Notifications

- **Location notification removed (Android)**: `DuoSpaceLocationService` no
  longer calls `startForeground()` (it was the always-on "DuoSpace" entry with
  no text, and re-appeared briefly on every push via ACTION_ONE_SHOT). Callers
  (`CallNotificationService`, `BackgroundGeolocationPlugin`) now use
  `startService`. Cost: background location is best-effort — see
  `docs/BACKGROUND_LOCATION_NATIVE.md`. The legacy channel is deleted on start.
- **Blank notifications**: `DuoSpaceMessagingService` no longer posts a
  notification when the push has no body.

### Not verified

- Kotlin was NOT compiled; nothing was run on a device. JS/TS was only
  syntax-checked. Build (`npm run build`), tests and lint were not run. No new
  tests added.
- `MediaPlaybackService.kt` still contains temporary diagnostic `Toast`s
  ("notification posted OK ...") from the uploaded snapshot; not touched.

## 2026-09-20 — E2E fix: messages undecryptable across platforms for the same account

User-reported bug, directly diagnosed and fixed (not part of an audit
pass).

### Root cause

`src/hooks/useE2E.ts`'s old `init()` generated a brand-new ECDH keypair
any time a device's local IndexedDB was empty, then unconditionally
overwrote the single `profiles.public_key` column with it. Every new
platform the same account was opened on (APK, website, a second browser)
minted its own keypair and silently invalidated every other already-
signed-in device's ability to decrypt — both going forward (partner
starts encrypting against the newest key) and retroactively (old
messages stay encrypted under whichever key was current when they were
sent).

### Fix

- `supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`:
  new `user_e2e_identity_keys` table, owner-only RLS, one row per
  account.
- `src/hooks/useE2E.ts`: new `resolveAccountIdentityKey()` — checks for
  an existing account-wide key first; if none, adopts this device's
  local key if it has one (or generates fresh if truly first-ever);
  registers it via a race-safe ignore-on-conflict upsert; always
  re-fetches to find the actual winner, even if it wasn't this device's
  candidate. `profiles.public_key` untouched (still partner-visible,
  now actually consistent across devices).
- `src/test/e2eAccountWideKey.test.ts`: 6 tests covering server-has-key /
  local-key-registers-and-wins / local-key-loses-a-race /
  truly-first-run / error propagation. Written, not executable in this
  sandbox (no `npm ci`).
- Updated `.ai/CURRENT_STATE.md`, `.ai/KNOWN_ISSUES.md` (KI-10: the
  accepted security trade-off — private key now syncs via Supabase,
  `service_role`-readable, no longer purely device-local; KI-11: one
  extra lightweight Supabase round-trip per app launch, low priority).

### Honest trade-off, stated directly to Aradhya as well as in the docs

Private keys used to never leave the device (stronger against a
compromised Supabase project). Making cross-device sync actually work
without new user-facing recovery-passphrase UX means giving that up —
`service_role` can now read the table. This was the pragmatic, correctly
-scoped fix for what was asked; a passphrase-wrapped stronger version is
possible later if wanted, flagged as a real option, not silently assumed
unwanted.

### Not done

- No retroactive recovery of messages already orphaned by pre-existing
  key mismatches across devices — not possible without a device's
  original local key material, which may no longer exist anywhere.
- No live testing (no DB access, as always).
- No local-first fast-path optimization for the new extra round-trip
  (KI-11).

## 2026-09-20 — Merge of duospace-redesign-final-3 + duospace-e2e-cross-platform-fix; Map "Location timed out" fix

### Merge

Compared the two uploaded snapshots file by file (`diff -r`, excluding
`node_modules`). `duospace-e2e-cross-platform-fix` is a strict superset of
`duospace-redesign-final-3`: every file is byte-identical except
`.ai/CHANGELOG.md`, `.ai/CURRENT_STATE.md`, `.ai/KNOWN_ISSUES.md`,
`src/hooks/useE2E.ts` (each of which only *adds* the E2E account-wide-key
work on top of the redesign version), plus two files that exist only in the
E2E snapshot (`src/test/e2eAccountWideKey.test.ts`,
`supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`).
The redesign snapshot contributes nothing the E2E snapshot lacks, so the
merged tree is the E2E snapshot as the base — no conflicts to resolve, no
hunks dropped. The location fix below is layered on top.

### Bug: Map screen showed "Location Access Required / Location timed out. / Request Permission"

Three separate problems combined:

1. **Wrong screen for a non-permission error.** `MapView.tsx` showed its
   blocking permission screen whenever `locationError` was *any* string —
   including a plain GPS timeout on a device where permission was already
   granted. `Request Permission` cannot fix a timeout.
2. **The button was a no-op on web.** `useLiveLocation.retryPermission()`
   called `navigator.geolocation.getCurrentPosition(() => {}, () => {}, …)`
   — a successful fix was discarded and the error never cleared, so the
   screen stayed up forever.
3. **Timeouts were reported but never recovered from.** The 20s/30s
   per-fix budget is short for a cold GPS start indoors or desktop Wi-Fi
   positioning, and after a timeout nothing tried a cheaper position source
   or restarted a wedged watcher.

Also found: the native error normaliser mapped "Location services are not
enabled" (GPS toggle off) to a *timeout* — it only matched "unavailable"/
"disabled".

### Fix

- `src/lib/locationErrors.ts` (new, import-free): `LocationErrorKind`
  (`denied | unavailable | timeout`), `normalizeNativeGeoError`,
  `describeGeoError`. Unrecognised native messages fall back to `timeout`,
  never `denied`. "Services not enabled" now maps to `unavailable`.
- `src/hooks/useLiveLocation.ts`: exposes `errorKind`; timeouts never touch
  `permission`; HIGH/ECO timeouts raised to 30s/45s; new one-shot coarse
  `fallbackFix()` (fed through the normal `onPos` noise gates) fired on a
  timeout; after 3 consecutive timeouts the watcher is restarted in
  low-accuracy mode; `retryPermission()` now clears the stale error,
  restarts the watcher and takes a fallback fix on both platforms.
- `src/contexts/LocationContext.tsx`: exposes `myLocationErrorKind`.
- `src/pages/MapView.tsx`: the blocking "Location Access Required" screen
  now shows only for a real denial (`permission === "denied"` or
  `errorKind === "denied"`). While there is no fix yet, a timeout/unavailable
  shows the pulsing "Still looking for your location…" overlay with a
  **Try again** button (and a services-off hint). Once any fix exists, later
  timeouts no longer cover the map at all.
- `src/test/locationErrors.test.ts`: new.
- Unchanged on purpose: `LocationAccessGate` (mandatory-location product
  decision), the noise gates, write throttling, the offline queue, the
  background-geolocation layer.

### Verification status (honest)

- `locationErrors.ts` compiled under `tsc --strict` and its assertions were
  executed in plain Node: PASS (the vitest file itself was NOT run — no
  `npm ci` here).
- `useLiveLocation.ts` type-checked clean against minimal hand-written
  stubs for react/@capacitor/supabase; `MapView.tsx` and
  `LocationContext.tsx` were only syntax-checked. NOT a full project build.
- NOT VERIFIED on a device or browser: real timeout recovery, the fallback
  fix, the watcher restart, and the exact wording of native plugin errors
  ("services not enabled" matching is best-effort against the plugin's
  messages, not a documented contract).

## 2026-09-20 (later) — Blank "DuoSpace" notification hardening; location-on-push verification

### Blank notification on app open

Screenshot: a notification headed "DuoSpace" with no text. No code path in this
snapshot that runs at app launch posts one except the Media3 automatic
notification path, so the source could NOT be identified with certainty
without a device. Known historical source: the old `DuoSpaceLocationService`
foreground notification (already removed 2026-09-19; `LocationContext` starts
that service on every app open, which matches "every time I open the app" —
an APK built before that change would still show it).

Defense in depth, so the media services can never produce one:
- `MediaPlaybackService.onUpdateNotification()` is now a no-op. This service
  has always posted its own notification; nothing had actually disabled
  Media3's automatic one, which is built from player metadata (blank title =
  bare "DuoSpace").
- `WebKeepAliveService.onUpdateNotification()` holds back the automatic
  notification until JS has supplied a real track title (`MirrorPlayer`'s
  placeholder title is literally "DuoSpace").
To identify a persisting one: long-press it -> Notification settings shows the
channel name; or `adb shell dumpsys notification --noredact | grep -A25 com.duospace.app`.

### Location on message / call arrival

Traced end to end; findings are KI-12 (three gaps, none run on a device).
Code changes: `DuoSpaceLocationService.requestFixForPush()` (shared, 15s
debounce, skips "typing" pushes) now called from BOTH `CallNotificationService`
and `DuoSpaceMessagingService`. Previously only the former triggered a fix and
it fired for every push including typing indicators.

### Not verified
- Kotlin NOT compiled; nothing run on a device (same as every native change here).
- `onUpdateNotification` override signature written against Media3 1.4.1 from
  memory of its API — a compile error there is possible; both overrides are
  small and self-contained if they need adjusting.

## 2026-09-19 (this session) — "Securing connection…" on text send; block screenshots + screen recording on Android

Input: `duospace-merged.zip`. Reports: after tapping send, only "Securing
connection… Please wait a moment." appears and the text never goes; and "no
screenshot or screen recording should be available on apk".

### 1. "Securing connection…" — WHY
`Chat.handleSend` refused to send unless `useE2E().ready` (own key AND partner
public key). `ready` never became true when key init kept failing: the
2026-09-20 account-wide-key change made `init()` depend on the new
`user_e2e_identity_keys` table, and `init()` retried on EVERY error. If
`20260920100000_e2e_account_wide_identity_key.sql` had not been applied to the
Supabase project (table missing -> PostgREST 404 / PGRST205), it retried
forever, `myKeys` stayed null, and the only visible symptom was that toast.
Secondary contributors found on the way: `profiles.update({public_key})`
errors were never checked (the partner could be left with no key to encrypt to,
silently), and a slow key exchange made the user re-tap with no bubble shown.
This is the most likely cause from reading the code; it could NOT be confirmed
against the live project (no DB access) — see "Not verified".

### WHAT (files)
- `src/hooks/useE2E.ts`: new `isSyncTableUnavailable()` +
  `resolveIdentityKeyWithFallback()`. Missing/unreadable sync table -> use this
  device's local key (or mint one) instead of retrying forever; transient errors
  still retry (capped backoff 15s -> 5s). Own keys are set as soon as they
  resolve; publishing the public key is a separate, retried, error-checked
  best-effort step. Partner-key query errors are now logged once. Hook also
  returns `hasOwnKeys` / `hasPartnerKey`.
- `src/pages/Chat.tsx`: removed the hard stop in `handleSend`. The optimistic
  bubble appears immediately; `attemptSendText` waits up to 12s for the key
  exchange (via refs, so it never uses a stale `encrypt`), then encrypts. If
  still not ready the bubble is marked failed (tap to retry) with a reason
  ("Your partner needs to open DuoSpace once…" vs "Secure setup isn't finished
  yet…"). Text is now NEVER sent as plaintext from this path (previously
  `e2eReady ? encrypt(text) : text`, reachable via the pending-text replay on
  mount and tap-to-retry). Edit-message path gets the same guard.
- `src/test/e2eAccountWideKey.test.ts`: tests for the two new functions.

### 2. Screenshots + screen recording (Android) — WHAT
- `scripts/patch-native-permissions.mjs`: new `patchSecureWindow()` adds
  `FLAG_SECURE` to `MainActivity.onCreate` right after `super.onCreate()`
  (Java and Kotlin variants). Independent of the existing push-additions marker
  so an already-patched MainActivity still gets it. Exits non-zero, loudly, if
  it cannot insert it.
- `scripts/verify-android-build.mjs`: `--native` now fails if MainActivity lacks it.
- `src/components/PeekGuard.tsx`: on Android the privacy-screen plugin is always
  `enable()`d and never `disable()`d (it previously disabled it whenever both
  Privacy and Peek Guard toggles were off, which would have cleared the flag).
  iOS behaviour unchanged.

### RISK
- Fallback key mode: until the migration is applied, cross-device decryption is
  only as good as before the account-wide-key change (device-local keys). The
  fallback saves the local key; once the table exists the next launch registers
  that key as canonical.
- FLAG_SECURE also blanks Recents, Cast/mirroring and third-party screen
  recorders, and blocks the user's own screenshots for bug reports. It cannot
  stop photographing the screen with another device, or rooted/modified devices.
- Still-open plaintext fallbacks with the same `e2eReady ? encrypt : text`
  pattern: scheduled messages and love letters in `Chat.tsx` (not changed).

### TEST / RESULT
- Executed in plain Node against mocks: the fallback logic (12 assertions incl.
  missing table on SELECT and on UPSERT, transient error rethrow): PASS.
- Executed: `patch-native-permissions.mjs` against stub Java and Kotlin
  MainActivity files (fresh, already-patched-by-old-script, idempotent re-run,
  and the no-`super.onCreate` failure case): PASS.
- `node --check` on both scripts; TypeScript syntax-only parse of the touched
  .ts/.tsx: PASS. Type-check, vitest, lint, build, Gradle/APK build: NOT RUN
  (no `npm ci` / network here). The Java/Kotlin insertion was not compiled.
- Real device: NOT VERIFIED (send flow, screenshot block, screen recorder block).

## 2026-09-19 (later) — Supabase migrations applied to the live project

Project `jzlpelxwzjjpddqcrtpu` (Duospace). Diffed repo migrations against the live
schema first (migration names differ from the repo's, so state was probed directly).
Applied, in order: `e2e_account_wide_identity_key` (table was missing — this was the
cause of the "Securing connection…" send failure), `call_history_provider_column`
(columns only; client already writes `provider`), `messages_replica_identity_full`
(client filters DELETE realtime by sender/receiver), `lock_get_partner_daily_key_to_service_role`
(only caller is the edge function via service role), `message_reactions_atomic_upsert`,
`search_users_enumeration_guard` (rate-limit path exercised in a rolled-back test),
`realtime_authorization_couple_channels` (client uses private channels; live had RLS on
with no policies), `privacy_consent_ai_foundation`. Post-apply catalog check: all present.
Held back: see KI-16. Not done: KI-09 dashboard toggle "Allow public access" (manual).
Not verified: end-to-end behaviour from a running app.

## 2026-09-20 (this session) — Merge of 3 uploads + Surprise section rebuild (v3.10.0 → 3.11.0)

### Merge (diffed, not assumed)
Three uploads: `duospace-redesign-final-3.zip` (B), `duospace-e2e-cross-platform-fix.zip` (A),
`duospace-merged-fixed.zip` (C). All three are v3.10.0.
- B ⊂ A: A = B + the E2E cross-platform fix (6 lines replaced in `useE2E.ts`; every other
  difference was added lines: CHANGELOG/CURRENT_STATE/KNOWN_ISSUES entries, the migration,
  the test, hook changes). Nothing in B was missing from A.
- A ⊂ C: C = A + the later sessions' work (location error handling / `locationErrors.ts` +
  its test, `useLiveLocation`, `LocationContext`, `MapView`, `Chat.tsx` send-path wait for
  key exchange, `useE2E` sync-table fallback + `publishPublicKey`, `PeekGuard`, native
  `DuoSpaceLocationService`/`CallNotificationService`/`DuoSpaceMessagingService`/audio-engine
  services, `patch-native-permissions.mjs`, `verify-android-build.mjs`, notes). Lines A had
  that C lacks are only in-place replacements (checked file by file: `CallNotificationService.kt`
  now delegates to `DuoSpaceLocationService.requestFixForPush`; `useE2E` retry cap 15s→5s;
  one SETUP_GUIDE line reworded).
- So **C is the merged baseline**; no file was taken from A or B. None of the 7 surprise files
  this session edited differ between A, B and C, so the surprise work below applies cleanly.

### Surprise section — what was wrong (reproduced in headless Chromium against the OLD code)
1. Creator JS was wrapped in `try { … }` → top-level `const`/`let` block-scoped → `const go = () => …`
   + `onclick="go()"` threw ReferenceError. (Function declarations happened to survive via Annex B.)
2. Creator CSS sat after app rules in one `<style>` → a leading `@import` (Google Fonts, animate.css)
   was silently ignored.
3. `new Audio(src).play()` on load was refused by autoplay policy and never recovered, even after a
   tap; the iframe also had no `allow="autoplay"` delegation.
4. `localStorage`/`sessionStorage` throw SecurityError in the sandboxed frame → any library touching
   them crashed.
5. Link taps inside the frame did nothing.
6. (Mirrored-CSS layout check, not the real Tailwind tree) In the glass phase the card has no
   definite height, so the iframe's `h-full` resolved to auto = 150px: every surprise ran in a
   ~254×150 window.
7. The iframe mounted during the ~1.5s blur/fade entrance, so CSS animations, timers and one-shot
   effects ran mostly unseen.
Not reproducible / ruled out: pasted full HTML documents keep `<html>`/`<body>` attributes (the HTML
parser merges them) — an earlier hypothesis that they were lost was WRONG and is not claimed.

### Surprise section — changes
- `src/lib/surpriseDocument.ts` (new; builder moved out of `codeSurprises.ts`, still re-exported):
  plain global user script (omitted entirely when JS is blank), separate user `<style>`, in-frame
  runtime (error report, storage shims, autoplay recovery "Tap for sound" chip + AudioContext resume,
  link forwarding, white page background fallback for imported pages), `no-referrer` +
  `upgrade-insecure-requests` metas, media URL normalisation (Drive/Dropbox/GitHub share links,
  protocol-relative → https; media contexts only), `findUnresolvedLocalRefs` lint, import marker.
- `CodeSurpriseFrame.tsx`: `allow="autoplay *; accelerometer; gyroscope; magnetometer; fullscreen"`,
  `referrerPolicy="no-referrer"`, verifies `event.source` is its own iframe, opens forwarded
  http(s)/mailto/tel links (Capacitor Browser on native, `window.open` on web), `onRuntimeError` prop
  replaces the editor's global `message` listener.
- `SurpriseReveal.tsx`: real height for the glass-phase content area; iframe mounted only after the
  entrance finishes (3.5s backstop timer); `filter` cleared after the entrance.
- `surpriseImport.ts` (new): one .zip OR any mix of .html/.css/.js. Finds the entry page
  (index.html preferred), moves `<style>` + linked/`@import`ed CSS into CSS, classic
  `<script>`/`<script src>` into JS (**JS stays "" if the page has none**), keeps remote
  `<link>`/`<script src>`/module scripts as tags, inlines local images/audio/video/fonts as data:
  URIs (CSS `url()`, HTML attrs, `srcset`, inline `style`, and JS string literals that are exactly an
  uploaded file's path). Budgets: 1.5 MB/asset, 3 MB total, 4.5M chars, zip ≤25 MB / ≤600 entries /
  ≤60 MB expanded. Large PNG/JPEG re-encoded (WebP, ≤1600px) when the browser can. Everything not
  embedded is reported by name + reason; nothing is silently dropped. Path traversal / `__MACOSX` /
  dotfiles ignored. ES modules with `import`/`export` are skipped with a reason.
- `surpriseAssets.ts` (new): editor shows `ds-asset://aN` tokens instead of multi-MB base64 in the
  text areas; expanded on preview/save/library.
- Library ("save the uploaded code in our database"): `supabase/migrations/20260920110000_surprise_library.sql`
  (`surprise_library`, owner-only RLS, no partner policy, size CHECK, updated_at trigger),
  `surpriseLibrary.ts`, `SurpriseLibraryPanel.tsx`, editor UI (Import zip/files, Library, Save to
  library, "Save uploads to my library" switch — default ON — replace-confirmation when there are
  unsaved edits). It is separate from `code_surprises` on purpose: that table's SELECT policy
  exposes every row, active or not, to the partner.
- Because imported surprises can be MBs: `fetchSurprisesForConversation` now returns metadata only
  (`body_loaded:false`), `ensureSurpriseBody()` fetches html/css/js once on open;
  `useChatSurprise` opens/auto-opens through it and also refreshes the list when a Realtime payload
  lacks `creator_id`; `analyzeSurpriseContent` strips data: URIs before scanning.
- Tests added: `surpriseDocument.test.ts`, `surpriseAssets.test.ts`, `surpriseImport.test.ts`.
- Version 3.10.0 → 3.11.0 (`package.json` + `APP_VERSION`).

### Verification actually performed
- Headless Chromium (Playwright): old vs new builder side by side for items 1–5 above; imported a
  real multi-file zip and rendered it in a `sandbox="allow-scripts"` frame (body class/onload,
  external JS file, inlined image, running CSS animation, inline handler over a `const`, blank-JS
  page emits no user script); canvas re-encode took a 1.3 MB PNG to 27 KB.
- The 3 new test files (38 tests) executed in Chromium through a ~60-line vitest-compatible shim:
  38/38 pass. **They have NOT been run under vitest/jsdom** (not installed here); jsdom differences
  (TextDecoder/Blob.arrayBuffer/JSZip realm) are possible.
- Isolated `tsc --noEmit` of every touched file against stubs for third-party modules: no errors in
  the touched files (stub-caused noise filtered). No real project typecheck/lint/build (no `npm ci`).
- `node scripts/check-rls-coverage.mjs`: passes with the new table (advisory only).
### NOT verified
Android/iOS WebView behaviour (autoplay, mixed content, Drive/Dropbox direct links, Referer), any
network-hosted media, the new migration against a live DB (NOT applied — see KI-17), Realtime's
oversized-payload behaviour (assumed, see the `creatorId === undefined` guard), the real Tailwind
layout of the glass-phase fix, and framer-motion's `transitionEnd` in the actual bundle.

## 2026-09-20 (later) — Incoming calls: can't answer / keeps vibrating / lag

Symptoms reported: can't pick up calls, app lags, phone keeps vibrating, tapping
Accept does nothing, continues after the call ends. Found by reading code only —
NOT built, NOT run on a device (no network/device in the sandbox).

### Root causes (source-level)
1. `useCallEngine()` returns a new object every render, so `acceptIncomingCall`
   (deps `[call, ...]`) changed identity every render. `IncomingCallOverlay`'s
   subscribe + cold-start-poll effect depended on it, so it re-ran constantly:
   re-subscribed channels, stopped/restarted ringtone + vibration, and the poll
   re-hydrated the same still-`in_progress` call — re-opening the incoming
   screen after Accept (second tap hit `acceptLockRef` = no-op).
2. `haptics.startCallVibration()` was not idempotent and only stored the last
   interval handle → orphaned vibration loops that `stopCallVibration()` could
   not clear.
3. Android: `CallRingingService` (ringtone + vibration), notification 9911 and
   the ringing Telecom connection were started by the FCM push but never stopped
   by in-app accept/decline/end (only by notification buttons, call_ended/
   missed/rejected pushes, or the 45s timeout).
4. Native call actions did `window.location.href = "/chat"` (hard reload; twice
   on cold start because the pending-action replay re-ran the handler).
5. `handleAccept` returned silently when `room_url` was empty.

### Changes
- `src/components/IncomingCallOverlay.tsx`: refs for callbacks, effects keyed on
  user id only, handled-call-id set, accept/decline/auto-accept rewritten
  (auto-accept no longer runs inside a setState updater), missing-room fallback
  + toast, native stop on every dismiss path, opaque backdrop (no full-screen blur).
- `src/contexts/CallContext.tsx`: `acceptIncomingCall` now identity-stable via refs.
- `src/lib/signalingEngine/callSignalingBridge.ts`: returned bridge memoized.
- `src/lib/haptics.ts`: idempotent start, tracked timeouts, 60s safety cap.
- `src/lib/nativeIncomingCall.ts` (new) + `dismissIncomingCall` in
  `native-plugins/callkit-bridge` (TS definition, Android, iOS no-op).
- `native/android/CallRingingService.kt` (`ACTION_DISMISS_INCOMING`),
  `CallNotificationService.kt` (public `NOTIFICATION_ID`, end Telecom connection
  on call_ended/missed/rejected), `DuoSpaceConnectionService.kt`
  (`endConnectionForCall`, keep ref after Telecom-side answer),
  `CallOngoingService.kt` (always end the Telecom connection on hang-up).
- `scripts/patch-native-permissions.mjs`: MainActivity (Kotlin + Java variants)
  cancels the ringing notification on Accept/Decline.
- `src/hooks/usePushNotifications.ts` / `nativeCallActionBridge.ts`: soft
  navigation instead of reload, live handler clears the durable pending-action
  slot, iOS `callAction` listener removed on cleanup.

### Verified vs not
- Verified: TS syntax of all edited files; vibration logic (single loop, full
  cancel, safety cap) via a fake-timer harness.
- NOT verified: `vite build`, `tsc`, vitest, any Kotlin/Swift compile, any
  on-device behaviour. Run `npm run cap:sync` so the MainActivity patch
  re-applies, then test: answer in-app, answer from notification, caller
  cancels while ringing, hang up, and a second call right after.


## 2026-09-20 — Appearance: theme picker, collapsible wallpapers

Source-level only; nothing compiled, linted, or run in the app (no
node_modules / no network here — KI-06 still stands). What WAS run: the real
`themeEngine.ts` under Node against all 33 theme identities × light/dark ×
6 text/background pairs (396 checks, 0 below 4.5:1), and a syntax +
best-effort type pass over the touched files.

- **Theme picker rebuilt** (`components/settings/ThemePicker.tsx`, shared by
  Appearance settings and Theme Studio). Category chips (Cool / Romantic /
  Warm / Nature / Neutral) and 3-column cards that each draw a mini
  conversation from the theme's own derived tokens. Previews now render in the
  *current* color mode — previously swatches always showed a theme's "home"
  mode while selecting a theme never changed the mode, so the picker could
  show a dark Wine Red and apply a light one.
- **5 new themes**: Peony, Mulberry, Aurora, Meadow, Noir (33 total). Every
  theme now has a `category`; `THEMES` is derived from one ordered
  `THEME_META` list so preview/accent/dark can't drift from
  `THEME_IDENTITIES` / `THEME_DEFAULT_MODE`. `couple_theme` is free text, so
  partners on an older build fall back to Midnight instead of erroring.
- **Collapsible sections** (`CollapsibleSection.tsx`): Theme colors and Chat
  wallpaper collapse from a full-width header (aria-expanded, height animation
  skipped under reduced motion). Open/closed persists in one localStorage key
  (`duo-appearance-sections`). The header keeps a thumbnail + name of the
  current selection while collapsed. Wallpaper defaults to collapsed, theme to
  open.
- **Wallpaper picker** (`WallpaperPicker.tsx`): live chat preview behind the
  current theme's bubbles, category chips, 3-column tiles with names, an
  explicit "Default" (none) tile, Live badge for Dynamic Sky.
- Added `src/test/themeCatalog.test.ts` (unique ids, one category each,
  4.5:1 contrast on every preset in both modes, wallpaper pairs present).

## 2026-09-20 — KNOWN_ISSUES pass: KI-14 and KI-17

Source-level only; nothing compiled, linted, or run (KI-06 still stands).

- **KI-14 fixed** — `src/pages/Chat.tsx`: `handleScheduleMessage` and
  `handleSendLoveLetter` no longer fall back to plaintext when E2E isn't ready.
  They wait for the key exchange (6 s), encrypt through `e2eEncryptRef`, and
  abort with a toast unless the result passes `isEncrypted()`. Encryption now
  runs before the composer is cleared / dialog closed so nothing typed is lost.
- **KI-17 applied** — `20260920110000_surprise_library.sql` applied to live
  project jzlpelxwzjjpddqcrtpu (migration name `surprise_library`); RLS/policies
  verified via catalog query. Two-account cross-read test still outstanding.
- **KI-05 fixed** — added `exportPrivacyData()` (consent.ts) and an export button in
  `PrivacyAISettings.tsx`. Source-level only.
- **KI-08 investigated, deliberately not changed** — the live
  `enforce_call_history_update_rules` trigger does not compute `ended_at` /
  `duration_seconds` (only the un-applied repo migration does, see KI-16), so
  removing them from the client would leave them null. Real fix is server-side.
- **KI-12 gap 1 built (unverified)** — Android "Allow all the time" request: plugin
  methods (Kotlin + definitions.ts), `backgroundLocationPermission.ts`,
  `BackgroundLocationPrompt.tsx`, mounted in `LocationAccessGate.tsx`. Gaps 2 and 3
  untouched.
- **KI-04 audited (no code change)** — findings and options recorded in KI-04. Main
  result: mood is the only one of the six that leaves the device, and the partner can
  read raw camera-derived `features` in `mood_logs`.
- **KI-04 option (a) applied** — raw facial measurements no longer written to
  `mood_logs.features` (MoodDetector.tsx, useBackgroundMoodDetection.ts). Old rows
  untouched; optional scrub SQL recorded in KI-04, not run.
- **Live scrub run** — stripped the four raw facial keys from 37 of 47 existing
  `mood_logs` rows (project jzlpelxwzjjpddqcrtpu). Irreversible by design.
- **Kill switch** — `BACKGROUND_LOCATION_PROMPT_ENABLED` in
  `backgroundLocationPermission.ts` (set false to hide the new Android dialog).
- **KI-12 gap 2 built (unverified) + live infra** — migration
  `location_push_credentials` applied; edge functions `location-push-register`
  (jwt) and `location-push-upload` (no jwt, credential-authenticated) deployed to
  jzlpelxwzjjpddqcrtpu; native upload in DuoSpaceLocationService; JS registration
  in LocationContext. See KI-12 #2 for the full design and limits.
- **Not touched (need a device, network, dashboard, or a product decision):**
  KI-01, 02, 03, 06, 07, 08, 09, 10, 11, 12, 15, 16, 18, 19.


## 2026-09-20 — Phase 1.6 (repository reconciliation + privacy foundation), partial
Added: `consentFeatures.ts` (dependency-free vocabulary + `isConsentActive`),
policy matrix and PARTNER/ANALYTICS/LOGS destinations, gate destination-consent
and explicit-share rules, `sensorPolicy.ts`/`sensorGate.ts`, purpose-required
`acquireCamera`, `derivedMoodGate.ts`, `ai/provenance.ts`, `ai/sharing.ts`,
`ai/localInsightStore.ts`, validator patterns, telemetry consent guard and wider
redaction, `scripts/check-lock-sync.mjs`, RLS-script recognition of
service-role-only tables, vitest plugin aliases, four new test files, five new
`.ai` docs, Phase 1.6 report.
Fixed: mood auto-publish to partner profile; persisted background-mood flag;
object-extra telemetry leak.
Changed behaviour: saving camera-derived mood needs `MOOD_PROCESSING` (KI-24).
Not done / blocked: see the report and KNOWN_ISSUES KI-20..KI-30.

Also 2026-09-20: merged `duospace-theme-update.zip` (theme picker, collapsible
wallpapers, 5 new themes) onto this tree with `patch -p1` — applied cleanly, no
rejects. `ThemeContext.tsx` keeps both the theme additions and the Phase 1.6
persistence-ordering fix. The overlay's own changelog entry is above.


## 2026-09-20 (later) — Music: "no notification when a song plays"
Input: log line "notification posted OK (isPlaying=true)" + "no notifications on playing songs".
Found: the toast is a leftover TEMPORARY diagnostic in `MediaPlaybackService.postNotificationInternal`;
success was inferred from "no exception". See KNOWN_ISSUES KI-31 for the full change list.
Files: `MediaPlaybackService.kt` (verification, new channel, transport category, no toasts,
`onNotificationIssue`), `AudioEnginePlugin.kt` (`notificationIssue` event,
`openNotificationSettings`), `definitions.ts`/`web.ts`, `nativeAudioEngine.ts`
(`ensureNotificationPermission`, `onNotificationIssue`, `openNotificationSettings`),
`GroicContext.tsx`, new `lib/music/notificationIssue.ts` + `notificationIssueToast.tsx`,
new `test/notificationIssue.test.ts` (6 cases, passed under the stand-in runner only).
Not verified: Kotlin compile, any device behaviour.


## 2026-09-20 (later still) — Audit pass merged onto Helllooi.zip: perf + QR partner link

Ported from a parallel session's `duospace-redesign-final-updated.zip` onto this tree with `patch -p1`
(all hunks applied; `AppearanceSettings.tsx` re-done by hand because this tree restructured it). Source-level
only; nothing compiled or run on a device (KI-06 stands).

### Performance
- `src/lib/crypto.ts`: ECDH-derived AES key cached per (private-key JWK object, peer public key) in a WeakMap.
  Opening a chat used to run importKey x2 + deriveKey for EVERY message. Executed against real WebCrypto in
  Node: 60 decrypts 21 ms -> 2 ms (desktop), 120 ops = 2 derivations, wrong key still fails, a failed
  derivation is not cached.
- `GroicContext`: `position`/`duration` moved to `GroicProgressContext` (`useGroicProgress`). `useGroic()` no
  longer changes twice a second during playback; only `SeekBar` (extracted from `GroicFullPlayer`) follows it.
  Merged with the KI-31 notification-issue changes in the same file.
- `QRSignInScanner` / `QRSignInDisplay`: `html5-qrcode` and `qrcode` are dynamically imported on use.
- `AuthContext`: provider value memoised.
- "Smooth mode": `src/lib/perfProfile.ts` + `html[data-effects="lite"]` block at the end of `index.css` +
  Performance card in Appearance settings. Auto turns backdrop blur off on low-end devices
  (deviceMemory <= 3, cores <= 4, saveData). Capable devices unchanged.

### QR partner link — docs/QR_PARTNER_LINK_FIX.md (KI-32)

### Deliberately not changed
Static imports of PeekGuard/MoodDetector/GroicFullPlayer (earlier boot-crash fix). Chat's first load still waits
for all attachment URLs to be signed. KI-11 re-examined: partner-key fetch already runs in parallel, so caching
the own key buys little.

### 2026-09-20 — QR link fix DEPLOYED (server side)
Applied migration `qr_partner_link_fix`, redeployed `redeem-qr-token` (v9), deployed `check-qr-token-status` (v1,
never live before). Details and limits in KNOWN_ISSUES KI-32. App build not yet installed; not tested on devices.


## 2026-09-20 (latest) — "Location not updating although permissions are granted"

Foreground live-location engine (`src/hooks/useLiveLocation.ts`) — NOT compiled
or device-tested (KI-06 still applies). Only the write-gating arithmetic was
checked, by a standalone Node simulation of old vs new logic (3 min, 1 fix/s,
±6 m GPS noise): stationary 1 write -> 5; walking 1 -> 30 (last write ~255 m
stale -> ~4 m); cycling 1 -> 46 (~900 m stale -> ~11 m); driving unchanged.

Root causes found in `onPos`:
1. **Write gate was unreachable below ~10 km/h.** Smoothing (30 % of the raw
   delta) was applied before the "moved >= 8 m" write check, and the smoothing
   base only advanced when the marker moved > 3 m. Net effect: an 8 m smoothed
   step needed a ~27 m raw jump in ONE fix. Standing still or walking wrote
   nothing after the first fix, so the partner's "Updated X ago" froze.
   The code comment promised "distance OR initial OR long idle" but the idle
   branch did not exist. FIX: gate measured against the last WRITTEN position;
   `KEEPALIVE_WRITE_MS` (45 s) idle write added.
2. **Smoothing never converged.** Base now advances on every accepted fix, with
   a heavier weight (0.8) when the raw fix is > 25 m away (real movement).
3. **Eco/high switch thought walking was standing still** (used the same
   unreachable 8 m smoothed step), so a walking person dropped into eco
   (coarse, cached up to 30 s) after 30 s. Movement is now "left the last
   written spot by >= 8 m".
4. **Every fix could be dropped.** Hard reject at > 250 m accuracy (and soft
   drift reject) discarded all fixes on cell/Wi-Fi-only positioning while the
   UI still showed "tracking". Gates are skipped after `STARVED_AFTER_MS`
   (90 s) with nothing accepted; the speed-jump gate is skipped when either fix
   is imprecise.
5. **Dead watcher never noticed.** Added a silence watchdog (150 s without an
   accepted fix while visible -> restart watcher + coarse one-shot) and a
   foreground-resume check (> 60 s silent -> restart).

NOT changed (needs a product decision): Android background tracking. Since the
2026-09-19 "no notification" change `DuoSpaceLocationService` is not a
foreground service, so Android stops delivering fixes shortly after the app is
minimized. See docs/BACKGROUND_LOCATION_NATIVE.md header.

Unverified suspicion: `@capacitor/geolocation` may use the `timeout` option of
`watchPosition` as the Android update INTERVAL. If so, HIGH_OPTS (30 s) /
ECO_OPTS (45 s) mean one fix per 30-45 s. Check `Geolocation.java` in
node_modules after `npm ci`.

## 2026-09-20 (latest, 2) — Quiet background location (no notification)

Request: keep location updating with the app minimized WITHOUT bringing the
foreground-service notification back. There is no legitimate way to hide a
foreground-service notification, so the approach is to not need a foreground
service: Play services PendingIntent updates.
- NEW `native/android/LocationUpdateReceiver.kt`: PendingIntent subscription
  (register/unregister), receiver for location results (forwards to JS if alive,
  else uploads natively via the existing `location-push-upload` credential),
  boot/app-update re-subscribe, and the shared native upload helper.
- `native/android/DuoSpaceLocationService.kt`: ACTION_START registers the
  subscription and stops itself; one-shot bookkeeping via a counter (was
  `isWatcherRunning`); `onDestroy` no longer tears the subscription down; upload
  code delegated to the receiver's helper.
- `scripts/patch-native-permissions.mjs`: copies the new file, registers the
  receiver (own guard), adds RECEIVE_BOOT_COMPLETED.
NOT compiled/run. Needs "Allow all the time"; Android throttles background
apps. Needs a rebuilt APK, then open the app once.

## 2026-09-20 (Calling Phase 4) — authoritative WebSocket signaling for self-hosted calls

Merged onto `duospace-redesign-notification-fix.zip` (3-way; only overlapping
files were `IncomingCallOverlay.tsx`, `CallContext.tsx`, `Chat.tsx`). Full
detail: `docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md`.

- Gateway now authorizes every call-control message against Supabase and acks
  each one (`gateway.ts`, `callRegistry.ts`, `authorizer.ts`); migration
  `20260920140000_signaling_call_facts_and_session_id.sql` (renamed from
  `…130000` — collided with `qr_partner_link_fix`).
- `livekit-token`: room derived from call id (caller-chosen `room_name` no
  longer trusted), provider check, receiver must hold the claim.
- Client engine/client/bridge rewritten; self-hosted ring, accept, reject,
  cancel, end, timeout are socket-driven with typed results; Realtime kept only
  as a labelled recovery path. Daily untouched. No JSX changes.
- Fixed: reconnect used an expired ticket forever; accept flow marked
  token stages before any token existed; call-latency metrics were truncated /
  `[redacted]` by telemetry (KI-41).
- Infra: local/staging/production split; TURN docs corrected (KI-36).
- Not verified: see KI-33. Lockfile: KI-20 downgraded (static agree).

## 2026-09-20 (Partner unlink) — stuck confirm dialog + two-sided (consent) unlink

Source: `duospace-phase4-authoritative-signaling.zip`. No DB / `node_modules` /
device in this sandbox — nothing below was executed. Full write-up:
`docs/PARTNER_UNLINK_CONSENT.md`.

WHY: (1) after a successful unlink the "Unlink from partner?" dialog stayed on
screen; (2) either partner could end the pairing alone (RPC `unlink_partner`
open to all signed-in users, and `profiles` allowed direct `partner_id` writes).

WHAT:
- `ConfirmActionDialog` closes itself after `onConfirm` (resolve `false` to keep
  open); new optional `approvalNote` row. `Settings.handleSignOut` returns
  `false` on failure to keep its retry behavior. Also fixes the same stuck
  dialog on "Turn off App Lock?".
- Migration `20260920150000_partner_unlink_consent.sql`: `unlink_requests`
  (read-only for clients), RPCs `request_unlink` / `respond_unlink` /
  `cancel_unlink`, `unlink_partner` revoked from `authenticated`,
  `profiles.partner_id` client-write guard trigger, push trigger.
- Push types `unlink_request|unlink_approved|unlink_declined`
  (`send-push` `_shared/pushTypes.ts`, `_shared/fcm.ts`); client routing +
  foreground refresh in `usePushNotifications.ts`.
- App: `useUnlinkRequests`, `UnlinkRequestHost` (in `AppLayout`),
  `lib/partnerUnlink.ts`; `PartnerSettings` sends a request, shows
  waiting / incoming state and Cancel. `clearCachedPartner` added; `Chat`
  drops a stale cached partner when the server says none.

RISK: the `profiles.partner_id` guard relies on `current_user` (definer-owner
vs `authenticated`) — correct in theory for Supabase, unverified live. Old app
builds can't unlink after the migration. A partner who never answers cannot be
unlinked (see KI-42).

TEST: `src/test/partnerUnlink.test.ts` (helpers + static SQL checks),
`src/test/confirmActionDialog.test.tsx` — written, NOT RUN. Static regexes in
the SQL checks were confirmed against the migration text with node only.

RESULT: implemented in source, NOT VERIFIED (lint/tsc/tests/build/DB all
BLOCKED BY ENVIRONMENT).

## 2026-09-20 (Shayari) — author-only Edit button

Source: `duospace-phase4-partner-unlink-consent.zip`. No DB / `node_modules` /
device in this sandbox — nothing below was executed against a real build.

WHY: shayaris could be written and deleted but never corrected afterwards.

WHAT:
- `src/pages/Shayari.tsx`: pencil button on a card, rendered only when the
  signed-in user is the author (`canEditShayari`); Edit dialog (title + text);
  saves with `update(...).eq(id).eq(user_id).select()` so a write the database
  refused (0 rows) shows an error instead of a false success; the dialog closes
  on success and stays open with the draft intact on failure. The existing
  realtime UPDATE listener shows the edit on the partner's screen live.
- `src/lib/shayariEdit.ts` (pure rules: author check, trim/empty-title→null,
  "unchanged" short-circuit) + `src/test/shayariEdit.test.ts`.
- `src/lib/errors/registry.ts`: `DS-SHAYARI-006`.
- No migration: the existing "Update own shayaris" RLS policy
  (`auth.uid() = user_id`) already makes editing author-only in the database.

RISK: low. No `updated_at` column exists, so edited shayaris aren't marked
"edited" (would need a migration). The export/PDF/card paths read from state and
pick up edits automatically.

TEST: helper logic run under node (8 cases pass); `shayariEdit.test.ts` written,
NOT RUN under vitest. `Shayari.tsx` not compiled (BLOCKED BY ENVIRONMENT).

RESULT: implemented in source, NOT VERIFIED at runtime.


## 2026-09-21 — Supabase production reconciliation and security fixes

Source: `duospace-offline-gallery-us-shayari.zip`. Work was done against the LIVE project
(`jzlpelxwzjjpddqcrtpu`); nothing in the app was compiled or run in this sandbox.

WHY: the live project had diverged from the repo history. A live exploit
(`partner_requests` sender_id rewrite → forced pairing), a public bucket anyone could write to,
two public diagnostic Edge Functions that leaked secret fragments, and an open `send-push`
were found and fixed while applying the earlier zips. Details: `docs/SUPABASE_PRODUCTION_RECONCILIATION.md`.

WHAT:
- New migrations `20260921110000` … `20260921110500` (all idempotent; already applied live).
- `supabase/functions/send-push/index.ts`: rejects non-service-role callers (403); the zip's
  `/important` bypass is kept.
- `20260921120000_add_messages_important_flag_and_bypass_dnd.sql` corrected: it re-added the
  plaintext `preview` that `20260908090000` had removed. Live already has the correct function.
- Docs corrected: `SUPABASE_SCHEMA_INVENTORY.md` (surprise-assets), `.ai/KNOWN_ISSUES.md`,
  `.ai/CURRENT_STATE.md`.

RISK: `send-push` no longer accepts user-JWT calls (none exist in the app). The unlink cleanup
deletes accepted `partner_requests` rows between the unlinked pair. `accept_partner_request`
now refuses when either side is already linked.

TEST: rolled-back SQL tests on live (listed in the doc); live 403 check on `send-push`.
NOT RUN: vitest, tsc, build, a real two-device flow, Realtime delivery, a real push through the new
`send-push`.

RESULT: applied to live; repo files added to match. Live `send-push` v7 is still the previous
source (no `/important` bypass) — redeploy needed for that.

## 2026-09-22 — Media send speed, WhatsApp ZIP import, on-device downloads
- WhatsApp import: ZIP detected by "PK" signature (Android pickers often drop the .zip extension); file picker accepts zip MIME types; picks `_chat.txt` / "WhatsApp Chat…" / largest .txt instead of first .txt; skips __MACOSX; strips iOS bidi marks inside message content (iOS attachments were never matched); CRLF, a.m./p.m. and dotted-time support; media uploads 4-at-a-time with correct Content-Type; friendly out-of-memory message.
- Sending: new `src/lib/directUpload.ts` — single XHR upload with real progress for files ≤50 MB (bucket cap), chunked `resumableUpload` kept as fallback; photos >600 KB downscaled to 2048px JPEG before send; chunk fallback now uploads 4 chunks concurrently; progress updates throttled to whole-percent changes.
- UploadProgressRing redesigned on theme tokens (--primary/--background, frosted disc, arrow/check icon).
- New `src/lib/downloadToDevice.ts`: file bubbles and PhotoViewer save the file to Documents/DuoSpace (native) or trigger a real browser download (web); raw Supabase URLs are never opened.
- NOT VERIFIED on real devices / live Supabase (npm install blocked in this environment; edited files syntax-checked with esbuild only).

## 2026-09-22 (b) — Scheduled picker layering, slash-command menu, /important & /urgent
- ScheduledMessagePicker portaled to <body> as a z-[80] bottom sheet (was rendered under DuoSpaceBottomSurface z-40, i.e. behind the chat box).
- Composer: typing "/" shows a "Send as" menu (/silent, /important, /urgent), filtered as you type, keyboard + tap support; portaled so the overflow-hidden shell can't clip it.
- /urgent was never parsed (sent as literal text) — now parsed; sets important=true + new urgent column (additive migration 20260922120000). Falls back to important-only if the column isn't deployed yet.
- Messages fetch never selected silent/important, so flags vanished after reload — now selected. Bubbles show "Important" (amber) / "Urgent" (red) label + ring; own silent sends show "Sent silently".
- NOT VERIFIED on device / live DB.

## 2026-09-22 (c) — Vanish Mode persistence, no App Lock during file picking
- Vanish ("ghost") Mode persisted per user+partner (storage key duo-vanish:<uid>:<pid>); survives app close/reopen, WebView reclaim and App Lock; only cleared by endVanishMode.
- appLockTimer: picker grace window. installPickerLockGuard() (called from ThemeContext) marks every <input type=file> click; shouldLockOnResume returns false while the mark is fresh (≤10 min); mark cleared ~3s after return. Real backgrounding still locks as before.
- NOT VERIFIED on device.

## 2026-09-22 (d) — WhatsApp-style call notification, no call spam, music reattach
- Android: new native/android/IncomingCallNotification.kt — ONE incoming-call notification (CallStyle.forIncomingCall: green Answer / red Decline on API 31+, coloured actions below), ongoing, full-screen, no auto-timeout. CallRingingService posts it as its foreground notification under the same id (9911) — was two notifications (9911 + 9912). CallNotificationService always uses the native path (foreground skip removed) and only posts it directly if the ringer service was refused. Added to patch-native-permissions copy list.
- IncomingCallOverlay: on native, renders nothing and plays nothing while the OS owns the ring; falls back to its own screen+ringtone only if native isn't ringing after ~3s; notification body tap ("duospace-call-reveal") shows the in-app answer screen.
- "Call ended" / "Call declined" pushes no longer post tray notifications (missed calls still do).
- Ongoing call + music notification taps bring the existing task forward.
- GroicContext: snapshots current track+queue; on startup/foreground reads nativeEngine.getState() and restores the player UI for music still playing in the background service.
- NOT VERIFIED: needs a native rebuild (npx cap sync + patch script) and device testing.

## 2026-09-22 (e) — Map: single info entry, full zoom without "Map data not available", no control overlap
- Status/details sheet now opens ONLY from the bottom battery chip (header pill made display-only; partner-marker tap removed).
- Tiles: maxNativeZoom reduced by 1 on retina (detectRetina's zoomOffset was requesting z20 → Esri "Map data not yet available" placeholder / OSM 404); satellite real-tile cap lowered 19→17 (z18-19 are placeholders outside major cities); Leaflet upscales to MAX_ZOOM 21; transparent errorTileUrl.
- Leaflet zoom control removed (overlapped recenter at bottom-right); custom glass +/- stacked above the recenter button.
- NOT VERIFIED on device.

## 2026-09-22 (f) — Call "stuck on Connecting… → Call failed"
- useDailyCall.joinCall: mic (and camera for video) permission resolved BEFORE Daily join — an OS prompt raised mid-join could leave join() hanging until the watchdog showed a fake "Couldn't connect"; a denial now surfaces as PERMISSION_DENIED.
- One silent automatic retry (fresh call object, same room/token) on watchdog timeout or non-permission join failure; watchdog 15s first attempt, 20s retry. Error UI only after both fail.
- Removed deprecated dailyConfig.camSimulcastEncodings (daily-js 0.87); best-effort updateSendSettings({video:"bandwidth-optimized"}) after join.
- CallContext accept watchdog 40s → 55s to cover join + retry.
- Daily.co kept as provider per DO_NOT_CHANGE.md. NOT VERIFIED on device.

## 2026-09-22 (g) — Groic trending variety, more languages, language bar, legal YouTube background
- New src/lib/music/trendingMix.ts: per-language rail built from SoundCloud → YouTube → Audius (fixed tier priority, ~40/40/20), each tier from a random query in a per-language pool and shuffled; 30-min provider cache, reshuffled every render/“Shuffle”.
- music-trending edge function: accepts { languages: [...] } (allowlisted, max 4); random query + publishedAfter 60 days + random order instead of fixed order=viewCount; English chart region rotates; results sampled/shuffled. Legacy empty body still returns the original four.
- 16 languages: Hindi, English, Punjabi, Urdu, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Haryanvi, Bhojpuri, Arabic, Spanish, K-Pop.
- Language picker: single scrollable bar, tap select / tap again deselect (any, incl. last), check indicator + native script, Shuffle button.
- YouTube background: no ToS bypass. On backgrounding a YouTube track (native app), Groic hands off to the same song on SoundCloud/Audius (title key + ±20s duration match) at the same position; otherwise YouTube pauses as required.
- NOT VERIFIED on device; redeploy music-trending.

## 2026-09-23 — Self-hosted calling is the only provider (Daily removed)
- Removed: @daily-co/daily-js (+ transitive lock entries), useDailyCall.ts, DailyCallEngineAdapter.ts, DailyKeyManager (onboarding step + Settings card), supabase/functions/daily-call, provider switch/override/VITE_CALL_PROVIDER, all Daily branches in Calls/Chat/CallContext, "No Daily.co API key" 402 message.
- SelfHostedCallEngineAdapter: bounded stages (token 15s / connect 20s / mic 12s), duplicate-join + join-generation (cancel-while-joining) guards, room-mismatch refusal, unexpected-disconnect → error + cleanup, telemetry participant_joined/remote_audio_ready/call_connected.
- Deterministic failure cleanup: caller (leaveCall + cancelOutgoingCall "join_failed"), accept (leaveCall), recovery rejoin (leaveCall + signalCallTerminated).
- livekit-token: service-role signaling_get_call_facts; mutual current partnership, decline, UUID callId, TTL 300s clamped 60–900.
- Gateway: STALE_CONNECTION rejection for replaced sockets (+2 tests).
- Migration 20260923120000: provider default self_hosted, BEFORE INSERT trigger rejects others, dangling live Daily rows → failed/provider_removed. Historical rows kept; Daily-key columns NOT dropped.
- scripts/check-calling-config.mjs (`npm run check:calling`): static production config preflight.
- Tests: adapter (10), no-Daily guard (4), authz (+4), provider config (rewritten), callSignalingBridge (hoisting bug fixed — 6 tests now actually run).
- Docs: docs/calling-architecture.md (authoritative), docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md; superseded banners on 35 historical docs; DO_NOT_CHANGE/ARCHITECTURE/NATIVE_CALLING/SECURITY_MODEL/deployment README updated.
- NOT runtime-verified on devices / live LiveKit / TURN.

## 2026-09-23 — Phase 2B: local AI engine, evaluation harness, 2A hardening
- FIX (pre-existing): local-rule-v1 output failed the validator for Values/Expectations/Reflection (HIGH confidence over cap; unhedged explanations) → every analysis errored.
- FIX (security, verified exploitable on real Postgres): relationship_shares un-revoke/extension; migration 20260923130000 (one-way revoke, immutable expiry, server-owned insert fields, partner-checked recipient reads).
- FIX: validator false negatives ("Your partner…", "they don't care"); euphemism coverage; expectations evidence catalog lists only present types.
- NEW: local-model-v1 provider, capability layer, integrity-verified manifest, transformers.js web runtime (lazy), strict JSON prompt contract, provenance check, local-rule-v1 fallback, device-only enforcement.
- NEW tests: src/test/ai (87), src/test/db (10, PGlite). Deps via npm: @huggingface/transformers, @electric-sql/pglite (dev).
- NOT VERIFIED: no real model inference executed. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## 2026-09-23 — Merge + Phase 2C: AI execution modes
- MERGE: photos-upload + LiveKit-Cloud zips (built on pre-2B) 3-way merged with Phase 2B; 2B share-revoke migration restored; deps re-added via npm. FIX: MoodDetector `pool` ReferenceError (from LiveKit zip).
- NEW: RelationshipAIService (single orchestrator), executionMode (LOCAL/E2E_CLOUD/RULE_BASED/UNAVAILABLE, failure policy, capability assessment), e2eCloud envelope (ECDH P-256/HKDF/AES-GCM, AAD, replay) + BLOCKED E2E provider (no TEE). Validator +8 subtle-inference groups. Reflection.tsx routes via service; toast states mode.
- NOT DONE: real model (403), hashes, inference, performance. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## 2026-09-23 — Phase 2D (blocked at model artifact)
- Artifact BLOCKED (HF/CDN/ModelScope 403; no official non-HF source). No weights, hashes or measurements fabricated.
- NEW: grounding validator (history/frequency/numbers not in input → rejected) in pipeline for generated output; manifest versioning + compatibility gate (safetySpecVersion 3); .ai/MODEL_MANIFEST.json (BLOCKED); real-model evaluation runner (skips without LOCAL_MODEL_DIR).
- Tests 806 pass / 2 skipped / 6 pre-existing fail. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.

## 2026-09-23 — Calling deployment root cause + instrumentation (+ merged peek + Phase 2D)
- ROOT CAUSE: signaling-ticket used SUPABASE_JWT_SECRET, which hosted Supabase never provides to Edge Functions (reserved SUPABASE_ prefix) → tickets 503 → socket never opens → "Connecting…". Fix: dedicated SIGNALING_TICKET_SECRET on both signaling-ticket and the signaling server (old name = local fallback); env examples, docker-compose, README, check-calling-config updated.
- Signaling server now logs socket_connected/closed, upgrade_rejected_origin/auth and every accepted signal (ids only).
- Client trace: required stage names, callId/sessionId, call_failed with machine-readable reason.
- Real local e2e re-run with the fix (real signaling + LiveKit 1.13.7 + 2 WebRTC peers): PASS. Devices: NOT tested. See docs/CALLING_DEVICE_VERIFICATION.md.

## 2026-09-23 — Smoothness / flicker pass (+ incoming-call notification follow-up)
- Route flicker: every page chunk is now warmed after first render (one per idle slot; Gallery/Groic first), Reflection added to routePreload, and BrowserRouter uses v7_startTransition — navigations no longer unmount the current page to flash a skeleton.
- Hub: destination chunk warmed on pointer-down (like dock tabs), so the post-close navigation never waits on a download.
- Global: -webkit-tap-highlight-color: transparent (Android WebView grey tap flash on every button/card/tab).
- Sheets: open 500ms→300ms, close 300ms→200ms. Gallery full-screen image decodes async.
- Incoming call (user's WhatsApp-style change — fullScreenIntent removed): the non-foreground-service fallback path no longer uses CallStyle (which on API 31+ requires a foreground service OR a fullScreenIntent); it uses the regular high-priority template with coloured Answer/Decline. Not compiled here (no Android SDK).
- Gates: check:lock 0, check:rls 0, lint 0 errors, tsc 19 pre-existing/0 new, tests 808 pass / 2 skipped / 6 pre-existing, build 0. Not measured on a device.

## 2026-09-24 — Instant Decline from the call notification (+ smoothness pass)
- Decline no longer launches the app: native CallActionReceiver stops the ringer, removes the notification and clears Telecom instantly, then POSTs a per-call HMAC decline token (minted by send-push, `_shared/callActionToken.ts`) to the new `call-decline` Edge Function (verify_jwt=false; token is the auth). It applies decline_call()'s rules (receiver, in_progress, unclaimed); the existing trigger pushes 'call_rejected' to the caller. Offline/expired → "Tap to finish declining" notification (Android 12 forbids activity trampolines from receivers).
- Requires Supabase secret CALL_ACTION_SECRET + deploy of call-decline and send-push. Without it, Decline uses the old app-launch path (no regression).
- Answer unchanged (must open the app for the call UI; already the fastest allowed path).
- Kotlin NOT compiled here (no Android SDK). Token logic + wiring tested (8 tests).

## 2026-09-24 — "Self-hosted calling isn't set up on this build" (Vercel + APK)
- Cause: VITE_SIGNALING_URL is build-time only and was not set for the Vercel/APK builds → every build without it could never call.
- Fix: runtime config — signaling-ticket (authenticated) returns SIGNALING_PUBLIC_URL (new Supabase secret; `configOnly` mode + included with each ticket); the app fetches it on sign-in and before connecting, validates wss://, caches in localStorage; a build-time URL still wins. Bridge rebuilds a client created before the URL arrived. signalingConfig now uses the standard `import.meta.env.VITE_SIGNALING_URL`.
- Also: type-narrowing fix in useChatRealtimeMessages (alerts zip) — generated Message type lacks important/urgent.
- Requires a deployed signaling server (Docker; not Vercel). See docs/CALLING_SETUP_QUICKSTART.md.
- Gates: lock/rls/lint 0, tsc 19 pre-existing/0 new, tests 834 pass/2 skipped/6 pre-existing, build 0 (with and without the env var). Not tested on devices.

## 2026-09-24 — Fix: routePreload ReferenceError after refactor; iOS origin clarification
- App.tsx used `routePreload` after the map moved to src/lib/routePreload.ts, but only re-exported it (`export … from` creates no local binding) → ReferenceError in the idle warm-up effect on every app start. Added it to the existing import list.
- DO NOT change SIGNALING_ALLOWED_ORIGINS to `DuoSpace://localhost`: capacitor.config.json `ios.scheme` is the Xcode BUILD scheme (Capacitor docs), not the WebView URL scheme; that is `server.iosScheme`, default `capacitor` → the real iOS origin is `capacitor://localhost` (already correct).
- Real local e2e on this tree (real signaling server + LiveKit 1.13.7 + 2 WebRTC peers): PASS, incl. wrong-secret 401. Devices not tested.
