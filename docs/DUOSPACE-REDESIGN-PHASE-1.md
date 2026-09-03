# DuoSpace Redesign — Phase 1: Global System, Navigation, Chat

**Continues from:** `docs/DUOSPACE-REDESIGN-AUDIT.md` (Phase 0 forensic audit).
**Scope of this phase:** global design tokens, light/dark themes, navigation,
Chat, and the shared motion primitives those areas need. Map, Calls, Gallery,
Groic, and Music were **not** redesigned — touched only where a shared
primitive (tokens, motion) is used by them incidentally.

**Toolchain note:** same sandbox constraint as Phase 0 — no network egress,
`npm install` 403-blocked, `node_modules` empty. Verification in this phase
was: (1) `tsc --noEmit` against the project's own `tsconfig.app.json`, with
the unavailable `vitest` type package temporarily excluded via an extended
config so real diagnostics weren't drowned out by that one missing package;
(2) a manual read-through of every changed file; (3) grep-based route/token
cross-checks. `eslint` could not run — `npx eslint` itself is unavailable in
this sandbox (blocked package registry). All `tsc` module-resolution errors
(`Cannot find module 'react'`, `'framer-motion'`, etc.) are the expected
consequence of no `node_modules` and apply identically to every file in the
repo, not just the ones touched here — confirmed by running the same check
against untouched files, which show the same class of error. No genuine
syntax error, and no error specific to a file this phase touched, was found
after that noise was filtered out.

---

## 0. An incidental fix that had to happen first

`tsc -p tsconfig.app.json` failed to parse **the entire project** before any
other check could run. Root cause: `src/lib/motion.ts`'s opening doc comment
contained the literal text `--ease-*/--dur-*` — which includes a literal
`*/`, so the block comment closes mid-sentence and everything after it in
that file is parsed as code. This is a pre-existing bug (I didn't introduce
it and hadn't otherwise touched this file), but it blocked all verification
for this phase, so I fixed the comment text only:

```diff
- * Shared motion tokens — the JS-side mirror of index.css's --ease-*/--dur-*
- * custom properties.
+ * Shared motion tokens — the JS-side mirror of index.css's --ease-* and
+ * --dur-* custom properties.
```

No logic in `motion.ts` changed — every exported constant (`EASE_SMOOTH`,
`DUR_MED`, `gentleSpring`, etc.) has the identical value it had before.
Flagging this explicitly since it's outside the areas this phase was asked
to touch, even though the fix itself is one comment string.

---

## 1. What I found already in place (not rebuilt)

Before writing anything, I re-verified the current state of `src/index.css`,
`tailwind.config.ts`, `FloatingDock.tsx`, `useDockVisibility.ts`,
`ChatHeader.tsx`, and `MessageComposer.tsx` against this phase's brief. A
meaningful amount of it was **already done** in a prior pass and needed no
change:

- **Light-mode-default token system** — `:root` is the light theme (soft
  off-white background, charcoal text, restrained violet accent), `.dark`
  is the alternate. This already matches the brief exactly.
- **A glass layer already exists**, already scoped narrowly (`.glass-dock`,
  `.glass-hub`) rather than applied everywhere — already matches the "glass
  is a functional layer, not the whole app" rule.
- **The dock already never disappears on scroll.** `useDockVisibility.ts`
  documents that scroll-driven hide/show was deliberately removed in an
  earlier pass specifically because it caused flicker and made primary
  navigation feel unreliable. It only hides for a genuine full-screen
  takeover (active call, photo/video viewer, camera).
- **Chat header** already matches the brief's shape almost exactly: compact
  avatar + name + presence line, direct video/voice call buttons, and
  everything else (nudge, search, disappearing-messages toggle, settings,
  recover chat, clear chat) already lives in an overflow menu, not inline.
- **Composer progressive disclosure** already exists: attach + input + mic
  by default, attach + input + send once there's text, with the attach tray
  and hub already appearing as contextual/overlay surfaces rather than a
  permanently-expanded row of buttons.

I called this out in Phase 0 and re-confirm it here so it's clear why this
phase's diff is smaller than the brief's full list might suggest — the
brief asks for verification and refinement, not a rebuild, of things that
already work.

## 2. What changed

### 2.1 Global design tokens (`src/index.css`, `tailwind.config.ts`)

Added, **additively** — nothing pre-existing was renamed, removed, or had
its value changed:

| New token | Light | Dark | Purpose |
|---|---|---|---|
| `--text-primary` | = `--foreground` | = `--foreground` | Alias for clarity in new code |
| `--text-secondary` | `230 8% 45%` (= existing `--muted-foreground` value) | `230 8% 60%` (= existing dark `--muted-foreground` value) | Named middle text tier |
| `--text-tertiary` | `230 8% 62%` | `230 8% 42%` | New, genuinely quieter tier — hints, disabled captions |
| `--divider` | = `--border` | = `--border` | Semantic name for hairlines, distinct from input/component borders |
| `--overlay` | `230 20% 10% / 0.24` | `230 15% 4% / 0.4` | Lighter backdrop than the existing `--bg-overlay-scrim`, for contextual (non-modal) dimming |
| `--accent-muted` | `255 90% 62% / 0.10` | `255 92% 68% / 0.16` | Soft violet wash for selected/active chip fills |
| `--glass-blur-sm/md/lg` | `12px / 24px / 40px` | same | Named blur steps for new glass surfaces |

Exposed in Tailwind as `text-foreground-secondary`, `text-foreground-
tertiary`, `border-divider` / `bg-divider`, `bg-overlay` / `text-overlay`,
and `bg-accent-muted` / `text-accent-muted`. `--text-secondary` and
`--text-tertiary` are **new names for the tier system**, not new colors —
`text-secondary` was deliberately given muted-foreground's existing value
so nothing that already reads `text-muted-foreground` anywhere in the app
shifts in this pass.

Also added `.glass-sheet` — a new, lighter-weight glass utility (medium
blur, not the dock's heavy blur+saturate stack) for future contextual
surfaces near Chat (attach tray, context menu) — built on the new blur
tokens without touching `.glass`, `.glass-strong`, `.glass-hub`, or
`.glass-dock`, all of which keep their existing, already-tuned values
untouched since those also back out-of-scope surfaces (Calls, Profile).

**Still open (flagged, not done this phase):** the brief also asked for
`radius`/`spacing`/`typography`/`motion` to be represented as tokens.
`--radius` and the spacing/motion scales already existed before this phase
(`--radius`, `--dock-*`, `--touch-target-min`, `--ease-*`/`--dur-*`) and
were left as-is since they weren't missing. Typography was evaluated (see
`docs/DUOSPACE-REDESIGN-AUDIT.md` §5) and deliberately kept unchanged — the
existing Space Grotesk/Inter pairing already reads as intentional, not a
generic default.

### 2.2 Navigation — Chat / Duo / Calls

Phase 0 flagged this as the one real product decision in the nav area: the
dock only had 2 tabs (Chat, Calls), with the shared-space hub only
reachable from inside Chat's sparkle button. This phase implements the
brief's explicit 3-tab model:

- **`src/lib/duoHubItems.ts`** (new) — the hub's destination list (Gallery,
  Music/Groic, Us, Map, Shayari — unchanged set, unchanged routes) is now
  defined once, with an added `description` field for the new full-page
  list view.
- **`src/components/chat/GridMenu.tsx`** — refactored to read from
  `duoHubItems.ts` instead of its own inline list. This is a pure
  extraction: same items, same routes, same tile rendering, same animation.
  The in-chat sparkle "Hub" shortcut still exists, unchanged, and still
  opens the exact same panel it always did.
- **`src/pages/Duo.tsx`** (new) — a full page presenting the same hub
  destinations as a scrollable list, registered at `/duo` in `App.tsx` with
  its own lazy-loaded chunk and preload entry, following the same pattern
  every other route already uses.
- **`src/components/FloatingDock.tsx`** — added the Duo tab (Heart icon)
  between Chat and Calls. The tab reads as "active" on `/duo` and on every
  route it links to (`/gallery`, `/groic`, `/us`, `/map`, `/shayari`,
  `/playlist`), so drilling into e.g. Gallery from the hub doesn't make the
  dock look like it's pointing at the wrong destination.
- **`src/components/AppLayout.tsx`** — `SWIPE_NAV_ORDER` updated from
  `["/chat","/calls"]` to `["/chat","/duo","/calls"]` so left/right swipe
  navigation stays in sync with the dock's new tab order.

**Explicitly not done:** the Love Letter and Schedule Send actions that
live in `GridMenu`'s panel (via `onLoveLetter`/`onScheduledMessage`) are
NOT on the `/duo` page. Those two are chat-composer actions — they operate
on the message currently being composed and only make sense with an active
compose context, which a standalone hub page doesn't have. They remain
exactly where they were, reachable only from the in-chat hub shortcut. This
was a deliberate scope decision, not an oversight — `/duo` lists
destinations you navigate *to*; it was never those two actions' natural
home.

### 2.3 Dock — compact-on-scroll (never hide)

Added `src/hooks/useDockCompact.ts` and wired it into Chat's message list
(`useDockCompactReporter(messagesContainerRef)`), consumed by
`FloatingDock` via `useDockCompactState()`.

Behavior: while a scrollable page is actively being scrolled, the dock's
own pill scales down slightly (0.92× scale, 0.88 opacity) after ~90ms of
sustained scrolling; it restores to full size the instant the user is back
within 24px of the top, or automatically ~260ms after scrolling stops. The
dock **never** unmounts, never hides, and never stops accepting taps during
this — it's a size/opacity step on the pill itself, layered on top of (not
replacing) the existing `isVisible`/`isHidden` mechanism that's reserved
for genuine full-screen takeovers.

This is deliberately a small, module-level pub-sub rather than new React
context: `FloatingDock` is a sibling of routed page content in
`AppLayout` (not an ancestor/descendant), so there's no normal prop path
from Chat's scroll container to the dock. The same kind of cross-tree
signal already exists elsewhere in this codebase (`CallContext`'s
`duospace-call-control` window event, `useImmersiveMode`'s module-level
subscriber set) — this follows that established pattern rather than
introducing a new one.

Only wired into Chat's message list this phase, since Chat is the only
screen in scope. Wiring the same hook into Map/Gallery/Groic's own scroll
containers is a one-line addition per page and is left for whichever phase
redesigns those screens.

### 2.4 Chat — contextual (non-repeated) timestamps

`src/components/chat/MessageBubble.tsx`: the time + read-receipt row
previously rendered on every bubble, including every message in a
consecutive group from the same sender. It now renders only on:
- the **last** bubble in a group (`isLastInGroup`), or
- any bubble that's **disappearing** (the countdown ring is per-message
  functional information, not decoration), or
- any bubble that's been **edited** (the pencil mark).

No data changed — `formatTime`, `msg.is_read`, `msg.disappear_at`, and
`msg.edited_at` are read exactly as before; only whether that row renders
changed. This directly matches the brief's "timestamps should be
contextual rather than repeated unnecessarily" instruction without
removing the read-receipt or disappearing-countdown functionality — both
still show, just once per group instead of once per bubble, mirroring how
the group already visually reads as one block.

## 3. What did NOT change (by design)

- **Map, Calls, Gallery, Groic, Music/Playlist** — no files under these
  features were touched, per the brief's explicit scope. (`FloatingDock`'s
  new `DUO_HUB_ROUTES` list references their paths as *strings*, for
  active-tab matching only — it doesn't import or alter those pages.)
- **All backend/Supabase/auth/encryption/location/native-call/media-
  storage behavior** — untouched. This phase only added presentation-layer
  files and CSS tokens.
- **Existing chat functionality** — voice notes, camera/media, replies,
  reactions, disappearing messages, scheduled messages, search, Love
  Letters, Surprise Mode, call events in the timeline, encryption
  indicator, typing/presence, wallpapers, recovery, and every existing
  message action are all still wired exactly as before; only the
  MessageBubble metadata-row *visibility rule* and the token layer changed.
- **`.glass`, `.glass-strong`, `.glass-hub`, `.glass-dock`** — kept their
  exact existing blur/alpha/tint values. Only a new, separate
  `.glass-sheet` utility was added alongside them.
- **`--foreground`, `--muted-foreground`, and every other pre-existing
  token** — values unchanged. New tokens were added; nothing existing was
  redefined.
- **The `location_mode` discrepancy flagged in Phase 0** — still
  untouched, still awaiting the product decision described there.
  `/map`'s Location Sharing Mode switch was not part of this phase's
  scope, and Map wasn't redesigned this phase regardless.
- **`BottomNav.tsx`** — still present, still unused, still not deleted.
  Deletion is a cleanup task, not something this phase's brief asked for.

## 4. Verification performed

- **`tsc --noEmit -p tsconfig.app.json`** (with `vitest` types excluded via
  a temporary extended config, since that package isn't installable here):
  after fixing the pre-existing `motion.ts` comment bug (§0), the only
  remaining errors across the entire project are `TS2307`
  ("Cannot find module") for every third-party package, and a small,
  pre-existing, repo-wide `key` vs. `Props` false-positive pattern
  (`TS2322`) that appears identically in dozens of files that were never
  touched this phase (`MessageTimeline.tsx`, `Calls.tsx`, `Groic.tsx`,
  `Playlist.tsx`, `Shayari.tsx`, `Us.tsx`, `PageSkeleton.tsx`, etc.) — an
  artifact of checking JSX without the real `@types/react` package
  installed, not a real bug. The two new instances of this same pattern in
  `Duo.tsx` (a `key` prop on a mapped component) are consistent with how
  every other list in this codebase is already written.
- **No new genuine syntax or type error** was introduced by any file this
  phase added or changed, confirmed by filtering the full `tsc` output down
  to just `src/pages/Duo.tsx`, `src/lib/duoHubItems.ts`,
  `src/hooks/useDockCompact.ts`, `src/components/FloatingDock.tsx`,
  `src/components/AppLayout.tsx`, `src/components/chat/GridMenu.tsx`,
  `src/components/chat/MessageBubble.tsx`, and `src/pages/Chat.tsx`.
- **`eslint`** could not be run — the package itself isn't fetchable in
  this sandbox (blocked registry), matching the project's documented
  `npm install`-blocked constraint. Manual review substituted.
- **Routes** — confirmed `/duo` is registered in `App.tsx` inside
  `<ProtectedRoutes>`, lazy-loaded the same way every other route is, with
  a matching `routePreload` entry; confirmed all five hub destination
  routes (`/gallery`, `/groic`, `/us`, `/map`, `/shayari`) plus `/playlist`
  are unchanged and still separately registered.
- **Light/dark** — every new token has both a `:root` and `.dark` value;
  none reference a color that only exists in one theme.
- **Reduced motion** — the new `.glass-sheet` utility has no animation of
  its own. The new dock compact/restore step and the `Duo.tsx` list's
  stagger-in both use Framer Motion `animate`/`transition` (via the
  existing `gentleSpring`/`standardTransition` tokens), which is already
  covered by `App.tsx`'s app-wide `<MotionConfig reducedMotion="user">` —
  nothing in this phase bypasses that wrapper with a raw CSS animation.

## 5. Suggested next steps (not part of this phase)

1. Get a look at `/duo` on a real small-screen device — the list layout
   was built to the same spacing/typography conventions as `Us.tsx`/
   `Shayari.tsx`, but hasn't been visually verified outside this sandbox.
2. Extend `useDockCompactReporter` to Map/Gallery/Groic's own scroll
   containers once those screens are in scope, so the compact-on-scroll
   behavior is consistent app-wide rather than Chat-only.
3. Consider wiring `.glass-sheet` into the attach tray / message context
   menu's own surfaces when those get their own redesign pass — the token
   and utility exist now, but neither surface was changed this phase.
4. `BottomNav.tsx` remains a safe, confirmed-dead deletion candidate
   whenever a cleanup pass is scheduled.
