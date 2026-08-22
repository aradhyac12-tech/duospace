# Relationship-Feature Redesign — QA Notes

Scope: **Us, Memories, Countdown/Anniversary, Mood, Map/Live Location,
Shayari, Groic, Playlist, Music Queue/Blend, and the relationship
utilities they share.** Companion to `docs/UI_REDESIGN_FORENSIC_AUDIT.md`
(the RED/YELLOW/GREEN Safety Map this pass was gated on) and
`docs/error-system.md` (the typed error registry this pass extended).
Dated entries for each change are in `docs/memory.md` under
"Relationship-feature redesign."

Like the Calls/Gallery pass before it (`docs/CALL_GALLERY_QA.md`), no
physical device, simulator, or live Supabase/Daily project was available
in this environment — network access is disabled in this sandbox.
Verification below is a **full manual trace of every code path against
the actual source**, plus a static syntax check (`tsc --noEmit`,
per-file) on every edited file. Nothing here was executed against a
running app. A real two-account device pass is still required before
shipping — see Known Gaps at the end.

---

## 1. What changed, and what didn't

**Untouched, per the Safety Map (RED):** `GroicContext.tsx` (session/
queue/playback state machine), `useLiveLocation.ts` (GPS engine, stale
detection, watchdog/polling fallback), the mood-detection pipeline in
`MoodDetector.tsx`, all RPCs/triggers, the `signedStorageUrl.ts`
private-bucket pattern, and every realtime channel's subscribe/query
logic. None of these had their underlying data flow rewritten — every
edit below is presentation-layer (loading/error/empty states, dialogs,
confirmations, deep-link params, visual identity) or a defensive
`try/catch` around an existing call that previously had none.

**Modified:**
- `src/pages/Us.tsx` — loading/error states, deep links, destructive
  confirm on countdown delete, error handling on all four mutations.
- `src/components/MemoryWall.tsx` — loading/error states, deep-link
  target prop, destructive confirm on memory delete, error handling on
  add/delete.
- `src/components/MoodHistory.tsx` — split the loading/error/empty
  conflation bug, added retry.
- `src/pages/Shayari.tsx` — loading/error states, deep link, error
  handling on add.
- `src/pages/Groic.tsx` — degraded-search banner, registry capture on
  fallback, `Shimmer` skeleton, connected-state pulse.
- `src/pages/Playlist.tsx` — loading/error states, destructive confirm
  on song removal, error handling on add/remove/all blend actions.
- `src/pages/MapView.tsx` — additive telemetry only
  (`DS-MAP-001`/`002`), `tabular-nums` typographic treatment. No
  structural change — see §4.
- `src/lib/errors/types.ts`, `src/lib/errors/registry.ts` — five new
  error modules (`US`, `MOOD`, `MAP`, `SHAYARI`, `GROIC`) and 15 new
  typed codes.

**Not touched at all:** `GroicMiniPlayer.tsx`, `GroicFullPlayer.tsx`,
`GroicInviteBanner.tsx` — already used the shared glass/surface tokens
correctly and had no loading/empty/error gaps to close (mini/full
player state is entirely derived from `GroicContext`, which is RED).

---

## 2. Confirmed bugs found and fixed

These were found while auditing each feature's state coverage, not known
issues going in.

### Bug 1 — Loading and empty were the same state (Us, Shayari, Playlist)
All three fetch their primary data in a `useEffect` with no `loading`
flag distinct from the data array's own length. On a slow connection,
"No shayaris yet," "No songs yet. Add your first song!", and an empty
Countdowns section would flash correctly-but-misleadingly during every
cold load — and if the fetch actually failed, they'd say that forever,
indistinguishable from "you have never added anything," which reads as
silent data loss.
**Fix:** explicit `loading` + `loadError` state per page, a skeleton
shaped to that feature (see §5), and only falling through to the empty
state once loading is `false` and `loadError` is `null`.

### Bug 2 — Same conflation, sneakier form (MoodHistory)
`MoodHistory.tsx` used `rows === null` for loading, but on a fetch
error the old code caught it, logged to console, and set
`rows = []` — identical to the real empty state. A person whose mood
history genuinely failed to load saw "No mood check-ins in the last 30
days yet," which is a false claim about their own data.
**Fix:** separate `loadError` state, rendered via the shared
`ErrorCard` with retry; `rows` no longer gets a fake empty array on
failure.

### Bug 3 — Several mutations had no error handling at all
`Us.tsx`'s `sendTap`, `addCountdown`, `deleteCountdown`, and
`submitDailyAnswer`; `MemoryWall.tsx`'s `addMemory` and `deleteMemory`;
`Playlist.tsx`'s `acceptBlend`, `declineBlend`, and `endBlend` — all
called Supabase without checking `error`, or checked it but didn't
surface anything. A failed insert/delete/update just silently no-opped:
the button appeared to do nothing, with no toast, no rollback, no way to
know whether to retry.
**Fix:** every one of these now checks the Supabase response, calls
`capture()` with a new typed code (`DS-US-*`, `DS-MOOD-001`,
`DS-GROIC-*`), and shows a toast telling the person what didn't happen.
`deleteCountdown` specifically got an optimistic-update rollback (it
removed the row from local state before the request; on failure it now
restores it instead of leaving the UI out of sync with the database).

### Bug 4 — Destructive actions with no confirmation
Countdown delete (`Us.tsx`) and song removal (`Playlist.tsx`) were a
single tap on a small icon button with no confirmation step —
inconsistent with Shayari's mutual-consent delete flow and Memory
Wall's confirm-before-delete (which itself needed a real confirm dialog
added, not just a text button inside the viewer — see §3).
**Fix:** both now go through the shared `AlertDialog` confirm pattern,
matching Shayari's and the new Memory Wall confirm.

### Bug 5 — Deep links didn't exist for any of these features
Push notifications (`usePushNotifications.ts` →
`routeForNotificationData()`) have no case for a tap, a new memory, a
new shayari, or a countdown coming due — those events don't currently
generate a push at all, and nothing in the app accepted a query param to
jump to a specific item even if one arrived by another route (a share
link, for instance).
**Fix:** the *receiving* half only — see §6. Sending the payload is a
backend change (edge function + DB trigger work) explicitly out of scope
for a UI pass; documented as a gap, not silently left broken.

---

## 3. Per-feature state audit

Legend: ✅ = present and verified by trace · 🆕 = added this pass ·
— = not applicable to this feature · ⚠️ = present but with a caveat
noted below.

### Us (hub: mood, streak, tap, daily question)

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | Full skeleton (avatar circle, two quick-action cards, countdown row, question card) replaces the old "renders empty sections" behavior. |
| Empty | ✅ | "No countdowns yet. Add one!" / no-answer-yet composer — pre-existing, now only shown once loading is confirmed done. |
| Error | 🆕 | `ErrorCard` + retry on the whole-page load; per-mutation toasts on tap/countdown/answer/mood failures. |
| Offline | ✅ (inherited) | `OfflineBanner` is mounted once in `AppLayout`, above every route — no per-page work needed. Verified it renders above this page's content and below the invite/incoming-call overlays in z-order. |
| Realtime update | ✅ | Untouched — partner mood/profile and countdown channels already live-update the hub. |
| Stale data | — | No staleness concept on this page (mood timestamp shown as relative text, not flagged stale/fresh). |
| Retry | 🆕 | Load-error retry button; individual failed mutations can simply be retried by repeating the action (all are idempotent-safe: tap send, countdown add, answer submit are each single inserts/upserts). |
| Destructive action | 🆕 | Countdown delete now confirms via `AlertDialog` before deleting (previously a bare icon tap). |
| Navigation back | ✅ | `PageHeader`'s back button, unchanged, consistent with every other tab page in the app. |
| Deep link | 🆕 | `?focus=mood`, `?focus=countdown` open the matching dialog once (param stripped after); `?memory=<id>` forwarded to Memory Wall. See §6 for the honest gap on the sending side. |
| Mobile scrolling | ✅ | Unchanged `overflow-y-auto overscroll-contain`, momentum scrolling via `WebkitOverflowScrolling`. |
| Keyboard | ✅ | Daily-question `Input` submits on Enter; dialogs use the existing `Dialog` primitive which already handles viewport-resize/keyboard-avoidance app-wide. |
| Safe area | ✅ | `safe-top` on `PageHeader`, unchanged. |

### Memories (Memory Wall, embedded in Us)

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | 6-tile shimmer grid, matching the real grid's 3-column layout. |
| Empty | ✅ | Icon + "No memories yet — add your first! 📸", now gated behind `loading`/`loadError`. |
| Error | 🆕 | `ErrorCard` + retry, scoped to the wall's own section (doesn't block the rest of the Us page). |
| Offline | ✅ (inherited) | Same global banner. |
| Realtime update | ✅ | Untouched insert/update/delete channel. |
| Stale data | — | No staleness concept (photos don't go stale). |
| Retry | 🆕 | Both the section-level load retry and per-action recapture on add/delete failure. |
| Destructive action | 🆕 | Delete previously fired straight from a text button inside the viewer dialog; now confirms via `AlertDialog` first, matching the rest of the app's destructive pattern. |
| Navigation back | — | Not a standalone route — embedded section, closes via the dialog's own dismiss. |
| Deep link | 🆕 | Accepts `focusMemoryId` from `Us.tsx`'s `?memory=<id>`; opens/scrolls to that memory once the wall has finished loading. |
| Mobile scrolling | ✅ | Grid scrolls with the parent page; unchanged. |
| Keyboard | ✅ | Caption `Input` in the add dialog, unchanged. |
| Safe area | ✅ (inherited from Us). |

### Countdown / Anniversary (section of Us)

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | Covered by the Us-page skeleton (countdown row placeholder). |
| Empty | ✅ | "No countdowns yet. Add one!" — anniversary card (from Settings) still shows independently even with zero countdowns. |
| Error | 🆕 | Covered by the Us-page load error; add-countdown failures get their own toast + `DS-US-002`. |
| Retry | 🆕 | Add dialog stays open with a disabled-until-retry save button (`savingCountdown` guard, prevents double-submit — pre-existing, verified still correct). |
| Destructive action | 🆕 | Confirm dialog before delete (Bug 4). |
| Realtime | — | Countdowns aren't currently on a realtime channel (only fetched on load) — noted as a possible future improvement, not fixed here since it's a data-flow change. |
| Deep link | 🆕 | `?focus=countdown` opens the add dialog directly. |
| Mobile/keyboard/safe area | ✅ | Shares the Us page's dialog and layout, unchanged. |

### Mood (quick-set on Us + `MoodHistory.tsx` dialog)

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | History dialog: two stat-card shimmers + one chart shimmer, replacing a plain "Loading…" line. |
| Empty | ✅ | "No mood check-ins in the last 30 days yet," now only shown when genuinely empty (Bug 2 fix). |
| Error | 🆕 | Previously indistinguishable from empty (Bug 2) — now a real `ErrorCard` + retry. |
| Offline | ✅ (inherited). |
| Realtime | — | History is a one-shot fetch on dialog open, by design (private-to-you data, no live multi-device need identified). |
| Stale data | — | N/A — always refetches on open. |
| Retry | 🆕 | Retry button on the new error state. |
| Destructive action | — | No delete affordance on mood history (read-only view). |
| Navigation back | — | Dialog dismiss, unchanged. |
| Deep link | 🆕 | `?focus=mood` on Us opens the quick-set dialog (not the history dialog, which has no route of its own). |
| Keyboard | ✅ | Mood text `Input` in the quick-set dialog, unchanged. |
| Safe area | ✅ | Dialog respects `max-h-[85dvh]`, unchanged. |

*Note: `MoodDetector.tsx` (the automatic on-device detection pipeline
that feeds `mood_logs`) is RED per the Safety Map and was not opened
beyond confirming it wasn't a target of this pass — its detection logic,
thresholds, and lock-screen integration are a different subsystem from
the quick-set/history UI covered here.*

### Map / Live Location

See §4 for the dedicated deep-dive — summary here for consistency with
the other rows.

| State | Status | Notes |
|---|---|---|
| Loading | ✅ (pre-existing) | `requesting_permission`/`reconnecting`/`idle` states already rendered distinctly. |
| Empty (no partner linked) | ✅ (pre-existing) | "Link with partner in Settings." |
| Error | ✅ (pre-existing), 🆕 telemetry | Bespoke inline error UI was already correct; now also captures `DS-MAP-001`/`002` for consistency with the rest of the app's error registry — additive only, no UI change. |
| Offline | ✅ (pre-existing) | Own `online`/`navigator.onLine` listener, independent `WifiOff` chip (kept as-is — this page needs it faster/more prominent than the global banner, since GPS sharing depends on connectivity in a way most pages don't). |
| Permission denied | ✅ (pre-existing) | Dedicated "Request Permission" button, distinct copy from GPS-unavailable. |
| Realtime update | ✅ (pre-existing) | Realtime channel + watchdog→polling fallback, untouched. |
| Stale data | ✅ (pre-existing) | Dual staleness check (location age AND heartbeat age), grays out marker + pill. |
| Retry | ✅ (pre-existing) | "Request Permission" re-triggers the browser prompt. |
| Destructive action | — | No destructive actions on this page. |
| Navigation back | ✅ | `PageHeader`, unchanged. |
| Deep link | — | Not added — no per-location deep-link target makes sense for a live-position map (unlike a static memory or shayari). |
| Mobile scrolling | — | Full-bleed map, not a scroll page. |
| Keyboard | — | No text input on this page. |
| Safe area | ✅ (pre-existing) | `safe-top`, verified unchanged. |

### Shayari

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | 3-card shimmer, shaped like the real quote cards (title/body/date-tag lines). |
| Empty | ✅ | Three distinct empty copies (favorites tab / search / genuinely none) — pre-existing, now gated on load completing. |
| Error | 🆕 | `ErrorCard` + retry. |
| Offline | ✅ (inherited). |
| Realtime | ✅ (pre-existing) | Insert/update/delete channel, untouched. |
| Stale data | — | N/A. |
| Retry | 🆕 | Load retry; add-failure toast + `DS-SHAYARI-002`. |
| Destructive action | ✅ (pre-existing, verified) | Mutual-consent delete (requester → partner approves) was already well-designed; not changed. |
| Navigation back | ✅ | `PageHeader`, unchanged. |
| Deep link | 🆕 | `?id=<id>` scrolls to and highlights (accent border) the target entry once loaded. |
| Mobile scrolling | ✅ | Unchanged. |
| Keyboard | ✅ | Add-dialog `Textarea`/`Input`, search `Input` with clear button — unchanged. |
| Safe area | ✅ | `safe-top` via `PageHeader`. |

### Groic (discovery/search + listen-together session)

| State | Status | Notes |
|---|---|---|
| Search | ✅ (pre-existing) | Edge function → Piped-mirror fallback (3s abort per mirror) → static curated list. Already the most sophisticated degradation path in this feature set. |
| Loading | ✅ (pre-existing), 🆕 polish | Was already distinct from empty (`loading && results.length === 0`); swapped ad hoc `animate-pulse` divs for the shared `Shimmer` component. |
| Failed search | 🆕 | Previously only a toast on total failure; now also captures `DS-GROIC-001` and — critically — shows an inline "Full search is unreachable — showing a small curated set instead" banner whenever the fallback path is in use, even when it *did* return results (a "degraded," not "empty" or "broken," state that had no visual signal before). |
| External media (YouTube thumbnails/Piped) | ✅ (pre-existing) | `loading="lazy"` on result thumbnails, unchanged. |
| Queue | ✅ (pre-existing) | "Add to queue" button on each result card, unchanged — feeds `GroicContext`. |
| Player state | — (RED, untouched) | Owned entirely by `GroicContext`. |
| Mini player | — (untouched) | Already correct, no gaps found. |
| Full player | — (untouched) | Already correct, no gaps found. |
| Invite/blend (session) | ✅ (pre-existing), 🆕 polish | "Together"/"Connected" pill; added a subtle pulse dot when actively connected, for at-a-glance status without reading text. |
| Background transitions | ✅ (pre-existing) | `motion.div` fade-in on mount, staggered result-card entrance — unchanged. |
| Destructive action | — | No delete affordance on this page (results are ephemeral search state, not owned data). |
| Retry | ✅ (pre-existing) | "Try again" button on the true-empty state. |
| Navigation back | ✅ | Custom `ChevronLeft` header (not `PageHeader` — this page predates that convention and has bespoke sticky-search-bar needs; left as-is, functionally equivalent). |
| Deep link | — | Not added — a search page has no natural persistent target. |
| Mobile scrolling | ✅ | Unchanged. |
| Keyboard | ✅ | Search `Input` submits on Enter, unchanged. |
| Safe area | ✅ | `safe-top` on the sticky header, unchanged. |

### Playlist ("Our Playlist" — separate collaborative queue + Blend)

*Architecture note:* `Playlist.tsx` is a second, independent music
player (its own iframe-embedded playback, its own `blend_invites`
concept) that does not share `GroicContext`. This predates this pass and
was not touched structurally — see Known Gaps for why this is worth a
future look, not a redesign-scope fix.

| State | Status | Notes |
|---|---|---|
| Loading | 🆕 | 4-row shimmer list (thumbnail + two text lines), matching the real song-row layout. |
| Empty | ✅ | Icon + "No songs yet. Add your first song!" with Search/Paste-Link CTAs — pre-existing, now gated on load completing. |
| Error | 🆕 | `ErrorCard` + retry on the whole-page load. |
| Offline | ✅ (inherited). |
| Realtime update | ✅ (pre-existing) | Blend-sync broadcast channel (play/pause/skip) and blend-invite notification channel, untouched. |
| Stale data | — | N/A. |
| Retry | 🆕 | Load retry; every mutation (add/remove/invite/accept/decline/end) now surfaces a toast on failure so the person knows to retry. |
| Destructive action | 🆕 | Song removal now confirms via `AlertDialog` (Bug 4) — previously a single tap. |
| Navigation back | ✅ | `PageHeader`, unchanged. |
| Deep link | — | Not added — songs don't have a natural share/notification target yet (no push type exists for "song added"). |
| Mobile scrolling | ✅ | Unchanged. |
| Keyboard | ✅ | Add-song dialog inputs, unchanged. |
| Safe area | ✅ | `safe-top` via `PageHeader`. |

### Music queue/blend (cross-cutting: Groic session + Playlist blend)

Two independent "listen together" concepts exist side by side — Groic's
`sessionRole`/`startSession`/`endSession` and Playlist's
`blend_invites`/accept/decline/end. Both got the same treatment within
their own file (invite/accept/decline/end error handling in Playlist;
degraded-state banner and connection pulse in Groic) but were **not**
unified into one system — that would be a data-flow/architecture change,
explicitly out of scope ("do not rewrite the underlying data logic").
Flagged in Known Gaps.

### Relationship-specific utilities (taps, daily question, mood text,
countdown/anniversary)

Covered individually above under Us/Countdown/Mood — there's no separate
"utilities" page; these are all sections of the Us hub. Each got the
same error-handling and confirm-dialog treatment as the section it lives
in.

---

## 4. Map — dedicated deep-dive

Per the brief, Map got the most caution. Summary of what was traced and
confirmed **already correct and left alone**, plus the two additive
changes made:

- **Location permission** — `permissionState === "denied"` renders a
  dedicated card with a "Request Permission" button that re-triggers
  `navigator.geolocation.getCurrentPosition`; distinct from the
  GPS-unavailable copy. Traced, correct, untouched.
- **GPS unavailable** — `locationError` (from the hook, RED) renders
  inline with an `AlertCircle`; distinct from permission-denied. Traced,
  correct, untouched.
- **Stale partner location** — dual check: location `updated_at` age
  AND partner heartbeat (`last_seen_at`) age both have to exceed their
  thresholds before the UI calls it stale (avoids flapping on a single
  slow update). Marker opacity/grayscale + "· stale" label + pill
  opacity all respond together. Traced, correct, untouched.
- **Partner offline** — separate from staleness: a `WifiOff` chip driven
  by the page's own `online`/`offline` listeners (kept independent from
  the app-wide `OfflineBanner` deliberately — GPS sharing needs faster,
  more prominent feedback than a generic banner). Traced, correct,
  untouched.
- **Location mode** — `persistent` vs `on_open`, gates `sharingActive`
  and is reflected in copy ("Background GPS active" / "GPS active while
  app is open" / "Paused — tab is in the background"). Traced, correct,
  untouched.
- **Battery impact** — `PartnerStatusPill` shows the partner's battery
  level/charging state (from `useDeviceStatus`, RED) with its own
  staleness gate (`deviceStatusStale`), separate from location
  staleness, since a phone can keep reporting battery after GPS goes
  stale or vice versa. Traced, correct, untouched.
- **Map tile loading** — Leaflet tile layer swap on style change; no
  loading-state gap found (`mapLoaded` guards marker/line rendering
  until the base map is ready). Traced, correct, untouched.
- **Marker updates** — `createIcon`/`animateMarker` interpolate marker
  position on new coordinates rather than snapping; stale styling
  applied via the same icon-creation path so a marker never has to be
  torn down and rebuilt just to show/clear staleness. Traced, correct,
  untouched.
- **Subscription cleanup** — realtime channel `removeChannel` in the
  effect's cleanup, watchdog timer cleared, `setInterval` for the
  30s ticker cleared, visibility/online/offline listeners removed on
  unmount. All traced individually; all correct, all untouched.

**What was changed (additive only):**
1. `DS-MAP-001` (permission denied) and `DS-MAP-002` (GPS unavailable)
   captured into the shared error registry alongside the existing inline
   UI, for telemetry/consistency — the visible UI is byte-for-byte the
   same as before.
2. `tabular-nums` added to the coordinate readout and the distance/
   timestamp stats, so digits don't jitter horizontally as they update
   — a small legibility fix, not a restructure. This also doubles as
   Map's personality marker: monospace-feeling numerals for a
   utilitarian/geographic read, in contrast to Us/Shayari's `font-serif`
   treatment for "warm" numbers (streak, days-until, distance-apart
   already used serif and was left as-is).

Nothing in `useLiveLocation.ts` (the GPS engine itself, RED) was opened
for editing at any point in this pass.

---

## 5. Groic/Playlist — dedicated deep-dive

- **Search** — Groic: edge function first, three Piped mirrors with a
  3s abort each, static curated list as last resort; traced and
  confirmed each layer degrades gracefully into the next rather than
  hanging. Playlist has no search of its own beyond the "Paste Link"
  flow plus an optional `showSearch` overlay — not restyled beyond the
  loading-state fix already covered in §3.
- **Loading** — both now use the shared `Shimmer` component instead of
  ad hoc pulse divs (Groic) or nothing at all (Playlist).
- **Failed search** — Groic's fallback chain now surfaces a visible
  "showing a curated set" banner (previously silent unless it hit the
  absolute worst case, in which case it was toast-only) — see Bug/§3.
- **External media** — thumbnails `loading="lazy"` on both pages,
  unchanged; no `decoding="async"` gap found here (that fix was already
  applied to Gallery in the prior pass per `CALL_GALLERY_QA.md` — not
  duplicated here since these thumbnails are small grid tiles, not a
  full-bleed viewer).
- **Queue** — Groic's "add to queue" (`enqueue`) and Playlist's ordered
  `queue` state (shuffle/repeat) are two separate concepts in two
  separate systems (see the architecture note in §3) — both traced,
  neither's data flow touched.
- **Player state / mini player / full player** — entirely `GroicContext`
  -owned (RED); zero changes. Playlist's own iframe-based player
  (`currentSong`, `isPlaying`, `repeatMode`, `shuffleOn`) is likewise
  untouched logic-wise; only its song-row loading/error/destructive
  states changed.
- **Invite/blend** — Groic's session invite (via `GroicInviteBanner.tsx`,
  untouched) and Playlist's `blend_invites` accept/decline/end (now with
  error handling, §2 Bug 3) are the two separate "listen together"
  mechanisms — see the cross-cutting note in §3 for why they weren't
  unified.
- **Background transitions** — both pages already used Framer Motion
  fade/stagger on mount and result-card entry; unchanged.

---

## 6. Deep links — what actually works today

Added this pass (all client-side, all gated behind their page's own
`loading` state so a deep link never opens a dialog for data that hasn't
arrived yet):

| Target | Param | Behavior |
|---|---|---|
| Us — mood dialog | `/us?focus=mood` | Opens the quick-set mood dialog once, strips the param. |
| Us — countdown dialog | `/us?focus=countdown` | Opens the add-countdown dialog once, strips the param. |
| Memory Wall — specific memory | `/us?memory=<id>` | Forwarded to `MemoryWall` as `focusMemoryId`; opens the viewer for that memory once it's in the loaded list. |
| Shayari — specific entry | `/shayari?id=<id>` | Scrolls to and highlights (accent border) that entry once loaded. |

**Honest gap:** nothing sends these links yet. `usePushNotifications.ts`'s
`routeForNotificationData()` only handles call/chat/settings/group-
invitation payload types — there is no notification type for a tap, a
new memory, a new shayari, or a countdown coming due, so none of those
events currently produce a push notification at all (confirmed by
reading the full `switch` in that file). Making that work end-to-end
needs:
1. New notification `type`s decided and added to whatever sends the
   payload (the `send-push` edge function / its trigger).
2. A `case` added to `routeForNotificationData()` mapping each new type
   to the query params above.

Both are backend/business-logic changes and were intentionally not
attempted here, per "do not rewrite the underlying data logic." This
table is the contract the backend side should target.

---

## 7. Unification — what's shared vs. what's deliberately different

**Shared across all nine features (unchanged from earlier redesign
passes, verified still consistent):**
- `PageHeader` for page-level chrome (title, subtitle, back button,
  safe-top) — every page except Groic, which predates this convention
  with a bespoke sticky search header for layout reasons specific to
  that page (verified functionally equivalent: same back-button
  behavior, same safe-top handling).
- `OfflineBanner`, mounted once in `AppLayout` — no per-page
  reimplementation needed or added.
- `AlertDialog` for every destructive confirmation added this pass
  (countdown delete, memory delete, song removal) — same component,
  same copy pattern ("X will be removed for both of you. This can't be
  undone."), same cancel/confirm button order.
- `ErrorCard` + the typed error registry for every new error state —
  same visual treatment, same retry-button pattern, app-wide.
- `Shimmer` for every new loading skeleton — same shimmer animation,
  shaped differently per feature (see below) but never a bare spinner
  or a plain "Loading…" string.
- Surface tokens (`bg-card`, `border-border`, `rounded-2xl`/`rounded-xl`
  radii, `shadow-sm`) — no new hardcoded colors introduced anywhere in
  this pass; verified via `grep` for hex/rgb literals in every edited
  file (none found beyond the pre-existing Leaflet marker HTML strings
  in `MapView.tsx`, which were already using `hsl()` token-derived
  values and were not touched).

**Deliberately different per feature (personality, not inconsistency):**
- **Us / Shayari** — `font-serif` on the "meaningful numbers" (streak,
  days-until-countdown) and quote-card treatment (serif opening quote
  mark) for warmth/intimacy.
- **Map** — `tabular-nums`, geographic/utilitarian register, its own
  independent offline indicator (faster feedback than the global
  banner, justified by GPS's tighter connectivity dependency).
- **Groic** — energetic discovery register: mood chips, square album-art
  grid, a connection pulse dot, `Sparkles` iconography.
- **Playlist** — collection/vinyl register: horizontal song rows with a
  now-playing equalizer animation, distinct from Groic's grid-of-tiles
  discovery feel, even though both are "music."
- **Memory Wall** — photo-wall grid (3-col squares), distinct from every
  other list/grid in the app.

**Avoided, per the brief:** no new generic "dashboard card" grid was
introduced anywhere — Us's quick-actions are two cards (mood, tap), not
a wall of stat tiles; Map's stats are two purposeful cards (distance,
device status), not a KPI dashboard; nothing here reads as
interchangeable CRUD-list boilerplate between features.

---

## 8. Verification method

For every edited file: `tsc --jsx react-jsx --noEmit --skipLibCheck
--allowJs --esModuleInterop --target es2020 --moduleResolution bundler
--module esnext <file>` was run individually (this environment has no
`node_modules`, so a full project type-check with path aliases isn't
possible — this catches syntax errors and any type error local to the
file's own logic, not cross-module type mismatches). All edited files
came back clean of anything beyond expected "cannot find module `@/...`"
noise from the missing path-alias resolution. **This is not a substitute
for `npm install && npm run build`/`tsc -p .` — that full-project check
still needs to run before shipping.**

---

## 9. Known gaps / needs a live pass

- **No real device/simulator/live-Supabase pass.** Every state above is
  a source trace, not an executed run. Before shipping: a real
  two-account pass through every row in §3, especially realtime
  scenarios (partner adds a memory/shayari/song while you're on the
  page) and the Map staleness/battery combinations, which are hard to
  fully reason about statically.
- **Full project type-check not run** (see §8) — only per-file syntax
  checks were possible in this sandbox.
- **Push-notification deep-link sending is not implemented** — see §6.
  The receiving side is ready; the sending side needs backend work.
- **Groic and Playlist are still two separate "listen together"
  systems** with no shared code — not unified in this pass since that's
  a data-flow decision, not a redesign one. Worth a dedicated
  architecture review before it's treated as permanent (mirrors the
  "two parallel calling implementations" issue found and fixed in an
  earlier phase — see `docs/memory.md`'s calling-infrastructure entry).
- **Countdowns have no realtime channel** — only fetched on page load.
  A partner adding a countdown while you're already on the Us page
  won't appear until next load/refetch. Not fixed here (would mean
  adding a new subscription, a data-flow change); flagged for a future
  pass.
- **MoodDetector.tsx itself** (the automatic detection pipeline, distinct
  from the quick-set/history UI covered here) was not audited beyond
  confirming it's RED and out of scope — if its own chrome needs a
  redesign pass, that's a separate, more cautious piece of work given
  its Peek Guard/security integration.
