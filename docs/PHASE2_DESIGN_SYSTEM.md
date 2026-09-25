# Phase 2 — Design System + Application Shell

Scope: token system + shared `components/ui/*` + app shell only (`AppLayout`,
`FloatingDock`, `PageHeader`, dialogs/sheets, toasts, offline/error/loading
states). Per the audit's Redesign Safety Map, nothing RED was touched —
Chat/Calls/Gallery/Map/Music/Settings internals are untouched, as directed.

## Token system (`src/index.css`, `tailwind.config.ts`)

- **Surface hierarchy** — new `--surface-0..3` + `.surface-0/1/2/3`
  utilities, the primary elevation system going forward. Flat, restrained
  background steps, no blur/saturation stacking — this is the concrete
  answer to "no excessive glassmorphism" in the brief.
- **Background hierarchy** — `--bg-canvas` / `--bg-subcanvas` for page
  backdrops, `--bg-overlay-scrim` for every modal/sheet/drawer overlay.
- **Layout tokens** — `--touch-target-min` (44px), `--dock-height`,
  `--dock-gap`, `--dock-reserve`, `--page-header-height`.
- **Input/status tokens** — `--input-hover`, `--input-invalid`, `--offline`
  (mapped to `--warning`, not `--destructive`).
- Renamed an unused shadow-only `.surface-1/2/3` to `.elevation-1/2/3`
  (grep-confirmed zero usages before the rename — non-breaking) to free
  the name for the new background-hierarchy utilities.
- Wired `surface`/`offline` colors and touch-target spacing into
  `tailwind.config.ts`.

Categories 1–12, 22, 25 (background/surface/typography/spacing/radius/
borders/shadows/accent/status/destructive/input-states, safe-area,
haptics) were already substantially token-driven from the prior redesign
pass (see the rest of `docs/design.md`) — this pass filled the specific
gaps (surface hierarchy, offline/input states, layout constants) rather
than rebuilding what already worked.

## Shared component audit (`src/components/ui/*`)

| Component | Fix |
|---|---|
| `Button` | `default`/`icon` sizes 40px → 44px (below the mobile minimum). |
| `Input` / `Textarea` | 40px → 44px height; added hover + `aria-invalid` states via tokens. |
| `Dialog` | Overlay: hardcoded `bg-black/80` → `--bg-overlay-scrim` token. Content: `bg-background` → `bg-card` (real elevated surface, not same-tone-as-page). Added `max-h-[90dvh] overflow-y-auto` so tall content + open keyboard can't push primary actions off-screen. Close button enlarged to a real touch target. |
| `Sheet` | Same overlay/surface fixes as Dialog. Added safe-area classes per side + `max-h`/`overflow-y-auto` on top/bottom sheets specifically (the keyboard-avoidance risk case). Close button enlarged. |
| `AlertDialog` | Same overlay/surface/max-height fixes as Dialog (was still on the old `bg-black/80` + `bg-background` pattern after Dialog/Sheet were fixed — this closes that inconsistency). |
| `Drawer` (unused in the app today, kept for parity) | Same overlay/surface fix + safe-area bottom padding. |
| `DropdownMenu` | Items bumped to a touch-friendly height; `rounded-sm`/`rounded-md` mixing unified to `rounded-md`; separator fixed from `bg-muted` (a fill token) to `bg-border` (the actual divider token). |
| `Tabs` | List/trigger heights bumped for touch. |
| `Toast` | Default variant `bg-background` → `bg-card`, matching the new surface hierarchy used by Dialog/Sheet. |
| `Avatar`, `Card`, `Tooltip`, `Progress`, `Skeleton` | Reviewed — already token-clean, no changes needed. |

**Real duplicate-system bug found and fixed:** `App.tsx` mounted both
shadcn's `<Toaster/>` (backing `useToast()`, used at every call site in the
app) *and* Sonner's `<Toaster/>` — but `toast()` from the `"sonner"`
package itself is never imported anywhere in `src/`. That meant two
overlapping toast viewports were live at once for no reason. Removed the
Sonner mount; left `components/ui/sonner.tsx` in the tree in case a future
feature wants Sonner's own stacked/promise toast API specifically.

## App shell

- **`FloatingDock`** — moved off `.glass-dock` onto the new `.surface-dock`
  (solid `--surface-3`, hairline border, `--shadow-pop` — no blur/
  saturate/brightness stack). Its own bottom offset now reads
  `var(--dock-gap)` instead of a hardcoded `14px`. Tab buttons were already
  44px — untouched. `aria-label`/`aria-current`, the `onPointerDown` route
  preload, and `SWIPE_NAV_ORDER` wiring in `AppLayout` are all untouched.
- **`AppLayout`** — the dock-visibility ↔ content-padding coupling (a
  documented RED item — changing dock height without updating this calc
  reintroduces a previously-fixed "gap" bug) now reads
  `var(--dock-reserve)` / `var(--dock-gap)` instead of the literals `84px`
  / `14px` it computed to before. **Same values, same logic** — only the
  numbers got names. Nothing about *when* the padding changes was touched.
- **`PageHeader`** — back button 40px → 44px, `aria-label="Back"` added.
- **`OfflineBanner`** — `bg-destructive` → `bg-offline`/`text-offline-foreground`
  (see token rationale above). Added `role="status"`.
- **`ErrorCard`** — `INFO`/`WARNING` severities were hardcoded to Tailwind's
  `sky-500`/`amber-500` swatches instead of the existing `info`/`warning`
  tokens; fixed, including the inline "device is offline" note inside the
  expanded technical-details panel.
- **`ErrorBoundary`**, **`PageSkeleton`**, **`Shimmer`** — reviewed, already
  fully token-driven. No changes.

## Verified safe

- Grep-swept `src/components/ui/*` and the touched app-shell files for
  remaining hardcoded colors (`bg-black`, `text-white`, raw hex, Tailwind
  color-scale classes like `amber-*`/`sky-*`) after the pass — the only
  hits left are inside `chart.tsx`'s Recharts CSS selectors, which target
  Recharts' own inline SVG styles (`stroke='#ccc'` etc.) and aren't
  rendered colors themselves.
- Brace/paren balance-checked every edited file (no compiler available in
  this sandbox — see the audit's Section 0 on the blocked toolchain; this
  is a partial substitute, not a real type-check).
- Preserved every RED/YELLOW item called out in the Redesign Safety Map
  that intersects this pass's scope: `MotionConfig reducedMotion="user"`
  scope untouched, dock padding *logic* untouched (values only),
  `aria-current`/route-preload/`SWIPE_NAV_ORDER` wiring untouched,
  `open`/`onOpenChange` contracts on every Dialog/Sheet/AlertDialog/Drawer
  untouched.

## Not done in this pass (flagged, not silently skipped)

- No real toolchain run — `npm install`/`tsc`/`eslint`/`vitest` are still
  blocked in this environment (unchanged from the audit's Section 0).
  Please run a real build before merging.
- Feature-page internals (Chat, Calls, Gallery, Map, Music, Settings) are
  untouched per the brief — their empty/error/loading states weren't
  touched either, since that's feature-internal work, not app-shell work.
- `docs/design.md` was updated with the new token categories; a full
  before/after screenshot pass wasn't possible in this sandbox (no
  browser/build).
