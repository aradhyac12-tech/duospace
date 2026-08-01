# DuoSpace — Rules & Conventions

Read this before touching code. Most of these exist because something broke
once and got fixed — treat them as load-bearing, not stylistic preference.

## Never do these

- **Never store E2E encryption keys in localStorage as extractable JWK.**
  They live in IndexedDB with `extractable: false`. This was a real
  vulnerability that got fixed — don't reintroduce it.
- **Never call `getPublicUrl()` on `gallery`/`chat-files`/`memories`
  buckets.** They are private buckets by design. Use
  `resolveSignedUrl`/`resolveSignedUrls` from `lib/signedStorageUrl.ts`.
  Calling `getPublicUrl()` here silently produces a URL that 403s — it
  looks like it works until someone actually loads the image.
- **Never call `supabase.functions.invoke` directly for new code.** Use
  `invokeEdgeFunction()` from `lib/edgeFunction.ts` — it gives real error
  messages, a timeout, and safe transport-only retry. Raw
  `functions.invoke` calls produce the unhelpful generic "Failed to send a
  request to the Edge Function" on any failure.
- **Never do `String(err)` on a catch-block error without checking shape
  first.** Daily.co (and possibly other SDKs) reject with a plain
  `{errorMsg: string}` object, not an `Error` — `String()` on that
  literally renders "[object Object]" to the user. Use
  `extractErrorMessage()` from `lib/errorMessage.ts`.
- **Never assume more than two people can see a row.** Every table's RLS
  is scoped to "you or your linked partner." If a feature needs a third
  party to see data, that's a product conversation, not a quick RLS
  tweak.
- **Never touch `20260721111940_drop_orphaned_gdrive_backup.sql`'s target
  columns/tables as if they still exist** — Google Drive backup was
  removed as dead/broken-on-native code. If backup/export work is needed,
  extend `BackupManager.tsx`'s existing local-export flow instead of
  reviving Google Drive.

## Design system rules

- **No hardcoded Tailwind color swatches** (`bg-green-500`, `text-red-400`,
  etc.) in app code. Use the semantic tokens: `success` / `warning` /
  `info` / `destructive`, or the single `accent`/`primary` for brand/active
  state. See `design.md` for the full token list. (Exception: content that
  is itself inherently multi-colored, like `MoodDetector.tsx`'s 7 distinct
  mood-emoji colors — that's semantic content, not chrome, and collapsing
  it to 4 status tokens would lose meaning. If you're tempted to add
  another such exception, ask whether it's really content or just chrome
  you didn't want to theme properly.)
- **`bg-accent`/`bg-primary` are solid, bold fills now** (not a soft
  neutral tint like some earlier code assumed). Any icon or text sitting
  on top of a *solid* `bg-accent`/`bg-primary` must use
  `text-accent-foreground`/`text-primary-foreground` explicitly — don't
  rely on inherited `text-foreground`, it will have wrong contrast in one
  theme or the other. (Opacity-modified accents like `bg-accent/50` are
  fine with `text-foreground` — the math has been checked in both themes
  for that case.)
- **Touch targets on high-frequency actions should be ~40px minimum.**
  Back buttons, primary confirm/delete actions, anything pressed daily.
  It's fine to keep secondary/tertiary controls smaller in genuinely
  tight rows (composer bar, transport controls) — don't force a resize
  that breaks a layout you can't visually verify; a modest safe bump
  (e.g. 28→32px) beats a broken row.
- **Every new interactive element needs a haptic**, matched by weight to
  what it means (see `design.md`'s mapping table). This is a design
  requirement now, not a nice-to-have — check `haptics.ts` for the
  right `hapticX()` before wiring a bare `onClick`.
- **Respect `prefers-reduced-motion`.** It's already handled globally via
  `<MotionConfig reducedMotion="user">` in `App.tsx` — don't add animation
  libraries or raw CSS animations that bypass this wrapper.

## Working conventions

- **Route-level loading states go through `PageSkeleton`**, wired
  centrally in `App.tsx`'s `Suspense` fallback per route (with a
  `variant` matching the page type: chat/grid/list/map/settings) — don't
  add a bespoke loading spinner per page.
- **Shared header → use `PageHeader.tsx`**, don't hand-roll another back
  button. If a page can't use it for a real layout reason, at least match
  its back-button treatment (40px, `bg-accent/15` + `text-accent`) for
  consistency.
- **One file per subject in project memory / docs.** If you're an AI
  assistant picking this project back up, check `docs/memory.md` first —
  it's the condensed history of what's been fixed and why, so you don't
  re-discover (or re-break) something already handled.
- **This is a Vite+Capacitor project with no test-driven build loop
  available in some environments** (e.g. a sandboxed AI coding session
  may have no network/node_modules). When that's the case, say so
  explicitly rather than claiming a change was verified — the human needs
  to know to run `npm install && npm run build` themselves before
  trusting a change.
- **Every session that changes code updates the docs in the same turn —
  never as a deferred cleanup pass.** Concretely:
  - `docs/memory.md` gets a new dated entry (`YYYY-MM-DD`) under the
    relevant feature section: what changed, why, and anything a future
    session would otherwise waste time re-discovering.
  - `docs/phases.md` gets the relevant phase's checklist updated in
    place — items just finished move from planned → done, and the
    phase's "planned next" list is rewritten to reflect what's actually
    still outstanding, not what it said last session.
  - `docs/architecture.md` gets updated if the change adds/removes a
    file, a data flow, or a subsystem worth knowing about (new lib file,
    new worker, new edge function, changed pipeline) — not for a pure
    bugfix with no structural change.
  - `docs/design.md` gets updated only if the change touches tokens,
    motion, or visual conventions.
  - `docs/rules.md` gets a new rule only when something broke *because*
    a convention wasn't written down — don't pad it with restatements of
    what the code already makes obvious.
  Skipping this because the code change felt small is exactly how this
  file and `memory.md` go stale — treat the doc update as part of the
  change, not an optional extra.

## When in doubt

Prefer the smallest correct change over a rewrite. This codebase has been
through many hardening passes (security audit score went 38→94 over
several rounds) — code that looks unusual (e.g. inlined `_shared` helpers
in deployed edge functions, or a specific opacity value on a token) is
often that way for a reason logged in `docs/memory.md`, not an oversight.
