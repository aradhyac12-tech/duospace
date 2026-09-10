# DuoSpace Redesign — Phase 2: Map & Calls

**Continues from:** `docs/DUOSPACE-REDESIGN-PHASE-1.md` (global tokens,
navigation, Chat). **Scope of this phase:** Map, Calls, and shared
floating/contextual control primitives those two needed. Gallery, Groic,
and Music were **not** touched.

**Toolchain note:** same sandbox constraint as Phases 0–1 — no network
egress, `npm install` 403-blocked, `node_modules` empty. Verification was
`tsc --noEmit` against the project's own `tsconfig.app.json` (with the
unavailable `vitest` types excluded via an extended config, same as Phase
1), plus a manual read-through of every changed file. `eslint` itself
still isn't fetchable in this sandbox. All remaining `tsc` output after
filtering is either module-resolution noise (`TS2307`, `TS2875`, `TS2882`
— no `node_modules`) or a pre-existing, repo-wide `key`-prop false
positive (`TS2322`) that appears identically in dozens of files this phase
never touched (`Groic.tsx`, `Playlist.tsx`, `Us.tsx`, `Shayari.tsx`,
`NotificationsSettings.tsx`, etc.) — confirmed to be the same artifact
described in the Phase 1 doc, not something new.

---

## 1. The critical requirement: removing the location-mode switch

Per this phase's explicit instruction, `src/pages/MapView.tsx`'s
**"Location Sharing Mode" switch (persistent vs. on_open) has been
removed.** This was the exact discrepancy flagged in Phase 0
(`docs/DUOSPACE-REDESIGN-AUDIT.md` §8): the switch let a user pause live
location, battery, and ringer sharing for as long as the Map page wasn't
open, which functions like a hidden off-switch even though it was framed
as a "mode."

**What changed, precisely:**
- The `Switch` UI, its label/copy ("Location Sharing Mode", "Always
  sharing in background" / "Share only when app is open"), and the local
  `locationMode` state that drove it are gone.
- `sharingActive` — the flag that gates both `useLiveLocation`'s `active`
  prop and `usePublishDeviceStatus`'s `enabled` prop — is now the constant
  `true`, evaluated only against `!!user`. There is no remaining
  user-facing path in this app to pause or disable location, battery, or
  ringer sharing while signed in.
- The Map page no longer reads `profiles.location_mode` when it loads the
  partner's profile, and no longer writes to that column. **The database
  column itself was not touched** — no migration, no schema change — it's
  simply unused by the UI going forward. Any historical value stored there
  is now inert.
- Every underlying system this switch used to gate is **completely
  unchanged**: `useLiveLocation`'s permission handling, GPS watcher,
  realtime publish/subscribe, retry/backoff, staleness detection, and the
  polling fallback; `usePublishDeviceStatus`'s battery/charging/ringer
  publish logic; the `locations` table and its RLS; the presence/heartbeat
  system. Only the boolean that was previously sometimes `false` is now
  always `true`.
- One second-order effect worth flagging explicitly: `useLiveLocation`
  has a `"paused"` tracking state that only occurs when its `active` prop
  is `false`. Since Map now always passes `active: true`, this state is
  no longer reachable from Map's usage of the hook. The hook itself still
  defines and can still enter that state in principle (nothing in the hook
  was edited) — it's just that Map's own `sharingActive = true` means it
  won't happen in practice anymore. The now-dead "Paused — sharing only
  when app is open" status copy that referenced it was removed from the
  tracking-status line in the new status sheet.

This is a genuine behavior change, made deliberately and only because this
phase's brief explicitly instructed it ("remove the conflicting UI only if
consistent with the current product requirement... document exactly what
changed"). If a user previously had `on_open` mode selected, their
experience going forward is that location/battery/ringer now share
continuously instead of only while Map is open — which is the entire point
of the fix, not a side effect of it.

## 2. Map — layout redesign

- **Top area** is now a minimal `PageHeader` showing only the partner's
  name (or "Map" if unlinked) — no subtitle. The old "Map / Always close"
  header copy is gone.
- **The map itself now fills essentially the whole screen.** Previously it
  sat inside a bordered, rounded, margined container capped at `min-h-
  [55vh]`, with an invisible full-cover button that intercepted all touch
  input in the non-fullscreen state (tapping anywhere just opened
  fullscreen — the map wasn't actually pannable until you did). Both are
  gone: the map is `flex-1`, edge-to-edge, no card chrome, and directly
  pannable/zoomable in its default state. "Fullscreen" now only hides the
  header and bottom status bar for a fully immersive view — it no longer
  toggles whether the map responds to touch.
- **Floating controls** (map-style cycle, fullscreen toggle, recenter FAB)
  are unchanged in behavior, restyled onto the new `.glass-sheet` token
  (small, translucent, functional — per the brief).
- **Markers** — replaced the emoji-in-a-circle markers (📍 for you, 💕 for
  partner) with a restrained dot-marker (solid color core, soft outer glow,
  thin white ring) plus the same name/stale label underneath. Same data,
  same positions, same animation on update — purely a visual swap.
- **Bottom contextual status surface** — new, matches the brief's example
  hierarchy exactly:

  ```
  Partner
  Online · Updated just now          78% · [ring icon]
  ```

  Battery percentage and ringer status (via proper Lucide icons — `Bell`/
  `BellOff`, `Battery*` — not emoji, which was already the case for these
  specific fields even before this phase) are visible on this single row,
  with zero extra navigation depth, exactly as required. Tapping the row
  opens a bottom sheet with:
  - Distance apart (previously a large standalone card below the map —
    same value, same `formatDistance` computation, relocated here so the
    default view stays uncluttered)
  - The partner's full device-status pill (reusing the existing
    `PartnerStatusPill` component unchanged)
  - My own live-tracking status line (previously a separate card)
  - The transport/sync diagnostics row — same 5-tap-to-open debug overlay
    behavior as before, just relocated from a floating map chip into this
    sheet, since it's a diagnostic control, not primary hierarchy.

## 3. Calls — incoming call

`src/components/IncomingCallOverlay.tsx` was already close to the brief on
inspection — avatar, name, call-type line, decline/accept, no extra
panels. Changes here are narrower than the rest of this phase:
- Fixed a pre-existing theme bug (see §5) affecting its colors in dark
  mode.
- No structural changes — identity, call-type, and the two actions were
  already the entire screen.

## 4. Calls — active call

### 4.1 Voice call now has its own cinematic layout

**This was a real, pre-existing functional gap, not just a visual one:**
`Calls.tsx` had a local `callMode` state that correctly tracked "voice" vs.
"video" for a call **this device started**, but was never set at all for
an **accepted incoming call** — so a receiver joining a voice call always
rendered the video-call chrome (a black video rectangle) regardless of
what kind of call it actually was.

Fixed by promoting call-type tracking into `CallContext` (`activeCallType`
/ `setActiveCallType`), the same pattern already used for `activeCallId` —
both the caller's `startCall` and the receiver's `acceptIncomingCall` path
now set it, so it's correct regardless of which side of the call you're
on. `Calls.tsx` now derives `effectiveCallType = activeCallType ?? callMode`
and uses that (not the old page-local `callMode` alone) to decide layout.

The new voice layout (`isVoiceCall = effectiveCallType === "voice" &&
!isVideoOn`): centered partner avatar (photo if set, initial otherwise), name,
and a duration/status readout — nothing else. The existing remote `<video>`
element stays **mounted** (Daily still needs it for the audio track) but is
hidden via class, not removed, so nothing about the connection itself
changes. If either party turns their camera on mid-call, `isVideoOn`
flips and the layout steps aside automatically back to the normal video
view — camera capability is fully preserved, including the ability to
escalate a voice call to video.

Also added: partner avatar fetching in `Calls.tsx` (previously only
`display_name`/`pet_name` were fetched for the partner).

### 4.2 Self-preview — smaller, frameless, edge-snapping, safe-area aware

Previously: a bare `drag` with `dragMomentum={false}` and no constraints —
draggable anywhere, including under a notch or home-indicator area, and it
just stayed wherever released.

Now: a `dragBoundsRef` div marks out a safe-area-padded draggable region
(`env(safe-area-inset-*)` on all four sides, with extra clearance at the
bottom for the control bar). `dragConstraints` is bound to it. On release,
`snapPreviewToNearestCorner` measures the preview's and the boundary's
actual rendered rects and animates (spring, via Framer's `animate()` on
the underlying motion values) to whichever of the 4 corners the release
point was nearest — not a hardcoded position, so it's correct at any
screen size. Sized down slightly (from `w-28 h-40` to `w-20 h-28`) and the
thick 2px border was replaced with a thin `ring-1` for a more frameless
look, per the brief. The preview simply isn't rendered at all during a
pure voice call with the camera off (nothing to preview) and reappears
the instant either party's camera activates.

### 4.3 Control layer

**Unchanged in structure, deliberately.** The brief asked for "one
coherent floating control layer," which this screen already had — a
single row (mic, audio-route, camera, screen-share, camera-picker, PiP,
end-call), no competing bars. Rather than introduce a second layout for
voice calls, the exact same control row renders for both voice and video
— only the content area above it (video canvas vs. avatar-cinematic) swaps.
End-call is unchanged: visually distinct (larger, red, its own shape) and
was already sufficiently isolated from the other controls.

Not changed: mic/camera/screen-share/audio-route toggle logic, camera
picker, PiP support detection, or any of the underlying `useDailyCall`
plumbing — this section only reorganizes *when* the voice-avatar layout
vs. video layout is chosen and *where* the duration readout appears (top
pill for video calls; larger, near the name, for voice calls — not shown
in both places to avoid redundant info).

### 4.4 Transitions

Ringing → connected already used a consistent fade/pulse language in both
`IncomingCallOverlay` and `Calls.tsx`'s own ringing state — this phase
extended the same ripple-ring animation (matching `IncomingCallOverlay`'s
exact `scale: [1, 1.5], opacity: [0.3, 0]` pulse) onto the new voice-call
avatar, so a voice call ringing → connected reads as one continuous
visual idea rather than two different treatments handing off. No new
transition infrastructure was introduced. **Connected → "minimized"**:
this app has no in-app minimized/mini call-bar state to redesign — the
only "leave the call screen but stay connected" mechanism that exists is
the browser's native Picture-in-Picture (`togglePip`), which was left
exactly as-is. Building a new custom minimize/mini-bar system would be new
functionality, not a redesign of something existing, so it was
deliberately not added.

## 5. A pre-existing dark-mode bug, found and fixed (in scope: it's Calls)

The entire cinematic call surface — `Calls.tsx`'s ringing/connecting/
joined screen, `IncomingCallOverlay`, `CallOutcomeScreen`, and
`CallStatusBanner` — used Tailwind's `bg-foreground` as its dark backdrop
and `text-background`/`bg-background/NN` for its light text and frosted
pill fills. **`--foreground` and `--background` are theme-relative**
(defined once for light, flipped for dark — see `docs/DUOSPACE-REDESIGN-
PHASE-1.md` §2.1 and `index.css`'s `:root`/`.dark` blocks). That pairing
only produces a dark cinematic stage in **light mode**. In **dark mode**,
`--foreground` flips to near-white (`230 15% 95%`) and `--background`
flips to near-black (`230 10% 8%`) — so the entire call screen would have
inverted to a bright, near-white surface with near-black text, exactly
backwards from "cinematic depth," and the one place in this app where
light and dark did not "feel equally intentional" (this phase's own
explicit requirement).

This is a pre-existing bug — not introduced this phase — but it lives
entirely inside the surface this phase was asked to redesign, so it was
fixed here rather than left for later:

- Added two new **theme-invariant** tokens to `index.css` (identical
  values in `:root` and `.dark`, deliberately not swapping):
  `--call-stage: 230 15% 9%` and `--call-stage-foreground: 230 20% 97%` —
  exposed in `tailwind.config.ts` as `bg-call-stage` /
  `text-call-stage-foreground` (and their `ring-`/`border-`/`outline-`
  variants).
- Swapped every `bg-foreground` → `bg-call-stage`, `text-background` →
  `text-call-stage-foreground`, and `bg-background/NN` (plus the
  `ring-`/`border-`/`outline-` variants that use the same two base colors)
  → the matching `call-stage`/`call-stage-foreground` class, across all
  four files, restricted only to the actual cinematic-surface JSX (the
  "at rest" Calls list/history screen uses normal theme-relative tokens
  and was left untouched — confirmed line-range before editing).
- The camera-picker and audio-route picker sheets were already using raw
  `rgba(0,0,0,0.85)` / `text-white/*` literals rather than semantic
  tokens — already accidentally theme-invariant, so nothing there needed
  fixing.

Calls now render as an intentional dark cinematic stage in **both**
themes, not just light mode.

## 6. What did NOT change (by design)

- **Gallery, Groic, Music/Playlist** — no files under these features were
  touched.
- **All backend/Supabase/auth/encryption/native-call/media-storage
  behavior** — untouched, except the one deliberate, explicitly-instructed
  location-sharing behavior change in §1.
- **`locations` table, RLS, edge functions, `profiles.location_mode`
  column** — schema untouched. Only the Map UI's reads/writes of that one
  column were removed.
- **Permission handling, error handling, realtime retry/backoff, staleness
  detection** in `useLiveLocation`/`usePublishDeviceStatus` — logic
  untouched; only the `active`/`enabled` input they're called with changed
  from "sometimes false" to "always true."
- **Native calling infrastructure** — CallKit/ConnectionService bridges,
  VoIP push, native notification behavior, `useAppNative`, the 3 Capacitor
  plugins — none of this was touched. The `callType === "voice"` boolean
  passed into `call.joinCall()` (which drives Daily's own camera-on/off at
  join time) was already there before this phase; this phase only added a
  *second*, UI-facing place (`CallContext.activeCallType`) that records
  the same fact so the presentation layer can read it reliably too.
- **Mic, camera, screen-share, audio-route, PiP toggle logic** — all
  unchanged; only their layout position and which content area they sit
  above changed for voice calls.
- **`CallErrorScreen.tsx`, `CallHistoryRow.tsx`, and the "at rest" Calls
  list screen** (call history, start-call buttons) — not touched this
  phase; already reasonably minimal on inspection and out of this phase's
  explicit scope (incoming + active call experiences).
- **`GroicContext.tsx`'s `cur_titleFallback` reference error**, surfaced
  by this phase's `tsc` run (`Cannot find name 'cur_titleFallback'`) — a
  real, pre-existing bug, but inside Groic, which is explicitly out of
  scope this phase. Flagging it here for whichever phase redesigns Groic,
  rather than fixing it now.

## 7. Verification performed

- **`tsc --noEmit -p tsconfig.app.json`** (vitest types excluded via
  extended config, same method as Phase 1): zero new genuine errors from
  anything this phase touched. Filtered full-project output down to just
  `MapView.tsx`, `Calls.tsx`, `CallContext.tsx`, `IncomingCallOverlay.tsx`,
  `CallOutcomeScreen.tsx`, `CallStatusBanner.tsx`, `index.css`, and
  `tailwind.config.ts` — the only remaining error is the same pre-existing
  repo-wide `key`-prop false positive documented in Phase 1, on a line
  this phase didn't edit.
- **Location/battery/ringer** — traced `sharingActive` end-to-end: it's a
  literal `true` now, gating both hooks identically regardless of page
  visibility or any user setting; confirmed no remaining `location_mode`
  reference anywhere in `MapView.tsx` (`grep` returned nothing); confirmed
  the DB column itself is untouched (no migration authored).
  Battery/ringer render path (`PartnerStatusPill`, plus the new inline
  battery+ringer read on the status bar) is unchanged data-wise — same
  `partnerDeviceStatus` fields, same staleness check.
- **Stale-state handling** — `partnerStale` (location) and
  `deviceStatusStale` (battery/ringer) still computed exactly as before;
  both still visually flagged (dimmed marker + "stale" label on the map;
  dimmed pill + "Last seen" copy in the status bar).
- **Permissions/errors** — the denied-permission and "getting your
  location" full-screen states in `MapView.tsx` are byte-for-byte the same
  JSX as before, just re-parented under the new layout container.
- **Incoming/accepting/rejecting calls** — `IncomingCallOverlay`'s
  `handleAccept`/`handleDecline` handlers, and `CallContext`'s
  `acceptIncomingCall`/`declineIncomingCall`, are unchanged apart from the
  one added `setActiveCallType(...)` line inside the existing accept
  success path — same rate-limiting, same claim/token/join sequence, same
  error handling.
- **Video call / voice call / mute / camera / speaker / local preview** —
  `toggleAudio`, `toggleVideo`, `toggleScreenShare`, `switchCamera`,
  `useAudioRoute`, and the `localVideoRef`/`remoteVideoRef`/
  `screenShareRef` wiring are all unchanged; this phase only changed
  which container the video elements render inside and added the
  conditional avatar overlay on top for voice calls.
- **Existing native behavior** — no native (Android/iOS/Capacitor plugin)
  source file was touched.
- **Light/dark** — every new token (`--call-stage`, `--call-stage-
  foreground`, plus the Phase 1 tokens the sheet/status-bar use) has both
  a `:root` and `.dark` value; the call-stage pair is intentionally
  identical in both, everything else is theme-relative as normal.
- **Reduced motion** — the new marker/status-bar/sheet animations and the
  voice-call ripple pulses all use Framer Motion `animate`/`transition`
  (no raw CSS `@keyframes` animation added), which remains covered by
  `App.tsx`'s app-wide `<MotionConfig reducedMotion="user">` from Phase 1
  — nothing in this phase bypasses it.

## 8. Suggested next steps (not part of this phase)

1. Get real-device confirmation of the corner-snapping self-preview and
   the new Map bottom sheet on a small-screen device — built to the same
   spacing/safe-area conventions as Phase 1's `Duo.tsx`, not yet visually
   verified outside this sandbox.
2. Fix `GroicContext.tsx`'s `cur_titleFallback` reference error whenever
   Groic/Music is in scope (§6).
3. Consider whether a genuine in-app "minimized call" bar (visible while
   navigating to Chat/Duo mid-call) is wanted as a real feature — it
   doesn't exist today, so it wasn't in scope for a *redesign* phase, but
   it's a reasonable candidate for a future *feature* phase, distinct from
   the browser-native PiP that already exists.
4. `.glass-sheet` (from Phase 1) is now used by both Chat-adjacent
   surfaces and Map's floating controls/status bar — worth confirming it
   still reads correctly once Gallery/Groic/Music also start reaching for
   it in a future phase.
