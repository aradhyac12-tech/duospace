# DuoSpace — Phases

A chronological view of where this project has been and where it's headed.
For the detailed "what broke and how it was fixed" history, see
`docs/memory.md`. This file is the higher-level roadmap.

## Phase 0 — Core build-out (complete)

Chat, Calls, Gallery, Groic/Playlist, MapView, Us, Shayari, Settings,
Onboarding, Auth all built with real feature depth (not stubs) — E2E
encrypted messaging, Daily.co calls, private-bucket media storage,
QR/passkey/biometric auth, WebAuthn, a full theme engine, and the
Surprise Mode flagship feature.

## Phase 1 — Security hardening (complete)

Multi-round security audit taking the score from 38/100 to 94/100:
- E2E key storage moved off extractable localStorage JWK → IndexedDB
  non-extractable
- RLS hardened across all tables (private-by-default, partner-scoped)
- Storage buckets made private with signed-URL access
- QR pairing rebuilt with cryptographically secure, brute-force-protected,
  atomically-claimed tokens
- Passkey/WebAuthn tables and edge functions added
- 16+ Supabase migrations, 8+ edge functions grew to today's 15

## Phase 2 — Bug-fix & reliability sweep (complete)

A long tail of real bugs found and fixed, including: partner-request
notifications never arriving (bad column selection), location tab unable
to scroll, WhatsApp import invisible to partner and chronologically
scrambled (day/month date-parsing bug), voice recording cancelling itself
mid-hold (missing pointer capture), duplicate sign-in notifications, a
reactions bug allowing multiple emoji per user per message, broken
gallery/chat images (public-URL-on-private-bucket), and the native OAuth
redirect root-caused to a missing Supabase Dashboard allow-list entry.
Full detail in `docs/memory.md`.

## Phase 3 — Full UI/UX redesign (complete, this engagement)

Chosen direction: bold single-accent on deep charcoal, Nothing OS/Linear
register. Covered:
- Complete design token rebuild (color/type/radius/elevation/motion) —
  see `docs/design.md`
- Settings restructured to default-collapsed (fixed a real "feels like
  one long scroll" problem)
- Full-repo sweep (112 `.tsx` files) removing hardcoded colors and
  monochrome CTA patterns in favor of the token system
- Touch-target audit, file-by-file (not blind mass-resize)
- A contrast regression caught and fixed mid-pass (solid `bg-accent`
  paired with unset/wrong-token icon colors in ~16+ spots)

## Phase 4 — Haptics (in progress)

Goal: every interactive action in the app fires a haptic weighted to its
meaning (mild → max), using the already-excellent `lib/haptics.ts` engine.
Coverage went from 113/300 to 231/300 `onClick` handlers in this pass —
see `docs/design.md`'s coverage table for exactly which files are fully
wired and which still have gaps. **Not yet complete** — remaining files
are lower-traffic dialogs/editors (Settings' remaining handlers,
CodeSurpriseEditor, Us, Shayari, MapView, ThemeStudio, Groic,
GroicFullPlayer, FaceEnrollmentDialog, MoodDetector, GridMenu).

## Phase 5 — AI Privacy & Emotion Engine upgrade (in progress, started 2026-07-30)

Upgrading `usePeekDetection`/`PeekGuard`/`MoodDetector` toward a flagship
privacy+emotion experience, in scoped sub-passes rather than one giant
rewrite (see `docs/memory.md` for the reasoning and full detail per item).

**Done:**
- ✅ **2026-07-30 — Speed:** off-thread detection via a new module Worker
  (`faceDetection.worker.ts` + `faceWorkerClient.ts`), landmark math
  deduped into `lib/faceMath.ts`, polling moved to
  `requestVideoFrameCallback`, `lockDelay` default 500ms → 150ms.
- ✅ **2026-07-30 — Mood engine:** replaced the single-path if/else mood
  cascade with a 7-mood evidence scorer + softmax probability
  distribution (stored in full, not just the winner), blink-filtered +
  recency-weighted sample averaging.
- ✅ **2026-07-30 — Security:** second liveness channel (head-pose
  micro-movement, alongside the existing blink-EAR check), a
  `staticStrangerTimeoutMs` escalation so a persistently motionless
  unrecognized face locks after a configurable timeout instead of
  deferring forever, and a heuristic 0-100 threat score
  (`threatScore`/`threatLevel`) surfaced on the lock screen for elevated
  threats. **Not full anti-spoof** — no pixel-level texture/moiré replay
  detection (would need raw frame access in the worker, not just
  landmarks); see `docs/memory.md` for the honest scope note.
- ✅ **2026-07-30 — Battery:** dynamic FPS (idle/normal/movement/threat
  tiers, scaled off the user's own configured `checkInterval`), a
  brightness-based camera-covered detector that skips the expensive
  MediaPipe call entirely while covered, and a native-specific
  `appStateChange` pause (`visibilitychange` alone isn't always reliable
  inside a native WebView).
- ✅ **2026-07-30 — Settings/dashboard UI:** `SecurityDashboard.tsx`
  (opened from `PeekConfigDialog`) — privacy score (transparent additive
  checklist), locks today/week, avg lock speed, false-alarm rate (needs
  ≥3 rated events), owner-enrollment quality, recent events. New
  `lib/peekEventLog.ts` local event log backs it, and `PeekGuard.tsx`
  gained a post-dismissal "was that accurate?" feedback prompt to
  populate the false-alarm stat. **No CPU%/battery-draw numbers** — no
  standard browser API for either; the dashboard says so rather than
  faking a number. **No debug mode / developer-stats toggle** — not
  attempted this pass, still open below. Fixed a real bug found while
  building this: `isPeeking` was never reset anywhere, so the lock could
  only ever fire once per app session (see `docs/memory.md`'s "Real bugs
  found and fixed").
- ✅ **2026-07-31 — Mood history/trends UI:** `MoodHistory.tsx` — today's/
  30-day positivity score, 7-day recharts bar chart, dominant mood,
  time-of-day breakdown. Opened from a new "Mood history" row in
  Settings. **Also fixed a more serious pre-existing bug found while
  building this** — `mood_logs` inserts have very likely been failing
  outright the whole time (a `features` column the code sent was never
  actually in the live schema). Migration + `MoodDetector.tsx` error
  handling added — **migration not yet applied to the live database**,
  see `docs/memory.md` for the "run this before trusting mood data" note.
- ✅ **2026-07-31 — Debug mode / developer stats:** `getDebugSnapshot()`
  on the hook (worker vs. fallback, dynamic-FPS interval, camera-covered
  state, tick-in-flight — read from refs, zero cost when unused) plus a
  small always-on corner HUD in `PeekGuard.tsx`, toggled from a new
  "Advanced" section in `PeekConfigDialog`. Engineering-facing
  counterpart to the Security Dashboard's user-facing stats.
- ✅ **2026-07-31 — Premium lock/mood animations:** lock-screen backdrop
  is now a radial-gradient vignette with a pulsing glow halo behind the
  shield icon (was flat black + plain icon pulse); mood-detection capture
  phase gained a face-scan overlay (corner brackets + sweeping scan
  line). Both `motion.*`-based specifically so they inherit `App.tsx`'s
  existing `MotionConfig reducedMotion="user"` for free — no new
  reduced-motion handling needed or written.
- ✅ **2026-07-31 — Pixel-level anti-spoof (partial, honestly scoped):**
  `textureScoreFromGrayscale()` in `faceMath.ts` (Laplacian variance +
  luma std-dev), computed in `faceDetection.worker.ts` from raw pixels
  (largest face only, via a reused `OffscreenCanvas`, before the
  `ImageBitmap` closes) and fed into the threat score as a minor +10
  contributor — never a lock-gating signal on its own. **Does NOT catch
  screen/tablet replay (no moiré/FFT analysis) or good-quality prints —
  only flat/blurry low-quality ones.** Thresholds
  (`laplacianVar < 15 && lumaStdDev < 8`) are **unvalidated placeholder
  guesses** — no way to calibrate against a real device/camera in this
  sandboxed session. See `docs/memory.md` for the full honest scope note.
  Visible in the debug HUD for tuning.

This closes out every item from the original 16-step spec — the items
above with an explicit scope note (anti-spoof here, mood's 7-vs-20
labels, dashboard's missing CPU/battery numbers) are deliberate,
documented trade-offs, not gaps that were missed.

**Planned (not started):**
- ⏳ **Real-device validation, all of the above.** Nothing in this phase
  has run through an actual `npm install && npm run build`/`tsc` pass or
  been tested on a real camera/device from this sandboxed session (no
  network, no camera access here). Before trusting any of it: run the
  build, apply the pending `mood_logs` migration (see `docs/memory.md`),
  and tune the anti-spoof/battery-tier constants against real hardware.

## Open blockers (not fixable from a sandboxed coding session)

- **Native directories missing.** `android/`/`ios/` have never been
  generated in any checkout used for this work (`cap add` never run).
  No sandbox used on this project has had network/build tooling to run
  `npm install`, `cap sync`, or a Gradle/Xcode build. Someone with a real
  dev machine needs to run the native build pipeline and confirm the
  merged `AndroidManifest.xml` intent filters.
- **Google OAuth native redirect.** Root-caused via live Supabase auth
  logs: `duospace://auth` is not in Supabase Dashboard → Authentication →
  URL Configuration → Redirect URLs, so it falls back to the web Site
  URL instead of returning to the native app. This is a dashboard config
  change, not a code fix — add `duospace://auth` and
  `duospace://auth/reset-password` there.
- **No SMTP/email provider configured** on the Supabase project, so the
  built-in confirmation email never arrives. Worked around with a
  `complete-signup` edge function that auto-confirms + mints a session
  immediately after sign-up (time-boxed to 15 minutes post-creation so it
  can't be used to confirm arbitrary emails later) — but if transactional
  email (password reset, notifications) is ever needed, an actual
  provider still needs to be wired up.
- **Pending migration not yet applied everywhere:** confirm which
  Supabase project is "live" before applying new migrations — this
  project has switched active Supabase projects before
  (`ffrsohhfqcypnkkbtali` → `jzlpelxwzjjpddqcrtpu`); always verify via a
  live query, not assumption, before trusting a migration has landed.

## Suggested next phase (not started)

- Finish haptics coverage on the remaining files listed above.
- Run the native build pipeline end-to-end on a real machine and close
  out the Android/iOS blocker.
- Fix the Supabase Dashboard redirect-URL config for native Google OAuth.
- Decide whether a real transactional email provider is worth wiring up,
  or whether the `complete-signup` workaround is acceptable long-term.
