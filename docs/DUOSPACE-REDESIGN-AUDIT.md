# DuoSpace — Minimal/Liquid-Glass Redesign: Forensic Audit & Foundation

**Scope:** read-only audit of the repo as uploaded (`duospace-redesign-final.zip`,
`package.json` v3.2.0), before any redesign work, for the new design
direction: **minimal + premium + subtle liquid glass + cinematic depth**,
light-mode-default.

This is a **new visual direction**, distinct from the prior "bold
single-accent on deep charcoal" pass already recorded as complete in
`docs/phases.md` (Phase 3) and detailed in `docs/UI_REDESIGN_FORENSIC_AUDIT.md`
/ `UI_REDESIGN_BUG_REGISTER.md`. Those docs remain accurate for the codebase
state they describe and are cross-referenced below rather than duplicated —
this doc only re-verifies and re-states what's relevant to planning the
*new* pass, plus everything the task brief asked for that isn't already
written down.

Toolchain note (unchanged from prior audits): no network egress, no
`node_modules`. `npm install` is 403-blocked in this sandbox. Everything
below is static-source verification, not a compiler/build/test run.

---

## 1. Feature inventory

| Feature | Entry point | Backing state |
|---|---|---|
| 1:1 E2E encrypted chat, voice notes, Love Letters | `/chat` | `messages` table, IndexedDB non-extractable keys, realtime channel |
| Scheduled Send | inside Chat (GridMenu → Schedule Send) | `deliver-scheduled-messages` edge function |
| Surprise Mode (code surprises) | inside Chat (`ChatSurpriseHost`), deep-link `/surprise/:id` | `useChatSurprise`, `CodeSurpriseEditor`/`Frame` |
| Voice/video calls (Daily.co) | `/calls`, plus global `IncomingCallOverlay` via `CallProvider` | `daily-call` edge fn, `useDailyCall`, `CallContext` |
| Native call integration (CallKit/Telecom, VoIP push) | cross-cutting | `native-plugins/callkit-bridge`, `send-voip-push` |
| Gallery (shared/private media) | `/gallery` | private `gallery` bucket, signed URLs, `resumableUpload` |
| Groic (shared live listening) | `/groic` | `GroicContext`, mini/full player, invite banner |
| Playlist | `/playlist` | separate from Groic's live-session state |
| Live location + partner battery/ringer | `/map` | `locations` table, `usePublishDeviceStatus`, `useLiveLocation`, `useDeviceStatus` |
| Us (memories, moods, countdown, daily Q&A, taps) | `/us` | `MemoryWall`, `MoodHistory`, etc. |
| Shayari | `/shayari` | — |
| Peek Guard | app-wide (`PeekGuard`, mounted once in `App.tsx`) | — |
| Mood detection (MediaPipe) | app-wide (`MoodDetector` in `AppLayout`) + `/us` history | — |
| Pairing/invites/QR | `/settings`, `/auth` | `issue-qr-token`, `redeem-qr-token`, `qr-anon-issue` |
| Passkeys/biometric/PIN lock | `/auth` (passkeys), app-wide `AppLockScreen` | WebAuthn edge fns, `useBiometricLock` |
| Cloud backup/restore | `/settings` (`BackupManager`) | local-export flow (Google Drive backup removed — see `rules.md`) |
| WhatsApp import | `/settings` / `/chat` | — |
| Themes/wallpapers/icons | `/settings` (`ThemeStudio`, `IconStudio`) | `ThemeContext`, `lib/themeEngine.ts` |
| Push/VoIP notifications | app-wide | `usePushNotifications`, `send-push`, `send-voip-push` |
| Capacitor Android/iOS shell | cross-cutting | `useAppNative`, 3 custom native plugins |

This list matches `docs/UI_REDESIGN_FORENSIC_AUDIT.md` Section C — confirmed
still accurate against this zip.

---

## 2. Route / navigation map

All routes declared in `src/App.tsx`, unchanged shape from the prior audit:
`/auth`, `/auth/callback`, `/reset-password`, `/` → `/chat`, `/index` →
`/chat`, `/surprise/:id`, then 10 protected routes (`/chat`, `/gallery`,
`/calls`, `/playlist`, `/shayari`, `/map`, `/us`, `/settings` + 7
`/settings/*` subpages, `/profile`, `/groic`), each behind
`<ProtectedRoutes>` → `<CallProvider><AppLayout /></CallProvider>`.

### Navigation — what's actually active today

- **`FloatingDock.tsx`** is the live navigation bar, mounted from
  `AppLayout.tsx`. It is **intentionally limited to two tabs: Chat and
  Calls** (confirmed via in-source comment). Settings is reached via
  Profile (tap partner name/avatar in the Chat header), not a tab.
- **Everything else — Gallery, Us, Map, Music (Groic), Shayari, Love
  Letter, Schedule Send — lives behind a "Hub" grid** (`GridMenu.tsx`),
  opened via a sparkle `HubButton` from inside Chat's composer bar, not
  from a persistent dock tab.
- **`BottomNav.tsx` exists in the tree but is dead code** — grep confirms
  zero imports anywhere except its own file. This matches the
  already-recorded finding in the prior audit (Section O, "confirmed dead
  components"). **Do not resurrect it as part of this pass** — build the
  new hub-tab (if any) on `FloatingDock`, not `BottomNav`.

### Gap vs. the brief's target nav model

The brief's target is "Chat / Duo-hub / Calls" as **three persistent
primary destinations**. Today it's **two** persistent tabs (Chat, Calls)
plus an in-Chat-only hub entry point — there is no third dock tab, and the
hub is only reachable from inside Chat, not from Calls or anywhere else.

**This is the one real navigation decision for the redesign, not a blind
migration:**
- *Option A (minimal-diff):* keep 2 dock tabs, restyle `HubButton` +
  `GridMenu` to the new glass/minimal language, but don't add a 3rd tab.
- *Option B (matches brief literally):* promote the hub to a 3rd
  `FloatingDock` tab (e.g. a "Duo" tab opening the same `GridMenu`
  content, or a proper `/us`-anchored hub page), and keep the in-chat
  sparkle button as a shortcut, not the only path.

Recommend **Option B**, since it's explicitly what the brief asks for and
the underlying `GridMenu` content already maps 1:1 onto "Duo/shared-space
hub" (Gallery, Music, Us, Map, Shayari). This is additive (new tab,
existing destinations) not a rewrite of hub logic — low risk. Flagging as
a decision point rather than assuming, per the brief's own instruction not
to implement navigation blindly.

---

## 3. Component dependency maps

**Chat** (`pages/Chat.tsx`, ~1400+ lines): composer (`chat/MessageComposer`),
context menu as bottom sheet (`chat/MessageContextMenu`), hub
(`chat/GridMenu`), surprise host, love-letter flow, schedule-send picker.
Realtime via a dedicated Supabase channel; E2E encryption keyed per
conversation.

**Map** (`pages/MapView.tsx`): `useLiveLocation` (own position + permission
state), `usePublishDeviceStatus` (battery/ringer publish, gated on
`sharingActive`), a realtime `locations` subscription with retry/backoff
for partner location, distance calculation, stale-data detection, and the
**Location Sharing Mode switch** (see Risk Register, §7).

**Calls** (`pages/Calls.tsx`, 728 lines) + `contexts/CallContext.tsx`:
`CallContext` owns `useDailyCall`, exposes `activeCallId`/accept/decline,
and globally mounts `IncomingCallOverlay` so an incoming call is visible
from *any* route — this was a prior-session bug fix (calls used to be
invisible outside Chat) and must not regress. **The actual in-call UI
(local/remote `<video>`, screen-share video, PiP request, controls) is
rendered directly inside `Calls.tsx`**, not a separate `CallScreen`
component — any redesign of in-call visuals happens in this one file plus
`components/calls/*` (`CallErrorScreen`, `CallOutcomeScreen`,
`CallStatusBanner`, `CallHistoryRow`).

**Gallery** (`pages/Gallery.tsx`): private-bucket media via
`resolveSignedUrl(s)`, `resumableUpload`, native camera via
`CameraWithFilters` + `Capacitor`, lock/unlock (private) and hide/show
affordances, grid density toggle.

**Groic** (`contexts/GroicContext.tsx` + `GroicMiniPlayer` /
`GroicFullPlayer` / `GroicInviteBanner`, all mounted once in `AppLayout`)
and **Music/Playlist** (`pages/Playlist.tsx`, separate playback/queue state
from Groic's live shared-session state) — two related but distinct
systems; don't collapse them into one component during redesign without
confirming with Aradhya, since they track different state.

---

## 4. Existing design tokens (current baseline)

Confirmed in `src/index.css` (already token-driven, already light-default
with a `.dark` override block — this part of the brief's requirement is
**already satisfied**, not something to build from scratch):

- **Color:** `background`, `foreground`, `card`(+fg), `popover`(+fg),
  `primary`(+fg), `secondary`(+fg), `muted`(+fg), `accent`(+fg),
  `success`/`warning`/`info`/`destructive` (+fg each), `border`, `input`,
  `input-hover`, `ring`.
- **Surface hierarchy (Phase 2 addition):** `surface-0..3` (background →
  card → raised-on-card → highest flat elevation), plus `bg-canvas` /
  `bg-subcanvas` / `bg-overlay-scrim`.
- **Sidebar-specific:** `sidebar-background/foreground/primary/accent/border/ring`
  (currently unused by any visible sidebar UI — verify before relying on
  it for the new hub if a sidebar-style surface is considered).
- **Glass (already exists, currently narrow scope):** `glass-bg`,
  `glass-border`, `glass-highlight`, `glass-dock-bg`, `glass-dock-sheen` —
  i.e. there is **already a glass token layer**, currently applied to the
  dock. This is a strong starting point for the brief's "Liquid Glass is a
  functional layer" material rule — extend this token set rather than
  inventing a parallel one.
- **Shadow:** `shadow-glass`, `shadow-soft`, `shadow-pop`.
- **Motion:** `ease-spring`/`ease-smooth`/`ease-snap`,
  `dur-fast`(140ms)/`dur-med`(220ms)/`dur-slow`(380ms) — mirrored in JS as
  `lib/motion.ts` constants (`EASE_SMOOTH`, `DUR_MED`, `gentleSpring`,
  `gentlePanelSpring`, etc.) so CSS and Framer Motion stay in sync.
- **Layout:** `touch-target-min`(44px), `dock-height`/`dock-gap`/`dock-reserve`,
  `page-header-height`.
- **Typography:** `font-heading` (Space Grotesk), `font-body` (Inter),
  `font-mono` (JetBrains Mono) — see §5 on whether to keep.
- **Status:** `input-invalid/valid`, `offline`(+fg).

**Gap vs. the brief's requested token list:** the brief asks for
`elevated background`, `elevated surface`, `primary/secondary/tertiary
text`, `divider`, `accent foreground`, `overlay`, `scrim`, and explicit
`blur/material intensity` tokens. Mapping:
- `elevated background`/`elevated surface` → **partially covered** by
  `surface-1..3`, needs a semantic rename/alias pass, not new color math.
- `secondary text`/`tertiary text` → **missing** — only `foreground` and
  `muted-foreground` exist today (two tiers, brief wants three).
- `divider` → **missing as a named token** — `border` is reused for this;
  worth a semantic alias so "divider" and "input border" can diverge
  later without a rename.
- `overlay`/`scrim` → **partially covered** by `bg-overlay-scrim` only;
  brief wants them as first-class separate tokens.
- `blur/material intensity` → **missing** — glass tokens define color/
  opacity but no `--glass-blur` variable; blur values are currently
  hardcoded per-usage (e.g. `backdrop-blur-sm` inline in Tailwind
  classes). Should become a token if glass usage expands per the brief.

This gap list is the concrete starting point for the token-architecture
work — extend, don't replace, the existing system.

---

## 5. Typography — evaluate-before-replace

Current: `Space Grotesk` (headings), `Inter` (body), `JetBrains Mono`
(mono, presumably timers/codes/QR text). This is already a considered,
non-default pairing — geometric-sans heading against a neutral body face
is consistent with "minimal + premium," not a generic AI-default combo.
**Recommendation: preserve as-is** unless a specific screen shows a
mismatch; nothing found during this audit suggests replacing it serves
the new direction better than reusing it.

---

## 6. Native integrations

- **Capacitor** (Android + iOS), one web codebase.
- **3 custom native plugins**, each with `src/` + `android/` + `ios/`:
  `duospace-audio-route` (call audio routing), `duospace-callkit-bridge`
  (CallKit/Telecom native call UI integration), `duospace-device-status`
  (battery/ringer state for the Map feature).
- **Raw native call-bridge sources** (Telecom/CallKit/PushKit) in
  `native/android`, `native/ios` — separate from the Capacitor plugins
  above; these are the lower-level native call-handling code the plugins
  wrap.
- **`useAppNative.ts`** — central hook surfacing native-shell state
  (platform detection, safe-area, etc.) to the web layer.

None of this is touched by a visual redesign, but any change to Calls'
control layout must keep triggering the same underlying native audio-route
/ CallKit calls — the redesign changes *presentation*, not which native
bridge method fires on which tap.

---

## 7. Backend / Supabase integrations

- **Postgres:** 35 `public.` tables, all RLS-enabled (repo's own
  `check-rls-coverage.ts` script — pure Node, ran successfully in this
  sandbox, confirms current coverage).
- **17 Edge Functions** (Deno) present in this zip: `cleanup-orphan-uploads`,
  `complete-signup`, `daily-call`, `deliver-scheduled-messages`,
  `finalize-upload`, `issue-qr-token`, `music-search`, `notify-signin`,
  `qr-anon-issue`, `redeem-qr-token`, `send-email`, `send-push`,
  `send-voip-push`, `set-email-password`, `webauthn-login-options`,
  `webauthn-login-verify`, `webauthn-register-options`,
  `webauthn-register-verify`.
- **Storage:** private buckets (`gallery`, `backups`, chat-files-style),
  always via signed URLs (`lib/signedStorageUrl.ts`) — see `rules.md`'s
  explicit "never `getPublicUrl()` on these buckets" rule.
- **Realtime:** Postgres changes + Presence + Broadcast, one `.channel()`
  per concern (messages, call signaling, partner location, Groic session
  state, badge counts).

None of this is in scope for a visual redesign; listed here only so it's
clear what the "don't touch" boundary actually covers.

---

## 8. ⚠️ Flagged product-behavior discrepancy — Map / location mode

**The brief states there must NOT be a new user-facing "turn off
location" control, and that if one already exists it must be flagged, not
touched.**

Confirmed in `src/pages/MapView.tsx`: a **"Location Sharing Mode" switch**
already exists in the Map page UI (below the map, in a card), backed by a
real `profiles.location_mode` column (`persistent` | `on_open`):

- **Persistent:** background GPS always active, `sharingActive` is always
  `true`.
- **On open:** `sharingActive = pageVisible` — location (and, because
  `usePublishDeviceStatus` is gated on the same `sharingActive` flag,
  **battery + ringer status too**) is only published while the Map page
  is actually open and the tab/app is foregrounded. When backgrounded or
  the page is closed, sharing pauses.

This is **not literally a global "turn off location" toggle** — there's
no `off` state, only "always" vs "only while viewing the map." But
functionally, "on_open" mode means the partner's live-location and
device-status visibility can go dark for arbitrarily long stretches
whenever the Map page isn't open, which is close enough to the concern
the brief is guarding against that it needs a human decision, not a
silent redesign pass-through.

**Action taken in this phase:** none — left exactly as found, per
instruction. **Flagged for Phase 2:** Aradhya should decide whether
"on_open" mode is intended product behavior (e.g. a deliberate
battery-saving option) or a gap that should be tightened, before this
control gets any visual treatment beyond a straight reskin.

---

## 9. What must be protected (do not change behavior)

- E2E key handling (IndexedDB non-extractable) — `rules.md`.
- All Supabase RLS/auth/schema, all 17 edge functions' logic.
- Signed-URL-only access to private buckets.
- Calling architecture: `CallContext` as single global call manager,
  global `IncomingCallOverlay` mount, DB-backed rate limiting, native
  CallKit/Telecom bridges, audio routing, screen share, PiP.
  video/audio semantics (mic/camera/speaker toggles' actual effect).
- Location/device-status publish semantics, including the `location_mode`
  gate described above — **do not add an off-switch, do not silently
  change persistent/on_open semantics.**
- Push/VoIP notification delivery paths.
- Groic/Playlist state separation (don't merge their state models).
- Peek Guard, biometric/PIN lock, mood detection triggers and thresholds.
- `prefers-reduced-motion` handling via `<MotionConfig reducedMotion="user">`
  in `App.tsx` — any new glass/motion work must route through this, not
  bypass it with raw CSS animations.

## 10. What's safe to redesign (presentation-layer only)

- `FloatingDock` / `HubButton` / `GridMenu` visual treatment and (per §2)
  possibly its tab count/structure.
- `PageHeader`, sheet/dialog chrome (`ui/Dialog`, `ui/Sheet`), toast
  styling.
- Chat bubble composition, composer bar chrome, `MessageContextMenu` bottom
  sheet visuals.
- Calls' control layout/hierarchy inside `Calls.tsx` (button placement,
  sizing, iconography) — not the state machine driving it.
- Map's card/switch/legend chrome — not the location-mode semantics.
- Gallery grid chrome, lock/hide affordances' visual treatment.
- Settings row/section chrome (already restructured to default-collapsed
  per Phase 3 — verify that still reads well under the new material
  language rather than re-deciding it from scratch).
- Theme token values themselves (colors, blur, elevation) — this is the
  actual redesign surface.

## 11. Legacy/dead components (candidates for later removal, not this phase)

- `components/BottomNav.tsx` — confirmed unused (§2). Already flagged
  in the prior audit; still true in this zip.
- Anything else flagged as dead in `docs/UI_REDESIGN_BUG_REGISTER.md` /
  `UI_REDESIGN_FORENSIC_AUDIT.md` Section O should be treated as still
  current unless this audit explicitly contradicts it above — it doesn't.

## 12. Risk register — do not touch during visual implementation

| Risk | Why |
|---|---|
| `location_mode` semantics | See §8 — flagged, needs a product decision first. |
| Calling state machine in `Calls.tsx`/`CallContext` | Global-visibility fix and rate-limiting were hard-won prior fixes (see `docs/memory.md`); a visual pass that reorganizes this file must not touch the state logic interleaved with the JSX. |
| `usePublishDeviceStatus` gating | Shares a flag with location — touching one without checking the other silently changes both. |
| Signed-URL helpers | Any new gallery/media visual component must still route through `resolveSignedUrl(s)` — never `getPublicUrl()`. |
| `GroicContext` vs `Playlist` state | Visually unifying their UI is fine; merging their underlying state is a functional change, out of scope. |
| RLS / edge functions | Zero UI reason to touch these; any file under `supabase/` is out of scope for this engagement. |
| Native plugin bridges | Redesigning call controls must keep calling the same plugin methods (`audio-route`, `callkit-bridge`, `device-status`) with the same triggers. |
| `prefers-reduced-motion` wrapper | New glass/motion effects must respect `MotionConfig`, not add a parallel animation path that ignores it. |

---

## 13. Summary — what I inspected, what's active, what's legacy

**Inspected:** route table (`App.tsx`), active navigation (`FloatingDock`,
`GridMenu`) vs. dead navigation (`BottomNav`), Chat/Map/Calls/Gallery/
Groic/Playlist component structure, `CallContext`, native plugin sources,
Supabase schema/RLS coverage script output, all 17 edge functions'
filenames, current design tokens in `index.css`, motion utilities in
`lib/motion.ts`, and the Map page's location-mode switch end-to-end
(state → DB write → gating of both location and device-status publish).

**Currently active:** 2-tab `FloatingDock` (Chat, Calls) + in-Chat-only
`GridMenu` hub; light-default token system with an existing (narrow-scope)
glass layer already on the dock; `location_mode` persistent/on_open switch
live in Map.

**Legacy/confirmed dead:** `BottomNav.tsx` only — no other new dead code
found in this pass beyond what the prior audit already recorded.

**Must be preserved:** everything in §9 — all backend/native/state-machine
behavior, encryption, RLS, calling architecture, location/device-status
semantics (location_mode included, unchanged).

**Should be redesigned:** everything in §10 — presentation layer only,
token values, glass material extended per §4's gap list, nav structure per
the §2 decision (recommend adding a 3rd "Duo hub" dock tab).

**Contradictions/gaps found:**
1. Brief's target 3-tab nav (Chat/Duo-hub/Calls) doesn't exist yet — only
   2 tabs + in-Chat-only hub entry. Needs a decision (§2), not a blind
   port.
2. Brief's requested token set (elevated bg/surface, 3-tier text, divider,
   overlay, scrim, blur-intensity) is only partially present — needs
   additive tokens, not a rebuild (§4).
3. Brief's "no new turn-off-location control" requirement runs into an
   *existing* location-mode switch with de-facto sharing-pause behavior —
   flagged for a product decision, not modified (§8).

**Recommended implementation order:**
1. Get Aradhya's decision on the §2 nav question (2-tab-restyle vs.
   3rd-tab) and the §8 location-mode flag — both are product decisions,
   not implementation details, and change what "Phase 1 visual" scope
   actually covers.
2. Extend the token architecture (§4 gaps) — additive aliases/new tokens,
   verified in both themes, before any component reskinning starts.
3. Redesign the shared/floating layer first (Dock, Hub, sheets, dialogs,
   toasts) since it's reused everywhere and is explicitly where the brief
   wants glass concentrated.
4. Then per-surface passes in order of daily-use frequency: Chat →
   Calls (presentation only, per §9/§12) → Map (chrome only, per §8) →
   Gallery → Groic/Playlist → Us/Shayari/Settings.
5. Docs update each session per `rules.md`'s existing convention
   (`memory.md` dated entry, `phases.md` checklist, `design.md` for token/
   motion changes) — this project already enforces that discipline;
   continue it rather than batching doc updates at the end.

No code outside this new doc was changed in this phase, per the brief.
