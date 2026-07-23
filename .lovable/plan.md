# Auth-adjacent + chat polish pass

## 1. Sync uploaded zip

- Extract `duospace-codesurprise-a11y.zip` into `/dev-server` (excluding `.git`, `node_modules`), then run `bun install`.
- Diff key files after sync so subsequent edits build on the newest sources (Chat.tsx, BottomNav.tsx, DisappearGestureHandle.tsx, PhotoViewer.tsx, Onboarding.tsx, storage.ts, storage_buckets.sql).

## 2. Photo sharing (both directions)

Symptom: photos user sends don't appear for the partner.

- Verify `chat-media` (or equivalent) Supabase Storage bucket exists and is either public-read or has RLS letting both partners read each other's objects. Fix `scripts/sql/storage_buckets.sql` to:
  - Create `chat-media` bucket if missing.
  - Add policies: sender can INSERT into own prefix; both users in a pair can SELECT any object whose owner is either partner (join on `pairs`/`profiles`).
- In `src/lib/storage.ts` / chat send path: after upload, store the resolved public URL (or signed URL) on the message row so the receiver renders it — currently the receiver likely gets a path they cannot resolve.
- Request media library permission at first attach (Capacitor `Camera`/`Filesystem` photo picker) with a clear denial toast.
- Also i have tried uploading the photos but it just shows the photo while it gets error and doesnt load properly and shows a error so solve that too

## 3. Remove menstrual-cycle step from onboarding

- In `src/pages/Onboarding.tsx`, drop the cycle question step and any related state, progress indices, and DB writes. Keep remaining steps sequenced correctly.

## 4. Vanish mode redesign (Instagram-parity)

Replace current `DisappearGestureHandle` + Chat.tsx integration:

- **Trigger**: swipe up on the entire chat scroll surface (not just a pill) OR long-press (3s) anywhere on the composer bar toggles on/off, with progress ring haptics at 1s/2s/3s.
- **Visual state**: when active, don't just dim a black overlay — swap chat theme tokens to a dedicated dark "vanish" palette (background, bubbles, input) via a `data-vanish="on"` attribute on the chat root + CSS variable overrides in `index.css`. Smooth 300ms crossfade.
- **Timer UI**: on activation, show a bottom-sheet **radial half-circle picker** (SVG arc) letting user drag from 1 min → 24 h with snap stops (1m, 5m, 15m, 1h, 8h, 24h) plus a "Custom…" numeric input. Selected duration persists per-pair.
- **Motion**: swipe-up uses spring-follow on the scroller with rubber-band; long-press uses animated conic-gradient ring around composer send button.

## 5. Composer rebuild

Symptom: rectangular box appears next to textarea while typing; composer sometimes drops below viewport.

- Rewrite composer container in `src/pages/Chat.tsx`:
  - Single flex row: `[attach] [autosize textarea] [send]` inside a rounded pill with `bg-card/70 backdrop-blur`.
  - Autosize textarea (min 1 row, max 6) using `field-sizing: content` fallback + JS height sync; no sibling ghost div.
  - Anchor composer with `position: sticky; bottom: env(safe-area-inset-bottom)` inside a flex column so it never falls below the viewport when the keyboard opens; use `visualViewport` listener to offset for iOS keyboard.
  - Remove any absolute/fixed positioning conflict with `BottomNav` (hide bottom nav on `/chat` when composer focused).

## 6. Chat screen sizing

- Tighten `max-w`, side padding, and message bubble `max-w` so bubbles use ~78% of viewport width on phones.
- Increase scroll area height by making the header condense on scroll (already partially present) and giving the message list `flex-1 min-h-0` inside a proper column layout.
- Ensure safe-area padding on top/bottom is applied once (not doubled by header + nav).

## 7. BottomNav — Apple/Instagram glass

- Replace current `bg-card/80 backdrop-blur-xl border-t` with a floating pill:
  - Detached from screen edges (`mx-4 mb-4 rounded-full`), `bg-background/40 backdrop-blur-2xl saturate-150`, subtle inner highlight (`shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]`), soft outer shadow.
  - Active tab: filled circle pill with spring layoutId (keep existing).
  - Respect safe-area; hide on `/chat` when composer is focused (see §5).
- Add matching translucency to top header on chat.

**8. the calls have the error of object object so consider solving it as well**

## Technical notes

- New file: `src/components/chat/VanishTimerSheet.tsx` (radial picker).
- New CSS tokens in `src/index.css`: `--vanish-bg`, `--vanish-bubble-me`, `--vanish-bubble-them`, applied under `[data-vanish="on"]`.
- Storage policies live in a new migration under `scripts/sql/` and must be run in Supabase SQL editor (this project is BYO Supabase).
- No changes to auth, calls, or unrelated features.

## Out of scope

- Any auth/session changes.
- Redesigning message rows, reactions, or call UI.
- Server-side push notifications for photo messages.

## Verification

- Typecheck + build.
- Playwright: open `/chat`, focus composer, confirm no ghost box, textarea grows, BottomNav is floating glass and hides on focus.
- Manual (user): send photo from A → B and refresh; toggle vanish via swipe-up and long-press; open timer sheet, pick 15 min + custom; confirm chat theme darkens (not overlay).