# Phase 8 — Reliability & Performance Hardening

**Date:** 2026-08-10
**Scope:** Post-redesign audit of the full app (not just Phase 2's app-shell
surfaces) for React render/effect hygiene, resource-cleanup correctness,
realtime-subscription health, list/media performance, and mobile lifecycle
behavior. No new features were added — every change below is a fix to
existing behavior.

**How to read this doc:** findings are graded **P0** (real user-facing
break or resource leak, fix landed), **P1** (real cost/regression risk,
documented with a recommended fix but *not* implemented this pass — see
"Why not fixed now"), or **PASS** (checked closely, already correct —
listed so a future session doesn't re-audit it from scratch). Every P0/P1
item names the exact file(s) so it can be found without re-grepping the
codebase.

---

## 0. Build/verification status — read this first

This sandbox has **no network egress**. `npm install` fails immediately:

```
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/@capacitor-community%2fprivacy-screen
```

Because `node_modules` was never installed, none of the following could be
run in this session:

| Command | Status | Exact blocker |
|---|---|---|
| `npm run build` (`vite build`) | **Not run** | Vite/plugins not installed — depends on `npm install` |
| `npx tsc --noEmit` (typecheck) | **Not run** | `typescript` binary present globally (`tsc` v6.0.3 via a global install), but the project's own `tsconfig.json` path aliases (`@/...`) and every third-party type package (`@daily-co/daily-js`, `@mediapipe/tasks-vision`, etc.) are unresolvable without `node_modules` |
| `npm run lint` (`eslint .`) | **Not run** | ESLint config + plugins not installed |
| `npm test` (`vitest run`) | **Not run** | Vitest not installed |

This matches `docs/rules.md`'s own documented expectation for sandboxed AI
sessions ("no test-driven build loop available in some environments...say
so explicitly rather than claiming a change was verified"). **Every code
change in this document was verified by manual reading only** — full
before/after diffs, cross-reference of every call site of anything
renamed/moved, and manual type-shape tracing (e.g. confirming
`useDailyCall()`'s actual return shape before extending it in
`CallContext.tsx`). Nothing here should be treated as build-clean until
`npm install && npm run build && npx tsc --noEmit && npm run lint && npm test`
is actually run in an environment with registry access. The single
highest-priority manual check is called out in §1.1's regression-risk note.

---

## 1. P0 fixes landed this session

### 1.1 Incoming calls were silently missed off the Chat screen

**Files:** `src/contexts/CallContext.tsx`, `src/pages/Chat.tsx`, `src/pages/Calls.tsx`

**Impact (measured from code, not synthetic benchmark):** `IncomingCallOverlay`
— the component that rings, vibrates, and shows the accept/decline UI — was
mounted *only* inside `Chat.tsx`. Its `postgres_changes` subscriptions on
`call_history` (`incoming-calls`, `call-cancel`) only existed while that
page was mounted. Concretely: if the person was on Calls, Gallery, Map, or
Settings when their partner called, there was no ring, no vibration, no
banner — nothing — until (if at all) a push notification arrived. This
wasn't a hypothetical: `usePushNotifications.ts` has a comment explicitly
routing a notification tap to `/chat` *because* that's the only page where
the accept UI exists — a workaround for this gap, not a fix for it. For a
couples app whose core promise is "always reachable," a missed in-app call
because you were looking at photos is a severe reliability bug.

**Root cause:** `CallProvider` (in `CallContext.tsx`) already wraps every
protected route and persists across navigation — that's the exact
mechanism a previous session used to fix the "Duplicate DailyIframe
instances" bug (see the comment block already in that file). `Incoming
CallOverlay` should have been mounted there from the start; it was left
behind in `Chat.tsx` along with its accept/decline handlers and their
page-local `currentCallId`/`isStartingCall` state.

**Fix:**
- `IncomingCallOverlay` now mounts once inside `CallProvider`, so its
  subscriptions are alive for the whole authenticated session regardless
  of route.
- Accept/decline logic (multi-device `claim_call` RPC → token fetch →
  `joinCall`) moved into `CallContext.tsx` as `acceptIncomingCall`/
  `declineIncomingCall`, using new context state `activeCallId` (renamed
  from `currentCallId`) and `isAcceptingCall` (parallel to the existing
  per-page `isStartingCall`, covering the claim/token network window
  before `callState` itself flips to `"joining"`).
- `Chat.tsx` and `Calls.tsx` both now read `activeCallId`/`setActiveCallId`
  from `useCall()` instead of owning local `currentCallId` state, so
  `endCall()` on either page still finds and closes out the right
  `call_history` row even when the call was accepted while a *different*
  page was mounted. Both pages' full-screen call-UI render gates now also
  check `isAcceptingCall`.
- `Chat.tsx`'s duplicate `handleAcceptIncoming`/`handleDeclineIncoming` and
  its own `<IncomingCallOverlay>` mount were removed (dead code now that
  the overlay is global).

**Regression risk: HIGH — this is the change most in need of manual QA
before shipping.** It touches the call accept/hangup path in two large,
heavily-commented page files that other sessions clearly hardened
carefully (multi-device claim races, call-outcome detection, "Duplicate
DailyIframe" avoidance). I traced every reference to `currentCallId`,
`setCurrentCallId`, and `isStartingCall` in both files by hand and
believe the substitution is mechanically sound, but this was **not**
run through `tsc` or the app itself. Manual test checklist before
trusting this:
1. Start a call from Chat, answer from a second device — unaffected path, confirm no regression.
2. Have your partner call while you're on **Calls**, **Gallery**, and **Map** (three separate tests) — confirm ring/vibrate/UI now appears on all three, and confirm accepting from each of those pages successfully joins.
3. After accepting from a non-Chat page, navigate to Chat and tap "end call" — confirm the `call_history` row transitions out of `in_progress` (not left dangling).
4. Rapid-tap Accept twice — confirm `isAcceptingCall` guard prevents a double `claim_call` call.
5. Two devices signed into the same account, both receive the call — confirm only one claims it and the other sees "Call answered elsewhere."

### 1.2 Build-breaking duplicate import

**File:** `src/pages/Chat.tsx`

`useMediaPermission` was imported twice from `@/components/PermissionDeniedSheet`
(once for the chat-composer's own media checks, once redundantly a few
lines later for the call-media check that already had its own alias).
TypeScript treats a repeated named import of the same binding from the
same module in one file as a hard `Duplicate identifier` error — this
would have failed `tsc`/`vite build` outright, unrelated to anything else
in this pass. Removed the redundant line.

**Regression risk: none.** Deletion of a literal duplicate; the binding
is still imported once and used at both original call sites.

### 1.3 Duplicate Supabase queries fired on every badge event

**File:** `src/components/FloatingDock.tsx`

**Impact:** The dock's two realtime channels (`dock-msgs` on `messages`,
`dock-calls` on `call_history`) both called one shared `fetchCounts()`
that ran *both* the unread-message count query and the missed-call count
query together. Since `FloatingDock` is mounted for the whole
authenticated session, every single message insert/update fired an
unrelated `call_history` COUNT query too, and every call-history change
fired an unrelated `messages` COUNT query — double the Postgres round
trips this component needed, on every event, for the life of the app.

**Fix:** Split into `fetchUnreadMessages()` (wired to `dock-msgs` only)
and `fetchMissedCalls()` (wired to `dock-calls` only). Behavior is
identical; only the number of queries per event changes (2 → 1).

**Regression risk: low.** Pure split of an existing function with no
change to the queries themselves or to when they fire relative to their
own table's events.

### 1.4 Missing lazy-loading on chat image attachments

**File:** `src/components/chat/MessageBubble.tsx`

Chat image attachments rendered via a plain `<img src=... />` with no
`loading`/`decoding` hints, unlike Gallery's grid (which already has
`loading="lazy" decoding="async"` on its `<img>`, confirming this is the
established convention elsewhere in the app — just missed here). In a
long chat history this means every image message decodes eagerly as soon
as it's in the DOM, whether or not it's actually scrolled into view.
Added `loading="lazy" decoding="async"` to match Gallery's existing
pattern.

**Regression risk: none.** Additive HTML attributes only; no layout or
behavior change (native lazy-loading degrades to eager loading gracefully
on any WebView that doesn't support it).

---

## 2. P1 — real findings, not fixed this session, with why

These are the two largest remaining performance risks in the app. Both
are correct in that they don't have UI/data bugs today, but both scale
badly with account age and neither can be safely hand-edited without a
working build/test loop, given how much surrounding logic (upload queue,
realtime dedup, disappearing messages, swipe gestures, context menus)
already lives in these exact files.

### 2.1 Gallery has no query pagination or list virtualization

**File:** `src/pages/Gallery.tsx` (`loadGallery`, line ~342)

```ts
const { data: mine } = await supabase.from("gallery_items")
  .select("id,owner_id,file_url,file_type,is_shared,created_at")
  .eq("owner_id", uid).order("created_at", { ascending: false });
// (no .range()/.limit() — fetches every row)
```

**Impact:** every mount of the Gallery page fetches *every* `gallery_items`
row for both partners (two unbounded queries), then calls
`resolveGalleryItems` → `resolveSignedUrls`, which fires one
`createSignedUrl` network call **per item, in parallel** via
`Promise.all`. For a couple a year into using the app with a few thousand
photos, that's a few thousand storage API calls fired simultaneously on
every single Gallery visit, plus a few thousand `<img>`/`<video>` DOM
nodes rendered with no windowing (the grid `.map()`s over the full
array directly — see `pages/Gallery.tsx` ~line 627). This is the single
biggest scaling risk in the app.

**Recommended fix (not implemented):** paginate `loadGallery` with
`.range(offset, offset + PAGE_SIZE - 1)` and a "load more"/infinite-scroll
trigger (the same pattern `Chat.tsx` already uses for message history,
`PAGE_SIZE = 200` there), and wire the grid through the **already-built,
already-unused** `useVirtualList` hook (`src/hooks/useVirtualList.ts` —
see §2.2) so only visible rows mount `<img>`/`<video>` elements.

**Why not fixed now:** this touches the upload queue, the realtime
partner-photo INSERT handler, the "select multiple" flow, and the shared
timeline rebuild — all of which currently assume `myItems`/`partnerItems`
are the *complete* set (e.g. `rebuildShared` sorts the full arrays
client-side). Correctly paginating requires either also paginating the
shared-view merge or accepting that "shared" only reflects the newest
page, which is a product decision, not a pure performance fix — exactly
the kind of change this phase was told not to make blind. Flagging as the
top item for a dedicated Phase 9 pass with an actual build loop available.

### 2.2 Chat message list and Gallery grid are unvirtualized despite existing infrastructure

**Files:** `src/hooks/useVirtualList.ts` (unused), `src/components/chat/MessageTimeline.tsx`, `src/pages/Gallery.tsx`

A lightweight virtual-scrolling hook already exists
(`useVirtualList.ts`, fully implemented, documented, exporting
`virtualItems`/`totalHeight`/`containerRef`) but a repo-wide search shows
it is imported nowhere except its own test setup —
`grep -rl "useVirtualList" src` returns only the hook file itself and
`src/test/setup.ts`. Neither `MessageTimeline.tsx` (chat) nor
`Gallery.tsx` (photos) uses it; both map directly over their full arrays.

**Compounding factor found in `MessageBubble.tsx`:** each rendered message
bubble instantiates **8 separate `motion.div` elements** (bubble
container, tail, reaction pill, timestamp fade, read-receipt check,
swipe-reply affordance, long-press ripple, and the image/attachment
wrapper). With `Chat.tsx`'s own `PAGE_SIZE = 200` messages per page load
and no windowing, a moderately active conversation a few "load more" taps
deep can have 400-600+ live Framer Motion-tracked elements in the DOM
simultaneously, none of them memoized (`grep -rl "React.memo" src/components`
returns zero files — no component in the app is memoized).

**Compounding factor found in `Chat.tsx`:** `partnerTyping` (the typing
indicator boolean) is `useState` at the top of `Chat.tsx` itself, the same
component that owns and passes down the full `messages` array to
`MessageTimeline`. Every typing-indicator broadcast from the partner
(fired on every keystroke via the `typing-${name}` channel) triggers a
`Chat.tsx` re-render, which — because `MessageTimeline` and every
`MessageBubble` inside it are unmemoized — re-renders the entire visible
message list on every partner keystroke, not just the typing indicator
itself.

**Recommended fix (not implemented):**
1. Wire `MessageTimeline`'s item list through `useVirtualList`.
2. Wrap `MessageBubble` in `React.memo` with a comparator on the message's
   own fields (id, content, status) so it doesn't re-render on unrelated
   parent state changes like `partnerTyping`.
3. Lift `partnerTyping` state (or at minimum the `TypingIndicator`
   component that consumes it) so it doesn't force a re-render of
   `MessageTimeline`'s parent — e.g. a small dedicated context or moving
   the indicator's own subscription closer to `TypingIndicator` itself.
4. Same virtualization treatment for `Gallery.tsx`'s grid once §2.1's
   pagination lands (virtualizing an already-unbounded list only fixes
   the DOM/render cost, not the unbounded fetch/signed-URL cost).

**Why not fixed now:** `MessageTimeline`/`MessageBubble` carry substantial
existing behavior (swipe-to-reply via `useMotionValue`, disappearing-message
timers, context menus, reaction pickers, read-receipt logic, search-result
highlighting) that a previous session clearly built and tuned carefully.
Retrofitting virtualization changes scroll-anchoring behavior (auto-scroll
on new message, "load older" preserving scroll position, jump-to-search-result)
in ways that are easy to get subtly wrong and impossible to verify without
running the app. This is real, worth doing, and explicitly scoped for a
follow-up phase with build access — not something to gamble on blind.

---

## 3. Full audit — checked and confirmed correct (PASS)

Everything below was checked against the specific concern in your
checklist and found to already be handled correctly, generally by prior
hardening sessions. Listed with evidence so a future session doesn't
have to re-derive this from scratch.

| # | Area | Evidence |
|---|---|---|
| 4 | Missing subscription cleanup | Every `supabase.channel(...)` call site (24 found via `grep -rn "\.channel("`) has a matching `removeChannel`/`unsubscribe` in its effect's cleanup — cross-checked 1:1, no orphans found. |
| 5 | Timers not cleared | All ~30 `setInterval` call sites store the id in a ref or local var and clear it both on early-return paths and in the effect cleanup (spot-checked `AppLockScreen.tsx`, `useLiveLocation.ts`, `useSessionGuard.ts`, `useAuth.tsx`, `GroicContext.tsx`, `ThemeContext.tsx`, `MapView.tsx`). |
| 6 | Animation loops not stopped | All `requestAnimationFrame` call sites (`VoiceMessagePlayer.tsx`, `SurpriseScene3D.tsx`, `MapView.tsx` marker animation, `codeSurprises.ts`) cancel the frame handle in cleanup/teardown. `MapView.tsx`'s marker-animation cleanup explicitly cancels in-flight RAFs before calling `map.remove()`. |
| 7–8 | Camera/microphone streams not stopped | `src/lib/cameraBus.ts` is a dedicated, refcounted camera pool (`acquireCamera`/lease `.release()`) specifically built to prevent exactly this class of bug across `PeekGuard`, `MoodDetector`, `FaceEnrollmentDialog` — it hard-stops tracks on pause and after a grace-period timeout post-release. `usePeekDetection.ts`'s `teardown()` calls `leaseRef.current.release()` and nulls the video element's `srcObject` on every teardown path (disable, tab-hide, camera-bus handoff, unmount). |
| 9 | Daily call objects not cleaned up | `useDailyCall.ts` has two dedicated fixes already in place for this exact class of bug: an awaited, promise-tracked `call.destroy()` (`pendingDestroyRef`) so a second create can't race a still-tearing-down instance, and `CallContext.tsx` ensures only one `useDailyCall()` instance exists app-wide (see the "Duplicate DailyIframe instances" comment block in that file). |
| 10 | Leaflet map cleanup | `MapView.tsx`: `map.remove()` in the init effect's cleanup, plus explicit cancellation of both marker-animation RAFs before that. Tile-layer swap effect calls `.remove()` on the old layer before adding the new one. |
| 11 | YouTube player cleanup | `GroicContext.tsx`'s hidden-player effect: `cancelled` guard on the async `loadYouTubeAPI().then()`, `player.destroy()` and `div.remove()` and `clearInterval` on the position-poll timer, all in the effect's cleanup. |
| 12 | MediaPipe worker cleanup | `src/lib/faceWorkerClient.ts`'s `teardownFaceWorker()` rejects all in-flight requests, clears the pending map, and calls `worker.terminate()`; called from `usePeekDetection.ts` on a real disable (not on transient pause, which is a deliberate choice documented inline to avoid reloading the ~3MB model on every tab-hide). |
| 13 | Object URL leaks | All 6 `URL.createObjectURL` call sites (`ThemeStudio.tsx`, `PhotoViewer.tsx`, `ErrorLogPanel.tsx`, `useCloudBackup.ts`, `iconGenerator.ts`, `Gallery.tsx`) have a matching `revokeObjectURL` — all are the "create → trigger download/render → revoke" pattern, none held indefinitely. |
| 22 (partial) | Unnecessary network requests — reconnect handling | `src/lib/networkState.ts` provides `useNetworkState`/`useAppLifecycle`/`useReconnectRefetch` specifically to avoid duplicate/spinner-forever refetch loops on reconnect; `Chat.tsx` uses `useReconnectRefetch` rather than its own ad hoc online/visibility listeners. |
| 24 | Duplicate badge subscriptions | Confirmed and fixed — see §1.3. The *channels* themselves (`dock-msgs`/`dock-calls` vs. Chat's own `messages-rt-*`/`call-history-rt`) are not literally duplicate (different names/purposes, and only one page is ever mounted at a time under the router), but the badge query itself was wastefully duplicated per-event — fixed. |
| 25 (partial) | Race conditions after navigation | 22 files use an explicit `cancelled`/`mountedRef` guard pattern around async work inside effects (e.g. `App.tsx`'s onboarding check, `Gallery.tsx`'s realtime INSERT handler explicitly documents guarding against a stale `.then()` firing after a partner/user change). Not exhaustive — see the note in §4. |
| — | Android/iOS keyboard resize | Not a JS-side concern here: `capacitor.config.json` already sets `"Keyboard": { "resize": "body", "resizeOnFullScreen": true }`, which is the Capacitor-level native config that keeps the webview correctly resized above the keyboard without needing the `@capacitor/keyboard` JS plugin wired in. Confirmed present and correctly configured. |
| — | prefers-reduced-motion | Already global via `<MotionConfig reducedMotion="user">` in `App.tsx` (per `docs/rules.md`'s own standing rule) — not re-litigated here. |

---

## 4. Checklist items not independently re-verified this session

In the interest of being precise about what was and wasn't actually
checked (rather than implying blanket coverage), the following items from
the requested checklist were **not** independently traced to a specific
finding or PASS this session, given the size of the codebase (238
TS/TSX files, ~38.7k lines) relative to the time available:

- **Expensive effects** — no systematic effect-by-effect cost audit (e.g.
  profiling which `useEffect`s do synchronous heavy work on the main
  thread) was performed beyond what surfaced incidentally (the
  camera-covered brightness check in `usePeekDetection.ts`'s `tick()` is
  already optimized to an 8×8 downsample specifically to avoid this class
  of cost — see the inline comment there).
- **Excessive backdrop-filter / box-shadow density** — counted but not
  reduced: 77 `backdrop-blur`/`backdrop-filter` usages and 59 files
  importing `framer-motion` across the app. This is a *lot* of blur
  surface for a glassmorphism-heavy design system, and `backdrop-filter`
  is one of the more GPU-expensive CSS properties, especially stacked
  (multiple blurred layers over each other, e.g. a blurred sheet over a
  blurred header). No specific over-budget instance was pinpointed or
  reduced — this needs an actual on-device frame-rate profile (Chrome
  DevTools Performance panel on a mid-range Android target) to say
  anything more specific than "77 is worth checking," and per this
  phase's explicit instruction not to fix performance by disabling
  functionality, blindly stripping blur without that profile would be
  guessing.
- **Layout shifts (CLS)** — not measured; would need Lighthouse/real
  device timing, not static reading.
- **Duplicate Supabase queries** more broadly than the one confirmed case
  in §1.3 — not exhaustively cross-referenced (e.g. whether Settings
  sub-pages independently re-fetch the same profile row Chat/Calls
  already fetched).
- **Full mobile lifecycle matrix** (process recreation on Android,
  CallKit/PushKit end-to-end, cold start timing, app termination during
  an active call) — these require an actual device/emulator and the
  native Android/iOS projects, which don't exist in this repo yet (`npx
  cap add android`/`ios` has never been run — confirmed via `find native
  -type f` returning only the hand-written Kotlin/Swift source files
  meant to be merged in later, not a generated project). `useAppNative.ts`
  and `usePeekDetection.ts` both already listen for Capacitor's
  `appStateChange` event correctly, which is the one piece of this
  observable from source alone.
- **Slow-network/offline/reconnect/session-expiry manual test matrix** —
  the underlying mechanisms (`useNetworkState`, `useReconnectRefetch`,
  `useSessionGuard`, `OfflineBanner.tsx`) all exist and were read, but
  actually *running* the app under throttled/offline network conditions
  to confirm end-to-end behavior requires a running build, which isn't
  available here.

These are exactly the kind of items worth a dedicated Phase 9 session
once `npm install` succeeds in an environment with registry access.

---

## 5. Files changed this session

- `src/contexts/CallContext.tsx` — mount `IncomingCallOverlay` globally; add `activeCallId`/`isAcceptingCall`/`acceptIncomingCall`/`declineIncomingCall`.
- `src/pages/Chat.tsx` — remove duplicate import; consume `activeCallId`/`isAcceptingCall` from context instead of local state; remove now-dead accept/decline handlers and overlay mount.
- `src/pages/Calls.tsx` — consume `activeCallId`/`isAcceptingCall` from context instead of local state.
- `src/components/FloatingDock.tsx` — split combined badge-count refetch into per-table refetchers.
- `src/components/chat/MessageBubble.tsx` — add `loading="lazy" decoding="async"` to chat image attachments.
