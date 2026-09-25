# DuoSpace — Design System

Visual direction: **bold single-accent on deep charcoal** — closer to
Nothing OS / Linear than to a typical messaging app. Premium through
restraint, not through decoration. Everything below lives as CSS custom
properties in `src/index.css` and Tailwind config in `tailwind.config.ts` —
never hardcode a color, radius, or motion value in a component; reference
the token.

## Color tokens

| Token | Role |
|---|---|
| `background` / `foreground` | Page base. Dark mode is deep charcoal (`230 10% 8%`), **never pure black**. Light mode is soft off-white (`230 20% 97%`), never stark white. |
| `card` / `card-foreground` | Elevated surfaces (cards, sheets). |
| `primary` / `accent` (same value) | The **one** bold brand color — violet, `255 90-92%` lightness-adjusted per theme. Used for every CTA, every "this is active/selected" signal, and nowhere else. If you're reaching for it a third time on one screen for three different meanings, that's a sign something should be neutral instead. |
| `primary-foreground` / `accent-foreground` | Text/icon color for content sitting on a **solid** `primary`/`accent` fill. Always use this explicitly there — see `rules.md`'s contrast note. |
| `success` / `warning` / `info` / `destructive` (+ `-foreground` pairs) | Status semantics, deliberately muted, never garish saturated Tailwind swatches. `success` = muted green, `warning` = warm amber, `info` = soft blue, `destructive` = muted red. |
| `muted` / `muted-foreground` | De-emphasized text/surfaces. |
| `border` / `input` / `ring` | Standard shadcn structural tokens. |

**Rule of thumb:** if two different UI elements on the same screen are both
solid `bg-accent`, ask whether they're really both "the one accent-worthy
thing" or whether one of them should be neutral. The brief this system
follows is "single elegant accent," not "accent as default button color."

## Typography

Default pairing: **Space Grotesk** (headings) + **Inter** (body) — a tight
geometric grotesk pairing in the Linear/Nothing OS register. Plus
**JetBrains Mono** (`--font-mono`) as a fixed utility face for
timestamps/durations/data — not user-swappable.

The heading/body pair *is* user-swappable via Theme Studio
(`lib/fontLoader.ts` → `FONT_PRESETS`) — there are ~10 presets spanning
serif/sans. Space Grotesk · Inter is `FONT_PRESETS[0]`, the default; all
prior presets are preserved as options, this only changed which one is
first.

Scale: use Tailwind's default type scale (`text-xs` through `text-3xl`+)
consistently — this project does not define a bespoke display/title/body
naming scheme beyond what Tailwind already provides; don't invent one-off
font sizes in a `style` prop.

## Spacing & radius

- Base radius token `--radius: 0.75rem` (tighter than the previous
  `1rem` — part of the Nothing OS/Linear direction). Component-level
  overrides (e.g. chat bubbles' `rounded-2xl`/`rounded-br-md` tail
  shaping) are intentional and independent of the base token.
- Spacing: Tailwind's default scale (4px increments). No custom spacing
  scale was introduced — the existing scale was already sufficient.

## Elevation / shadow

`--shadow-soft`, `--shadow-glass`, `--shadow-pop` (+ matching
`--glass-bg`/`--glass-border`/`--glass-highlight`) — three tiers, values
differ between light/dark (dark mode leans on a faint light inset edge
rather than shadow-only, since a shadow barely reads against charcoal).

**Surface hierarchy (Phase 2, primary system going forward):** `--surface-0`
through `--surface-3` (+ `.surface-0/1/2/3` utilities) are the *default*
way to express elevation now — flat, token-driven background steps, no
blur/saturation stack. `.glass-*` utilities still exist for the couple of
pre-existing feature surfaces (Calls, Profile) that already used them, but
new app-shell work should reach for `.surface-*` first per the "no
excessive glassmorphism" direction. `FloatingDock` was moved off
`.glass-dock` onto a new `.surface-dock` (solid `--surface-3` + hairline
border + `--shadow-pop`) in this pass. The old shadow-only
`.surface-1/2/3` utilities (unused anywhere in the codebase) were renamed
to `.elevation-1/2/3` to free up the naming for this hierarchy.

**Background hierarchy:** `--bg-canvas` / `--bg-subcanvas` for page-level
backdrops, and `--bg-overlay-scrim` (a tinted charcoal, not `black/80`) for
every dialog/sheet/drawer/alert-dialog overlay — all four now share this
one token instead of three of them hardcoding `bg-black/80` independently.

## Layout tokens

`--touch-target-min` (44px), `--dock-height`, `--dock-gap`,
`--dock-reserve` (= height + gap + 14px breathing room), `--page-header-height`.
Introduced so the dock-visibility ↔ content-padding coupling in
`AppLayout.tsx` (a documented RED item — see the redesign audit) reads as
intentional constants instead of repeated magic numbers (`84px`, `14px`)
in two files. **The coupling logic itself was not touched** — only the
literals were replaced with `var(--dock-reserve)` / `var(--dock-gap)`,
same computed values.

## Input & status tokens

`--input-hover`, `--input-invalid` (mirrors `--destructive`) for
Input/Textarea hover and `aria-invalid` states. `--offline` (mirrors
`--warning`, deliberately *not* `--destructive`) — connectivity loss is
transient/recoverable, not an error the user caused, so `OfflineBanner`
no longer borrows the destructive channel for it.

## Motion

- `--ease-spring`, `--ease-smooth`, `--ease-snap` cubic-beziers; `--dur-fast`
  (140ms) / `--dur-med` (220ms) / `--dur-slow` (380ms).
- **Global reduced-motion support:** `<MotionConfig reducedMotion="user">`
  wraps the app in `App.tsx` — every Framer Motion `motion.*` component
  automatically respects the OS accessibility setting. Don't bypass this
  with raw CSS animations for anything that should respect it.

## Haptics — the felt layer

Engine lives in `src/lib/haptics.ts`: layered (native Capacitor Haptics →
web `navigator.vibrate` → silent no-op), spanning sub-8ms micro-ticks to
sustained multi-pulse ramps. **Every interactive element should fire one**,
weighted to what the action means:

| Weight | Function(s) | Use for |
|---|---|---|
| Mildest | `hapticTick`, `hapticSelection` | Pure navigation, list/tab selection, search result paging, PIN digit entry, seeking a waveform |
| Light | `hapticLight`, `hapticSoft` | Routine taps: open a dialog, reply, view a photo, dismiss, back-navigate |
| Medium | `hapticMedium`, `hapticSwipe`, `hapticToggleOn/Off` | Confirmations and toggles: start a call, mute/unmute, share, download, accept an invite, submit a form |
| Max | `hapticHeavy`, `hapticRigid`, `hapticLongPress` | High-commitment/destructive: end a call, restore a backup, hold-to-record |
| Outcome | `hapticSuccess`, `hapticWarning`, `hapticError` | Result of an action: opening a destructive-confirm dialog (`warning`), a delete that just happened (`error`), copying a secret successfully (`success`) |
| Special-purpose | `hapticSend`, `hapticReceive`/`hapticDouble`, `hapticCameraShutter`, `startCallVibration`/`stopCallVibration` | Message send/receive, camera shutter, incoming-call ring pattern |

`fireHaptic(kind)` / `withHaptic(kind, fn)` exist for binding a haptic to
any handler generically, but most call sites just call the specific
`hapticX()` inline at the top of the `onClick` arrow function — that's the
established pattern, keep using it:

```tsx
<button onClick={() => { hapticMedium(); doTheThing(); }}>
```

**Coverage status:** as of this doc, 231 of 300 `onClick` handlers app-wide
fire a haptic (up from 113 at the start of this pass). Fully wired:
Chat, Gallery, Calls, BackupManager, PhotoViewer, MemoryWall, AppLockScreen
(including the PIN keypad and biometric unlock — highest-frequency
targets in the app), LoveLetter, LipReadingOverlay, Onboarding, Auth,
CameraWithFilters (including a proper `hapticCameraShutter` on capture).
Still gapped (lower-traffic dialogs/editors): parts of Settings,
CodeSurpriseEditor, Us, Shayari, MapView, ThemeStudio, Groic,
GroicFullPlayer, FaceEnrollmentDialog, MoodDetector, GridMenu's remaining
items. Same weighting convention applies — check `hapticX` availability in
`lib/haptics.ts` before inventing a new one.

## Accessibility

- `prefers-reduced-motion` — handled globally (see Motion above).
- Touch targets — 40px minimum on high-frequency actions (see
  `rules.md`); smaller only where a row is provably tight.
- Contrast — every solid `bg-accent`/`bg-primary` fill must pair with the
  matching `-foreground` token, not an inherited/default text color (see
  `rules.md`).
- WCAG AA+ was a stated goal from the original design brief for this
  pass; large touch targets, TalkBack/VoiceOver support via existing
  `aria-label`s, and dynamic text sizing are the concrete asks —
  ongoing, not a one-time checkbox.
