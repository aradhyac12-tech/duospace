# Phase 2.5 — Chat + Calls Premium UX Redesign — Session Notes

Scope this session (user-selected subset of the full Phase 2.5 brief):
composer redesign, message interactions, calls (incoming/active), dock
refinement. NOT a full pass over all 30 sections in one sitting — see
"Already done in prior sessions" and "Not touched this session" below.

## Already done in prior sessions (verified, not re-done)
- Dock is genuinely translucent glass (`.glass-dock` in index.css), not a
  whitish pill — blur(40px)/saturate(1.7)/brightness(1.01), theme-invariant
  tokens, inner rim light + specular hairline. Exactly 2 tabs (Chat/Calls).
- Active-tab morph: `.glass-dock-lens` + `layoutId="dock-active-pill"` —
  already a small lens-in-material read, not a flat tinted pill.
- Shared motion tokens already existed (`src/lib/motion.ts`): EASE_SMOOTH/
  SNAP/SPRING, DUR_FAST/MED/SLOW, gentleSpring/gentlePanelSpring.
- Composer already fully optimistic on send: input clears immediately,
  bubble appears instantly (150ms), encryption/network happen after.
- Swipe-to-reply and long-press already implemented with real physical
  motion (motion-value drag, elastic, haptic on threshold cross) —
  MessageBubble.tsx.
- Message context menu already a fast spring-driven bottom sheet
  (~stiffness 420/damping 36), not a generic slow modal.
- Video-call self-preview already redesigned (small, frameless,
  edge-snapping, draggable) from an earlier "Phase 2" pass.
- Incoming call screen already minimal (avatar/name/decline+accept only).

## Changes this session

### Motion language (`src/lib/motion.ts`)
Added `quickSpring` (620/38/0.6) and `snappySpring` (560/26/0.7) — the two
smallest-scale members of the spec's named primitives ("quickSpring"/
"snappySpring"), for button-press and idle-reveal feedback where the
existing `gentleSpring` reads a touch slow.

### Dock (`FloatingDock.tsx`)
Tab buttons switched from CSS `active:scale-95` to `motion.button` +
`whileTap={{ scale: 0.94 }}` on `quickSpring` — spring-driven compression
instead of a linear CSS transition, matching spec section 6/7 ("tiny scale
reduction, subtle material compression"). No behavior change.

### Composer attach tray (`Chat.tsx`)
Was a visually unrelated card (`bg-card/90` + own border/blur) floating
above the composer. Rebuilt on `.glass-sheet` — the same material family
already used by the input pill — with `transformOrigin: bottom center`
so the open/close scale genuinely reads as the composer's own material
extending, not a separate object appearing. Timing tightened to spec
range (open via a stiff spring, close 0.15s tail — was one untuned
380/28 spring both directions). Added **Schedule** as a 4th tray item:
the feature already existed (`setShowSchedulePicker`) but was only
reachable via an undiscoverable long-press on the hub button — this is
the "appears contextually from +" placement section 15 asks for, not new
functionality.

### Calls — video idle auto-hide controls (`Calls.tsx`)
Real gap found: the status row (quality/duration/lip-read) and the
control bar were permanently visible for the whole video call — spec
section 21 explicitly wants them to fade away when idle and reappear on
tap. Added `controlsVisible` state + a 3.5s idle timer, scoped to VIDEO
calls only (voice call's small glass control group stays as-is — it's
already minimal per section 20 and doesn't sit over content). Tap on the
remote/screen-share video toggles visibility; every individual control
button (mute, video, screen share, camera picker, PiP, audio route, lip
read) resets the idle timer on use so hiding never happens mid-interaction.
Reveal via `snappySpring` (~180ms), hide via a 150ms fade — both inside
the spec's 160-200ms reveal target. End-call button and the two picker
sheets (camera/audio-route) live inside the same visibility wrapper.

### Incoming call transition (`IncomingCallOverlay.tsx`)
Was a bare opacity fade (default ~300ms). Now a quick, slightly physical
entrance — opacity + scale 1.03→1 over 220ms on `EASE_SMOOTH`, matching
the spec's 200-280ms target for this transition — with a faster 150ms
exit.

## Verified
- Bracket-balance sweep on all 5 touched files: clean (Chat.tsx's
  pre-existing +1 paren is the known comment-string artifact documented
  in prior sessions, not from this pass).
- No CallContext/native-calling/E2E/Supabase logic touched — this pass
  is presentation-layer only, per the brief's hard prohibitions.
- No build possible in this sandbox (no network/Node here, as every
  prior session on this project has noted) — verified via static
  read + bracket balance only, same method used throughout this project.
  Real-device testing still matters more than usual for the idle-hide
  timer and the dock's `motion.button` swap.

## Not touched this session (still open against the full 30-section brief)
- Chat header refinement (section 10) — not selected this session.
- Message bubble geometry/grouping/whitespace polish (section 11).
- Media viewer shared-element (thumbnail→fullscreen) transition (13).
- Voice message player visual pass (14).
- Keyboard-transition polish beyond what already exists (16).
- Calls page (history list) minimal-list treatment (18).
- Call state-transition continuity (Incoming→Connecting→Connected→Ending→
  Outcome) beyond what CallOutcomeScreen/CallErrorScreen already do (23).
- Full accessibility pass (26) and reduced-transparency fallback check
  beyond the existing `@supports not (backdrop-filter)` fallbacks.

Per the brief: do not start Phase 3. This file should be extended (not
replaced) by whichever future session picks up the remaining sections
above.

**Correction (added in Session 4, do not re-remove):** two items on the
list directly above were stale even at the time of this file's last
edit — the code already carried `Phase 2.5, section 18` / matching
comments for both, contradicting the "not touched" claim:
- Chat header (10) — already edge-integrated, gradient scrim instead of
  a bordered toolbar, quiet no-resting-chrome call buttons, subtle
  typing state. Verified in Session 4 by reading ChatHeader.tsx
  directly, not by trusting this list. One flag, not a bug: an
  anniversary badge (`DA-06` tag) is extra header metadata the brief's
  section 10 says to avoid — but it's tagged as a prior direct user
  request, not something a session added unprompted, so left alone
  rather than silently removed.
- Calls page list (18) — CallHistoryRow.tsx and its empty state in
  Calls.tsx both already carry explicit `Phase 2.5, section 18`
  comments: no per-row cards, swipe-to-delete, restrained missed-call
  text (no big red badge), minimal empty state. Nothing left to do here.

This is exactly the "don't trust prior completion reports" failure mode
the original brief warned about — a doc claim went stale without the
code being wrong. Lesson for future sessions: verify this list against
the actual files before picking a task off it, same as everything else.

## Session 2 — Message bubble rhythm (section 11)

Audited MessageBubble.tsx/MessageTimeline.tsx against section 11 before
touching anything, per the brief's "don't trust prior reports" rule.
Most of section 11 was already done, just not logged in this file:
- Consecutive-sender grouping (4-min window) with avatar collapsed to a
  same-width spacer on non-first bubbles.
- Tail-corner tightening only on `isLastInGroup` (Telegram/iMessage
  pattern — full radius throughout the group, tight only on the last
  bubble) — correct as-is, not touched.
- No borders/shadows on bubbles; partner tone is a plain tonal surface,
  not a card. Media (images) bleeds past the bubble's own padding via
  negative margins to reach the corners. All correct as-is.
- Metadata row (time/read-receipt) collapsed to only the last bubble in
  a group. Correct as-is.

Real gap found: `isFirstInGroup` drove top spacing (`pt-2` vs `pt-[1px]`)
uniformly, whether the new group started because the *other person*
started talking or because the *same* sender re-grouped after crossing
the 4-minute gap. A real conversational turn change read identically to
one person sending a second burst — no rhythm distinction between the
two very different things.

Added `isSenderChange` (computed in MessageTimeline: true when the
previous timeline item is a different sender, or isn't a message at all
— e.g. a call event sits between). `isFirstInGroup && isSenderChange`
now gets `pt-3.5` instead of `pt-2`; a same-sender regroup keeps `pt-2`.
Optional prop, defaults to falsy — doesn't affect any other caller.

No other section-11 items changed. Not touched: chat header (10), media
shared-element transition (13, already done per session 1 notes —
`layoutId` on the image), voice message player visual pass (14),
keyboard audit (16), calls page list (18), call state-transition
continuity (23), accessibility pass (26).

## Session 3 — Keyboard audit, part 1: double safe-area padding (section 16)

Audited before touching anything, per the brief. No keyboard-aware JS
existed anywhere in the app (confirmed: `@capacitor/keyboard` isn't a
dependency, no `visualViewport`/`Keyboard.` usage in src/). Chat.tsx's
scroll-to-bottom effect only depends on message/call-history counts, not
viewport size, so it does NOT re-fire on keyboard open/close — ruled out
as a source of "accidental scroll-to-bottom."

Confirmed real bug: `capacitor.config.json` sets `Keyboard.resize: "body"`,
and MessageComposer's outer wrapper applied `safe-bottom`
(`env(safe-area-inset-bottom)`) unconditionally. That combination is a
well-documented Capacitor/iOS failure mode — the safe-area inset can keep
reporting the home-indicator height even once the keyboard has already
resized the viewport past it, leaving a dead gap between the composer and
the keyboard. This matches the brief's "composer jumping" / "double
safe-area padding" items directly.

Fix: added `src/hooks/useKeyboardOpen.ts`, a dependency-free heuristic
(tracks the tallest viewport height seen at the current width as the
"closed" baseline via `window.innerHeight`/`visualViewport`, reports open
once height drops >120px below it; resets the baseline on width change so
orientation changes aren't mistaken for a keyboard). Deliberately not
using `@capacitor/keyboard` — that's a native plugin, and this sandbox
can't verify the matching native iOS/Android project wiring would build.
MessageComposer now drops the `safe-bottom` class (keeping its other
padding untouched) while `useKeyboardOpen()` is true.

Checked for other `safe-bottom` usages on the Chat screen that might have
the same issue — there were none; the composer was the only one.

Not yet done from the keyboard-audit list: content jumping, dock overlap
(likely already covered by the existing composer-focus immersive-hide,
but not independently re-verified this session), incorrect scroll
position, keyboard animation mismatch, keyboard reopening incorrectly
after navigation. This session covered one specific, confirmed bug, not
the full audit.

Verified: bracket-balance clean on both touched/new files. No
build/typecheck possible in this sandbox. This one genuinely needs
on-device (or at least real WebView) confirmation — a viewport-height
heuristic is inherently a best-effort signal, not a guarantee, and I
can't observe actual keyboard behavior here.

## Session 4 — Voice message player (section 14) + doc correction

Audited VoiceMessagePlayer.tsx before touching anything. Most of section
14 was already solid: spring press feedback + play/pause icon crossfade
(matches the shared motion language), a live Web-Audio-analyser waveform,
duration/progress display, lightweight (no precomputed-peaks pipeline,
which would've been a heavier "waveform" implementation than what's here
— judged as a legitimate lightweight tradeoff, not a gap, and out of
scope to rearchitect given no way to test audio decoding in this
sandbox).

Real gap: seeking was tap-only (`onClick` jumps to a point) — no drag/
scrub. For a voice message, scrubbing back a few seconds with one
continuous drag is a common gesture; tap-only needed several separate
taps. Replaced with pointer down/move/up(+cancel) handlers using pointer
capture (same pattern as the composer's hold-to-record button), so drag
tracks correctly even if the finger wanders off the bar. Also added
`role="slider"` + `aria-valuemin/max/now` to the seek bar, which had zero
accessibility semantics before — not the full section-26 pass, just
bringing this one control in line since it was already being touched.

Verified: bracket-balance clean; confirmed no other file references the
old `seekTo` signature. No build/typecheck possible in this sandbox.

**Also corrected this session:** the Session 1 "not touched" list above
had gone stale on two items (chat header, calls page list) — see the
correction note right after that list.

## Session 5 — Call state-transition continuity (section 23)

Audited callUiState.ts and its consumer in Calls.tsx first. The state
*derivation* layer (idle/connecting/ringing/connected/reconnecting/
partner-left/error) was already thorough and well-reasoned — not
touched. The gap was purely in how the three mutually-exclusive full-
screen phase blocks (`connecting`, `ringing`, `isVoiceCall &&
connected/reconnecting`) were drawn: three independent conditionally-
rendered `<div>`s with zero animation, so every callUiState change was a
hard instant cut — exactly what section 23 says to avoid.

Fix: wrapped the three blocks in one `AnimatePresence` (default/
simultaneous mode, explicitly NOT `mode="wait"` — that would sequence a
full fade-out then fade-in, ~440ms total, contradicting "FAST >
CINEMATIC"), each as a `motion.div` with a plain opacity crossfade using
the existing shared `standardTransition` token (220ms, `lib/motion.ts`) —
within the brief's own 220-300ms target for call transitions. All three
are `absolute inset-0`, so overlapping mid-crossfade is correct, not a
layout bug. Reordered the JSX slightly (the `connecting` block used to
sit after the partner-left/reconnecting/audio-fallback banners, now it's
grouped with the other two phase blocks before them) — safe, since every
pair of states involved here is mutually exclusive by `callUiState`, so
no new co-rendering/stacking case was introduced.

Did not touch: callUiState.ts itself, the underlying Daily call state
machine, CallOutcomeScreen/CallErrorScreen (the "Ending"/"Ended" side of
this — not audited this session), or the incoming/outgoing (pre-join)
screens, which are separate components (IncomingCallOverlay.tsx,
CallOverlay.tsx) not covered by this pass.

Verified: bracket-balance clean on Calls.tsx. No build/typecheck
possible in this sandbox. This is exactly the kind of change that looks
right on paper but really needs an on-device run through
connecting→ringing→connected→reconnecting to confirm no flash-of-both-
states or flicker under real network timing.

## Session 6 — Keyboard audit, remaining items (section 16)

Two more items from the original keyboard-audit list, both in Chat.tsx:

**Keyboard reopening incorrectly after navigation:** confirmed there's no
`autoFocus` anywhere on the composer input and the whole Chat page
unmounts on route change (plain react-router, no keep-alive) — so this
isn't a React-state bug. More likely a Capacitor WebView quirk: a
focused `<input>` removed from the DOM without an explicit `blur()`
first can leave native keyboard state confused. Added a plain
unmount-cleanup effect next to `inputRef`'s declaration that calls
`inputRef.current?.blur()`. Low-risk, presentation-only.

**Content jumping / incorrect scroll position:** with
`Keyboard.resize:"body"`, the viewport genuinely shrinks when the
keyboard opens, but `scrollTop` doesn't auto-adjust — someone reading
the latest message can find the conversation scrolled away from the
bottom the instant they tap the composer, purely from the viewport
shrinking. Added an effect (reusing `useKeyboardOpen` from Session 3)
that re-anchors to the bottom only if the container was already within
~120px of the bottom right as the keyboard opened — same "don't
force-scroll someone reading older messages" principle already used by
the existing auto-scroll effect just above it. Instant (`behavior:
"auto"`), not smooth, since it's correcting a layout shift that already
happened, not animating a new message in.

Not done this session: keyboard animation mismatch (comparing the
composer's own movement against the native keyboard's actual animation
curve/timing — needs on-device measurement, not something auditable by
reading source). "Dock overlap" was already covered by the existing
composer-focus immersive-hide (Session 1) and wasn't re-verified
independently here.

Verified: bracket-balance flagged the file at +1, traced it to a
pre-existing duplicated comment line (584/585, both "BUG FIX
(\"scroll loading\"...") from an earlier session — harmless (inside `//`
comments, irrelevant to compilation), not introduced this session. Both
of this session's actual insertions independently balance to zero,
confirmed by isolating and counting each before relying on the
whole-file heuristic. No build/typecheck possible in this sandbox.
Keyboard reopening and content-jumping are both real device/WebView
behaviors — this needs on-device confirmation more than most of this
project's changes have.

## Session 7 — Accessibility pass (section 26)

Not a full pass — scoped to what's directly verifiable by reading, in
the Chat/Calls/Dock surfaces this phase covers, per the brief's own
restriction against touching other feature screens.

**Reduced transparency:** confirmed via grep there was no
`prefers-reduced-transparency` handling anywhere — only
`@supports not (backdrop-filter)`, which is a browser-*capability*
fallback, not the OS-level accessibility *preference* (a browser can
fully support backdrop-filter while the user has still asked for less
transparency). Added a `@media (prefers-reduced-transparency: reduce)`
block in index.css covering the three glass surfaces this phase touches
(`.glass-hub`, `.glass-sheet`, `.glass-dock`) — same near-opaque
fallback background already designed for the capability case, plus
`backdrop-filter: none` (leaving heavy blur active under a merely more
opaque fill would still be busy for someone who specifically asked for
less transparency).

**Stale comment correction:** index.css had a comment claiming keyboard
handling used "the Visual Viewport API in JS (see AppLayout)" — grep
confirmed AppLayout.tsx has no such code, and Session 3 already
established nothing like it existed anywhere before this phase. Same
"don't trust prior claims" trap as the doc itself warns about, just
found in a code comment. Corrected it to point at the real location
(`useKeyboardOpen.ts`).

**Dock keyboard-focus leak:** the dock is kept mounted (not unmounted)
while hidden, and `aria-hidden` was already correctly applied to hide it
from assistive tech while invisible — but `aria-hidden` alone doesn't
remove focusability, so a sighted keyboard user tabbing through could
still land on invisible dock buttons. Added conditional `tabIndex={-1}`
on the tab buttons while hidden. Deliberately not using the `inert`
attribute — can't verify it's typed in this project's exact
`@types/react` pin without a build; `tabIndex` is universally supported.

**Icon-only buttons with no accessible name:** found and fixed two
close (`X`) buttons with neither an `aria-label` nor visible text —
`ReplyPreview.tsx` and `ScheduledMessagePicker.tsx`, both in the
composer flow. Also found a similar gap in `LoveLetter.tsx` (close
button + unlabeled theme-swatch buttons) but left it alone: that's a
hub-invoked feature screen, not Chat/Calls/Dock itself, and the brief is
explicit about not touching other feature screens.

Not done — needs either a real screen reader/device pass or is simply
out of this session's scope: full contrast audit, complete keyboard-nav
audit beyond the two items above, reduced-motion coverage beyond the
existing global `prefers-reduced-motion` CSS override (not re-verified
component-by-component this session), and any icon-only buttons outside
the Chat/Calls/Dock/composer surfaces actually covered by this phase.

Verified: bracket/brace-balance clean on every touched file
(index.css, FloatingDock.tsx, ReplyPreview.tsx,
ScheduledMessagePicker.tsx). No build/typecheck possible in this
sandbox — same limitation as every session on this project.

This closes out the original list of open items from Session 1's audit.
Everything on it has now been either fixed, confirmed already-done, or
explicitly logged as out of scope with a reason. A genuinely fresh pass
(re-auditing the whole 30-section brief against current code, the way
Session 1 did) would be the right next step if this project continues,
rather than assuming this list is still exhaustive.

Verified: bracket-balance on both touched files (MessageBubble.tsx,
MessageTimeline.tsx) — clean. No build/typecheck possible in this
sandbox (no node_modules, no network) — same limitation every session on
this project has hit. This is a two-line, additive, type-safe change
(new prop is optional) touching only a className string, so the risk
profile is low, but real-device/browser visual confirmation still
matters more than usual given the inability to render here.

---

## Session 2 — chat header/bubble review, media shared-element, calls history list, call state continuity

Scope this session (user-selected, from the "not touched" list above):
chat header + message bubble polish, media viewer shared-element
transition, Calls history list, call state-transition continuity.

### Chat header + message bubble (sections 10-11) — reviewed, not modified
Both were already substantially spec-compliant from prior sessions:
edge-integrated header (gradient scrim, no hard border, no giant pill),
name as the strongest element with presence as a quiet secondary line,
restrained call/overflow controls with no resting chrome. Message
bubbles: grouping-aware corner radius (only the last bubble in a
consecutive run gets the "tail" corner), no shadow/border on every
bubble, partner tone is a plain neutral surface vs. the accent on the
user's own messages, images bleed past the bubble's own padding via
negative margins instead of sitting inset, metadata (time/read-receipt)
only shows on the last bubble in a group. No changes made here — real
gaps were elsewhere.

### Media viewer shared-element transition (section 13)
Real gap: PhotoViewer was a plain opacity fade over the tapped
thumbnail — exactly the "fade out → new page" behavior the spec calls
out as wrong. Wired a Framer Motion `layoutId` (`photo-${message.id}`)
shared between the thumbnail `<img>` in MessageBubble and the fullscreen
`<img>` in PhotoViewer, so opening/closing now animates the actual rect
between the two instead of two independent fades. Threaded the message
id alongside the URL through the whole chain: `onPhotoView` callback
signature, `MessageTimeline`'s `setViewingPhoto` prop type, and
`Chat.tsx`'s `viewingPhoto` state (now `{url, id} | null`). WhatsApp-
import photo messages (a separate render path in MessageTimeline, no
MessageBubble involved) also pass their own `imp.id` through the same
mechanism. Layout transition duration set to 280ms — inside the spec's
220-320ms shared-element/morph range. `photoId` is optional on
PhotoViewer's props so any future non-chat caller still works without
providing one (falls back to a plain non-shared img, no layoutId).
Known edge case, not fixed: an optimistic (`_sendStatus: "sending"`)
photo's id changes from a `pending-<uuid>` client id to the real DB id
once the send confirms; if the viewer is opened before that swap and
closed after, the close animation won't find a matching layoutId and
falls back to a plain fade. Cosmetic only, not a functional bug.

### Calls history list (section 18)
Real gap: `CallHistoryRow` used `bg-background` + `rounded-xl` per row —
literally "a card for every row," which section 18 names as the thing
to avoid. Rebuilt as a plain row on the page's own background, separated
by a hairline divider (suppressed on the last row) instead of a
container; the destructive swipe-reveal strip is unchanged (a transient
interaction affordance, not a permanent card). Added the partner avatar
per row (with a small call-type badge overlaid on it) since section 18
explicitly lists "avatar, person, call type, time/status" as the
per-row hierarchy — this app is strictly 1-to-1 so every row shares the
same partner identity, passed down once from `Calls.tsx` rather than
refetched. Row label switched from generic "Video call"/"Voice call" to
the partner's name (call type moved into the secondary line), matching
"person" as the named hierarchy element. Empty state rebuilt from a
single gray sentence into a quiet icon + two-line message — still
genuinely minimal (no illustration/card), matching the rest of the
page's restraint.

### Call state-transition continuity (section 23)
Investigated fully. The Incoming→Connecting→Connected→Ending→Outcome
states are implemented as separate `if`/early-`return` branches in
`Calls.tsx` (outcome screen, error screen, in-call screen, hub/history
screen) — a real architectural finding, not touched: restructuring this
into a single JSX tree under one `AnimatePresence` (needed for an actual
cross-fade FLIP between an exiting branch and an entering one) would
touch the ~500-line live in-call block (video refs, WebRTC state, PiP)
that a prior session explicitly flagged as too regression-risky to
touch without real build verification — same caution applied here.
Scoped, safe improvement made instead: standardized the entrance
transition on all four branch roots (`CallOutcomeScreen`,
`CallErrorScreen`, the in-call screen, the hub/history screen) to the
same 220ms/EASE_SMOOTH-with-a-6px-rise tuple, replacing four
independently-defaulted bare opacity fades (each silently 300ms via
Framer's default). Every state change in the call flow now transitions
with the same quick, consistent motion — the "one coherent product"
read the spec asks for — even though the transition BETWEEN branches is
still a hard swap rather than a true crossfade. Flagged honestly as
still open, not solved.

### Verified
- Bracket-balance sweep on all 8 touched files this round: clean
  (Chat.tsx's pre-existing +1 paren is the same known comment-string
  artifact from prior sessions, unrelated to this pass).
- No CallContext/native-calling/E2E/Supabase logic touched.
- Still no build possible in this sandbox — static read + bracket
  balance only, per every prior session on this project.

### Still open
- True continuous cross-fade between call-flow branches (see section 23
  above) — deliberately not attempted this session, flagged as the
  reason why in detail above.
- Voice message player visual pass (14), keyboard-transition polish
  beyond what exists (16), full accessibility pass (26).

---

## Session 3 — micro-detailing pass (chat + calls only)

Scope: a targeted consistency/polish pass across Chat and Calls only, per
request — not a new section of the 30-item brief, but a sweep for places
where earlier redesign work hadn't fully propagated. Found real,
low-risk (GREEN) inconsistencies rather than inventing decorative
changes; each one below is something a previous session's own comments
already establish as the intended pattern elsewhere in the app.

### `TypingIndicator.tsx` — stale bubble treatment
Real find: still used `bg-card` + `shadow-sm` + `border border-border`,
exactly the "bordered card" bubble style `MessageBubble.tsx`'s own
in-source comment says Phase 2 deliberately moved away from for every
other bubble ("don't put every message in a card," "don't add shadows to
every message"). This one bubble got missed in that pass. Switched to
the same `bg-[hsl(var(--surface-2))]` partner-tone surface, no
shadow/border, matching corner radius convention (`rounded-2xl
rounded-bl-md`).

### `VoiceMessagePlayer.tsx` — CSS-only press feedback
The play/pause button was still a plain `active:scale-95` CSS button —
every other primary control in Chat (dock tabs, composer send, grid menu
items, reactions) had already converged on the shared `quickSpring`
Framer whileTap from earlier sessions' motion-language work. Converted
to `motion.button` + `whileTap={{scale:0.94}}` + `quickSpring`, and added
a `DUR_FAST` (140ms) crossfade between the Play/Pause glyphs instead of
an instant swap — reuses the existing icon-swap timing token, no new
value introduced.

### `MessageStatus.tsx` — read-receipt tick swap
Single-tick → double-tick on read was an instant, unanimated prop swap.
Added a small `DUR_FAST` opacity/scale crossfade (`AnimatePresence
mode="wait"`) so "read" reads as a deliberate confirmation instead of a
silent flip — same reasoning/token as the voice player fix above. Purely
opacity/scale, so it inherits `App.tsx`'s global `MotionConfig
reducedMotion="user"` for free like every other Framer animation in the
app; no new reduced-motion handling needed.

### `CallOutcomeScreen.tsx` / `CallErrorScreen.tsx` — no press feedback at all
Real gap, not just a style mismatch: all five buttons across these two
screens (close, call-again, back, try-again, back-to-calls) were plain
`<button>`s with zero visual press response — the haptic fired but
nothing on screen acknowledged the tap before the action ran. Every
other terminal/action screen in the app already uses the shared
`quickSpring` whileTap. Brought both screens in line: `whileTap={{scale:
0.94}}` on the small icon-only close button, `{{scale: 0.96}}` on the
larger pill CTAs (matches the existing scale-by-size convention seen in
GridMenu/dock).

### Verified
- Bracket-balance sweep on all 5 touched files: clean.
- No `CallContext`/native-calling/E2E/Supabase/haptics logic touched —
  every change is presentation-only (JSX/className/motion props), no
  callback signatures or state shape changed.
- Still no build possible in this sandbox (no network/Node) — same
  static-read-only verification method as every prior session on this
  project. Real-device/browser check still recommended before shipping,
  particularly the two `AnimatePresence mode="wait"` additions
  (`MessageStatus`, `VoiceMessagePlayer`'s icon swap) since they're new
  exit/enter timing this codebase hasn't used in exactly this shape
  before.

### Still open (unchanged from Session 2)
- True continuous cross-fade between call-flow branches.
- Keyboard-transition polish beyond what exists (16), full accessibility
  pass (26).
