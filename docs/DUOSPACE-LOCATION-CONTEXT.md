# DuoSpace — Location keeps updating during calls/notifications

## The gap

Both halves of live location — `useLiveLocation` (publishes MY position)
and the partner-location fetch/realtime-subscribe/watchdog-polling engine —
lived entirely inside `src/pages/MapView.tsx`'s own hooks/effects. That
engine only ran while the Map page itself was mounted.

So the moment you left the Map page — navigated to Chat, an incoming call
came in and pushed you onto the call screen, or the app was simply on any
other tab when a push notification arrived — **both directions** of
location sharing silently stopped: you stopped publishing your own
position, and you stopped receiving your partner's. Reopening Map would
just show whatever was last fetched, then resume.

## The fix

Moved the whole engine into a new `src/contexts/LocationContext.tsx`
(`LocationProvider` / `useLocationContext`), mounted once at app-root in
`App.tsx` right alongside `CallProvider` — the same pattern already used
to fix an analogous bug for calls (see the comment block at the top of
`CallContext.tsx`: `useDailyCall` had the identical problem, two independent
instances stepping on each other, fixed by hoisting it to one shared
instance).

```
return <LocationProvider><CallProvider><AppLayout /></CallProvider></LocationProvider>;
```

This is mounted for the entire authenticated app (after onboarding, same
level `CallProvider` already sits at) — not gated by which route is
active. Since `IncomingCallOverlay` renders from inside `CallProvider`,
and `LocationProvider` wraps it, location keeps running straight through
an incoming call ringing. Since navigating between Chat/Calls/Settings/Map
only swaps `AppLayout`'s routed children (not the provider tree above it),
switching screens — including for a notification banner or opening
another tab of the app — no longer tears the engine down either.

`MapView.tsx` now consumes `useLocationContext()` instead of owning its
own copies of these hooks/effects — the map-rendering logic (Leaflet init,
markers, animation, sheet, recenter, debug overlay) is otherwise
byte-for-byte the same, just reading `partnerLocation`/`myLocation`/etc.
from context instead of local state. This also means opening Map no
longer causes a fresh GPS/partner fetch — it now shows whatever the
already-running background engine has, which is more accurate (it never
went stale while you were away) not less.

## What did NOT change

- `useLiveLocation.ts` and `useDeviceStatus.ts` themselves — zero edits,
  copied the exact same calls into the provider.
- The realtime subscription/retry, watchdog→polling fallback, staleness
  math, presence heartbeat — moved verbatim into the provider, no logic
  changed.
- Phase 2's decision that location/battery/ringer sharing is
  unconditionally on while signed in (no pause/off control in this UI) —
  unchanged, just now lives in the provider (`sharingActive = true`)
  instead of MapView.
- One small behavioral nuance, called out explicitly rather than silently
  changed: the Map's 5-tap debug overlay used to control
  `useLiveLocation`'s debug-ticker cadence (5s vs 20s) directly. Since
  that hook now lives in the provider, `LocationContext` exposes a
  `setDebugEnabled()` the debug overlay calls instead — same effect
  (fast ticker only while the overlay is open), routed through the
  shared instance.

## Known limitation — native background

This fixes every **foreground** case: on another in-app screen, the
ringing-call overlay, a notification banner while the app is open. It does
**not** by itself keep location updating once the OS fully suspends the
WebView (app minimized / screen off) — that still needs a native
background-location / foreground-service plugin (e.g.
`@capacitor-community/background-geolocation`) wired in separately, which
is outside what a JS-only provider change can do.

## Follow-up: native GPS plugin (why foreground itself needed more than the provider move)

The provider move above fixes *which screen* the engine runs on. It does
NOT fix *how* the engine reads GPS on native — `useLiveLocation.ts` was
still calling the WebView's own `navigator.geolocation.watchPosition`,
which is really just Chromium/WebKit's implementation running inside the
WebView's JS engine. Some OEM WebView implementations throttle or suspend
a *detached or visually obscured* WebView's JS timers independently of
whether the app process itself is foregrounded — and this app's calling
UI is a **native** CallKit/Telecom overlay (see
`native-plugins/callkit-bridge`), which covers the WebView exactly like
that while a call is ringing/active. So even with the provider fix, a
ringing/active call could still starve location updates specifically
because of *where the GPS listener lived*, not just *which page* it was
tied to.

Fixed by switching `useLiveLocation.ts` to the official
`@capacitor/geolocation` plugin (already a dependency — previously only
used once, for the upfront permission prime in `useLaunchPermissions.ts`;
nothing actually watched position through it) on native platforms:

- `startWatcher`/`stopWatcher` now branch on `Capacitor.isNativePlatform()`.
  Native calls `Geolocation.watchPosition`/`clearWatch`, which talk to the
  OS location APIs through Capacitor's native bridge rather than the
  WebView's JS engine — a listener registered this way isn't tied to the
  WebView's paint/attach state the same way `navigator.geolocation` is.
  Web (no Capacitor) is completely unchanged, still
  `navigator.geolocation`.
- Permission probe branches the same way: native uses
  `Geolocation.checkPermissions()` (the web `navigator.permissions.query`
  path is skipped entirely on native, since that API's behavior inside a
  Capacitor WebView isn't reliable for this).
- Capacitor's native error shape doesn't carry the web API's numeric
  `.code` (1/2/3) — added `normalizeNativeErr()`, a best-effort message-
  string match (`"denied"`/`"permission"` → 1, `"unavailable"`/
  `"disabled"` → 2, else → 3) so both platforms share the exact same
  downstream state-machine handling (`onErr`) instead of forking it.
- `watchIdRef` is now `number | string | null` (web watch ids are
  numbers; the Capacitor plugin's are string callback ids). Added a
  `watchGenerationRef` counter to guard against the plugin's *async*
  `watchPosition` promise resolving its id *after* a newer
  `startWatcher`/`stopWatcher` call already superseded it (e.g. the
  existing eco/high adaptive-accuracy restart) — without it, a late
  resolve could stomp `watchIdRef` with an id nothing intends to keep
  running, leaking an orphaned native watcher that's never cleared.

Everything else in `useLiveLocation.ts` — smoothing, noise rejection,
write throttling, offline queue, presence heartbeat, adaptive accuracy —
is untouched; `onPos`/`onErr` accept both platforms' data since the
underlying `Position`/error shapes are field-compatible.

This still doesn't add true background tracking for a minimized/
screen-off app (unchanged from the limitation above — that's a
categorically different, larger native change). What it fixes is
reliability *while the app process is genuinely foreground* but the
WebView surface itself isn't what's on screen (native call UI, certain
system dialogs) — which, given this app's native calling architecture, is
exactly the scenario in the original bug report.

## Verification

Bracket-balance sweep on all touched files (`LocationContext.tsx`,
`MapView.tsx`, `App.tsx`, `useLiveLocation.ts`) — clean. Confirmed
`@capacitor/geolocation`'s `Position`/`PositionOptions` shapes are
field-compatible with the browser DOM types `onPos`/`HIGH_OPTS`/
`ECO_OPTS` were already written against, so no changes were needed to the
smoothing/noise-rejection pipeline itself. No build tooling available in
this sandbox, as with every session on this project — this specific
change (native watchPosition behind a native call overlay) can only be
meaningfully confirmed on a real device/build, which is flagged rather
than claimed.
