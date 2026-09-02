# DuoSpace Phase 2 — Visual Correction — STATUS: COMPLETE (all 4 surfaces)

Scope: flagship dock, Chat, Map, Calls, shared material system, light/dark
quality. Done across 4 sessions, one surface per session — each of these
is its own multi-file compositional rewrite on files already 200–900+
lines, and doing all four shallow in one pass risks exactly the
"recolored old UI" outcome the brief rejects. One surface fully done beat
four half done.

## Dock (`src/index.css`, `FloatingDock.tsx`)
- New `.glass-dock-lens` class: the active tab's indicator is a denser,
  more-saturated pocket of the dock's own glass material (soft violet
  core, bright inner rim upper-left, faint pressed-in lower-right shadow)
  instead of a flat `bg-primary/12` tint chip.
- `layoutId="dock-active-pill"` unchanged — morph animation between
  Chat/Calls still works, only the surface it morphs changed.
- Theme-invariant, same rule as `--glass-dock-bg`.
- 2-tab nav/badges/scroll-compress/hide-on-fullscreen: already matched
  the brief, confirmed and left alone.

## Chat (`ChatHeader.tsx`, `MessageBubble.tsx`, `MessageComposer.tsx`)
- Header: bordered toolbar → edge-integrated identity on a top-fade
  gradient scrim, no hard line. Avatar gained ring+shadow depth, presence
  dot moved onto the avatar. Name promoted to primary identity; presence
  demoted to a quieter secondary line. Call/overflow icons lost their
  resting filled-circle background — icon-only at rest, background only
  on active press. Search bar promoted to `.glass-sheet`.
- Message surface: partner bubbles lightened from a bordered/blurred card
  to a plain tonal `--surface-2` surface. Image messages now bleed past
  the bubble's own padding via negative margins to dominate, instead of
  sitting inset like ordinary content. Mine-bubble fill, grouping,
  swipe-to-reply, disappearing-ring: unchanged.
- Composer: flat bordered strip → bottom fade-gradient scrim with the
  input pill promoted to `.glass-sheet`. Attach tray already contextual
  (pre-existing) — confirmed, not changed. Mic↔send morph, hold-to-record:
  unchanged.

## Map (`MapView.tsx`) — smaller pass, already mostly done
- Genuine finding: this file already carried "Phase 2" comments and
  matched most of the brief's Map section near-verbatim (minimal identity
  bar, no-card full-space map, floating `.glass-sheet` controls,
  attention-only status flags, bottom contextual status bar, detail sheet
  instead of stacked cards) — done in an earlier undocumented pass,
  flagged plainly rather than silently redone.
- Actual changes: `PartnerStatusPill` was still on the old flat bordered
  style while everything else had moved to `.glass-sheet` — promoted it
  to match. Added the brief's explicitly named pressed/active state
  differentiation to the two floating buttons, which had none.
- Recenter FAB deliberately kept solid `bg-primary`, not glass — same
  reasoning as Chat's send button: a "find your partner" action needs to
  be findable/trustworthy, not translucent. Flagged as a deliberate
  choice, not silently made.

## Calls (`CallOverlay.tsx`, `IncomingCallOverlay.tsx`)
- `IncomingCallOverlay`: already close to spec (minimal, large avatar,
  name, call type, two obvious actions) from an earlier pass — added
  ring+shadow depth to the avatar to match the depth treatment used
  elsewhere (Chat header, Map status).
- `CallOverlay` (active call) had the real gap: the top status row and
  bottom toolbar were unconditionally visible for the whole call — the
  brief explicitly wants controls hidden when not interacting. Added a
  4-second idle auto-hide + tap-anywhere-to-reveal, active only once the
  call is actually connected (not during ringing/connecting, where
  there's nothing else to look at and hiding the only feedback would be
  confusing). Control buttons promoted from ad hoc `bg-background/15` to
  `.glass-sheet`. End-call button got extra spacing from its neighbors —
  "don't make it easy to accidentally press."
- Self-preview PiP: added `dragConstraints` so it can't be dragged
  off-screen (previously fully unconstrained). **Gap**: the brief also
  wants edge-snapping on release — not implemented, would need an
  `onDragEnd` handler computing nearest-edge position.
- **Gap**: voice-call vs. video-call visual differentiation ("subtle
  ambient background" for voice vs. full video) not implemented —
  `CallOverlay` doesn't currently receive the call's type as a prop, so
  it can't distinguish them; always renders the video layout. Flagging
  rather than guessing at a prop that may not exist upstream.

## Explicitly out of scope (per the brief itself)
Gallery/Groic/Music — brief says "Do NOT redesign yet."

## Not built
`DuoGlassButton` / `DuoGlassControl` / `DuoGlassSheet` as componentized
React primitives — `.glass-hub` / `.glass-sheet` / `.glass-dock` CSS
classes were the de facto implementation across all 4 surfaces, used
consistently. Componentizing them is real but separate work.

## Preserved (confirmed by inspection, unmodified)
Supabase schema, RLS, encryption, auth, native calling (CallKit/
ConnectionService/VoIP), location backend, `/duo` route absence, 2-tab
nav decision.

## Verification
No Node/network in this sandbox (true every session on this project). Ran
the standard bracket/brace/paren-balance diff on every touched file
across all 4 sessions (`index.css`, `FloatingDock.tsx`, `ChatHeader.tsx`,
`MessageBubble.tsx`, `MessageComposer.tsx`, `MapView.tsx`,
`CallOverlay.tsx`, `IncomingCallOverlay.tsx`) — clean. No build/typecheck/
lint run; user verifies on device.

Two things worth an eyes-on device check specifically:
1. `MessageBubble.tsx`'s image-bleed `rounded-t-2xl` doesn't exactly track
   the bubble's own first/last-in-group corner variants — should look
   right but wasn't pixel-verified against every grouping state.
2. `CallOverlay.tsx`'s auto-hide timer resets on `onPointerDown` anywhere
   on the call surface, including on the control buttons (each also calls
   `stopPropagation()`). Should feel right — tapping a control also
   "wakes" the controls — but wasn't traced against real DOM event timing
   on-device.

## Optional follow-ups (Phase 2 itself is done)
- PiP edge-snapping on the call screen
- Voice/video call visual differentiation (needs an upstream prop first)
- Componentize the `DuoGlass*` primitives if repeated `.glass-sheet`
  className strings become a maintenance annoyance
