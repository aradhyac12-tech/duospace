# DuoSpace Redesign — Post-Phase-2 Correction: Nav Revert + Ringer Fixes

**Context:** direct product feedback after Phase 2 delivery. Two items,
both fixed in place (no new phase number — this corrects Phase 1/2 work
rather than covering new surface area).

## 1. Reverted: dock back to 2 tabs (Chat, Calls)

Phase 1 had promoted the shared-space hub from an in-chat-only shortcut to
a third persistent dock tab ("Duo", its own `/duo` page). Feedback: the
dock should stay strictly Chat + Calls, with every other feature living in
the Hub only — plus a reported "abnormal" extra menu-like element in the
top-left corner when opening the hub, most likely a side effect of the
Duo tab/page's active-state handling. Rather than chase the exact visual
cause, the whole experiment was reverted, which removes that code path
entirely:

- **`src/components/FloatingDock.tsx`** — back to exactly `PRIMARY = [Chat,
  Calls]`. The `"duo"` active-route matching logic (`DUO_HUB_ROUTES`) is
  gone.
- **`src/components/AppLayout.tsx`** — `SWIPE_NAV_ORDER` back to
  `["/chat", "/calls"]`.
- **`src/App.tsx`** — removed the `/duo` route, its lazy import, and its
  `routePreload` entry.
- **`src/pages/Duo.tsx`** — deleted.
- **`src/lib/duoHubItems.ts`** — kept. This was extracted in Phase 1 as a
  shared source of truth for the hub's destination list; it's still useful
  with `GridMenu.tsx` as its only consumer again (avoids the list drifting
  back out of sync with itself if it's ever touched again), so removing it
  would have been pure churn for no benefit. Its doc comment was updated
  to reflect that Duo.tsx no longer exists.
- **`src/components/chat/GridMenu.tsx`** — unchanged in behavior (it was
  already reading from `duoHubItems.ts`); only its stale comment
  referencing the now-deleted Duo page was updated.

Net effect: every shared feature (Gallery, Map, Groic/Music, Us, Shayari,
Love Letter, Schedule Send) is reachable exclusively through the in-chat
sparkle "Hub" again, identical to how it worked before Phase 1. Nothing
about GridMenu's own panel, animation, or content changed — only the
now-removed second entry point into the same content.

## 2. Map: ringer status wasn't a bug, but had a real gap

**What was reported:** battery shows on the Map's status bar, but ringer
(ring/vibrate/silent) doesn't.

**What's actually happening:** ringer status is `"unknown"` whenever the
underlying platform genuinely can't report it — this is true for every
iOS device (Apple provides no public API for reading the physical mute
switch — documented in `native-plugins/device-status/README.md`, not
something fixable from this app) and for the plain-web/browser fallback
path. Both the compact status row and the richer sheet's `PartnerStatusPill`
correctly hide the ringer half of the display in that case, on purpose —
showing a bell icon based on a guess would be actively misleading, worse
than showing nothing. This is pre-existing, documented behavior, not
something introduced in the redesign.

**What was a real gap, and is now fixed:** silent and vibrate modes were
using the *identical* icon (`BellOff`), distinguished only by an invisible
`aria-label` — so even when the ringer state genuinely was known, silent
and vibrate were visually indistinguishable. Fixed in both `MapView.tsx`'s
compact status row and its `PartnerStatusPill` (the sheet version):
vibrate now renders Lucide's `Vibrate` icon, silent keeps `BellOff`.

**Also added:** when the ringer state is explicitly `"unknown"` (not just
"no data yet" — those are different: `null` means nothing's been
published, `"unknown"` means the device explicitly reported it can't
determine the state), a faint `n/a` now shows next to the battery reading
instead of nothing at all. This makes the platform limitation legible —
"this device can't report ringer status" — rather than reading as a
silent omission that looks like a bug.

## Verification

- `tsc --noEmit -p tsconfig.app.json` (vitest types excluded, same method
  as prior phases): zero new errors from any file touched in this pass.
  The only remaining output on these files is the same pre-existing
  missing-`@types/react` / repo-wide `key`-prop artifact documented in
  Phases 1–2, on lines this pass didn't edit (`App.tsx`, `GridMenu.tsx`).
- Confirmed via `grep` that no `/duo` route, import, or component
  reference remains anywhere in `src/`.
- Confirmed the ringer condition logic in both display locations now
  matches (`normal` → `Bell`, `silent` → `BellOff`, `vibrate` → `Vibrate`,
  `unknown` → `n/a` label, `null` → nothing shown at all).
