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
