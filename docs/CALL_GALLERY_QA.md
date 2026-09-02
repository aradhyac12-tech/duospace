# Phase 4 — Calls + Gallery + Media Experience: QA Notes

Companion to `CALL_STATE_TEST_MATRIX.md` (which covers the DB-level state
machine invariants and is unchanged by this pass). This doc covers the
**UI layer** built on top of it, what changed, and how each required
scenario was verified.

No physical devices, simulators, or a live Daily/Supabase project were
available in this environment (network access is disabled for this
sandbox), so verification below is **static**: full manual trace of every
code path against the actual source, cross-checked against the existing
state machine's invariants. Anything marked "traced, not executed" needs
a real device/two-account pass before shipping — see Known Gaps at the
bottom.

---

## 1. What changed, and what didn't

**Untouched, as instructed:** `useDailyCall.ts` (Daily.co lifecycle),
`CallContext.tsx`, the Supabase RPCs (`claim_call`, `decline_call`,
`cancel_call`) and their triggers, `notify_voip_on_call_end`, CallKit
bridge, FCM/VoIP push code, `mediaPermissions.ts`'s permission logic,
`signedStorageUrl.ts`, and the gallery bucket's private/signed-URL
architecture. None of these files were edited.

**New presentation-layer files** (Calls):
- `src/lib/callUiState.ts` — pure function mapping the existing state
  primitives (`callState`, `isStartingCall`, `participantCount`,
  `networkQuality`, a new `everConnected` tracker) to one explicit
  `CallUiState`. Also documents haptic semantics per transition.
- `src/hooks/useCallOutcome.ts` — caller-side realtime listener (read-only
  on `call_history`) for remote-driven outcomes. See bug #1 below.
- `src/components/calls/CallOutcomeScreen.tsx` — terminal-state screen.
- `src/components/calls/CallStatusBanner.tsx` — reconnecting / partner-left
  / audio-fallback banners, shared by both call entry points.

**Modified:** `src/pages/Calls.tsx`, `src/pages/Chat.tsx`,
`src/components/chat/CallOverlay.tsx` (rebuilt as a pure, prop-driven
component around the same explicit states), `src/pages/Gallery.tsx`.

---

## 2. Confirmed bugs found and fixed (not pre-existing TODOs)

These were found while building the explicit-state screens, not known
issues going in. Each is scoped to a read-only listener or a client-side
UI fix — no RPC, Daily, CallKit, VoIP/FCM, or authorization code changed.

### Bug 1 — caller had no feedback when the receiver declined/timed out/cancelled elsewhere
Neither `Calls.tsx` nor `Chat.tsx` subscribed to their own outgoing
`call_history` row. Decline, the 30s auto-timeout (both write
`status='missed'`), and a cancel from another signed-in session all left
the caller's screen showing "Waiting for partner…" indefinitely, with no
way out but a manual hang-up.
**Fix:** `useCallOutcome.ts`, a Realtime `postgres_changes` listener
scoped to `id=eq.<callId>` while `everConnected` is still false. On
`status → missed` or `status → cancelled`, it calls the existing
`leaveCall()` (via the caller's own callback) and surfaces
`CallOutcomeScreen`. It only reads; it never calls an RPC.

### Bug 2 — "still ringing" and "partner left mid-call" looked identical
Both states show `participantCount <= 1` while `callState === "joined"`.
The old UI rendered "Waiting for partner..." for both, which is actively
misleading right after a real conversation — nothing told the person
their partner had left versus never having answered yet (this is the
explicit "call ends unexpectedly" scenario in the brief).
**Fix:** an `everConnected` boolean (set once `participantCount > 1`,
reset per call attempt) lets `deriveCallUiState()` tell `ringing` and
`partner-left` apart and show the correct copy in each case.

### Bug 3 — mic/camera permission denial had no recovery path in either call flow
Both `Calls.tsx` and `Chat.tsx` used a raw `getUserMedia` probe wrapped in
a bare toast ("Permission denied. Please allow..."), with no way to act
on it — while the app already has a full recovery flow
(`useMediaPermission`/`PermissionDeniedSheet`, deep-linking to OS
Settings on native, written steps on web, a working "Try again") that
Gallery already used.
**Fix:** both call flows now route the mic check through the same shared
hook Gallery uses. A camera denial that only surfaces once Daily itself
requests it at join time (so it can't be checked up front without racing
`cameraBus`) is caught via the existing `callError`/`error` state
(`code === "PERMISSION_DENIED"`) and routed to the same sheet.

---

## 3. Explicit state → screen mapping (Calls.tsx and CallOverlay.tsx)

| State | Primary action | Secondary action | Network feedback | A11y | Notes |
|---|---|---|---|---|---|
| `connecting` | (none — auto) | Cancel (hang-up button, calls `cancelStartingCall`) | — | `role="status" aria-live="polite"` on "Connecting…" | Shown the instant the button is tapped, not after the network round trip (pre-existing latency fix, preserved) |
| `ringing` | (none — auto) | Cancel | — | `role="status"` on "Ringing…" | Partner name shown when known |
| `connected` | Mute / camera / screen-share / route | End call | `AudioFallbackBanner` when `autoAudioFallback` is on | toolbar `role="toolbar"`, every control has `aria-label` + `aria-pressed` | |
| `reconnecting` | same live controls (call stays interactive) | End call | `ReconnectingBanner`, `role="status"` | | Derived from `networkQuality === "poor"` while connected — Daily itself is still retrying underneath; nothing here interrupts that |
| `partner-left` | End call | — | `PartnerLeftBanner` | `role="status"` | Bug #2 fix |
| `error` (`callState==="error"`) | Try again (retries same call mode) | Back to Calls/chat | — | `role="alert"` | New dedicated screen — previously fell through to a small inline banner only in `Calls.tsx`, and had no screen at all as a distinct case in `CallOverlay.tsx` beyond this same treatment |
| outcome: no-answer | Call again | Back | — | `role="status"`, `hapticWarning()` on mount | Bug #1 fix. Auto-dismisses after 5s |
| outcome: cancelled-elsewhere | Call again | Back | — | same | Bug #1 fix |
| outcome: failed | Call again | Back | — | same | Local failure with a message, not remote |

Incoming-call ringing (`IncomingCallOverlay.tsx`) was left structurally
as-is — it already had correct explicit states (30s auto-decline,
answered-elsewhere dismissal, `startCallVibration`/`stopCallVibration`
matching the OS ring pattern rather than one-shot haptics) and needed no
fix.

Touch targets: all call controls are 48–64px (`h-12`/`h-14`/`h-16`
Tailwind = 48/56/64px), above the 44px minimum on every platform's HIG.

---

## 4. Test matrix (traced against source; ✅ = holds, per code trace)

| Scenario | Path traced | Result |
|---|---|---|
| A calls B, B answers | `startCall`→`joinCall` (A) / `handleAcceptIncoming`→`claim_call`→`joinCall` (B) | ✅ both reach `connected`; `everConnected` flips true on both |
| B declines | `IncomingCallOverlay.handleDecline`→`decline_call` RPC→`status='missed'` | ✅ A's `useCallOutcome` listener fires → `leaveCall()` + "didn't answer" screen (bug #1 fix; previously stuck) |
| B does not answer (30s) | `IncomingCallOverlay`'s `setTimeout(handleDecline, 30000)` → same `decline_call` path | ✅ same outcome as decline — server can't distinguish, neither does the UI (intentionally labeled "No answer" either way) |
| A cancels | `cancelStartingCall`→`leaveCall()` + `cancel_call` RPC (if row already exists) | ✅ local, synchronous — `useCallOutcome` explicitly ignores its own device's cancel (only reacts to a `cancelled` row it didn't cause) |
| Two devices answer simultaneously | `claim_call` RPC, atomic `WHERE claimed_by IS NULL` (unmodified) | ✅ loser gets `claimed !== true` → "Call answered elsewhere" toast, never joins (pre-existing, verified untouched) |
| Answer/cancel race | `callCancelledRef` checked after both the edge-function call and the `joinCall` await, before committing to `claim`/insert (unmodified logic) | ✅ traced, logic unchanged |
| Network loss / reconnect | `networkQuality` from Daily's own `network-quality-change` event (unmodified) → `deriveCallUiState` maps `poor` while connected to `reconnecting` | ✅ new banner; Daily's own reconnection logic untouched |
| App background / foreground | Daily.co + CallKit/VoIP own this (unmodified); UI re-renders from the same `callState`/`participantCount` on resume | ✅ traced — no new state introduced that could desync on resume, since everything here is derived, not stored |
| Device locked | Native call UI (CallKit/Telecom) owns lock-screen presentation (unmodified) | not exercised — no native runtime in this environment |
| Microphone permission denied | `ensureCallMedia("microphone", …)` → `PermissionDeniedSheet` | ✅ bug #3 fix — was a dead-end toast |
| Camera permission denied | `callError.code === "PERMISSION_DENIED"` effect → `reportCallMediaFailure` → same sheet | ✅ bug #3 fix |
| Speaker route change | `useAudioRoute` (unmodified) — picker UI unchanged, still reachable from the connected-state toolbar | ✅ traced, no change |
| Call ends unexpectedly | `participant-left` Daily event → `participantCount` drops → `partner-left` state (not the ambiguous old "ringing" look) | ✅ bug #2 fix |

---

## 5. Gallery — what changed

Preserved unmodified: private bucket + `resolveSignedUrl`/
`resolveSignedUrls`, the upload call itself (`supabase.storage.upload`),
deletion, the shared/private visibility model, partner-gallery sharing,
`CameraWithFilters` integration, and the realtime sync channel.

- **Upload progress / failed-upload recovery** — replaced the single
  shared `uploading` boolean + fake `0 → 100` jump (Supabase's JS client
  has no byte-level progress callback, so faking a percentage would be
  dishonest) with a per-file queue (`queued → uploading → done/error`),
  rendered as a horizontal strip of thumbnails with a spinner, checkmark,
  or a tappable retry icon. Failed items keep their original `File`/`Blob`
  in memory so retry doesn't require re-picking the file.
- **Selection mode** — "Select" on the Mine tab enables tap-to-select with
  a bulk delete bar; single-item delete/share are still the per-item
  hover/press actions, unchanged.
- **Grid density** — comfortable (3-col) / compact (4-col) toggle,
  persisted via the same `storage` module the media-visibility toggle
  already uses.
- **Empty state** — added an icon-in-circle treatment and an inline "Add
  photos" CTA (only on the person's own tabs, not the partner's).
- **Full-screen viewer** — now opens with the current grid's full item
  list, supporting left/right arrow buttons, swipe (drag threshold), and
  keyboard arrow keys to move between items without closing/reopening.
- **Image loading** — added `decoding="async"` alongside the existing
  `loading="lazy"`.
- **Safe-area** — added `safe-top` to the page root and `safe-bottom` to
  the full-screen viewer and the new selection bulk-action bar.

Explicitly avoided: switching to a masonry/infinite feed layout, changing
how URLs are signed/stored, or touching RLS — none of that was asked for
and Gallery is deliberately not a social feed.

## 6. Known gaps / needs a live pass

- Everything in the test matrix above is a static code trace, not an
  executed run — there's no simulator or live Supabase/Daily project in
  this environment. Before shipping, a real two-device pass through the
  table above (especially the simultaneous-answer race and
  background/foreground on both iOS and Android) is still needed.
- `CallOutcomeScreen`'s "Call again" on the receiver side reuses whatever
  `callMode` was last set locally, which defaults to `"video"` if the
  outcome fires before any call was ever started from that side — a
  narrow edge case (receiver's own accept attempt fails before
  connecting) with low impact (worst case: retries as video instead of
  voice).
- Gallery's upload queue is in-memory only; a hard app kill mid-upload
  loses the retry affordance for any items still queued (the underlying
  upload itself is not resumed/re-attempted automatically — no chunked/
  resumable upload protocol exists in this codebase to hook into without
  changing storage architecture, which was out of scope).
