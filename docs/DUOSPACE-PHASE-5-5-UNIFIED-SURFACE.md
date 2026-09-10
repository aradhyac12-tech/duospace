# Phase 5.5 — Unified Bottom Surface + Zero-Flicker Navigation

## Scope taken

The brief was 15 sections. This pass implemented the two structural items
everything else in the brief depends on, end to end:

1. **§1 Unified bottom surface** — Chat's composer and the Chat/Calls nav
   are now ONE glass shell (`DuoSpaceBottomSurface.tsx`), not two stacked
   pills.
2. **§5/§7/§8/§9/§11 Persistent mount** — Chat and Calls no longer route
   through `<Outlet>` + `AnimatePresence mode="wait"`, which was unmounting
   and remounting the entire page on every tab switch. This was the actual
   root cause of the flicker (confirmed by reading the code, not assumed —
   see "Audit findings" below). Fixed via `ChatCallsShell.tsx`.

Sections §2 (reclaim dock space), §3 (attach tray inside the surface), §4
(composer collapse on Calls), §6 (transition motion), §10 (keyboard),
§12 (perf), §13 (a11y) are addressed as a consequence of the above two —
see the per-section notes below for exactly how, and what's still an
approximation vs. exactly spec'd.

**Not done this pass, flagged not missed:** §9's full realtime-stress
matrix (new message/image/voice arriving mid-switch) traces as correct by
construction now (nothing unmounts, so there's nothing to race against),
but wasn't independently exercised on a device. §15's verification
checklist (build/lint/test + the manual matrix) — same standing caveat as
every session in this project: no network/build tooling in this sandbox,
verified via isolated `tsc --noEmit` per touched file + a bracket-balance
sweep instead of a real build. Run `npm run build && npm run lint && npm
test` yourself, then the manual matrix in §15.

## Audit findings (before any change)

Per the brief's own "do not assume the cause of flickering" instruction,
traced the actual mechanism before touching anything:

- `AppLayout.tsx` rendered every route (including `/chat` and `/calls`)
  through a single `<AnimatePresence mode="wait"><motion.div
  key={location.pathname}>...<Outlet/></motion.div></AnimatePresence>`.
  `mode="wait"` means the outgoing page's component tree is fully
  unmounted before the incoming one mounts — so switching Chat → Calls was
  never a transition between two live pages, it was destroy Chat, mount
  Calls from scratch. That's a real remount: fresh effects, fresh scroll
  position (lost), fresh image `<img>` elements (full re-decode, hence the
  photo flicker), fresh realtime subscription setup. No transition tuning
  fixes that — the component instances themselves were different objects
  each time.
- The composer (`MessageComposer.tsx`) and the dock (`FloatingDock.tsx`)
  were two independent components: the composer rendered in Chat's normal
  document flow, in-flow padding-bottom reserving space for a `FloatingDock`
  that was a completely separate `position: fixed` overlay, positioned and
  animated independently. Visually and architecturally, exactly the "two
  separate pills" the brief says not to do.
- Attach tray (`Photo/Camera/File/Schedule`) was a third independent
  floating card, rendered by `Chat.tsx` itself, positioned just above the
  composer by document order — not part of either the composer's or the
  dock's material.

## What changed

**New files:**
- `src/components/ChatCallsShell.tsx` — mounts Chat once, and Calls the
  first time it's actually visited; both stay mounted afterward. Switching
  tabs toggles a `Pane` (opacity + ~10px transform + `pointer-events` +
  `inert`), never an unmount. This is the actual flicker fix — everything
  downstream (scroll position, composer draft, loaded images, live
  subscriptions) is preserved automatically because there's no teardown to
  preserve them through.
- `src/components/DuoSpaceBottomSurface.tsx` — the unified shell. Fixed,
  centered, one `.glass-dock` material, `calc(100% - 24px)` / max 520px,
  `rounded-floating` (26px). Composer slot height/opacity-animates between
  Chat (expanded) and Calls (collapsed) while the nav row underneath stays
  physically in place. Reports its own live height via `ResizeObserver` for
  §2/§11 (see below).
- `src/contexts/BottomSurfaceContext.tsx` — the plumbing connecting the two
  above: a portal target `HTMLDivElement` for the composer, and the shell's
  live measured height.
- `src/components/dock/DockNavRow.tsx` + `src/hooks/useDockBadges.ts` —
  extracted the tab-button/badge/active-lens/haptics logic out of
  `FloatingDock.tsx` so both the standalone dock (every other page) and the
  new unified surface (Chat/Calls) share one implementation instead of two
  that could drift.

**Edited:**
- `AppLayout.tsx` — branches on `pathname === "/chat" || "/calls"`: that
  branch renders `ChatCallsShell` + `DuoSpaceBottomSurface`; every other
  route is 100% unchanged (still `Outlet` + `AnimatePresence mode="wait"` +
  standalone `FloatingDock`, exactly as before this phase — the brief's own
  "don't redesign unrelated screens" instruction).
- `FloatingDock.tsx` — now just the outer positioning/glass pill, consuming
  `DockNavRow`. Only renders on non-Chat/Calls pages now.
- `MessageComposer.tsx` — stripped all the dock-clearance/safe-area/
  keyboard-inset math it used to own (the shell owns that now, once, for
  composer + nav together). Attach tray moved in here from `Chat.tsx`
  (§3 — new `attachActions` prop), so it now expands as part of the same
  surface instead of as its own floating card.
- `Chat.tsx` — portals `MessageComposer`'s whole return value into the
  shell via `useComposerHost()` (falls back to an inline render for the
  one-frame pre-mount window). Feeds `MessageTimeline` the shell's live
  height as `bottomInset` instead of the old in-flow layout.
- `MessageTimeline.tsx` — new optional `bottomInset` prop, applied as
  `paddingBottom`. Defaults to 0, so this is backward compatible with any
  other caller.
- `Calls.tsx` — swapped the hardcoded `pb-24` for the same
  `useBottomSurfaceHeight()` value Chat uses (§2/§11: "measured/dynamic
  dimensions... rather than magic numbers").

**Deleted:** `BottomInteractionZone.tsx` — its whole job (wrapping the
composer with dock-clearance) is now the shell's job; nothing referenced it
after the edits above (confirmed via grep before deleting).

## Section-by-section notes

- **§2 (reclaim dock space):** done via the `ResizeObserver` height
  feeding both Chat's and Calls' scroll containers directly — no more
  static reserved region, and it's exactly right for whatever state the
  shell is actually in (composer expanded/collapsed, attach tray open,
  recording).
- **§4 (Calls collapse):** composer slot's `height`/`opacity` animate on
  the shared `standardTransition` tween; the nav row is a sibling below it,
  never re-rendered by the collapse.
- **§6 (transition motion):** `Pane`'s hidden-state x offset is fixed per
  side (Chat always ±towards −10px, Calls always ±towards +10px) rather
  than computed from switch direction at runtime — this means "leaving
  forward" and "entering backward" naturally move the correct way for a
  given pane without direction bookkeeping, but it does mean opacity
  reaches 0 at rest for the inactive pane (unavoidable — both panes are
  absolutely stacked in the same space, so the hidden one has to be
  invisible once settled, not just "high opacity"). Kept the transition
  short (220ms) so this reads as a quick directional swap, not a fade.
- **§10 (keyboard):** the shell is `position: fixed`, and this app's native
  keyboard config is `Keyboard.resize="body"` (confirmed via a prior
  session's read of the config), so the viewport itself shrinks when the
  keyboard opens — a fixed-bottom shell naturally sits right above it with
  no JS height-tracking needed. Only correction: the shell drops the
  safe-area-bottom inset while the keyboard's open (same root cause
  `useKeyboardOpen`'s doc comment already described for the old
  per-composer padding).
- **§13 (a11y):** hidden panes get both `aria-hidden` and `inert` (not just
  one), so a focused control in the hidden pane can't be reached by
  keyboard/AT while it's visually gone. Nav labels unchanged (still
  text+icon, not icon-only).

## Known trade-off, called out rather than hidden

The old composer had a "typing hides the dock" behavior (iOS-style, driven
by `useSetImmersive`). That mechanism only ever affected `FloatingDock`,
which no longer renders on Chat — so this pass drops that specific
behavior for Chat/Calls (the nav row now stays visible while typing,
matching the brief's own mockups, which never show it hiding on focus).
`useSetImmersive`/`useIsImmersive` are untouched and still work exactly as
before for every other page.

## Verification

Same standing constraint as every session on this project: no
network/node_modules in this sandbox, so no real `npm run build`. Checked
instead:
- Isolated `tsc --noEmit --jsx react-jsx --skipLibCheck` per touched/new
  file — zero real errors on any of them, only the expected noise from
  missing React/DOM types in an isolated single-file check (same category
  this project's history documents every session).
- Bracket-balance sweep across every touched/new file — clean, except
  `Chat.tsx`'s pre-existing `()` mismatch, which was verified against the
  UNEDITED upload (still present there too — a known false positive from
  a `(` inside a string/comment, not something this pass introduced).
- `grep` sweep for dangling references to everything removed/renamed
  (`BottomInteractionZone`, `composerWrapperRef`, the old
  `useSetImmersive`/`useKeyboardOpen`/`useDockVisibility` imports in
  `MessageComposer.tsx`) — none found.

You'll still want to run the real build + the full manual matrix in the
brief's §15 on your machine before treating this as shipped.
