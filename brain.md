# brain.md — Phase 7 Audit Trail

Working notes for the "Full Product Surface Audit & Interaction Polish" pass.
This file exists so a session picking this up later doesn't have to re-derive
what's already been checked. Update it as you go — append, don't rewrite.

**Ground rule carried from the brief:** only change things that fix a real,
evidenced problem. Every entry below either found a concrete bug or
confirmed a surface is already solid — "confirmed clean" is a valid, useful
outcome, not a skipped step.

---

## Status by surface

| Surface | Status | Notes |
|---|---|---|
| Chat | ✅ audited (earlier phase) | Living Surprise embedding, keyboard-flicker fix |
| Calls | ✅ audited (earlier phase) | — |
| Surprise (Living Surprise 2.0) | ✅ built + audited | All 4 build phases done: chat-embedded message, 5 mood scenes, haptic engine, tilt-as-depth |
| Permissions / Splash | ✅ audited | Launch permission wall removed, splash-continuity gap fixed |
| Music (Groic) | ✅ audited | 1 bug fixed (see below). Rest already hardened — has its own prior dated AUDIT FIX comments |
| Map | ✅ audited | 1 bug fixed (see below) |
| Cross-cutting: motion tokens | ✅ audited | 2 duplicate springs consolidated (see below) |
| Cross-cutting: radius/spacing/opacity tokens | ✅ audited | 2 radius fixes made; spacing and opacity both confirmed already clean (see below) |
| Gallery | ✅ audited | 1 bug fixed (see below) — high-leverage, affects 3 other surfaces too |
| Us / Profile | ✅ audited | 1 bug fixed (see below); rest reviewed, no other concrete defect found |
| Settings (remaining sections) | ✅ audited | Devices, Security, Notifications, Data & Backup, Appearance, Import, Partner all read end-to-end this pass — error handling, loading/disabled guards, and confirm-before-destructive patterns already consistent throughout. One real gap fixed: PIN keypad's digit/backspace buttons had no `aria-label` (screen reader read nothing for "⌫"; the blank filler cell was still focusable) — added labels + `aria-hidden`/`tabIndex=-1` on the filler (`SecuritySettings.tsx`) |
| Peek Guard (UI/state layer) | ✅ done — table was stale | This table said "not started" but the work already landed and is fully documented in `docs/FLAGSHIP_INTERACTION_QA.md` §1 (semantic haptics, auto-biometric prompt, alertdialog `aria-label` + autofocus, reduced-motion via `MotionConfig`) — confirmed against the current `PeekGuard.tsx`, matches exactly. Only the manual device-QA checklist items in that doc remain genuinely open (see below) |
| Mood Detection (UI/state layer) | ✅ done — table was stale | Same situation: `docs/FLAGSHIP_INTERACTION_QA.md` §3 covers camera-permission-denied handling, no-face/multi-face/low-light/model-failure branching, live in-scan hints, and the detected-vs-confirmed confidence UI — confirmed present in `MoodDetector.tsx` |
| Auth / onboarding / notifications / app lock | ◐ partially done | App Lock (PIN) UI covered by FLAGSHIP_INTERACTION_QA.md §2. Broader auth/onboarding flow audit not done this pass. Two real, non-code items already identified in `docs/phases.md`: (1) `duospace://auth` redirect URL missing from Supabase Dashboard → Auth → URL Configuration, breaking native Google OAuth; (2) the `complete-signup` edge function is deployed but unused now that Resend SMTP handles real confirmation emails — flagged as attack surface worth formally removing via Supabase dashboard/CLI. Neither is a code change, both need a human with dashboard access |
| Error/offline/empty/loading states (global sweep) | ◐ spot-checked | Every Settings subview, Peek Guard, and Mood Detector confirmed to handle loading/error/empty states correctly. Did not do an exhaustive sweep of every remaining screen (Chat/Calls/Gallery/Groic/Map already had their own dedicated audits in earlier phases per the project history) |
| Accessibility | ◐ spot-checked | Static scan for icon-only buttons missing `aria-label` across `src/` came back clean except the PIN keypad fix above (false positives from the scan script were manually checked and ruled out). Confirmed reduced-motion is handled globally via `MotionConfig reducedMotion="user"` in `App.tsx` plus explicit gating in `SurpriseReveal.tsx` for non-framer-driven motion. Not a full WCAG audit |
| Security regression audit | ❌ still blocked | Needs live Supabase project access this environment doesn't have — inspection-only at best |
| Test matrix (Phase 24 of brief) | ❌ still blocked | Same as above — most matrix rows need a live build/device |
| Native device QA (Phase 25) | ❌ not possible from this sandbox | No physical device, no native build tooling |
| Build/lint/test release gate (Phase 26) | ❌ blocked | `npm ci` fails — no network egress in this environment (403 from registry). Must be run elsewhere. |

**On this session's re-audit:** `docs/FLAGSHIP_INTERACTION_QA.md` documents real, already-shipped work for exactly the two rows this table had marked "not started" (Peek Guard, Mood Detection). Whoever ran that phase didn't loop back to update this table. Lesson for next session: check `docs/` for a QA doc matching a surface's name before assuming a ⬜ row means untouched code — the checkbox items *inside* those QA docs are genuinely open (they're manual/device verification), but the implementation rows above them are often already done.

---

## Fixes made this pass (chronological)

### Music (`GroicMiniPlayer.tsx`, `GroicFullPlayer.tsx`)
`GroicContext` already tracked `loading` (resolving a stream URL) and
`buffering` (native engine stalled) but neither was ever rendered. Tapping a
new track swapped artwork/title instantly with zero feedback while the
stream resolved. Both play buttons now show a spinner and no-op the tap
while busy.
Reviewed and deliberately left alone: no auto-retry on network recovery for
a failed track — the file has an established principle elsewhere (call
interruption handling) of never auto-resuming audio without explicit user
action; adding auto-retry here would contradict that.

### Map (`useLiveLocation.ts`, `LocationContext.tsx`, `MapView.tsx`)
The "permission denied" retry button called `navigator.geolocation` directly
and unconditionally, bypassing the `@capacitor/geolocation` plugin the rest
of the engine uses on native (the WebView's own geolocation API doesn't
reliably bridge to the OS permission dialog). Also found: even a genuine
grant (e.g. via system Settings) wouldn't resume tracking — no reactive
permission-change listener on native, and the existing recovery effect only
retried on network `online`, never on permission change. Added a
`retryPermission` function to the engine (platform-correct, resumes the
watcher on grant), wired it through `LocationContext`, and hooked it into
the existing visibility-regain handler so returning from Settings self-heals
without the button. Denied-state copy is now platform-aware too.

### Cross-cutting motion tokens (`lib/motion.ts` + 4 call sites)
Grepped every hardcoded `type: "spring"` literal (17 found) against files
importing the shared `lib/motion` tokens (only 13 did) — 14 files had drift.
Rather than mechanically retuning all 14 (real risk of changing
deliberately-tuned feel with no evidence anything was wrong), checked for
EXACT numeric duplicates across unrelated files — the real signature of
"this should've been a shared token". Found two:
- `420/38` reinvented independently in `BackupManager.tsx` and
  `LipReadingOverlay.tsx` → promoted to `firmSpring`.
- `500/35` reinvented independently in `BottomNav.tsx` and
  `CallHistoryRow.tsx` → promoted to `swiftSpring`.
Zero visual change (same numbers). The other ~13 unique literals were left
untouched — no cross-file duplicate means no evidence of drift, just variety.

### Gallery / image system (`lib/signedStorageUrl.ts`)
The signed-URL resolver had **no caching** — its own prior comment said
"call sites re-sign on every load anyway" as if that were neutral. It's
actually the root cause of the flicker complaints spanning Chat, Gallery,
PhotoViewer, and MemoryWall: every signed URL carries a unique token, so
re-signing the same photo on every refetch (remount, realtime insert,
pull-to-refresh) produced a different `<img src>` for unchanged content —
and browsers cache by exact URL, so a changed src forces a full
re-download + re-decode. Added an in-memory cache keyed by (bucket, path)
with a safety margin under the signed URL's own TTL. One file, no call-site
changes, fixes all four surfaces at once.

### Cross-cutting radius/spacing/opacity sweep (`index.css`, `tailwind.config.ts` + 3 call sites)
Same method as the motion pass: mechanical duplicate-detection, not
subjective "this looks inconsistent" judgment calls.

- **Radius — 2 real findings, both fixed.** Grepped every `rounded-[...]`
  arbitrary value in the app (16 hits). `GridMenu.tsx` used `rounded-[26px]`
  — an exact hand-written duplicate of the *already-existing*
  `--radius-floating` token (26px, described in index.css as "composer,
  attach tray, dock" — GridMenu literally is the attach-tray/hub menu).
  Repointed to `rounded-floating`; MessageComposer.tsx already did this
  correctly, only GridMenu had drifted. Separately, three unrelated files
  (`GroicFullPlayer.tsx`, `Us.tsx`, `SurpriseReveal.tsx`) had each
  independently arrived at the exact same 28px "large glass panel" radius,
  written three different ways (`rounded-[28px]` ×2, `rounded-[1.75rem]`
  ×1) with no shared name. Added a new `--radius-panel` token (same
  "purely additive, only retarget genuine duplicates" rule the existing
  floating/pill tokens were added under) and pointed all three at it.
- **Spacing — confirmed clean, nothing to fix.** Grepped every arbitrary
  spacing value (`p-[...]`, `gap-[...]`, etc.) app-wide: only 4 exist
  total, each used exactly once, all trivial 1-3px nudges. No cross-file
  duplication — the default Tailwind spacing scale is already used
  consistently everywhere else.
- **Opacity — confirmed clean, nothing to fix.** `border-border/60` is
  already the overwhelmingly dominant convention for card/row borders
  (~90 uses across Settings, Groic, Gallery, IconStudio, ThemeStudio, and
  more) — already consistent, not drift. The outlier fractions (`/40`,
  `/30`, `/20`, `/10`) show up in contextually distinct, less-prominent
  UI (message-list separators, context menus) — legitimate intentional
  variation, not accidental duplication of what should have been `/60`.
  Also: unlike radius, Tailwind's `/NN` opacity syntax has no
  arbitrary-bracket escape hatch to grep for — there's no hidden token an
  opacity value could be silently duplicating, so the radius-style
  duplicate-detection method doesn't really apply here the same way.

### Us / Profile (`Us.tsx`)
Read through the full 652-line file rather than a grep sweep, per this
surface's own brief (UX/content judgment, not mechanical consistency).
Reviewed and confirmed correct, not bugs: the "day streak 🔥" stat is a
genuine relationship metric (consecutive days both partners answered the
daily question), not gamification clutter; `pet_name` cross-referencing
between `profile`/`partnerProfile` is correct per the established semantics
(each person's own profile row stores what THEY call their partner);
loading/error/empty states are all present and handled; both realtime
channels are properly filtered server-side and cleaned up on unmount.

One real bug found and fixed: the per-row countdown delete button used
`opacity-0 group-hover:opacity-100` with no touch fallback — on a touch
device (this app's primary platform) there's no hover state, so the button
was permanently invisible and the countdown's creator had no way to delete
it on mobile at all. No swipe/long-press alternative existed for that row
either. Cross-checked the rest of the app for the same `group-hover`-only
pattern before fixing anything: `Gallery.tsx` and `CallHistoryRow.tsx`
already have working touch-safe variants of this exact pattern (the fix
here reuses `CallHistoryRow.tsx`'s approach — dim-but-tappable on mobile,
hover-to-fully-reveal only past the `md:` breakpoint). Also checked
`MessageBubble.tsx`'s two hover-only Reply buttons, which look like the same
bug at first glance but aren't — swipe-to-reply and the long-press context
menu both already reach the exact same action on touch, so those are a
legitimate desktop-only convenience shortcut, not a dead end. Left those
alone. `ThemeStudio.tsx`'s one remaining hover-only instance starts at
`opacity-70` (already visible, hover just brightens it) — not a touch
dead-end either.

---

## NEXT: Settings (remaining sections, brief §11)

Not yet started beyond the Language row added in an earlier phase. The
brief wants these discoverable from Settings: Notifications, Privacy,
Security, Peek Guard, Mood Detection, Permissions, Appearance, Haptics,
Accessibility, Account — worth checking which of these already have a real
section vs. are missing entirely (same shape of gap as the Language row
was before it existed), plus a read-through of the sections that do exist
for the same "no unnecessary cards, no dead-end touch targets" issues found
elsewhere this pass.

After Settings, remaining unstarted surfaces in no particular order beyond
"smaller/more contained first": Peek Guard's UI/state layer, Mood
Detection's UI/state layer, auth/onboarding/notifications/app-lock, then
the larger cross-cutting sweeps (accessibility, error/offline/empty states
globally, security regression audit, test matrix).

## Known environment limitations (apply to every future session, not just this one)

- No network egress in this sandbox → `npm ci`/`build`/`lint`/`test` cannot
  actually be run here. Confirmed via 403 from the npm registry. Anyone
  continuing this work needs to run the Phase 26 release gate in an
  environment with registry access before trusting anything compiles.
- No physical device access → native lifecycle behavior, haptics feel, and
  real Chat↔Calls transition smoothness are reviewed via code inspection
  only, never actually verified on-device from here.
- No live Supabase project access → RLS/security audit items can only be
  inspected against migration files, not verified against the actual
  deployed policy state.
