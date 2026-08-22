# DuoSpace — Phase 3: Map Premium UX + Visual Redesign

Scope: `src/pages/MapView.tsx` only, plus a small unrelated app-wide addition
(version display in Settings, requested in the same session — see bottom of
this doc). Chat, Calls, Gallery, Groic, Music, auth, and Supabase were not
touched.

## What was audited first

Read the full existing `MapView.tsx` (908 lines) before changing anything:
Leaflet init/teardown, tile-style switching, `useLiveLocation`/
`usePublishDeviceStatus` hooks, the partner-location fetch + realtime
subscription + retry/backoff, the watchdog → polling fallback, staleness
math (location age + heartbeat age), marker creation + `requestAnimationFrame`
interpolation, the recenter/fit logic, fullscreen handling, and the existing
bottom status sheet. All of this predates this phase (built across the
"Phase 2" and "premium shell redesign" sessions) and none of it needed to
change — it was already correct. This phase only touched presentation.

## What changed

**Layout — map is now the hero, edge-to-edge:**
- Removed `PageHeader` (a solid `bg-background/90` sticky toolbar with a
  hard `border-b` — exactly the "conventional toolbar feeling" the brief
  said to avoid). The map now fills the full screen; everything else is a
  floating layer on top of it.
- Top row: a small circular back button + a compact floating **identity
  pill** (avatar, partner name, online/updated line) on the left, and the
  existing map-style + fullscreen controls on the right. Both are
  `glass-sheet` (same material family as Chat/Calls), safe-area aware.
- Contextual flags (offline / reconnecting / partner-stale) moved to sit
  just below the identity pill instead of stacked separately — same
  "only renders when something needs attention" behavior as before, now
  with an enter/exit transition (`snapTransition`) instead of popping in.
- Bottom row: replaced the old full-width button (avatar + name + status +
  battery pill + chevron, spanning the whole screen width) with a compact,
  left-aligned **status pill** (battery %, ringer icon, "Updated Xm ago")
  that only takes the width its content needs — plus the recenter control
  on the right. This matches section 9's explicit "78% Ring / Battery
  Status / Updated just now" compact hierarchy instead of a dashboard row.

**Recenter FAB (section 13):**
- Previously always full-size whenever a GPS fix existed. Now tracks a new
  `mapOffCenter` state: quiet (small, `glass-sheet`, muted) while the map
  is already on the fitted view, and becomes the prominent primary-colored
  FAB once the user has actually panned/zoomed away. Wired into the
  existing `dragstart`/`zoomstart`/`movestart` handlers (which already
  existed to suppress auto-recenter) and cleared on `recenter()` and on the
  initial auto-fit — no new gesture-tracking logic, reused what was there.

**Partner marker (section 6):**
- Now renders the partner's `avatar_url` (fetched alongside their name,
  same query) inside the same halo/ring treatment, instead of always being
  a flat color dot. Falls back to the original dot design when no avatar
  is set. Stale styling (opacity + grayscale) is unchanged.
- Tapping the partner marker now opens the same status sheet the identity
  pill and bottom pill open (section 19's "tap partner marker → status
  surface" interaction) — a `marker.on("click", …)` handler, added once at
  marker creation.
- Marker movement interpolation (`requestAnimationFrame` easing) was
  already implemented correctly from a prior phase and is untouched.

**Material / motion:**
- All floating surfaces use the existing `.glass-sheet` utility (already
  defined in `index.css`, already used by Chat/Calls) — no new glass
  variant was introduced, so Light/Dark adaptation is inherited for free.
- `mapOffCenter` combines both: a gesture latch (`dragstart`/`zoomstart`/
  `movestart` → immediately shows the prominent FAB, for responsiveness)
  and a `moveend` listener that re-checks the actual on-screen distance
  from the fitted anchor (partner+me midpoint, or just me) via
  `latLngToContainerPoint`, correcting the FAB back to quiet if a small
  drag ends up back near the anchor. Refs (`myLocationRef`/
  `partnerLocationRef`) mirror the location state so the once-registered
  `moveend` listener always reads current coordinates.
- Reduced motion: no separate handling was needed. `App.tsx` already wraps
  the whole app in `<MotionConfig reducedMotion="user">`, which every
  `motion.*` component (including the new recenter-FAB scale animation and
  the contextual-flags enter/exit) inherits automatically — same pattern
  already used by `MessageStatus.tsx`/`MoodDetector.tsx`. Confirmed this
  by reading `App.tsx` rather than assuming.

## Explicitly NOT changed

- Location permission handling, geolocation watcher, realtime subscription
  + retry/backoff, polling watchdog, staleness thresholds, distance math,
  marker interpolation math, map provider/tile URLs, gesture handling,
  fullscreen toggle behavior, debug overlay (5-tap), the status `Sheet`'s
  content (distance, device pill, sync/diagnostics row) — all byte-for-byte
  the same logic as before this phase, only the JSX layout around them
  changed.
- No location-off/disable/pause control was added anywhere. Location
  sharing remains unconditionally on while signed in, per the existing
  Phase 2 decision (see the comment block above `sharingActive` in the
  file, which predates this phase and was left as-is).
- Gallery, Groic, Music, Chat, Calls, auth, Supabase schema/RLS,
  encryption, native calling — untouched.

## Verification performed (no build tooling in this sandbox, as with every
prior session on this project — see the standing note in project memory)

- Bracket/brace/paren balance check on all three touched files
  (`MapView.tsx`, `Settings.tsx`, `DuoSpaceError.ts`) — clean.
- Manual cross-check that every newly-imported symbol (`useNavigate`,
  `ChevronLeft`, `snapTransition`) is actually used, and that no
  now-unused import (`PageHeader`, `Heart`) was left behind.
- Manual re-read of the new JSX against the original to confirm every
  existing conditional (`isFullscreen`, `locationError`,
  `permissionState === "denied"`, `!myLocation`, `partnerId`,
  `partnerLocation`, `partnerDeviceStatus`) still gates the same content
  it did before, just repositioned.
- Fixed one real risk caught during this re-read: the new compact bottom
  pill originally referenced `partnerLocation!` (non-null assertion) for
  the "Updated Xm ago" line, but `partnerDeviceStatus` and
  `partnerLocation` are populated by separate queries and can be out of
  sync — replaced with a proper `partnerLocation ? … : "No location yet"`
  guard.

## Known limitations / needs real-device verification

- Glass blur/translucency performance while panning/zooming was not
  measured (no device/browser available here) — the brief's performance
  section (26) asks for no continuously-animated backdrop-blur, which is
  satisfied (surfaces are static once rendered, no per-frame blur
  animation was added), but real-device frame-rate while dragging the map
  under the floating pills should still be checked.
- The 48px on-screen-distance threshold for `mapOffCenter` (via
  `latLngToContainerPoint`) is a reasonable default but untuned against a
  real device/screen size — may want adjustment after real-device use.

## Unrelated addition (same session, explicit user ask)

- Settings now shows the running app version ("DuoSpace v{APP_VERSION}")
  at the bottom of the hub list, reading the existing `APP_VERSION`
  constant from `src/lib/errors/DuoSpaceError.ts` (previously only used
  internally for error reports).
- Added a strict rule to `docs/rules.md` ("Never ship a change without
  bumping `APP_VERSION`") and strengthened the comment directly above the
  constant's definition, since it's now user-visible. Bumped
  `APP_VERSION` and `package.json`'s `"version"` from `3.2.0` → `3.3.0`
  for this phase, per that same rule.
