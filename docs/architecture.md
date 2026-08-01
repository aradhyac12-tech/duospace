# DuoSpace — Architecture

## Stack

- **Frontend:** Vite + React + TypeScript
- **Native shell:** Capacitor (targets Android + iOS from the same web codebase)
- **Backend:** Supabase (Postgres + Auth + Storage + Realtime + Edge Functions)
- **Calls:** Daily.co (WebRTC), via the `daily-call` edge function
- **Styling:** Tailwind CSS, fully token-driven (see `design.md`)
- **Animation:** Framer Motion, globally wrapped in `<MotionConfig reducedMotion="user">`
- **State/data:** React hooks + Supabase Realtime subscriptions (no global
  state library — each page owns its own Supabase queries/subscriptions)

## Repo layout

```
src/
  pages/            One file per route/screen (Chat, Calls, Gallery, Settings,
                     MapView, Groic, Playlist, Onboarding, Auth, Us, Shayari, ...)
  components/       Shared UI. Notable subfolders:
    chat/            Chat-specific pieces (bubbles' sub-parts, GridMenu/Hub,
                     LoveLetter, ScheduledMessagePicker, MessageReactions, ...)
    surprise/        Surprise Mode (SurpriseReveal, SurpriseScene3D — WebGL)
    auth/            Passkey/QR sign-in components
    skeletons/       Route-level loading skeletons (PageSkeleton, Shimmer)
    ui/              shadcn/ui primitives (button, dialog, toast, etc.)
  hooks/            useAuth, useLipReading, useCloudBackup, useLiveLocation,
                     useDailyCall, etc.
  lib/              Cross-cutting utilities — see "Key lib files" below
  integrations/
    supabase/        Generated types + client
    lovable/          Lovable-platform integration bits
  contexts/          ThemeContext (light/dark/auto + theme engine)
docs/               This documentation set
```

## Key `lib/` files worth knowing

- `haptics.ts` — the full haptic feedback engine (native Capacitor Haptics +
  web `navigator.vibrate` fallback + no-op). See `design.md` for the
  weight-to-action mapping.
- `signedStorageUrl.ts` — mints signed URLs for the private Supabase storage
  buckets (gallery, chat-files, memories). Never use `getPublicUrl()` on
  these buckets — they're private by design; only signed URLs work.
- `errorMessage.ts` — `extractErrorMessage()`, a shared catch-block helper
  that handles both real `Error` objects and Daily.co's plain
  `{errorMsg: string}` rejection shape (a plain `String(err)` on the latter
  produces the literal text "[object Object]").
- `edgeFunction.ts` — `invokeEdgeFunction()`, a hardened wrapper around
  `supabase.functions.invoke` with real error messages, timeout, and
  transport-only retry. Prefer this over calling `supabase.functions.invoke`
  directly anywhere new.
- `auth-callback.ts` — parsing/handling for the native OAuth deep-link
  callback (`duospace://auth`).
- `fontLoader.ts` — the user-selectable font-pair system (Theme Studio);
  `FONT_PRESETS[0]` is the current default pairing.
- `themeEngine.ts` — light/dark/auto/schedule theme resolution.
- `storage.ts` — thin localStorage/Capacitor Preferences wrapper used for
  simple client-side persisted state (not to be confused with Supabase
  Storage for files).

## Data model & security

- **E2E encryption:** message content is encrypted client-side; keys are
  stored in IndexedDB with `extractable: false` (moved off localStorage
  JWK during an earlier hardening pass — do not regress this).
- **RLS everywhere:** every table has row-level security scoped to "you or
  your linked partner." There is no server-side code path that assumes
  more than two people can see a given row.
- **Storage buckets are private:** `gallery`, `chat-files`, `memories` are
  all private buckets. Display code must resolve a signed URL
  (`signedStorageUrl.ts`), never a public URL.
- **WebAuthn/passkeys:** full register/verify + login/verify edge function
  pairs, backing `PasskeyRegister`/`PasskeyLogin`.
- **App-lock:** PIN (hashed, `crypto.ts`) and/or biometric
  (`AppLockScreen.tsx`), independent of Supabase auth — this is a
  local-unlock gate in front of an already-authenticated session.
- **QR pairing:** cryptographically random tokens, brute-force protected,
  atomic claim (can't be redeemed twice), backing both the "new partner
  onboarding" flow and "sign in on another device" flow.

## Edge functions

15 total, all deployed to the active Supabase project (`jzlpelxwzjjpddqcrtpu`):
`qr-anon-issue`, `issue-qr-token`, `redeem-qr-token`,
`webauthn-register-options`, `webauthn-register-verify`,
`webauthn-login-options`, `webauthn-login-verify`, `daily-call`,
`notify-signin`, `send-email`, `set-email-password`, `finalize-upload`,
`music-search`, `cleanup-orphan-uploads`, `deliver-scheduled-messages`,
plus `complete-signup` (auto-confirms + mints a session immediately after
sign-up, since no SMTP/email provider is configured — see `phases.md`).

Deployed copies have `_shared/*.ts` helper code inlined, because the deploy
tool used couldn't resolve cross-function relative imports. The **repo
source** still uses normal shared imports — that's correct for CLI-based
(`supabase functions deploy`) deploys; only the already-deployed copies
needed inlining as a workaround.

## Native build

- Capacitor-based; `setup-native.sh` automates zero-manual-setup builds.
- **`android/` and `ios/` directories do not exist in this checkout** —
  `cap add android` / `cap add ios` has never been run here. This sandbox
  has no build tooling or network access, so the native build pipeline
  (`npm install`, `cap sync`, Gradle/Xcode build) has not been run or
  verified from this environment. Whoever picks this up next needs to run
  it themselves and check the resulting `AndroidManifest.xml` intent
  filters for the `duospace://auth` scheme.
- Native Swift/Kotlin additions exist for background audio and calls.

## AI Privacy & Emotion Engine

On-device computer vision for two features, sharing one detection stack.
Nothing here ever leaves the device as image data — only derived numbers
(embeddings, mood labels/scores) are persisted, and only mood data goes to
Supabase (`mood_logs`); face embeddings stay local in IndexedDB.

```
lib/faceMath.ts             Pure landmark math (embedding/EAR/pose/bbox)
                             plus textureScoreFromGrayscale() — a weak,
                             unvalidated Laplacian-variance/luma-stddev
                             anti-spoof supplement (see its doc comment for
                             honest limits: doesn't catch screen replay/
                             moiré, doesn't catch good-quality prints).
                             Zero DOM deps — shared by both paths below so
                             they produce numerically identical embeddings.
lib/faceRecognition.ts      Main-thread MediaPipe FaceLandmarker wrapper.
                             detectFaces() — used by enrollment (still-image
                             sources) and as the peek-guard fallback path.
                             Also owns IndexedDB owner-embedding storage
                             (saveOwnerProfile/loadOwnerProfile) and
                             matching (matchAgainstOwner, cosine similarity,
                             getAdaptiveMatchThreshold). Does NOT compute
                             textureScore — only the worker path does.
workers/faceDetection.worker.ts   Same FaceLandmarker model, running in a
                             module Worker. This is peek-guard's hot path —
                             keeps ~15-30ms/frame inference off the main
                             thread so it never competes with React render
                             or the lock-screen's own animation. Also reads
                             raw pixels (via a small reused OffscreenCanvas)
                             for the largest face only, to compute the
                             texture-score anti-spoof supplement before
                             closing the ImageBitmap.
lib/faceWorkerClient.ts     Main-thread client for the worker: captures a
                             video frame as a transferable ImageBitmap,
                             posts it to the worker, resolves by message id.
                             isWorkerSupported() gates automatic fallback to
                             faceRecognition.ts's main-thread path on older
                             WebViews or on any worker error.
hooks/usePeekDetection.ts   Orchestrates the peek-guard pipeline: schedules
                             detection off requestVideoFrameCallback
                             (throttled to a *dynamic* interval — see
                             "Battery/dynamic FPS" below — falls back to a
                             fixed setInterval where rVFC is unsupported),
                             runs owner-match + two-channel liveness (blink
                             EAR drop + head-pose micro-movement) + N-frame
                             consistency gating, computes a 0-100 threat
                             score, and exposes `isPeeking`/`threatLevel`.
                             A stranger face with neither liveness signal
                             defers as a possible static photo/poster, but
                             escalates to a forced lock (`reason: "spoof"`)
                             after `staticStrangerTimeoutMs` (default 6s)
                             of continuous zero-movement presence.
components/PeekGuard.tsx    Consumes the hook, renders the blur/lock
                             overlay, reads config from ThemeContext's
                             appSettings (peek* keys). After dismissal,
                             shows a brief "was that accurate?" feedback
                             prompt (logged via lib/peekEventLog.ts) before
                             calling the hook's dismiss() to re-arm. When
                             `appSettings.peekDebugMode` is on, also renders
                             a small always-on corner HUD (polls the hook's
                             getDebugSnapshot() every 500ms — zero cost when
                             the setting is off) showing threat score,
                             face/stranger counts, worker-vs-fallback
                             status, effective polling interval/tier, and
                             camera-covered state. Lock screen uses a
                             radial-gradient vignette (not flat black) and
                             a pulsing glow halo behind the shield icon for
                             a more premium depth feel.
lib/peekEventLog.ts          Local (localStorage, never synced) log of
                             lock events + user feedback — backs the
                             Security Dashboard's stats. Every stat is
                             either a real logged number or an explicit
                             "not enough data yet", never a placeholder.
components/SecurityDashboard.tsx   Read-only dashboard opened from
                             PeekConfigDialog: privacy score (transparent
                             additive checklist, not a black-box number),
                             locks today/week, avg lock speed, false-alarm
                             rate, enrollment quality, recent events. No
                             CPU%/battery-draw numbers — there's no
                             standard web API for either; says so rather
                             than faking a number.
components/FaceEnrollmentDialog.tsx   Captures owner reference embeddings
                             via the main-thread detectFaces() path.
components/MoodDetector.tsx  Independent feature, same FaceLandmarker
                             model (main-thread path) but its own 5-second
                             multi-sample window: extracts 4 expression
                             features (mouth curve/openness, brow raise,
                             eye openness) per sample, blink-filters and
                             recency-weights them, scores 7 moods, and
                             turns the scores into a softmax probability
                             distribution (stored in full in
                             `mood_logs.features.mood_probabilities`, not
                             just the winning label). Capture phase shows a
                             face-scan-style overlay (corner brackets +
                             sweeping scan line, framer-motion).
components/MoodHistory.tsx  Trends view over `mood_logs` — today/30-day
                             positivity score, 7-day bar chart (recharts,
                             already a dependency), dominant mood, and a
                             time-of-day (Morning/Afternoon/Evening/Night)
                             breakdown. Opened from Settings → Security &
                             Privacy → "Mood history" (shown when Daily
                             Mood is enabled). All aggregation happens
                             client-side over rows fetched for the signed-
                             in user; no server-side aggregation function.
```

**Why a Worker only for peek-guard, not mood detection:** peek-guard runs
continuously while the app is open (real latency/battery pressure); mood
detection is an explicit, user-initiated 5-second one-off, so the main-thread
path's cost is bounded and not worth the added complexity — revisit if
mood detection ever becomes continuous/ambient.

**Owner embeddings never leave the device.** They're stored in IndexedDB
(`duo-assets`/`blobs`, key `owner-face-embeddings`), never uploaded, never
included in a backup export.

**Battery / dynamic FPS:** `usePeekDetection`'s polling interval isn't
fixed — it's recomputed every tick from that tick's own signals and scales
off the user's own configured `checkInterval` ("normal" baseline), not
hardcoded absolutes:
- **Idle** (no face in frame): ~2.5x slower than baseline.
- **Normal** (owner steadily present): the configured baseline.
- **Movement/uncertain** (stranger and/or multiple faces and/or a face
  showing no liveness signal yet): ~2x faster, floored at 100ms.
- **Threat** (threat score ≥ 60, or a spoof escalation just fired): ~4x
  faster, floored at 80ms — confirm or clear the situation as fast as the
  worker round-trip realistically allows.

Independently, a per-tick 8x8-pixel brightness sample (own tiny canvas,
not the worker) detects a physically covered/blocked lens — sustained
near-total darkness for 3 consecutive ticks skips the expensive MediaPipe
call entirely (the dominant per-tick cost) until it clears. This is a
coarse heuristic (a dark room can also trigger it), not a precise
"object over camera" classifier.

The pipeline also pauses fully (no camera polling at all) on
`document.hidden` (web) and, on native builds, on Capacitor's
`appStateChange` going inactive — the latter exists because
`visibilitychange` isn't always reliable inside a native WebView when the
screen locks or the app is swapped away.

## Nav structure

Bottom `FloatingDock` shows exactly 3 destinations: Chat, Calls, Settings.
Everything else (Gallery, Map, Music, Shayari, Us) lives in the in-chat
sparkle "Hub" (`GridMenu.tsx`, opened from Chat.tsx) — there is no "More"
tab/sheet; it was deliberately removed in favor of the Hub.
