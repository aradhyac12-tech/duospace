# DuoSpace — Map Reliability + Live Location Hardening

Scope: correctness, freshness, synchronization, real-device reliability only.
No Map UI redesign — layout, glassmorphism, controls, marker design,
battery/ringer presentation, fullscreen behavior, map styles, and the status
sheet are byte-for-byte unchanged except where a direct bug required a
touch (none did).

Base: `a89d2535d984c90ef3d4c17ea4e365f14ffbce7d`.

## 1. Root cause of every Map issue found

**Bug A — "Updated X ago" was frozen at account-creation time, not actually
tracking freshness.** All three location-write paths
(`useLiveLocation.ts`'s `writeLocation`, `locationQueue.ts`'s
`flushQueuedLocations`, `LocationContext.tsx`'s native-fix `writeFix`)
upserted only `{ user_id, latitude, longitude }`. Supabase-js builds the
`ON CONFLICT (user_id) DO UPDATE SET ...` clause strictly from the keys
present in the payload object. Since `updated_at` was never one of those
keys, and the column's `DEFAULT now()` only applies on `INSERT`, every
`UPDATE` after the very first location write for a user left `updated_at`
completely untouched. Every "Updated Xm ago" / staleness calculation in
`LocationContext.tsx` and `MapView.tsx` reads `partnerLocation.updated_at`
— so this single gap is the root cause of the entire section-2 complaint,
and it also meant `partnerStale` (section 6) was working off corrupted
data: `partnerLocAge` was effectively "time since the partner's very first
ever location write," not "time since their last one," so it would
eventually go stale for every partner regardless of how recently they'd
actually moved.

**Bug B — no monotonic write protection (sections 7/8).** Nothing anywhere
in the write path compared timestamps. Three producers write to the same
row (foreground GPS watcher, offline-queue flush, native
background-watcher/one-shot), and a delayed queue flush or a cached
one-shot fix could silently overwrite a newer, more-correct position with
an older, less-correct one. Confirmed via schema read
(`supabase/migrations/20260308224547_...sql` and later re-declarations):
the table has never had any timestamp column beyond `updated_at`, and
`updated_at` itself was never actually usable as a monotonic key because
of Bug A.

**Bug C — realtime watchdog conflated transport health with location
freshness (section 3/4).** `LocationContext.tsx`'s watchdog only reset
`lastPayloadAtRef` on a `locations` table `postgres_changes` payload.
Location writes are distance-gated (`MIN_MOVE_DB_M = 8` in
`useLiveLocation.ts`), so a **stationary** partner produces no location
payloads at all — the watchdog would then trip `REALTIME_WATCHDOG_MS`
(45s) and show "Reconnecting…" / fall back to polling even though the
realtime channel was perfectly healthy. This is exactly the anti-pattern
section 3 calls out by name.

**Bug D (minor, native) — a push-triggered one-shot fix obtained before the
JS bridge has ever loaded (cold-started app) was silently dropped with no
log line,** despite a code comment on `LocationFixBridge.kt` claiming it
was "logged once at INFO." The underlying limitation (no write path exists
until the JS bridge loads — see docs/BACKGROUND_LOCATION_NATIVE.md) is
real and out of scope to fully close, but the silent-drop-with-false-claim
was fixed on both platforms so it's at least observable in logs.

Everything else audited (recenter threshold, marker RAF interpolation,
polling fallback lifecycle, channel/listener duplication, error-state
coverage, device-status publishing) was already correct — see sections 3–11
below for what was verified vs. changed.

## 2. Exact files changed

- `supabase/migrations/20260828120000_locations_monotonic_write_guard.sql`
  (new) — adds `locations.captured_at`, backfills it, and adds a
  `BEFORE INSERT OR UPDATE` trigger (`locations_monotonic_write_guard_trg`)
  that (a) always stamps `updated_at = now()` on an accepted write — fixing
  Bug A — and (b) rejects (no-ops, without erroring) any `UPDATE` whose
  `captured_at` is older than the row's current `captured_at` — fixing Bug
  B, enforced at the one point all three write producers converge.
- `src/hooks/useLiveLocation.ts` — `writeLocation` now sends
  `captured_at: loc.updated_at` (the actual GPS fix timestamp) in the
  upsert.
- `src/lib/locationQueue.ts` — `flushQueuedLocations` now sends
  `captured_at` (converted from the queue's epoch-ms storage back to an
  ISO string) in the upsert, so a delayed flush carries its true capture
  time instead of "whenever it happened to flush."
- `src/contexts/LocationContext.tsx` — (1) native-fix `writeFix` now sends
  `captured_at` (from `fix.timestamp`); (2) the realtime watchdog's
  `profiles` `UPDATE` handler now also bumps `lastPayloadAtRef`, fixing Bug
  C — the 30s presence heartbeat (`useLiveLocation.ts`'s `HEARTBEAT_MS`)
  gives a movement-independent realtime-health signal.
- `src/pages/MapView.tsx` — added a fine-grained `tickNow` clock (1s while
  the page is visible, paused while hidden, force-recomputed immediately on
  mount / new partner location / visibility regain) and rewrote `timeAgo`
  to the required second-level granularity. `partnerLocAgeMin` switched
  from the coarse context `now` to `tickNow` for consistency. No JSX/layout
  changes.
- `native/android/DuoSpaceLocationService.kt` — added `deliverFix`/
  `deliverError` helpers that actually log (Bug D) instead of silently
  dropping when no plugin listener is attached; all internal call sites
  routed through them.
- `native-plugins/background-geolocation/ios/Plugin/BackgroundGeolocationPlugin.swift`
  — same fix on the iOS side (`NSLog` when `onFix` is nil).

## 3. Timestamp freshness behavior

`MapView.tsx`'s `timeAgo` now returns, from a 1s-resolution clock:
`< 10s → "just now"`, `10–59s → "Ns ago"`, `1–59m → "Nm ago"`,
`1h+ → "Nh ago"` (existing `Nd ago` branch preserved beyond 24h). Composed
with the existing `"Updated "` prefix at the bottom status pill this reads
exactly per spec: "Updated just now" / "Updated 12s ago" / "Updated 4m
ago" / "Updated 1h ago". The clock recomputes immediately (not on the next
tick) on: a new partner location arriving, this page mounting, and the tab/
app regaining visibility; it ticks once a second only while the page is
visible, and stops entirely while hidden. No Supabase query is issued by
the ticker — it only reformats the `updated_at` already in memory. This
required the DB-level fix (item 1, Bug A) to be meaningful — before that,
correct client-side formatting would still have displayed the wrong
(frozen) timestamp.

## 4. Realtime/polling behavior

Watchdog (`REALTIME_WATCHDOG_MS = 45s`) → polling fallback
(`POLL_INTERVAL_MS = 15s`) → back to realtime on reconnect: logic was
already correctly structured (single `pollTimer`, cleared on realtime
recovery and on unmount; single channel per `partnerId`, explicitly
removed on cleanup/re-subscribe, no duplicate `supabase.channel(...)`
calls found). The one real defect (Bug C, transport-health conflated with
location-payload cadence) is fixed as described above. No duplicate
channels or duplicate polling intervals found on review — nothing else to
change here.

## 5. Location/presence separation

The three axes (A: realtime transport health — `realtimeOk`/
`transportMode`; B: location freshness — `partnerLocAge`; C: presence/
heartbeat — `partnerHbAge`/`partnerPresence.last_seen_at`) were already
tracked as separate state in `LocationContext.tsx`, and `MapView.tsx`'s
`partnerStatusLabel` already correctly composes them (e.g. "Active now ·
location updated Xm ago" for an online-but-location-stale partner, vs.
"Last seen Xm ago" only when both are stale) — this matches section 6's
example exactly and required no logic change, only the Bug A/C data-source
fixes so the inputs feeding it are actually correct.

## 6. Native/foreground race protection

Fixed via the DB trigger (item 1) plus `captured_at` now being sent by all
three write paths (foreground `useLiveLocation`, native background
watcher/one-shot via `LocationContext`, offline queue flush). This is
enforced server-side rather than client-side because it's the one point
all three producers — which can run concurrently and complete in any order
— actually converge; no client-side ordering guarantee could cover that.

## 7. Offline queue behavior

`locationQueue.ts` was already FIFO with per-entry deletion on success and
early-stop-on-failure to preserve order. It did not previously guard
against a stale entry overwriting a newer live write — now it sends the
entry's true `captured_at`, and the DB trigger silently no-ops a
now-stale entry rather than erroring, so a stale queued write no longer
regresses the displayed location and no longer blocks the rest of the
queue behind a spurious "failure."

## 8. Background-location verification

Reviewed (not compiled/run — see item 12): Android foreground service
(`DuoSpaceLocationService.kt`, `START_STICKY`, proper
`startForeground()`-before-location-API sequencing, single watcher
callback replaced cleanly on restart) and iOS `CLLocationManager` wrapper
(`allowsBackgroundLocationUpdates` + significant-change monitoring as the
suspended-app wake source) both look structurally correct for foreground /
background / screen-locked / screen-off on Android and foreground /
background / screen-locked on iOS. No duplicate-listener issue found on
either platform (Android: single `LocationFixBridge.listener`, replaced on
`load()`/cleared on `handleOnDestroy()`; iOS: single `onFix`/`onError`
closure pair on a singleton, replaced on `load()`). Push-triggered
immediate fix verified end-to-end on both platforms through the same
`captured_at`-guarded write path as every other fix source. Bug D (silent
drop before JS bridge loads) is now at least logged instead of invisible;
fully closing it would need a native-side write path independent of the JS
bridge, which is a larger change flagged as a remaining limitation (item
14), not attempted here.

## 9. Battery/ringer verification

`useDeviceStatus.ts` (`usePublishDeviceStatus`) was already correct on
review: explicit `device_status_updated_at` stamped by the client on every
publish (unlike the location-write bug, this path always included its own
timestamp), debounced but force-published on real changes, iOS ringer
correctly reported as `'unknown'` rather than fabricated. `deviceStatusStale`
(5-minute threshold) and the UI's opacity-based stale treatment
(`PartnerStatusPill`, bottom status pill) were already correct. No changes
made.

## 10. Recenter verification

Not changed, per the brief's explicit instruction not to blindly change
the 48px threshold. No physical device was available in this environment
to test small-Android / large-Android / iPhone feel, so this remains an
open item requiring real-device testing (already flagged as such in
`docs/DUOSPACE-PHASE-3-MAP.md` from the prior phase — still true). The
surrounding logic (gesture latch on `dragstart`/`zoomstart`/`movestart`,
`moveend`-driven correction via `latLngToContainerPoint`) was re-verified
and is unchanged.

## 11. Performance findings

`animateMarker`'s `requestAnimationFrame` loop calls `marker.setLatLng()`
directly and never touches React state per frame — confirmed no React
re-render is triggered by marker animation. No continuously-animated
`backdrop-blur` found (glass surfaces are static once rendered, per the
prior phase's doc and re-confirmed here). Nothing changed in this area.

## 12. Tests actually executed

**None of TypeScript/ESLint/Vitest/production build were run.** This
sandbox has no `node_modules` and no network access to install
dependencies (confirmed: `npm`/`node` are present but the project has
never been installed here, and package installation is not possible
without network egress). This matches the standing caveat already present
in this project's own prior-phase docs. In place of real tooling, every
edited file was manually re-read against the diff, and a script-based
brace/paren/bracket balance check was run across all edited `.ts`/`.tsx`/
`.kt`/`.swift` files (all balanced) as a crude sanity check — this is not
a substitute for a real compile and should not be treated as one.

## 13. Device tests actually executed

**None.** No Android/iOS toolchain, emulator, or physical device was
available in this environment. The section-16 test matrix below reflects
code-path reasoning from reading the implementation, not observed
behavior on a device — it should be treated as a review checklist for
whoever runs the real device pass, not as a report of tests performed.

## 14. Remaining limitations

- No build/lint/test/device verification was possible in this
  environment (items 12–13) — this whole change needs a real CI/device
  pass before shipping.
- Bug D's underlying gap (a push-triggered fix obtained before the JS
  bridge has ever loaded has nowhere to persist to) is still open —
  only made observable via logging, not fixed. Fully closing it would mean
  giving the native layer its own lightweight write path to Supabase
  (a signed HTTP upsert from Kotlin/Swift directly, independent of the
  WebView/bridge), which is a materially larger change than this phase's
  scope and would need its own security review (embedding/refreshing a
  credential outside the JS auth session).
- The 48px recenter threshold is unchanged and still untuned against real
  devices (item 10).
- `heading`/`speed` are computed client-side (`useLiveLocation.ts`'s
  `LiveLocationData`) but were never persisted to `locations` before this
  phase and still aren't — out of scope for a reliability/correctness pass
  since nothing in the brief asked for it, but worth flagging since a
  future "facing direction" marker feature would need it added to the
  schema and write path.

---

## Section-16 test matrix — reasoned from code, not device-executed

| # | Scenario | Expected path after this change |
|---|---|---|
| 1 | Partner moves | Foreground watcher writes with real `captured_at`; trigger accepts (newer), bumps `updated_at`; realtime `locations` payload updates `partnerLocation` + `lastPayloadAtRef`; `tickNow` effect on `partnerLocation` change recomputes display immediately. |
| 2 | Partner stationary | No location write (distance-gated), but 30s presence heartbeat still bumps `profiles.last_seen_at` → realtime payload → `lastPayloadAtRef` refreshed → watchdog stays on `realtime`, does **not** false-trip to polling (Bug C fix). Location age display correctly grows since it's genuinely not updating. |
| 3 | Partner opens Map | `tickNow` force-set on mount; `LocationContext` already fetches on mount regardless of Map being open (app-root provider). |
| 4 | Partner leaves Map | `LocationContext` keeps running (app-root, not page-scoped) — sharing/receiving continues, matches the preserved product rule. |
| 5 | Partner goes to Chat | Same as #4 — no location/presence interruption, by design of `LocationContext` living above the router. |
| 6 | Partner receives call | `CallKitManager`/`CallNotificationService` trigger a native one-shot fix independent of the WebView's foreground state; write goes through the same `captured_at`-guarded path. |
| 7 | Partner receives message | Android: native one-shot via `CallNotificationService.onMessageReceived` (fires for every push). Both platforms: JS `usePushNotifications` also calls `requestImmediateFix` while the bridge is alive — redundant by design, harmless (guarded by monotonic trigger either way). |
| 8 | App backgrounded | Native background watcher (Android foreground service / iOS significant-change) keeps producing fixes; foreground `useLiveLocation` watcher may be throttled by the OS but background layer covers the gap. |
| 9 | Screen locked | Same as #8 — Android foreground service and iOS background modes are designed to survive this. |
| 10 | Network disconnected | `online` flips false → "Offline" banner shown; writes fail and fall into `enqueueLocation`. |
| 11 | Network restored | `online` listener triggers `flushQueueIfAny()`; queued entries flush with their true `captured_at`, guarded against overwriting anything newer that landed meanwhile. |
| 12 | Realtime disconnected | `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` → `realtimeOk=false`, exponential retry subscribe; watchdog independently trips polling fallback if no payload (of either kind) arrives within 45s. |
| 13 | Realtime restored | `SUBSCRIBED` status → `realtimeOk=true`, immediate `fetchInitial()`/`fetchPresence()`; watchdog sees fresh `lastPayloadAtRef` and drops back to `transportMode: "realtime"`. |
| 14 | GPS permission denied | `onErr` code 1 → `permission: "denied"`, `state: "failed"`; MapView's existing permission-denied overlay shown; does not crash. |
| 15 | GPS temporarily unavailable | `onErr` code 2/3 → `state: "reconnecting"`; existing UI handles this without crashing. |
| 16 | Battery changes | `useDeviceStatus` native `statusChanged` listener (or web Battery API fallback) publishes with a fresh `device_status_updated_at`; unaffected by this phase's changes. |
| 17 | Ringer mode changes | Same publish path; iOS always reports `'unknown'` (documented platform limit), UI already handles this correctly. |
| 18 | Native background fix arrives | Routed through `LocationContext`'s `writeFix` with `captured_at: fix.timestamp` → trigger accepts/rejects based on recency. |
| 19 | Foreground fix arrives immediately after | If genuinely newer, accepted and overwrites; if the background fix's `captured_at` was actually newer (e.g. foreground fix was queued/delayed), the trigger keeps the background one — correct per spec ("never let newer be overwritten by delayed older"). |
| 20 | Older queued fix flushes after newer fix | Trigger rejects (no-op) since `NEW.captured_at < OLD.captured_at`; the flush still reports "success" (not an error) and the queue entry is removed, per design — the newest valid location is preserved either way. |

This matrix should be re-run for real once a device/emulator + signed
build is available — nothing above was observed, only reasoned from the
code path.
