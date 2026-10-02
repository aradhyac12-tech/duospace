# Whole-page flicker fix (Chat, Android browsers) — v3.4.3 → v3.4.4

## Reported symptom
Screen recording (Samsung Internet, web-duospace.lovable.app) showed the
Chat screen repeatedly flashing blank/partial for the first ~1.5s after
load, and again during scroll: header, message bubbles, composer icons and
the bottom nav row dropping out and reappearing several times a second.

## Root cause
`useKeyboardOpen()` (used by `DuoSpaceBottomSurface` for its fixed `bottom`
offset and by `Chat.tsx` for a scroll-to-bottom correction) detected "keyboard
open" by comparing the current `visualViewport.height` against the tallest
height it had ever seen at the current width, and calling any drop of more
than 120px a keyboard opening.

On Chrome/Samsung Internet, the address bar and bottom browser nav bar
auto-hide on scroll. That alone shrinks the viewport by well over 120px —
with nothing to do with any keyboard. Every hide/show of the browser chrome
was read as the keyboard opening/closing, and since an animated toolbar
transition fires resize events on nearly every frame for ~300-500ms, the
hook flipped `open` many times a second during that window. Each flip moved
`DuoSpaceBottomSurface`'s fixed `bottom` position and re-ran Chat's
scroll-correction effect, which is what actually read as the composer, nav
row, and message content flickering — not a single bug in any one
component, but this one hook's state thrashing everything that reads it.

## Fix (`src/hooks/useKeyboardOpen.ts`)
1. **Platform-specific signal.** On native (Capacitor, `Keyboard.resize:
   "body"`) the keyboard genuinely shrinks `window.innerHeight` itself, so
   the previous baseline-vs-current-height heuristic is correct there and
   is unchanged. On web, the hook now uses the gap between
   `window.innerHeight` (layout viewport — unaffected by an on-screen
   keyboard) and `visualViewport.height` (visual viewport — shrinks under a
   real keyboard, but moves in lockstep with `innerHeight` when only the
   browser's own address/nav bars toggle). That gap stays ~0 through a
   toolbar animation and only grows for an actual keyboard overlay, so
   browser-chrome resizes can no longer be mistaken for a keyboard event.
2. **Debounce.** Resize events fire repeatedly over the course of any
   animated transition (toolbar or keyboard). The hook now waits ~120ms +
   one animation frame after the last resize event before reading geometry,
   so it only ever reacts to the settled end state, never a mid-animation
   sample.

No other files changed — `DuoSpaceBottomSurface` and `Chat.tsx` already
consumed this hook correctly; the state it fed them was just wrong.

## Verification
No build/device access in this sandbox (same caveat as every session).
Verified via isolated `tsc` syntax check (clean, only expected missing
`react`-types noise from the isolated check) and a bracket-balance sweep on
the touched file. Recommend the user re-run the same screen recording after
installing this build to confirm the flicker is gone on their device.

Bumped `APP_VERSION` / `package.json` 3.4.3 → 3.4.4 per `docs/rules.md`.
