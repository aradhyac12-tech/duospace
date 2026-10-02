# Phase 5.5 — Chat Composer: Hub/Record Integration + Multiline

Scope actually completed this session (full 33-section brief is large;
this pass targeted the two items marked MANDATORY/HIGH-PRIORITY — §10
Hub+Record inside the composer, and §8-9 multiline growth — rather than
a full Chat visual rebuild).

## Changed
- `src/components/chat/MessageComposer.tsx` — rewritten. Hub, text field,
  and Attach/Send/Mic now live inside one `.glass-sheet` pill instead of
  Hub floating as a separate button beside it (prior layout violated the
  brief's explicit MANDATORY requirement).
- Text field is now a `<textarea>` (was `<input>`): auto-grows from a
  40px single-line rest height up to a 128px cap, then scrolls
  internally (State C from the brief). Enter sends; Shift+Enter inserts
  a newline.
- `inputRef` type changed `HTMLInputElement` → `HTMLTextAreaElement`
  in `Chat.tsx` and `MessageTimeline.tsx` (only `.focus()`/`.blur()`
  called on it elsewhere — confirmed safe).
- Composer surface uses `motion.div layout` + `quickSpring` so the pill's
  own height animates smoothly as the textarea grows/shrinks, instead of
  snapping.
- `OnboardingTooltip` `side` flipped `left`→`right` (Hub moved from the
  pill's right side to its left edge; `side="left"` would now render the
  tooltip off-screen).

## Also added this session — §3 radius/typography tokens
Audited `ChatHeader.tsx`, `MessageBubble.tsx`, and `FloatingDock.tsx`
against the brief before touching anything: header is already an
edge-integrated, gradient-scrim, icon-only-controls layout; bubbles
already use a flat tonal (not card/shadow) surface with tail-corner
grouping and consolidated per-group metadata; the dock already
coexists with the composer via the same `useSetImmersive` mechanism
the composer's focus state uses. All three already match the brief —
no changes made there, per §30 ("don't touch what already works").

What was genuinely missing: §3 asks for a named RADIUS scale
(small/medium/large/floating/pill) and TYPOGRAPHY scale
(display/heading/body/caption/metadata) as a "coherent system," but
those existed only as scattered arbitrary values (`text-[15px]`,
`rounded-[26px]`, etc.) with no shared name. Added, purely additively:
- `src/index.css` — `--radius-sm/md/lg/floating/pill` and
  `--text-display/heading/body/caption/metadata` CSS variables, plus
  `.text-display/.text-heading/.text-body/.text-caption/.text-metadata`
  utility classes in `@layer utilities`.
- `tailwind.config.ts` — `rounded-floating` / `rounded-pill` added to
  `borderRadius` (sm/md/lg already existed, mapped to `--radius`).
- `MessageComposer.tsx`'s own `rounded-[26px]` switched to
  `rounded-floating` (same computed value, 26px — now named).

Nothing else was switched to consume the new typography classes —
that's a larger, riskier pass (touching header/bubble/every screen's
text sizing) intentionally left for a future phase rather than bundled
into an unverified token-introduction commit.

## Not touched this session (still open from the full brief)
- Chat header, message bubbles/grouping, dock, and design-token
  consolidation (radius/spacing/typography scale as named tokens) — the
  existing system already covers much of §2-3 (glass tokens, motion
  timing bands, Space Grotesk/Inter pairing) but wasn't audited fresh
  this pass.
- Keyboard/viewport behavior: unchanged. The composer already sits in
  normal flex flow (not `position: fixed`) so `Keyboard.resize="body"`
  reflow already keeps it above the keyboard — confirmed by reading
  `useKeyboardOpen.ts` and `Chat.tsx`'s root layout, not verified on a
  real device.
- Calls, Gallery, Music, Map — untouched per §26-28, §30.

## Testing
No network/build tooling in this sandbox (consistent with every prior
session on this project). Verified via: prop cross-reference against
`HubButton`/`OnboardingTooltip` signatures, bracket-balance sweep on all
three edited files (Chat.tsx's pre-existing sweep "mismatch" reproduces
identically on the unmodified original — confirmed a sweep artifact, not
a regression), and a full grep for other `inputRef` consumers before
retyping it. No `npm install`/`tsc`/`eslint`/build actually run — you'll
need to do that on your machine before trusting this compiles.

## Next
Full Phase 5.5 brief (header, message bubbles, dock, token
consolidation) is still open — this pass deliberately scoped down to the
one item flagged MANDATORY rather than attempting the entire 33-section
brief in one unverified pass.
