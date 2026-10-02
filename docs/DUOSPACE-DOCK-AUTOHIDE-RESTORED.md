# DuoSpace — Dock Auto-Hide Restored (Scroll + Typing)

**Context:** direct request to (1) re-check the in-chat Hub panel's
positioning, (2) confirm/upgrade the dock's glassmorphism to an
iOS/Instagram-style material, and (3) make the dock hide on scroll and
while typing, the way Instagram's bottom bar does.

## 1. Hub positioning — already fixed in this codebase, not touched

`GridMenu.tsx` already renders through `createPortal(..., document.body)`
and anchors `bottom-right` via `--dock-reserve`, per
`docs/DUOSPACE-HUB-AND-OPTIMISTIC-SEND-FIX.md` from a prior session. That
fix is what prevents the panel from inheriting a transformed ancestor's box
as its `fixed`-position containing block (the exact "opens in the top-left
corner" bug). I could not find any element in this codebase matching
"vertical, left-corner, misaligned" — re-verify against a current
screenshot before I touch this, since GridMenu is a 2-column grid (not a
vertical list) and is already anchored correctly.

## 2. Dock glassmorphism — already implemented, not touched

`.glass-dock` in `src/index.css` already does `blur(40px) saturate(1.7)
brightness(1.01)`, a sheen gradient, a forced compositor layer, and a
`@supports not (backdrop-filter)` solid-color fallback — this is already
the iOS-style frosted material. Also not touched, for the same reason as
above: happy to retune (more/less blur, tint, opacity) once we're aligned
on what's actually wrong with the current look.

## 3. Auto-hide on scroll + typing — implemented this pass

A prior session (see `useDockVisibility.ts`'s previous comment, now
rewritten) deliberately *removed* scroll-driven hide/show in favor of an
always-visible dock. This pass reverses that specific decision, restoring
Instagram-style behavior:

- **Scroll:** hides on scroll-down, reappears instantly on scroll-up or
  when back within ~24px of the top. A 6px per-frame dead-zone absorbs
  iOS rubber-band/trackpad jitter so it can't flicker — the same class of
  bug the original removal was reacting to.
- **Typing:** hides while the chat message input is focused (keyboard up),
  reappears the instant it blurs.

### Mechanism
- New `src/lib/dockScrollHide.ts` — a tiny module-scope pub/sub (same
  shape as the existing `lib/immersiveMode.ts`), exposing
  `setScrollHidden()` / `useIsScrollHidden()`. Kept independent of the
  immersive registry on purpose: immersive means "truly blocked by another
  full-screen surface," scroll-hide means "softer, instantly reversible."
- `src/hooks/useDockCompact.ts` — `useDockCompactReporter`'s existing
  scroll listener (already attached to Chat's message list) now also
  tracks scroll direction and calls `setScrollHidden`. The original
  "compress while scrolling" cosmetic step is unchanged and still runs
  alongside the new full hide.
- `src/hooks/useDockVisibility.ts` — now also reads `useIsScrollHidden()`
  and folds it into `isVisible` alongside the existing immersive/call
  checks.
- `src/components/chat/MessageComposer.tsx` — the message `<input>` calls
  `useSetImmersive("chat-composer-typing", isFocused)` on focus/blur,
  reusing the same registry the photo/video viewer and camera already use
  to hide the dock.

### What did NOT change
- `FloatingDock.tsx`'s render/animation logic — it already animates
  `isVisible`/`isHidden` via the same spring, so it needed no changes to
  pick up the new hide source.
- No change to the Hub panel or its glass styling (see §1, §2).
- Calls/photo/video-viewer/camera hide behavior — untouched, still driven
  independently as before.
