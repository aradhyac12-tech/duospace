# What changed

## 1. Vanish mode / disappearing messages → "unable to send message"
**File:** `supabase/migrations/20260804120000_fix_messages_disappear_at_type.sql` (new)

`messages.disappear_at` was created as `timestamptz`, but `Chat.tsx` inserts
the literal string `"pending"` into it for outgoing disappearing messages
(it only gets a real timestamp once read). Postgres rejects that for a
timestamp column, so every send failed at the database whenever vanish
mode was on. The migration converts the column to `text` and fixes the
cleanup functions/index that compared it against `now()`.

**Action required:** run this migration against your Supabase project
(`supabase db push`, or paste it into the SQL editor). Nothing in the app
code needed to change — it was already writing the right values.

## 2. Themes not applying
**File:** `src/contexts/ThemeContext.tsx`

`setTheme()` never cleared a previously-active *custom* theme (from Theme
Studio). The token-apply effect always re-applies "the active custom
theme" on top of whichever preset is selected, so once you'd ever used a
custom theme, picking any built-in preset afterward got silently
overwritten right back to the old custom palette. `setTheme()` now clears
the custom-theme override when you pick a built-in preset.

## 3. Gap under the chat when the dock hides
**Files:** `src/hooks/useDockVisibility.ts` (new), `src/components/FloatingDock.tsx`,
`src/components/AppLayout.tsx`

`AppLayout` reserved a constant 84px of bottom padding for the floating
dock regardless of whether it was actually on screen. The dock's
show/hide-on-scroll state is now a shared hook so the layout's reserved
padding animates down in sync with the dock's own hide animation instead
of leaving a static gap.

## 4. Peek Guard false alarms + feedback having no effect
**Files:** `src/hooks/usePeekDetection.ts`, `src/lib/peekEventLog.ts`,
`src/components/PeekGuard.tsx`, `src/contexts/ThemeContext.tsx`

- Default consistency window bumped from 2 → 3 frames, so a single noisy
  frame (motion blur, lighting flicker, half-turned head) can no longer
  arm a lock on its own.
- Rating a lock "False alarm" used to only log a stat for the Security
  Dashboard — it had zero effect on the detector. It now feeds a small,
  capped, always-loosening adjustment into the live match threshold, so
  repeated false-alarm feedback measurably reduces future false locks
  within the same session (not just after 3+ ratings and never above your
  own configured threshold).

## 5. Dock — premium glassmorphism
**File:** `src/index.css` (`.glass-dock` and new `--glass-dock-bg` /
`--glass-dock-sheen` tokens)

The dock already had a glass recipe, but it read as a flat, semi-opaque
pill rather than actual glass. Changes:
- New dock-only background tokens, more transparent than the shared
  `--glass-bg` used by dialogs/cards (0.38/0.34 alpha vs 0.66/0.6), so the
  chat behind it visibly shows through.
- Blur/saturation pushed up (`blur(40px) saturate(2.2) brightness(1.08)`,
  from `blur(32px) saturate(1.9)`) for a stronger "refraction" look.
- Added a soft top-left radial sheen and a thin bright specular hairline
  along the top edge — the detail that reads as glass rather than frosted
  plastic.
- Added `isolation: isolate; transform: translateZ(0);` — forces the dock
  onto its own compositor layer. Without this, `backdrop-filter` on an
  element nested inside an animated/transformed ancestor (the dock sits
  inside a framer-motion `motion.nav` that animates `transform` for the
  hide/show slide) can render flat/opaque instead of blurring in some
  WebKit builds, which is the most likely reason it wasn't looking glassy
  before.
- Added an `@supports` fallback to a more opaque fill for the rare browser
  with no `backdrop-filter` support at all, so it never looks broken.

Only the dock changed — every other glass surface (dialogs, cards) keeps
its existing look untouched.

## 6. Themes not tracking time / dark-light mode (root cause, deeper fix)
**Files:** `src/lib/customThemes.ts`, `src/contexts/ThemeContext.tsx`, `src/components/ThemeStudio.tsx`

Beyond the preset-switching bug from before, there was a second, deeper bug
in the same area: `applyCustomTheme()` decided light-vs-dark by reading the
raw `duo-color-mode` localStorage key directly — but that key is *only*
ever written by an explicit manual light/dark toggle. "Auto" (follow
system), "Schedule" (time window), and "Dynamic" (continuous day/night
blend) never touched it. So the moment you'd ever applied a custom theme,
it froze on whatever mode was last manually set (or defaulted to dark) and
completely stopped reacting to time of day or system preference — while
built-in presets kept working correctly, which is exactly the
"dark/light and time-based switching aren't working" pattern.

Fixed by having `applyCustomTheme()` / `restoreActiveCustomTheme()` accept
the already-correctly-resolved `colorMode` as a parameter instead of
re-deriving it from a stale key, and passing it through from
`ThemeContext`'s apply effect (which already recomputes it correctly for
every mode, including the 60s ticker driving Schedule/Dynamic) and from
Theme Studio's live preview.

## 7. Themes section — more presets + Wine Red + more wallpapers
**Files:** `src/contexts/ThemeContext.tsx`, `src/lib/wallpapers.ts`

- Added 10 new color presets (was 18, now 28): **Wine Red** 🍷 (the one
  specifically requested — a deep burgundy, dark by default), plus Sunset,
  Emerald, Sapphire, Indigo, Gold, Cherry, Olive, Steel, and Sand. Each
  goes through the same `deriveTokens()` pipeline as the existing presets,
  so every one gets a complete, contrast-checked light *and* dark palette
  automatically — nothing hand-tuned per token.
- A `"wine-red"` value from any old save now correctly resolves to the new
  native Wine Red theme (it used to fall back to Rose).
- Added 6 new wallpapers (was 20, now 26): Velvet Wine (pairs with the new
  Wine Red theme), Marble, Champagne, Emerald Isle, Starlight, and Cloud
  Nine — each with its own light/dark pair, same as the existing set.
- Both lists feed the existing Settings UI directly (theme grid, wallpaper
  picker grouped by category) — no UI changes needed, everything new just
  shows up.

## 8. Chat scroll loading — cold start now jumps instantly instead of visibly scrolling
**File:** `src/pages/Chat.tsx`

The auto-scroll-to-bottom effect always used `scrollIntoView({ behavior:
"smooth" })`, including on the very first load of a conversation — so
every time you opened a chat, the whole message list visibly flew past
from top to bottom before settling. Two changes:

- **Cold start is now instant, not animated.** A new `didInitialScrollRef`
  (reset whenever you switch conversations) tracks whether the first
  jump-to-bottom for the current conversation has happened yet. That first
  jump now runs in a `useLayoutEffect` — synchronously after the DOM
  updates but before the browser paints — using `behavior: "auto"`, so the
  very first frame you see already has the last message in view. You never
  see it travel. Any *later* new message (someone actually sends one while
  you're looking at the chat) still gets the smooth slide-in as before —
  only the cold-start jump changed.
- **"Load older messages" no longer yanks the viewport.** This was a
  related, separately-broken case: tapping it prepended older messages
  above what you were reading with no scroll-position compensation, so the
  page visibly jumped. It now snapshots the scroll position right before
  fetching and restores it (adjusted for the newly-added content's height)
  once the older messages land — so paging back through history stays
  anchored exactly where you were, loading in the background with no
  visible jump, matching how the initial load now behaves too.

## 9. Music search
Reviewed `supabase/functions/music-search/index.ts`, `Playlist.tsx`, and
`Groic.tsx` closely — the search/fallback/timeout logic already looks
correct and well-hardened (YouTube → Piped mirrors in parallel → static
fallback, all with per-attempt timeouts). I could not find an additional
code-level bug via static review, and couldn't deploy/test live in this
environment. Most likely causes on your end:
- the `music-search` edge function isn't deployed to your Supabase project
  (`supabase functions deploy music-search`)
- `YOUTUBE_API_KEY` secret is missing (should still fall through to Piped/
  fallback, but worth checking function logs)
- `ALLOWED_ORIGIN` in the function's env doesn't match your deployed app's
  origin, which would fail every call via CORS

Check the Supabase Edge Function logs for `music-search` — the actual
error there will tell you which of these it is.

## Verification pass

I don't have network access in this environment (npm registry is blocked,
confirmed via a failed `npm install` — 403), so I can't run a live build,
dev server, or the Supabase project itself. Everything below was
verified statically instead, and one real issue turned up and got fixed
during this pass:

- **Every changed `.ts`/`.tsx` file individually type-checked** with
  `tsc --noEmit` (relaxed to ignore only the errors that are pure
  artifacts of checking a file in isolation without `node_modules` — e.g.
  "cannot find module 'react'"). No genuine syntax errors in any change
  across the whole session.
- **All 28 color presets cross-checked programmatically** — the
  `ThemeColor` union, `THEME_IDENTITIES`, `THEME_DEFAULT_MODE`, and the
  `THEMES` display array all have exactly the same 28 ids, no typos, no
  duplicates, nothing missing.
- **New theme hues checked against `deriveTokens`'s contrast handling** —
  dark-mode primary lightness is always clamped to [45,68] regardless of
  a preset's raw value, and light-mode backgrounds sit at l:96 vs. the
  new presets' primaries (34–65), so nothing is at risk of washing out.
  Wine Red's intentionally low l:34 is exactly what dark clamping exists
  for.
- **26 wallpapers checked for id collisions and balanced
  parens/backticks/quotes** in their gradient strings — all clean.
- **The disappear_at migration was tightened**: the initial version cast
  existing timestamptz rows to text with Postgres's default format
  ("2026-08-04 12:00:00+00"), which isn't reliably parseable by
  `new Date()` in every JS engine. Now converts to real ISO 8601 first
  (`to_char(... AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`), so
  any pre-existing scheduled disappearing message still resolves
  correctly after the migration runs, not just newly-sent ones. Also
  confirmed no other RLS policy or function in the schema touches
  disappear_at beyond the two sweep functions the migration already
  redefines.
- **Found and fixed a real race condition while verifying the scroll fix**:
  the "load older messages" position-restore and the cold-start
  scroll-to-bottom were two separate effects, told apart by an
  `isLoadingMoreRef` flag — but that flag can get reset by
  `loadMoreMessages`'s `finally` block before React ever commits the
  render it was meant to guard (nothing `await`s between the state update
  and the reset, so they land in the same batch). Merged them into one
  effect that checks a `pendingScrollRestoreRef` snapshot instead, which
  is only ever non-null while an older-messages fetch is genuinely in
  flight — deterministic regardless of when the ref gets reset, so the
  two behaviors can no longer fight over the same render.
- **Cross-checked every default that appears in more than one place** —
  `peekConsistencyFrames` (usePeekDetection's DEFAULTS, PeekGuard's
  fallback, ThemeContext's defaultSettings) all agree on 3, not a mix of
  old and new.

What I still can't verify without a live environment: actual visual
contrast/rendering of the new theme presets and glass dock on a real
device, the Supabase migration actually applying cleanly against your
specific project state, and the music search edge function's real
behavior against your deployed secrets. Recommend a quick pass through
Settings → Themes/Wallpaper and a couple of chat opens after you deploy,
since that's the one thing I have no way to substitute for.

## 10. Calls: "Duplicate DailyIframe instances are not allowed"
**Files:** `src/contexts/CallContext.tsx` (new), `src/App.tsx`, `src/pages/Chat.tsx`, `src/pages/Calls.tsx`, `src/hooks/useDailyCall.ts`

Root cause: Chat.tsx and Calls.tsx each called `useDailyCall()` independently
— two separate hook instances, each with its own lock. Daily's SDK only
allows one call object per page at a time, so a call active on one page's
instance while the other tried to create its own threw exactly this error.
The existing double-tap guard only protected against races *within* one
page, not across the two.

Fixed by creating the hook exactly once, in a new `CallProvider` mounted
at the app root, with both pages now consuming the same instance via
`useCall()`. A call now also survives navigating between Chat and Calls
instead of being torn down by whichever page unmounts. Added friendly
"Already on a call" guards for the now-reachable cross-page case.

Second, related fix in `useDailyCall.ts`: `DailyCall.destroy()` is itself
async but was called fire-and-forget everywhere, so a fresh `joinCall()`
could run before a previous `destroy()` (from leaveCall()/unmount)
actually finished — risking the same error even with a single shared
instance. `joinCall()` now genuinely awaits any in-flight destroy before
creating a new call object.

## 11. Calls: "account-missing-payment-method" shown raw
**File:** `supabase/functions/daily-call/index.ts`

The edge function already translated this into a friendly message, but
via an exact string match on Daily's error code. Since I can't hit Daily's
live API to confirm the exact response shape, made the match robust: it
now checks a normalized blob of every string field Daily might put the
code in, rather than one exact field. The friendly "add a payment method
at dashboard.daily.co/billing" message should now surface regardless of
exactly where Daily nested the code.

## 12. Calls: lag between tapping the call button and the call screen
**Files:** `supabase/functions/daily-call/index.ts`, `src/pages/Chat.tsx`, `src/pages/Calls.tsx`

Two real causes, both fixed:

- **Two sequential network round trips before joining could even start**:
  create-room, then only after that resolved, get-token — each paying its
  own network + Supabase Functions overhead. Added a combined
  `create-and-token` edge function action that does both Daily API calls
  back-to-back on the server, cutting it to one round trip. Also stopped
  blocking on the `call_history` insert before joining — it only needs to
  finish before `endCall()` runs, not before `joinCall()` starts, so its
  round trip now overlaps with the (much longer) WebRTC join instead of
  sitting in front of it.
- **The call screen didn't render until `callState === "joining"`**,
  which only happens *inside* `joinCall()` — itself called only after all
  the above finished. The button just showed a "Starting..." label with no
  other feedback for that whole stretch. Both pages now show the call
  screen (with its own "Connecting..." state) the instant the button is
  tapped, with the actual network setup happening behind it. Added a
  `callCancelledRef` guard so the now-reachable hang-up button during that
  window genuinely cancels the in-flight setup (and best-effort deletes
  the just-created room) instead of the call silently connecting anyway a
  moment later.

## 13. Icon Preset Library — verification pass (feature already existed)
**File:** `src/lib/iconPresets.ts` (colors only — everything else already correct)

This entire feature — the 49-preset gallery, search/category filters,
"Create Custom Icon" / "Upload Icon" / "Generate From App Name", the full
customization panel (symbol/letter, shape, background, accent, border,
shadow, light/dark preview), per-app config, and Android + iOS asset
export (`src/lib/iconGenerator.ts`, `IconStudio.tsx`, `whitelabelApps.ts`,
`appIconConfig.ts`) — already existed in the codebase and already matched
your spec closely. I verified it end to end rather than rebuilding it:

- **Every one of the 49 requested presets exists**, cross-checked
  programmatically by exact name against your list — nothing missing, no
  duplicate ids.
- **Asset export sizes verified against Apple/Google's actual
  specifications**: Android legacy mipmaps (48–192px across 5 densities),
  adaptive icon layers at the correct 108–432px sizes with the proper
  ~66% safe zone, the full iOS `AppIcon.appiconset` (all iPhone/iPad
  point-size × scale combinations plus the 1024 App Store icon) with a
  correct `Contents.json`, and even the Android 13+ monochrome themed-icon
  layer, which most implementations miss entirely.
- **Found and fixed a real de-branding gap**: several presets used the
  *exact*, well-documented single hex code of a real company's brand
  color rather than just an evocative similar hue — Duolingo's precise
  green (`#58CC02`), Spotify's precise green (`#1DB954`), and Google's
  four-color palette (`#4285F4` blue, `#34A853` green, `#EA4335` red) used
  across Mail/Maps/Calendar/Browser. That crosses from "inspired by a
  category" into literally reusing a specific company's registered brand
  color, which runs against what you asked for. Shifted all of these to
  generic, framework-standard palette colors (Tailwind's `blue-500`,
  `green-500`, `red-500`, etc.) that read the same way (a blue mail icon,
  a green maps icon) without matching any one company's exact documented
  hex.

Reachable today at **Settings → Open Icon Studio**.

## 14. Disappearing messages — premium animations, precise timing
**Files:** `src/components/chat/DisappearRing.tsx` (new), `src/pages/Chat.tsx`, `src/index.css`

Researched how Signal, Telegram, and Instagram handle ephemeral messages —
they all converge on the same convention: a small depleting *ring*, not
ticking text, as the countdown signal, and the vanish moment itself gets
its own distinct animation rather than reusing a generic delete. The
existing implementation had good bones (a genuinely well-built pull-to-arm
gesture, working exit-animation infrastructure) but was missing both of
those, and the actual removal ran on a blunt 5-second poll:

- **New `DisappearRing` component** — a small SVG ring next to the
  timestamp that visually depletes from full to empty exactly as the
  message counts down, driven by a single CSS `transition` (not a
  per-second re-render) for zero ongoing cost even with many disappearing
  messages on screen at once.
- **Precise per-message expiry**: replaced the 5-second batch poll with an
  individual `setTimeout` scheduled at the *exact* instant each message
  expires. Messages now vanish precisely on time instead of up to 5s late,
  and one at a time with its own animation instead of several popping
  together in a visible clump.
- **A distinct "evaporate" exit** for disappearing messages specifically —
  a slower upward dissolve with more blur — instead of reusing the sharp
  pop used for a manual delete, so the two read as different actions.
- **A "this is about to vanish" cue**: a soft glow breathes on around the
  bubble in just the last ~2.5s before it disappears, timed via a plain
  CSS `animation-delay` computed once from the message's own remaining
  time — no JS ticking involved, and it respects `prefers-reduced-motion`
  along with everything else in the app.
- Lightened the dimming on active disappearing messages (0.6 → 0.75
  opacity) — legible while still reading as "temporary" — and gave the
  persistent "Disappear after X" banner's icon a slow breathing pulse
  (reusing the app's existing `animate-pulse-soft` utility) so the active
  state reads as alive rather than static.

Left the pull-to-arm gesture (`DisappearGestureHandle.tsx`) as-is — it was
already a genuinely well-built, physics-driven interaction (haptics at the
right moments, GPU-only transforms, proper release-threshold handling)
with nothing meaningful to add.
