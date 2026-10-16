# Handoff: premium + faster chat animations

## Changes
- MessageBubble: new bubbles rise from their own tail corner (mine: bottom-right, theirs: bottom-left) with a
  firm transform-only spring (560/36) + 160ms opacity fade; exits are opacity/scale/translate only.
  REMOVED `filter: blur()` from both exits (forced full re-raster per frame; janky on mid-range Android and
  could leave a blurred layer behind). Virtualized re-mounts still skip the enter animation (unchanged).
- TypingIndicator dots: framer JS animation -> CSS keyframes `.ds-typing-dot` (index.css), compositor-only;
  reduced-motion gets an opacity-only pulse.
- MessageComposer: mic<->send swap was AnimatePresence mode="wait" (exit THEN enter, ~2x140ms lag on the first
  typed character). Now a simultaneous crossfade in a fixed 44px slot (buttons absolute inset-0).
- Left as-is on purpose: composer `layout` growth animation, scroll-to-latest logic, reactions, status ticks.

## Verified here
All files edited this session (incl. earlier rounds) transpile with TypeScript with 0 syntax errors.
NOT run: vite build, tsc type-check, vitest (no node_modules/network). Feel can only be judged on device.
## Tuning knobs
Bubble spring: MessageBubble `transition.default`; enter offsets: `initial`. Slower/softer: lower stiffness
to ~420, raise damping to ~32.
