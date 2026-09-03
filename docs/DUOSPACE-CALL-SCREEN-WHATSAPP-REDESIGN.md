# Call screen redesign — WhatsApp reference match (v3.4.5 → v3.4.6)

## Ask
Match the uploaded WhatsApp call-screen screenshot "same to same": minimize /
name+encrypted-lock / add-slot header, big center avatar, 2-row/3-col control
grid (Speaker·Video·Mute / More·Share·End). Dock must be hidden during a call.
Theme-following colors: white stage in light mode, dark in dark mode. No
function removed.

## Real bug found: dock wasn't hidden during a live call
`Calls.tsx`'s in-call block was `flex flex-col flex-1 min-h-0` — a normal
child inside `ChatCallsShell`'s pane, sitting in-flow *below*
`DuoSpaceBottomSurface` (fixed, z-40) rather than covering it. The
composer/nav shell stayed visible (and tappable) over the bottom of every
active call on the Calls tab. Chat's own call screen (`CallOverlay.tsx`) was
already `fixed inset-0 z-[100]` and never had this problem — only the Calls
page's version did. Fixed by giving Calls.tsx's in-call block the same
`fixed inset-0 z-[100]` treatment.

## Color theming
`--call-stage`/`--call-stage-foreground` were previously fixed identical
values in both `:root` and `.dark` (documented as an intentional "always
dark like FaceTime/WhatsApp" choice). Per this explicit ask, made them
theme-following instead: light mode now `0 0% 100%` / `230 15% 14%` (white
stage, dark text — matches the app's own light `--background`/`--foreground`
pairing), dark mode unchanged. Every in-call surface reads these two tokens
(plus alpha steps of the foreground for button fills), so this one change
reskins the whole call UI per theme.

`CallOverlay.tsx` (Chat's own call screen) was separately using
`bg-[hsl(var(--foreground))]` + `text-background` as an inversion hack to
force a dark stage — that pairing is theme-relative, so it was already
subtly wrong (would invert to a bright stage in dark mode). Swapped every
occurrence to the same `bg-call-stage`/`text-call-stage-foreground` tokens
Calls.tsx uses, so both call entry points are now colored consistently and
correctly per theme.

## Layout changes (Calls.tsx only — CallOverlay.tsx left structurally as-is)
- New header: minimize button (navigates to `/chat` — the call itself keeps
  running via `CallContext` at the app root regardless of which page is
  showing, so this is a real minimize, not a hangup) — name + lock icon +
  status line (duration once connected / "Reconnecting…" / "End-to-end
  encrypted" otherwise) — lip-reading toggle (existing feature, kept in the
  same top-right slot). No "add participant" slot: this app is 1:1-only, so
  there's no real action to put there.
- Resolution/screen-sharing badges demoted to a slim row under the header,
  hidden entirely for voice calls (matches the reference's clean layout).
- Center avatar enlarged (h-56, was h-28) for connected voice calls; removed
  the redundant name/duration text underneath it since the header already
  shows both (screenshot only shows the name once, in the header).
- Bottom controls rebuilt as a `grid-cols-3` (naturally 2 rows of 3): Speaker
  (audio-route picker, unchanged) · Video · Mute / **More** · Share (screen
  share, unchanged) · End. Camera-switch and picture-in-picture — both
  conditionally-available secondary features — moved into a new "More" sheet
  instead of being extra always-visible buttons, since the reference is a
  fixed 6-slot grid. All three sheets (More/camera/route) restyled onto
  `bg-call-stage` tokens instead of hardcoded black, so they're theme-correct
  too.
- Nothing removed: every existing handler (toggleAudio/Video/ScreenShare,
  audioRoute, switchCamera, togglePip, endCall/cancelStartingCall/
  cancelAcceptingCall, showLipReading) is still wired to the same logic,
  just under the new visual arrangement.

## Verified
Isolated `tsc --noEmit` per touched file (zero real errors, only expected
missing-React-types/deprecated-flag noise) + bracket-balance sweep — both
balanced. No real build/device test possible in this sandbox, same caveat as
every session; user should verify visually on device.

## Not done this session (flagged)
`CallOverlay.tsx` (Chat's own call screen) only got the dock/color-safety
fixes — it was NOT restructured into the same header/2-row-grid layout, to
keep this pass's regression surface smaller. If you want the Chat-triggered
call screen to visually match too, say so and it can be done as a follow-up.

---

# Session 2: real minimize + Duospace-fixed.zip merge (v3.4.6→3.4.7)

## Fixed a real bug from my own prior session
Last session's Calls.tsx minimize button called `navigate("/chat")`. That
doesn't actually minimize anything — call state (`callState`) is global via
CallContext, so Chat.tsx *also* shows its own full-screen call UI whenever a
call is active. Tapping "minimize" would have just swapped which call
screen's design was showing, not revealed the chat/calls list underneath.

## Real fix: shared `isCallMinimized` flag in CallContext
Added `isCallMinimized`/`setIsCallMinimized` to `CallContextValue` (resets to
false alongside `activeCallType` once `callState` returns to `"idle"`, so the
next call always starts un-minimized). Both `Chat.tsx` and `Calls.tsx` now
gate their full-screen call UI on `!isCallMinimized`, and each renders its
own small persistent pill banner (partner name · duration · inline end
button, tap to restore) when minimized — using the partner-name/duration
each page already fetches locally, so nothing needed to be lifted into
context. Both call screens' minimize buttons now call `setIsCallMinimized(true)`.
`CallOverlay.tsx` (Chat's own call screen) got the same header treatment
Calls.tsx got last session (minimize / name+lock+status / lip-read,
demoted resolution/sharing badges) — that page was flagged "not done" at
the end of the previous session; done now, via a new optional `onMinimize`
prop.

## Duospace-fixed.zip merge
User uploaded this claiming "fixes in different pages." Checked before
merging — it's mostly an **older, divergent snapshot** (67 of 71 differing
files share one identical stale timestamp — the zip's own extraction time,
not real edit times — and diffing several confirmed real regressions:
missing the Language settings page entirely, missing DEPLOYMENT_INVARIANTS.md,
reverting `vite.config.ts` to the `@vitejs/plugin-react`/`plugin-react-swc`
mismatch bug a past session already fixed, and reverting
`useLaunchPermissions.ts`'s deliberate "permission wall" removal back to a
batch-request-everything-on-launch pattern). Same pattern as a past
session's "re-upload missing prior work" case.

Used per-file mtimes to separate real forward progress from stale-base
noise, then verified each candidate file's diff by hand (checked removed
lines specifically, not just added) before applying.

**Applied** (confirmed clean/additive):
- `GroicContext.tsx` + `AudioEnginePlugin.kt` + `docs/MUSIC_NATIVE_PLAYBACK.md`
  + `GroicFullPlayer.tsx` — real fix: native lock-screen/Bluetooth "next"/
  "previous" desyncing the app's own `current`/`position` display from
  what's actually audible. Adds a small resolved lookahead window synced
  to the native side. Android: `ContextCompat.startForegroundService()`
  instead of plain `startService()`. `GroicFullPlayer.tsx` also fixes a
  tap-open/close lag and adds an overflow-y-auto safety net for short
  screens.
- `GroicMiniPlayer.tsx`, `MoodDetector.tsx`, `PeekConfigDialog.tsx`,
  `PeekGuard.tsx` — small haptic-feedback polish additions.
- One line in `MessageTimeline.tsx` (hapticTick on "Load older messages").

**Skipped** (regressions, or just stale-base — no action needed):
- `.gitignore`, `ErrorCard.tsx` — looked like accidental damage (duplicate
  entries / dropped `supportUrl` prop)
- Surprise-feature cluster (SurpriseRenderer/Reveal, 5 scene files,
  useAmbientScene.ts) — has distinct timestamps but diffing confirmed it
  removes the "Phase 4 (§11) live tilt during expanded scene" feature a
  later session added. Real regression, skipped.
- Everything else in the 71-file diff — confirmed via mtime as untouched
  stale-base copies.
- `.yarnrc.yml` (new in fixed) — inert; project uses npm, left out.

## Verified
Bracket-balance + isolated `tsc --noEmit` on every touched file — all
clean. One pre-existing harmless paren-count asymmetry in Chat.tsx traced
to the pristine file itself (not this session's edits).
