# DuoSpace — UI Redesign Bug Register

Companion to `docs/UI_REDESIGN_FORENSIC_AUDIT.md`. Every issue below is
labeled with its evidence level:

- **Confirmed from source** — read directly in this repo, no inference.
- **Highly likely** — strong inference from source, not runtime-observed.
- **Requires runtime/device validation** — cannot be settled by reading
  source alone.

No bug here was invented to pad the register. Where a suspicion couldn't be
verified, it was either excluded or explicitly marked as unverified rather
than stated as fact.

---

## BUG-01 — ✅ FIXED

> **Status update:** `src/components/BottomNav.tsx` has been deleted.
> Re-verified immediately before deletion that it had zero import sites
> anywhere in `src/` (same check as the original audit, re-run fresh).
> `FloatingDock.tsx` (the live implementation) was not touched. No other
> file referenced `BottomNav` (no barrel exports, no test files), so this
> was a pure, behavior-neutral deletion.

- **Severity:** Low (dead code / maintenance risk, not a live defect)
- **Feature:** Navigation — primary tab bar
- **File:** `src/components/BottomNav.tsx`
- **Line/reference:** Whole file (205 lines); realtime subscriptions at
  lines 44–61; badge-clear-on-navigate effect at ~lines 65–78.
- **Problem:** `BottomNav.tsx` is a complete, independent duplicate of
  `src/components/FloatingDock.tsx`'s unread-message/missed-call badge
  logic — same two tables (`messages`, `call_history`), same count
  queries, same "mark missed calls as seen on navigating to /calls"
  side effect, same scroll-based auto-hide behavior — but under different
  realtime channel names (`nav-unread-messages`/`nav-missed-calls` vs.
  `dock-msgs`/`dock-calls`). It is never imported or rendered anywhere in
  `src/` (confirmed by repository-wide search).
- **Why it is a problem:** For a UI redesign specifically, this is a trap:
  a future engineer restyling "the bottom nav" could easily open and edit
  `BottomNav.tsx` (the more obviously-named file) instead of the actually-
  rendered `FloatingDock.tsx`, ship a change that has zero visible effect,
  and waste a redesign cycle. It also bloats the component surface a
  redesign audit has to reason about.
- **Reproduction path:** `grep -rn "BottomNav" src --include=*.tsx` →
  only match is the file's own `const BottomNav = () => {...}` and its
  `export default BottomNav;` — no import site anywhere, including
  `AppLayout.tsx` (which renders `FloatingDock` instead).
- **Expected behavior:** Either `BottomNav.tsx` should not exist, or it
  should be the one actually rendered (not both maintained in parallel).
- **Current behavior:** Two parallel, functionally-identical
  implementations exist; only one is live.
- **Recommended fix:** Delete `src/components/BottomNav.tsx` in a
  dedicated cleanup commit, separate from any redesign work, after
  confirming (via a repo-wide search at delete time, since this audit is a
  point-in-time snapshot) that nothing has started importing it since.
- **Risk of changing it:** Very low — it's unreachable code. Deleting it
  cannot change app behavior. The only risk is deleting the wrong file by
  mistake (i.e., accidentally deleting `FloatingDock.tsx`) — double-check
  the import graph before removing anything.
- **Fix before UI redesign?** **Yes, recommended, but not blocking.** It's
  safe to redesign around it as long as engineers are told which file is
  live (see Safety Map). Deleting it is a 5-minute cleanup that removes a
  known landmine before other people start touching the nav.
- **Evidence level:** Confirmed from source.

---

## BUG-02 — ✅ FIXED

> **Status update:** `src/components/SurpriseOverlay.tsx` has been
> deleted. Re-verified zero import sites anywhere in `src/` immediately
> before deletion. `ChatSurpriseHost`/`useChatSurprise` (the live
> implementation, and the sole owner of the `"code-surprises-realtime"`
> channel name going forward) were not touched. The channel-name
> collision risk this bug described is now moot — there is only one
> subscriber to that channel name in the codebase.

- **Severity:** Medium (currently dormant; would become a real defect if
  triggered)
- **Feature:** Surprise Mode
- **File:** `src/components/SurpriseOverlay.tsx` (channel definition at
  line 108) vs. `src/hooks/useChatSurprise.ts` (channel definition at
  line 95)
- **Line/reference:** Both files create
  `supabase.channel("code-surprises-realtime")` — an identical, hardcoded
  channel name, in two independent components.
- **Problem:** `SurpriseOverlay.tsx` is dead code (zero imports anywhere
  in `src/`, confirmed by repo-wide search), superseded by
  `ChatSurpriseHost` + `useChatSurprise`, per an explicit comment in
  `App.tsx`: *"Dedicated deep-link form: /surprise/:id folds into the
  chat query-param form so there is only ONE place (ChatSurpriseHost)
  that actually resolves it."* However, `SurpriseOverlay.tsx` was not
  deleted, and it independently subscribes to the exact same
  Supabase Realtime channel name that the live `useChatSurprise` hook
  uses.
- **Why it is a problem:** Supabase's JS Realtime client keys its internal
  channel registry by channel name per client instance. If
  `SurpriseOverlay.tsx` is ever re-mounted (e.g., a redesign pass
  "restores" it thinking it's an alternate/legacy UI worth keeping, or
  someone copies its scaffolding into a new component without renaming
  the channel), two independent `.channel("code-surprises-realtime")`
  calls from the same browser tab will not behave as two independent
  subscriptions — the client will reuse or clobber the existing channel
  object, producing silently-dropped or duplicated event handling that is
  very hard to debug because nothing throws.
- **Reproduction path (would require re-introducing the dead component,
  so this is a design-time landmine, not a currently-reproducible bug):**
  1. Mount `SurpriseOverlay.tsx` anywhere in the tree alongside `Chat.tsx`
     (which already mounts `ChatSurpriseHost` → `useChatSurprise`).
  2. Trigger a code-surprise event server-side.
  3. Observe that one of the two channel subscriptions doesn't fire
     as an independent listener would (exact failure mode depends on
     Supabase JS client version internals — **requires runtime
     validation** to characterize precisely).
- **Expected behavior:** Only one implementation of Surprise Mode's
  realtime resolution should exist in the codebase.
- **Current behavior:** Two exist under the same channel name; one is
  unreachable today.
- **Recommended fix:** Delete `src/components/SurpriseOverlay.tsx`
  (same cleanup commit as BUG-01, or its own). If any part of it turns
  out to contain UI/animation not present in `ChatSurpriseHost`'s render
  path, extract that specific JSX/CSS before deleting — but do not keep
  the file's realtime subscription code.
- **Risk of changing it:** Very low (dead code deletion), same caveat as
  BUG-01 — confirm it's still unimported at delete time.
- **Fix before UI redesign?** **Yes, recommended.** Low effort, removes a
  landmine that specifically threatens Surprise Mode, which is one of the
  features listed as in-scope for this redesign effort.
- **Evidence level:** Confirmed from source (both files' existence,
  content, and the App.tsx comment). The failure mode if both were live
  simultaneously is inference from documented Supabase client behavior,
  not something reproduced in this audit — marked accordingly.

---

## BUG-03 — ⚠️ NOT FIXABLE FROM THIS SESSION (environment constraint, not a code defect)

> **Status update:** this is not something a code change can fix — it
> requires `node_modules` to exist (network access to the npm registry,
> or a pre-populated dependency cache), neither of which this sandboxed
> session has. Re-attempted after the BUG-01/02/04 fixes above to confirm
> nothing changed: `npm install --no-audit --no-fund` still returns
> `403 Forbidden` from `registry.npmjs.org` for the first package
> resolved. As a substitute, every file touched by this fix pass
> (`Gallery.tsx`, plus the deletions of `BottomNav.tsx`/
> `SurpriseOverlay.tsx`) was checked with an isolated, dependency-free
> `tsc` syntax pass (filtered to `TS1xxx` syntax-error codes only, since
> module-resolution errors are expected without `node_modules`) —
> **zero syntax errors**. This is a weaker guarantee than a real
> `tsc --noEmit`/`eslint`/`vitest` run and should not be treated as
> equivalent to CI passing. This item remains open and blocking for full
> verification; it is listed here as explicitly unresolved rather than
> silently dropped.

- **Severity:** N/A — this is an environment/process finding, not an
  application bug, but it blocks every other kind of verification and
  must be resolved before any redesign PR can be validated by CI.
- **Feature:** Build/test tooling (applies to the whole repo)
- **File:** `package.json` (scripts), `tsconfig.json`/`tsconfig.app.json`
- **Line/reference:** n/a — this is a whole-toolchain blocker, not a
  line-level issue.
- **Problem:** In this audit environment, `npm install` fails for every
  package with `403 Forbidden` from `registry.npmjs.org` (no network
  egress permitted). As a direct consequence: `npx tsc --noEmit -p
  tsconfig.app.json` fails immediately with `TS2688: Cannot find type
  definition file for 'vitest/globals'` (it can't resolve *any* type,
  not just vitest's); `npx eslint .` fails to even fetch `eslint` itself;
  `npx vitest run` fails the same way. The **only** check that ran
  successfully was the repo's own `node scripts/check-rls-coverage.ts`,
  because it's pure Node `fs`/regex with zero external dependencies.
- **Why it is a problem:** None of TypeScript's type errors, ESLint's
  static-analysis warnings, or the Vitest suite's pass/fail status could
  be established in this audit. Any claim in the forensic audit or this
  register about "no type errors" or "tests pass" would be false — none
  were checked. This also means a redesign PR produced by an agent in a
  similarly network-restricted environment cannot self-verify with the
  project's own tooling and must be validated in an environment with
  registry access before merge.
- **Reproduction path:** `npm install --no-audit --no-fund` in a
  network-isolated environment → `403` for the first dependency resolved
  (observed: `@capacitor-community/privacy-screen`, but every package
  would fail identically — it's a registry-access issue, not a
  package-specific one).
- **Expected behavior:** `npm install`, `npm run lint`, `npm run test`,
  and `npx tsc --noEmit` should all be runnable in the environment used
  to validate redesign changes.
- **Current behavior:** All four are blocked in *this* sandboxed audit
  environment.
- **Recommended fix:** Not a code fix — this is an environment
  requirement. Any redesign work session needs either (a) network access
  to `registry.npmjs.org` to run `npm install` once, or (b) a pre-built
  `node_modules`/dependency cache supplied alongside the repo.
- **Risk of changing it:** N/A.
- **Fix before UI redesign?** **Yes — this is a hard prerequisite**, not
  for the redesign's code itself, but for anyone's ability to verify it
  didn't break type-checking, linting, or tests.
- **Evidence level:** Confirmed from source (directly reproduced in this
  session; exact error text captured above).

---

## BUG-04 (candidate — not fully confirmed) — ✅ FIXED (belt-and-suspenders)

> **Status update:** although the register originally marked this
> "No — not required," it was a small, low-risk, well-understood change,
> so it was fixed while addressing BUG-01/BUG-02. `src/pages/Gallery.tsx`'s
> realtime INSERT handler now sets a `cancelled` flag in the same effect's
> cleanup function and checks it before calling `setPartnerItems` inside
> the async `resolveGalleryUrl(...).then(...)` callback — the same
> mounted-guard pattern already used in `useDailyCall.ts` elsewhere in
> this codebase. This covers both the unmount case (which React already
> no-ops safely) and the effect-re-run case (new `partnerId`/`user`,
> which React does *not* no-op automatically), so it's a strict
> improvement with no behavior change on the success path.

- **Severity:** Low, and unconfirmed
- **Feature:** Gallery
- **File:** `src/pages/Gallery.tsx`, realtime INSERT handler,
  approximately lines 280–305 (the `.on("postgres_changes", { event:
  "INSERT", ... })` handler inside the `gallery-rt-${sortedIds}`
  subscription effect).
- **Line/reference:** The handler calls
  `resolveGalleryUrl(rawItem.file_url).then((signedUrl) => { ...
  setPartnerItems(...) ... })` — the state update happens inside a
  `.then()` callback, not synchronously within the realtime event
  handler.
- **Problem:** If the component unmounts (user navigates away from
  `/gallery`) while `resolveGalleryUrl`'s promise is still pending, the
  `.then()` callback will still fire and call `setPartnerItems` /
  `rebuildShared` against a component that's no longer mounted.
- **Why it is a problem:** In React 18+, calling a state setter after
  unmount is a silent no-op (no console warning, no crash) — so the
  *practical* impact is likely nil (a wasted network round-trip and a
  discarded state update), not a visible bug. It's included here for
  completeness and because a redesign that changes Gallery's
  mount/unmount timing (e.g., keep-alive tabs, different transition
  durations) could change how often this path is actually hit — but
  since React already no-ops it safely, this is **not a blocking issue**.
- **Reproduction path:** Navigate to `/gallery` while a partner is about
  to insert a new shared gallery item, then navigate away within the
  window between the realtime INSERT event arriving and the signed-URL
  fetch resolving. **[Requires runtime/device validation to confirm
  actual observable impact, if any — timing-dependent and likely
  imperceptible given React 18's no-op behavior.]**
- **Expected behavior:** No functional expectation is violated in
  practice; this is a code-cleanliness note (missing a
  mounted-ref/AbortController guard), not a user-facing defect.
- **Current behavior:** As described.
- **Recommended fix:** Not urgent. If touched for unrelated reasons,
  consider adding a `mountedRef` guard (a pattern already used elsewhere
  in this codebase, e.g. `useDailyCall.ts`'s `mountedRef`) around the
  `setPartnerItems` call inside the `.then()`.
- **Risk of changing it:** Low, if done — but not necessary to unblock a
  redesign.
- **Fix before UI redesign?** **No — not required.** Listed for
  completeness only; do not spend redesign-cycle time on this unless
  it's touched incidentally.
- **Evidence level:** Confirmed from source that the pattern exists;
  **not confirmed** that it produces any observable defect (React 18
  behavior makes it very likely harmless).

---

## BUG-05 — ✅ FIXED (P0 — confirmed build-breaking, not runtime speculation)

**Confirmed from source, and confirmed by actually compiling the file** —
not an inference. `src/components/IncomingCallOverlay.tsx` had a JSX
comment placed *inside* the `{incomingCall && ( ... )}` expression,
directly before `<motion.div>`, with no operator joining them:

```
{incomingCall && (
  {/* Phase 2.5, section 19: ... */}
  <motion.div ...>
```

`{/* comment */}` inside a plain parenthesized JS expression (not a JSX
children list) parses as an object-literal expression `{}` — two
adjacent primary expressions with nothing between them is not valid
JS/TSX grammar at all. Ran `tsc --noEmit` directly against this file to
confirm rather than eyeballing it:

```
IncomingCallOverlay.tsx(162,11): error TS1005: ')' expected.
IncomingCallOverlay.tsx(170,142): error TS1382: Unexpected token...
IncomingCallOverlay.tsx(220,11): error TS17002: Expected corresponding JSX closing tag for 'AnimatePresence'.
IncomingCallOverlay.tsx(222,5): error TS1128: Declaration or statement expected.
...
```

This is a hard parse failure — any bundler (Vite/esbuild, tsc, Babel)
fails on this file. `IncomingCallOverlay` is rendered once inside
`CallProvider` (`src/contexts/CallContext.tsx`), which wraps every
protected route in the app (see `App.tsx`). **This is very likely the
actual root cause of the reported "partner side can't pick up, hang up,
or go back to the screen"** — the incoming-call answer UI (and
potentially the surrounding app shell, depending on how the build
tooling/dev server handled the failure — e.g. a broken HMR/error-overlay
loop reads exactly like generalized "lag/stuck" from a user's
perspective) was never actually in a shippable state. Traced back to the
Phase 2.5 session that added this exact transition
(`docs/DUOSPACE-PHASE-2-5-CHAT-CALLS.md`, "Incoming call transition") —
that session's own notes say *"No build possible in this sandbox... 
verified via static read + bracket balance only"* — a bracket-balance
check does not catch this class of error (parens were balanced; the bug
is two adjacent expressions, not a mismatched bracket), which is exactly
why it went undetected across multiple subsequent sessions.

**Fix:** moved the comment to be a proper sibling JSX comment immediately
before `{incomingCall && (...)}` instead of inside the expression. Zero
behavior/logic change — purely a parse-error fix. Re-ran `tsc --noEmit`
against the corrected file: zero `TS1xxx` (syntax-category) errors
remain; only expected `TS2307`/`TS7xxx` (missing-module/implicit-any)
noise from this sandbox having no `node_modules`.

**Swept for recurrence:** grepped the whole `src/` tree for the same
`&& (` / `? (` followed immediately by a JSX comment pattern — no other
occurrences. Also ran `tsc --noEmit` per-file (syntax-error-only filter)
across all 254 `.ts`/`.tsx` files in `src/` — this was the only genuine
hit (`src/test/setup.ts`'s flagged top-level-`await` is a config
artifact of the ad hoc single-file check, not a real bug — top-level
await is fine under this project's actual `tsconfig`/Vite target).

**Still needs, before considering this fully closed:** an actual
`npm install && npm run build` (or a real device/simulator run) to
confirm the fix compiles clean in the real toolchain and that the
in-call experience (lag, connect time) is acceptable once the app is
actually reachable — this session could confirm and fix the parse error
itself with certainty (via `tsc`), but cannot reproduce WebRTC-level
network lag or lived device "stuck" behavior without an actual running
app. `useDailyCall.ts` and the caller-side hang-up/end-call/back wiring
in `Calls.tsx` were read in full and are logically sound (proper
re-entrancy locks, awaited `destroy()`, safety-net camera release,
auto-audio-fallback on sustained poor network) — no second logic bug
found there. If lag/stuck symptoms persist after confirming this build
actually ships, the next thing to check with real telemetry would be
`network-quality-change` events and `callDuration` timer drift on an
actual device, which isn't possible to diagnose from static source
alone.

---

## BUG-06 — ✅ FIXED (P0 — confirmed from a live production error report)

**Confirmed from source, matching a real production `ErrorBoundary` crash
report** (`DS-UNKNOWN-001`, `ReferenceError: Cannot access 'j' before
initialization`, thrown inside the `Calls` page's lazy chunk during
mount). `src/pages/Calls.tsx` declared `effectiveCallType`/`isVoiceCall`
well down in the component (right before the self-preview section) but
read `isVoiceCall` inside dependency arrays and a conditional much
earlier in the same component's body (`resetControlsIdleTimer`'s
`useEffect` deps, `toggleControlsVisible`). A React function component
re-executes top-to-bottom on every render; reading a `const` before its
own declaration line has run in the same scope is a textbook
temporal-dead-zone violation, and it's not conditional or device-specific
— it threw on literally every mount of the Calls page. Almost certainly
what surfaced as "partner can't pick up/hang up/go back, call feels
stuck": the ErrorBoundary catches it and shows "Something went wrong"
instead of the call screen.

**Fix:** moved the two-line declaration up to immediately after the
`useCall()` destructure (the only values it depends on —
`activeCallType`, `callMode`, `isVideoOn` — are all available there),
well before its first read. Pure reordering, zero logic change. Removed
the now-duplicate declaration from its original location.

**Verified:** `tsc --noEmit` (syntax-error-only filter) on the corrected
file — clean. Bracket-balance sweep — clean. Confirmed no other read of
`effectiveCallType`/`isVoiceCall` sits between the new declaration site
and the old one.

---

## BUG-07 — ✅ FIXED ("Failed to send voice message — Missing chunk 0")

**Root cause, confirmed from source:** `supabase/functions/finalize-
upload/index.ts` downloads every uploaded chunk back from storage to
concatenate them, immediately after the client's chunk-upload loop
reports success. A storage `.upload()` resolving successfully does not
guarantee the object is immediately visible to a `.download()` call that
follows within milliseconds — read-after-write isn't instantaneous
across every path in the storage backend. This bites hardest on exactly
the reported case: a small, single-chunk upload (a short voice note, a
modest photo/file). For a single-chunk upload, chunk 0 is simultaneously
the first AND the only/last chunk written, so it gets the *least* time
to settle before finalize's very next line tries to read it back. A
large multi-chunk file doesn't show this because chunk 0 there is
written earliest and so incidentally has the most settling time by the
time the loop reaches it — which is why this was specifically reported
for voice/photo/file/camera (all commonly small/single-chunk) and not
for anything larger.

**Fix:** added a short retry-with-backoff (`0ms, 150ms, 400ms, 900ms`,
capped at 4 attempts) around each chunk download before concluding it's
truly missing. This targets the actual point of failure (the read side
of a read-after-write race) without weakening the real "missing chunk"
error path — a chunk that's actually gone (e.g. failed all client-side
retries) still correctly 422s once these attempts are exhausted.

**Verified:** `tsc --noEmit` (syntax-only) on the edited Deno file —
clean. This is shared by voice, photo, file, and camera sends (all route
through the same `resumableUpload`/`finalize-upload` path via
`attemptSendMedia` in `Chat.tsx`), so one fix covers all four as
reported.

**Still needs:** an actual redeploy of the edge function to confirm in
production — this session can't invoke Supabase Storage's real
read-after-write behavior from a static sandbox, only reason about and
fix the race at the source.

**2026-08-22 update (still reported after the first pass of this fix):**
traced the full pipeline again end to end to confirm scope and look for
a second, deterministic cause rather than assuming the first fix just
needed more time:
- Confirmed via source, not assumption, that all four reported paths
  really do share this one function: Chat's voice/image/file always call
  `resumableUpload` regardless of size (no threshold check in
  `attemptSendMedia`); Gallery's camera photo/video call it too, but only
  once `file.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES` (6MB) — below that
  they use a plain single-shot `storage.upload()` that never touches
  `finalize-upload` at all, so "missing chunk" structurally cannot occur
  for a small gallery photo (only for the chunked path).
- Re-checked storage RLS policies for `chat-files`/`gallery` (across all
  the migrations that touch them) — every INSERT/SELECT policy scopes on
  `(storage.foldername(name))[1] = auth.uid()::text`, i.e. only the FIRST
  path segment, so the nested `.tmp/...` chunk directory structure is not
  blocked by RLS at any depth. Ruled out as a cause.
- Checked `withRetry` (the client's own per-chunk upload retry helper) —
  correctly rethrows after exhausting attempts, doesn't silently swallow
  a real failure and let the loop proceed as if a chunk succeeded when it
  didn't. Ruled out.
- No dedicated bug found beyond the read-after-write race already
  identified — but widened the fix's margins rather than assume the
  original window was enough, since production load conditions aren't
  something this sandbox can reproduce or measure: retry attempts
  6 (was 4), total backoff ceiling ~4.75s (was ~1.45s), and added a
  small client-side settle delay in `resumableUpload.ts` before calling
  finalize at all — scaled to chunk count (worse case ~300ms, least for
  large multi-chunk uploads that have already spent seconds in flight by
  that point, most for the single-chunk case that has the least natural
  settle time). This reduces how often the server-side retry loop is
  even needed, on top of widening that loop itself.
- Verified: `tsc --noEmit` clean on both edited files, bracket-balance
  clean on both.

---

## BUG-08 — ✅ FIXED (hub list not appearing directly above the hub button)

**Root cause, confirmed from source:** `GridMenu.tsx`'s panel positioned
itself with a hardcoded `bottom: calc(env(safe-area-inset-bottom) +
var(--dock-reserve) + 12px)` — an assumption that the floating nav dock
(and the page-content padding reserved for it) is always present and
full-height. But the dock hides — and `AppLayout`'s reserved bottom
padding collapses with it — the instant the message field is focused
(`MessageComposer.tsx`'s `useSetImmersive("chat-composer-typing", ...)`),
which is exactly the moment someone taps the Hub button right after
typing. In that state the real button sits ~84px lower than the panel
assumed, so the panel opened floating well above the button instead of
sitting right on top of it — a visible, unexplained gap.

**Fix:** rather than inventing a second hardcoded constant for the
"dock hidden" case, the panel now measures `#chat-hub-button`'s actual
on-screen position (`getBoundingClientRect()`) at open time via
`useLayoutEffect` (so it's correct before first paint, no flash-then-
correct), and recomputes on resize / `visualViewport` resize (keyboard
show/hide, orientation change). This is correct regardless of whether
the dock is showing, hidden, or compact — it no longer depends on any
assumption about the dock's state at all.

**Verified:** `tsc --noEmit` — clean. Bracket-balance sweep — clean.

---

## BUG-09 — ✅ FIXED ("dock behaves like a bouncing bag")

Not a build/logic bug — a motion-tuning issue, but worth registering
since it was reported as broken behavior. `FloatingDock.tsx`'s whole-pill
hide/show slide (120px) and its compact-scale step (on ordinary scroll)
both used `gentleSpring`, the same spring reserved elsewhere in the app
for small, occasional, self-contained motions (the active-tab pill
morph). The dock's hide/show and compact states, by contrast, can
retrigger repeatedly and in quick reversal during ordinary scrolling
(see `useDockCompactReporter`'s direction-tracking logic) — a spring
that gets re-targeted mid-motion before it's settled is exactly what
reads as jiggling/bouncing rather than one clean, resolved slide, even
though the spring's own damping ratio is high enough that it barely
overshoots in isolation.

**Fix:** switched both of these (the outer nav's hide/show `animate`
and the inner div's compact scale/opacity `animate`) from `gentleSpring`
to `standardTransition` (the app's existing 220ms `EASE_SMOOTH` tween) —
monotonic by construction, so it cannot overshoot or oscillate no matter
how often scroll retriggers it, while still reading as deliberate rather
than an abrupt cut. Left the active-tab pill's `layoutId` morph on
`gentleSpring`, since that's the small, occasional, contained case the
spring was actually designed for.

**Verified:** `tsc --noEmit` — clean. Bracket-balance sweep — clean.
Confirmed `gentleSpring` import is still used (pill morph) so nothing
was left dangling.

---

## BUG-10 — ✅ FIXED (P0 — the real cause of "dock jumping/flickering",
found from a screen recording, not the tuning issue BUG-09 addressed)

BUG-09 was a real fix for a real complaint, but the person reported the
dock still bouncing after it — this time with a screen recording as
evidence. Extracted frames from the video (`ffmpeg -vf fps=8`) and
cropped a filmstrip of just the dock's screen region across all 57
frames: the dock pill and the composer's vertical position were visibly
flipping between two states roughly every single sampled frame (~125ms
apart) throughout ordinary scrolling — not an occasional re-trigger, a
near-continuous oscillation. That rules out BUG-09's explanation (a
spring being retriggered too often) as the *whole* story — a tween
can't oscillate at all, yet the flicker was still happening, so
something was re-triggering the hide/show decision itself at high
frequency, not just animating each decision poorly.

**Root cause, confirmed from source:** a genuine feedback loop between
two files that don't call each other but affect the same DOM.
`useDockVisibility.ts`'s `isVisible` folds in `isScrollHidden` (true iff
the user is mid-scroll away from the top). `AppLayout.tsx` used to
animate its `<main>`'s reserved bottom padding directly off that same
`isVisible` value — meaning ordinary scroll-driven hide/show was
shrinking and growing the page content's available height on every
scroll-hide decision. Chat's own message list is a child of that
`<main>`, so growing/shrinking its available height shifts the message
list's own `scrollTop` — which fires a genuine native `scroll` event on
the exact element `useDockCompactReporter` is listening to, with no user
touch behind it. That hook has no way to distinguish a layout-driven
scrollTop shift from a real gesture, so it reads the shift as "user
scrolled" and flips the decision again — which changes `isVisible`
again, which changes the padding again, which shifts scrollTop again,
which fires another scroll event... a fully self-sustaining loop, with
nothing in the existing (real, already-correct) hysteresis logic able to
break it, because the hysteresis was designed to filter *sub-pixel
jitter from momentum scrolling*, not a clean multi-pixel shift caused by
its own side effect. This also explains "starts after cold start or page
switching" specifically: that's exactly when the chat message list first
mounts and settles near the bottom of a long conversation, which is
precisely the scroll position where a container-height change has the
most room to shift scrollTop.

Worth noting: `AppLayout.tsx` had a comment at this exact line claiming
"the dock ... is no longer scroll-driven at all" — true when that
comment was written, but `useDockVisibility.ts` had scroll-hide
*reintroduced* in a later pass (its own header comment documents this:
"UPDATE... restored per direct request") without anyone revisiting
whether animating shared layout padding off that value was still safe
once it could change during ordinary scrolling again. It wasn't — this
is exactly that gap.

**Fix:** `useDockVisibility()` now returns a second, separate flag,
`isLayoutCollapsed`, that only reflects the genuinely infrequent,
non-scroll cases (an active call, a photo/video viewer, the camera) —
deliberately excluding `isScrollHidden`. `AppLayout.tsx`'s padding
animation now keys off `isLayoutCollapsed` instead of the dock's full
`isVisible`. The dock itself still visually slides away on scroll
exactly as before (`FloatingDock`'s own `isVisible` prop is unchanged) —
it simply no longer changes the height of the container being watched
for scroll direction, so there's nothing left for the loop to feed on.

**Verified:** confirmed `useDockVisibility` has exactly two other
consumers (`FloatingDock.tsx`, which only reads `isVisible`/`isHidden`,
both unchanged) before widening its return shape — no other call site to
update. `tsc --noEmit` clean on both edited files, plus a full-tree
sweep (0 real syntax errors across all of `src/`).

**Still needs:** an actual device/build test to confirm the loop is
gone — this session traced the mechanism through source with real
frame-by-frame video evidence and fixed the coupling with certainty,
but can't run the live scroll physics of an actual browser from a static
sandbox.

**Same session, hub position:** the person also reported the hub panel
still not sitting correctly above the hub button, but the accompanying
recording never actually shows the hub menu being opened — it's entirely
scroll footage of the call-history flicker above. No fresh evidence to
re-diagnose against, so nothing was changed there beyond one legitimate
hardening found on re-review: `GridMenu.tsx`'s anchor measurement used
`window.innerHeight`, which can disagree with the actually-visible area
on mobile browsers with dynamic show/hide toolbars (Samsung Internet —
the exact browser in both reports — is a known case of this). Switched
to `window.visualViewport?.height` (falling back to `innerHeight` if
unavailable), which tracks the real visible viewport reliably. If the
hub position is still wrong after this, it needs its own fresh
screenshot/recording of the panel actually open to diagnose further —
everything reasoned about so far (the portal target, the measurement
logic, the containing-block chain) checks out correctly against the
current source.

---

## BUG-11 — ✅ FIXED (Music: "bad guy everywhere" / zero up-next variety,
trending compilations, missing language rails, no personalization)

A multi-part request; each part is a separate, real, confirmed-from-source
issue rather than one fix covering all of them.

**1. "Search 'bad guy' and it's bad guy everywhere in play-next — zero
randomness."** Confirmed from source: `Groic.tsx`'s `onPlay` built the
"up next" queue as `[tapped track, ...every other result from this exact
search, in the order the API returned them]`. For a direct song search
that "every other result" list is mostly more uploads of the *same* song
(covers, remixes, re-uploads) — not real recommendations, and fully
deterministic (identical search → identical queue → identical order,
every time). There's no true ML "related videos" endpoint in the
YouTube Data API to fully replicate what YouTube Music's own queue does
(`relatedToVideoId` was deprecated years ago) — a real, permanent
constraint of a plain API-key integration, not an oversight this session
can code around. Within that constraint: `onPlay` now (1) dedups the
up-next pool by song title alone (not title+artist), so it never stacks
multiple versions of the literal same song back-to-back, and (2)
shuffles what's left (`shuffled()`, Fisher-Yates), so replaying the same
search doesn't hand back the identical order every time. Applied
uniformly everywhere a track can be started (search grid, trending
rails, the new history rail) via a shared `onPlay(r, pool)` helper.

**2. "Remove trending results more than 15 minutes — some are videos of
multiple songs."** Confirmed from source: `music-trending/index.ts`'s
only duration handling was a soft -4 score penalty above 30 minutes,
which still let a compilation through whenever nothing else filled the
row. Now a hard exclusion at 900s (15 min), applied before scoring/dedup,
scoped to trending only (a direct search for something unusual keeps the
existing softer penalty in `music-search`, deliberately — an explicit
search shouldn't be as aggressively filtered as an algorithmic trending
slot).

**3. "Main page should show trending Marathi/Hindi/English/Haryanvi."**
`music-trending/index.ts` only had english/hindi buckets. Added marathi
(a real ISO 639-1 code YouTube's `relevanceLanguage` accepts — "mr") and
haryanvi (no such code exists for it — it's a regional dialect, not a
distinct `relevanceLanguage` YouTube's API recognizes — so that bucket
relies on a specific search query + regionCode=IN + order by view count
instead; a real, documented API limitation, not a gap in this session's
research). `Groic.tsx`'s home state now renders one real rail per
bucket instead of the old single hidden discovery-search section that
was mislabeled "Trending" — see BUG note below.

**4. "Ask the user for their language support."** Added a persisted
multi-select chip row ("Your languages") on Groic's home state,
defaulting to Hindi+English, controlling which trending rails show and
in what order. Client-side only (`localStorage`, key
`groic-lang-prefs`) — matches every other lightweight preference this
app already keeps client-side (e.g. `groic-recent`), not synced to the
account, which felt like the right scope for a page-specific preference
rather than inventing a new account-wide settings surface for this pass.

**5. "Understand search history to suggest songs on the main screen."**
Added a real "Because you searched '{term}'" rail using the single most
recent distinct search term, fetched via the existing `music-search`
function (no new edge function needed) and shown above the trending
rails. Deliberately just the most recent term, not the whole history, to
keep this to one extra lightweight call rather than one per past search.

**Also removed as dead code:** the old "rotating discovery query" system
(`DISCOVERY_QUERIES` / `hashSeed` / `pickDiscoveryQuery`) that used to
generate the fake "Trending" section — it ran a hidden generic search
(e.g. "feel good morning playlist") and displayed those results labeled
"Trending", which (combined with issue #1 above) is also part of why a
literal song search's own results could end up looking like they were
"trending" everywhere. Fully superseded by the real trending rails; no
remaining call sites, so deleted rather than left unused. `useAuth`'s
`user` became unused as a result and was removed too.

**Verified:** `tsc --noEmit` (syntax-only filter) clean on both edited
edge functions and the rewritten `Groic.tsx`, plus a full-tree sweep (0
real syntax errors across all of `src/`). Confirmed `Playlist.tsx` (the
only other consumer of `music-trending`) only reads the `english`/`hindi`
keys, which are unchanged in shape, so it stays fully compatible without
any edits.

**Still needs:** an actual deploy + real device test — this session
reasoned through and fixed each root cause with real source evidence,
but can't exercise live YouTube API quota/response behavior, real
shuffle/randomness perception, or actual multi-day "does trending feel
right" judgment from a static sandbox.

---

## Explicitly NOT bugs (checked and ruled out during this audit)

Listed so a future pass doesn't re-flag these as new findings:

1. **`lib/codeSurprises.ts` adds `window`-level `pointerup`/`resize`
   event listeners without matching `removeEventListener` calls in the
   same file (10 `addEventListener` calls, 0 `removeEventListener`
   calls).** Initially looked like a listener leak. **Ruled out:**
   confirmed via `components/CodeSurpriseFrame.tsx` that this HTML/JS is
   rendered inside a **sandboxed `<iframe sandbox="allow-scripts">`**, so
   these listeners are scoped to the iframe's own `window`, which is
   torn down (and all its listeners with it) whenever the iframe element
   itself is removed from the DOM — no leak into the host page.
2. **`lib/errors/errorManager.ts` adds `window` `error`/
   `unhandledrejection` listeners with no corresponding
   `removeEventListener`.** **Ruled out:** these are intentional,
   app-lifetime global error handlers (a singleton error-reporting
   module), not meant to be torn down — this is the correct pattern for
   this kind of module.
3. **`lib/cameraBus.ts` adds `document`/`window` `visibilitychange`/
   `pagehide` listeners with no corresponding removal.** **Ruled out:**
   same reasoning — `cameraBus.ts` is an app-lifetime singleton resource
   pool (module-level `if (typeof document !== "undefined") {...}`
   block), and these listeners exist for the life of the app by design.
4. **Two components (`Chat.tsx` and `Calls.tsx`) both needing a Daily.co
   call instance.** Looked like a candidate for a "duplicate hook
   instantiation" bug. **Ruled out as a *current* bug:** it was a real,
   documented, already-fixed bug — `CallContext` (`src/contexts/
   CallContext.tsx`) now wraps a single shared `useDailyCall()` instance
   specifically to prevent this "Duplicate DailyIframe instances are not
   allowed" crash. Both pages correctly consume the shared instance via
   `useCall()` today. Flagged in the forensic audit (Section L/Safety
   Map) as a RED area to protect during redesign, not re-flagged here as
   an open bug.
5. **`Settings.tsx`'s partner-request accept flow having a multi-step
   fallback chain (`accept_partner_request` RPC → `accept_partner_request_v2`
   RPC → manual last-resort path).** Looked like unfinished/duplicated
   logic. **Ruled out as a bug:** the in-source comment explains this is
   a deliberate, already-fixed race-condition mitigation (`FIX BUG-09`),
   with the manual path itself guarded by a `status === "pending"`
   re-check immediately before mutating. This is defensive layering, not
   duplication-by-accident.

---

## Redesign Safety Map

**GREEN = safe to visually redesign.** Pure presentation — layout,
spacing, color, typography, iconography, animation *parameters* (not
animation *systems* — see caveats below) — with no state-shape,
data-flow, or callback-signature changes.

**YELLOW = redesign with caution.** Visual changes are fine, but the
component has a timing dependency, a shared-resource dependency, or a
subtle prop contract that a naive restyle could break without realizing.

**RED = business/security/state logic must not be touched during UI
work.** Any change here needs to be treated as a logic change with its
own review, not folded into a "redesign" PR.

| Area | Classification | Why |
|---|---|---|
| Dialog/modal chrome (spacing, colors, transitions) across all 19 `Dialog`/3 `AlertDialog`/3 `Sheet` usages | **GREEN** | Standard shadcn/Radix `open`/`onOpenChange` pattern; no shared modal manager to break. |
| Shayari page visuals | **GREEN** | Smallest, simplest feature (312 lines, one table, one realtime channel, no cross-feature coupling). |
| Us hub visuals (layout of memory wall, mood history cards, countdown display) | **GREEN**, with **YELLOW** for `MoodHistory`/`MemoryWall` specifically | The page itself is presentation-heavy, but `MemoryWall` owns its own realtime channel (`memories-rt-${userId}`) — don't change its mount/unmount timing without checking the channel cleanup. |
| `FloatingDock` visual styling (colors, icon set, spacing, badge dot styling) | **YELLOW** | Safe to restyle, but preserve: the `aria-label`/`aria-current` attributes (N), the `onPointerDown` route-preload wiring (H), and the `SWIPE_NAV_ORDER` coupling in `AppLayout.tsx` if tabs are added/removed. |
| `AppLayout`'s bottom-padding calc tied to dock visibility | **RED for logic, YELLOW for the padding *values* themselves** | The `paddingBottom` formula is explicitly coupled to `dockHidden`/`dockVisible` state to avoid a previously-fixed "gap" bug (H). Changing dock height requires updating this calc in the same change, not a separate "just visual" PR. |
| `MotionConfig reducedMotion="user"` wrapper scope | **RED** | This is the actual accessibility fix for motion sensitivity across the whole app (N). Do not narrow its scope or remove it while restyling animations. |
| Chat message bubble visual redesign | **YELLOW** | Bubble content/spacing/colors are restylable, but the disappearing-message timing logic deliberately avoids per-second re-renders via `useMemo` math on `disappear_at` (M) — any redesign must not reintroduce a ticking-state-per-bubble pattern. |
| Chat's 5 realtime channels, message send/receive data flow | **RED** | Core business logic; explicitly out of scope per the brief, and P.5 flags unresolved uncertainty about optimistic-send/realtime-echo dedup that makes this doubly risky to touch incidentally. |
| Peek Guard lock-screen visuals | **YELLOW** | Restyle freely, but the `dismiss()` call wiring (L.4) is a hard requirement — if the redesign changes how/when the lock screen unmounts, confirm `dismiss()` still fires on every dismissal path (button tap, successful re-auth, etc.). |
| Peek Guard/Mood Detection detection pipeline (thresholds, consistency frames, worker offload) | **RED** | Security-relevant detection tuning; not a UI concern. |
| `AppLockScreen` PIN/biometric visuals | **YELLOW** | Restyle the screen; do not touch `useBiometricLock` logic, PBKDF2 hashing, or the `isAppLocked` gating in `App.tsx`. |
| E2E crypto (`lib/crypto.ts`), WebAuthn edge functions, QR pairing token issuance/redemption | **RED** | Security-critical; zero UI-redesign justification for touching any of this. |
| Theme/wallpaper/icon customization UI (`ThemeStudio`, `IconStudio`) | **YELLOW** | This *is* largely a redesign target by nature (it's literally a theming tool), but remember the couple-shared theme realtime sync (`couple-theme-${userId}`) means changes here have a live cross-user effect — test both sides of a pairing, not just one device. |
| Cloud backup/restore UI (`BackupManager`) | **YELLOW** | Restyle freely; do not change the encryption/device-secret logic in `useCloudBackup`, and preserve the explicit `"error"` status surfacing in the UI. |
| Groic mini/full player, invite banner visuals | **YELLOW** | Restylable, but all three are children of `GroicProvider`, which is mounted only inside `AppLayout` — don't extract them to a context-less location. |
| Live location map visuals (`MapView`) | **YELLOW** | Map chrome/markers/UI restylable; do not touch `useLiveLocation`'s adaptive-accuracy/smoothing/offline-queue internals (M). |
| Native call UI (CallKit/Telecom lock-screen call answer UI) | **RED, and largely out of reach** | This is native Kotlin/Swift UI (`native/android`, `native/ios`), not part of the React redesign surface at all, and this audit could not validate it (no native toolchain available). |
| Push/VoIP notification content/styling (the actual OS notification appearance) | **RED for payload/dispatch logic, out of scope entirely for "UI redesign" in the React sense** | Controlled server-side by `send-push`/`send-voip-push` edge functions and OS-level notification rendering, not by the web/React layer. |
| `BottomNav.tsx`, `SurpriseOverlay.tsx` (dead components) | **N/A — deleted** | See BUG-01, BUG-02 (both ✅ fixed). No longer present in the tree, no longer a trap for redesign work. |
| Route-level `PageSkeleton` variants | **GREEN** | Purely presentational loading states, cleanly parameterized by `variant` — good, low-risk redesign starting point. |
| Splash screen (`SplashScreen.tsx`) | **YELLOW** | Visually restylable, but preserve the `sessionStorage` "shown once per cold boot" gating logic in `App.tsx` — don't accidentally make it replay on every route change. |

### Suggested redesign sequencing (lowest to highest risk, based on the map above)

1. Route-level skeletons, Shayari, dialog/modal chrome — pure GREEN, good
   warm-up work and a chance to establish the new visual language.
2. Us hub, Groic players, Cloud backup UI, Theme/Icon studios — YELLOW,
   requires reading (not necessarily changing) the adjacent hook/context
   before touching layout, and cross-device testing for anything
   couple-synced.
3. FloatingDock, AppLockScreen, Peek Guard lock screen, MapView chrome —
   YELLOW with specific documented gotchas each (see table) — these
   should get individual sign-off against the specific risk noted, not
   a blanket "looks fine" pass.
4. Chat message bubbles — YELLOW but high blast radius given the page's
   size and complexity; do this with a dedicated regression pass against
   the disappearing-message timing behavior specifically.
5. Everything marked **RED** — do not fold into redesign work at all;
   these need their own logic-focused review process if they must change.

### Outstanding audit gaps (for transparency, not to be treated as findings)

- WhatsApp import's exact entry point/component ownership was not fully
  isolated in this pass (Feature Matrix row is marked "needs follow-up").
- Accessibility (screen-reader flow, dialog focus-trapping, color
  contrast, dynamic type) was not audited beyond confirming the
  `MotionConfig` reduced-motion mechanism exists.
- Visual consistency (Section T) was deliberately not catalogued in this
  pass, per the brief's own "do not redesign yet" instruction — recommend
  a dedicated screenshot-based pass as the actual first step of redesign
  work.
- Native build/permission-manifest correctness could not be verified —
  no Android SDK/Xcode toolchain available in this environment, and the
  native projects aren't generated in this zip (only plugin/bridge
  sources are present).
- `npm run lint` / `npx tsc --noEmit` / `npm test` results are entirely
  unknown (BUG-03) — this register cannot claim the codebase is free of
  type errors, lint violations, or failing tests, only that it was not
  possible to check in this environment.
