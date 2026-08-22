# DuoSpace — UI Redesign Forensic Audit

**Scope of this document:** a read-only forensic pass over the repository as
uploaded (`duospace-redesign-final__1_.zip`, `package.json` version `3.2.0`),
performed *before any redesign work*. Nothing in the codebase was changed to
produce this document. Every claim below is labeled:

- **[confirmed]** — read directly from source in this repo during this audit.
- **[likely]** — a strong inference from source (e.g. "two components read
  the same table with the same shape, therefore duplicated logic"), but not
  itself directly observed at runtime.
- **[needs runtime/device validation]** — cannot be settled by reading source
  alone (timing-dependent races, native permission prompts, on-device
  camera/GPS behavior, App Store/Play Store review behavior, etc.).

No bug or risk in this document or in `UI_REDESIGN_BUG_REGISTER.md` was
invented; if something looks likely but wasn't directly verified, it's
labeled as such.

> **Post-audit update:** the confirmed dead components described in
> Section O below (`BottomNav.tsx`, `SurpriseOverlay.tsx`) and the
> low-risk async-after-unmount guard described in Bug Register BUG-04
> have since been fixed — see `UI_REDESIGN_BUG_REGISTER.md` for the
> per-issue status notes. Section O and the Feature Matrix below are left
> as originally written (describing the state *as audited*) with fix
> status called out inline, so this document still serves as an accurate
> record of what was found versus what was changed.

---

## 0. Toolchain / static-check status (read this first)

This environment has **no network egress** and **no installed
`node_modules`**. This is a hard blocker for most standard checks:

| Check | Command | Result |
|---|---|---|
| `npm install` | `npm install` | **Blocked.** `403 Forbidden` from `registry.npmjs.org` for every package (confirmed by direct attempt). |
| TypeScript | `npx tsc --noEmit -p tsconfig.app.json` | **Blocked.** Fails immediately with `TS2688: Cannot find type definition file for 'vitest/globals'` — the compiler can't resolve any dependency types because `node_modules` doesn't exist. |
| ESLint | `npx eslint .` | **Blocked.** `npm error 403` trying to fetch `eslint` itself (not vendored, not installed). |
| Vitest | `npx vitest run` | **Blocked.** Same `403` — the test runner itself isn't available to fetch. |
| Repo's own RLS coverage gate | `node scripts/check-rls-coverage.ts` | **Ran successfully** (pure Node `fs` + regex, no dependencies). Output: `✓ RLS coverage OK — 35 tables, all have RLS + policies.` |
| Capacitor `cap:verify:deps` / `cap:verify:native` | `npm run cap:verify:deps` | **Blocked** — depends on `npm`/Capacitor CLI, which requires the same blocked `npm install`. |
| Android/iOS native build | n/a | **Not attempted.** No Android SDK / Xcode toolchain in this container, and `native/android`, `native/ios` here are Capacitor plugin sources + Kotlin/Swift call-bridge sources, not a generated native project (no `android/`, `ios/` top-level folders exist in this zip — those are created by `npx cap add`, which is also blocked).

**What this means for the audit below:** every finding here comes from
static reading of the source, migrations, and edge functions — not from a
compiler, linter, or test run. Type errors, unused-import warnings, and
test failures/passes are **unknown** and out of scope until dependencies can
be installed in an environment with registry access. Treat section P
("Potential race conditions") and section S ("Offline/reconnect risks")
especially as **source-level reasoning**, not confirmed runtime behavior.

---

## A. Architecture map

- **Frontend:** Vite + React + TypeScript, React Router (`BrowserRouter`),
  TanStack Query (`QueryClientProvider` — instantiated but most pages fetch
  via raw `supabase.from(...)` calls rather than `useQuery`; see section E).
- **Native shell:** Capacitor 8.x, targeting Android + iOS from one web
  codebase. Three custom native plugins live in `native-plugins/`
  (`duospace-audio-route`, `duospace-callkit-bridge`,
  `duospace-device-status`), each with its own `android/` and `ios/` native
  source. Raw Kotlin/Swift call-bridge sources (Telecom/CallKit/PushKit
  integration) live separately in `native/android` and `native/ios`.
- **Backend:** Supabase — Postgres (39 migrations, 35 `public.` tables, all
  RLS-enabled per the repo's own coverage script), Auth, Storage
  (`gallery`, `backups`, chat-files style private buckets — always accessed
  via signed URLs, see `lib/signedStorageUrl.ts`), Realtime (Postgres
  changes + Presence + Broadcast), and 19 Edge Functions (Deno).
- **Calls:** Daily.co WebRTC via the `daily-call` edge function, which
  mints per-call rooms/tokens with a key-resolution order (caller's own key
  → partner's key via a `SECURITY DEFINER` RPC → optional platform
  fallback key) **[confirmed, `supabase/functions/daily-call/index.ts`]**.
- **State management:** No global state library (no Redux/Zustand/Jotai).
  Pattern is: page-level `useState` + direct Supabase queries + one
  `.channel()` subscription per concern, with two app-wide React Contexts
  (`ThemeContext`, `CallContext`) and one feature-scoped context
  (`GroicContext`, mounted only inside `AppLayout`) for cross-page shared
  state. See section E for the full breakdown.
- **Styling:** Tailwind CSS, token-driven theme system (`ThemeContext` +
  `lib/themeEngine.ts` + `lib/customThemes.ts` + `lib/dynamicSky.ts`),
  Framer Motion for animation, globally wrapped in
  `<MotionConfig reducedMotion="user">` in `App.tsx` — this is the actual
  `prefers-reduced-motion` compliance mechanism for JS-driven motion; a
  separate CSS-level override in `index.css` only catches plain CSS
  transitions.

## B. Route map

All routes are declared in `src/App.tsx`. **[confirmed]**

| Path | Element | Auth-gated | Lazy-loaded | Notes |
|---|---|---|---|---|
| `/auth` | `AuthRoute` → `Auth` or redirect | No (redirects if already signed in) | No | Also handles post-auth redirect to `/reset-password` (password-recovery deep link) or `/settings?invite=...` (pending invite in `sessionStorage`/query param) before falling through to `/chat`. |
| `/auth/callback` | Same `AuthRoute` | No | No | OAuth/magic-link callback landing; only renders `<Auth />` if `hasAuthCallback()` recognizes the URL. |
| `/reset-password` | `ResetPassword` | No | No | |
| `/` | `Navigate` → `/chat` | n/a | n/a | |
| `/index` | `Navigate` → `/chat` | n/a | n/a | Legacy alias. |
| `/surprise/:id` | `SurpriseDeepLink` → `Navigate` to `/chat?surprise=<id>` | n/a | n/a | Deliberately folds into Chat's own surprise resolution (`ChatSurpriseHost`) — comment in source explicitly states this is the *only* place a surprise deep link is resolved (see O — dead code note on `SurpriseOverlay.tsx`, which resolves the same query param independently and unused). |
| `/chat` .. `/groic` (10 routes) | Wrapped in `<ProtectedRoutes>` | **Yes** | Yes (`React.lazy`) | See below. |
| `*` | `NotFound` | No | Yes | |

Protected routes (all children of `<ProtectedRoutes>`, which itself gates on
`useAuth()` → onboarding-completion check → `isAppLocked` → renders
`<CallProvider><AppLayout /></CallProvider>`):

`/chat`, `/gallery`, `/calls`, `/playlist`, `/shayari`, `/map`, `/us`,
`/settings`, `/profile`, `/groic`.

`ProtectedRoutes` also:
- Preloads **every** protected route chunk during browser idle time once a
  user is authenticated (`requestIdleCallback` fallback to `setTimeout`),
  so first-tap navigation is instant. **[confirmed]**
- Races the onboarding-profile check against an 8s timeout, with an explicit
  code comment explaining *why*: right after a native OAuth handoff, the
  profile fetch can stall indefinitely on some devices, and on timeout it
  deliberately treats the user as **not** needing onboarding (fail open
  toward "returning user") rather than risk trapping an already-onboarded
  user on the onboarding screen. **[confirmed — documented in source, not
  yet redesign-relevant but important context for anyone touching this
  screen.]**

## C. Feature inventory

See the full feature matrix in **Section — Feature Matrix** below (one row
per feature per the spec's required columns). High-level list, each mapped
to its primary route/entry:

1. 1:1 E2E encrypted chat — `/chat`
2. Voice/video calls (Daily.co) — `/calls`, plus in-call overlay reachable from anywhere via `CallProvider` + `IncomingCallOverlay`
3. Shared/private gallery — `/gallery`
4. Live location — `/map`
5. Groic (music/playlist + shared listening) — `/groic`, `/playlist`
6. Us (relationship hub: memories, moods, countdowns, taps, daily Q&A) — `/us`
7. Shayari — `/shayari`
8. Surprise Mode (code surprises embedded in chat) — inside `/chat` via `ChatSurpriseHost`, deep-linkable via `/surprise/:id`
9. Pairing/invites/QR — `/settings` (primary), `/auth` (signup-time QR)
10. Passkeys/biometric/PIN lock — `/auth` (passkeys), `AppLockScreen` (PIN/biometric, app-wide)
11. Peek Guard — app-wide (`PeekGuard`, mounted once in `App.tsx`)
12. Mood detection — app-wide (`MoodDetector`, mounted in `AppLayout`) + `/us` (`MoodHistory`)
13. Cloud backup/restore — `/settings` (`BackupManager`)
14. WhatsApp import — `/settings` or `/chat` (imported-chat realtime channel confirmed in `Chat.tsx`; see Feature Matrix)
15. Themes/wallpapers/icon customization — `/settings` (`ThemeStudio`, `IconStudio`)
16. Push/VoIP notifications — app-wide (`usePushNotifications`, two edge functions: `send-push`, `send-voip-push`)
17. Capacitor Android/iOS native support — cross-cutting (`useAppNative`, `native-plugins/*`, `native/android`, `native/ios`)

## D. Component dependency map (high level)

```
App.tsx
 ├─ ThemeProvider (contexts/ThemeContext.tsx)
 │    └─ used by: AppLayout, AppLockScreen, PeekGuard, Settings, ThemeStudio,
 │       IconStudio, Chat (sky/wallpaper), almost every page for theme tokens
 ├─ PeekGuard (mounted once, app-wide, above the router)
 ├─ SplashScreen (cold-boot only, sessionStorage-gated)
 ├─ BrowserRouter
 │    ├─ AuthRoute → Auth, ResetPassword (unauthenticated)
 │    └─ ProtectedRoutes
 │         ├─ Onboarding (first run only)
 │         ├─ AppLockScreen (if isAppLocked)
 │         └─ CallProvider (contexts/CallContext.tsx — wraps useDailyCall once)
 │              └─ AppLayout
 │                   ├─ GroicProvider (contexts/GroicContext.tsx)
 │                   │    ├─ GroicMiniPlayer
 │                   │    ├─ GroicFullPlayer
 │                   │    └─ GroicInviteBanner
 │                   ├─ OfflineBanner
 │                   ├─ ErrorBoundary → <Outlet/> → lazy page (Chat/Gallery/Calls/...)
 │                   ├─ FloatingDock (bottom tab bar: Chat + Calls only)
 │                   ├─ MoodDetector
 │                   ├─ EmojiScreenEffect
 │                   └─ (IncomingCallOverlay is mounted from useAppNative/CallProvider path — see Call feature row)
```

Notable **cross-page shared singletons** (not duplicated per-page):
- `useCall()` (via `CallContext`) — **explicitly a bug fix**: a source
  comment in `CallContext.tsx` documents that `Chat.tsx` and `Calls.tsx`
  used to each instantiate `useDailyCall()` independently, which crashed
  with "Duplicate DailyIframe instances are not allowed" because Daily's
  SDK only permits one `DailyCall` object per page. Now there is exactly
  one instance, shared via context. **[confirmed, and a great example of
  a component boundary that must NOT be touched during a UI redesign —
  see Safety Map.]**
- `useAuth()` — single source of truth for session/user, includes its own
  token-refresh interval (see P).
- `GroicProvider` — mounted once inside `AppLayout`, so it's unavailable
  outside the authenticated app shell (fine, since Groic is a protected
  feature) but also means any redesign that hoists/splits `AppLayout` must
  keep `GroicProvider` wrapping exactly the same subtree.

## E. State-management map

No global store. State lives in three tiers:

1. **App-wide React Context** (survive navigation):
   - `ThemeContext` (625 lines) — theme/dark-mode/app-lock state,
     wallpaper, custom themes, couple-theme realtime sync
     (`couple-theme-${userId}` channel), app settings (biometric lock
     toggle, etc.).
   - `CallContext` (60 lines) — single shared `useDailyCall()` instance
     (see D).
   - `GroicContext` (419 lines) — shared music/listening-session state,
     mounted only inside `AppLayout` (i.e., only for authenticated,
     onboarded, unlocked users).
2. **Page-local state** — every page (`Chat.tsx` 2050 lines, `Settings.tsx`
   1449 lines, `Auth.tsx` 823 lines, `Playlist.tsx` 842 lines,
   `MapView.tsx` 815 lines, `Calls.tsx` 715 lines, `Gallery.tsx` 686 lines,
   etc.) owns its own `useState`, its own data fetching, and its own
   realtime subscription(s) — there is no shared cache/query layer for
   these even though `@tanstack/react-query`'s `QueryClientProvider` is
   present at the root. **[confirmed by grep: pages call
   `supabase.from(...)` directly inside `useEffect`, not `useQuery`.]**
   This is architecturally significant for a redesign: refactoring a
   page's *data layer* is explicitly out of scope per the brief, but a
   *visual* redesign that changes when/how a page mounts (e.g. keep-alive
   tabs, route transition timing) can change when these local-state
   effects fire and refetch — see Safety Map, Section S.
3. **Custom hooks encapsulating one feature's lifecycle** — the biggest
   and most complex ones: `useDailyCall` (446 lines), `useLiveLocation`
   (578 lines), `usePeekDetection` (745 lines), `useCloudBackup` (388
   lines), `useLipReading` (240 lines), `usePushNotifications` (213
   lines), `useSessionGuard` (127 lines). These are the true "engines" of
   the app; each is designed to be a single instance per app (some
   enforce this explicitly, e.g. `useDailyCall`'s `joinInProgressRef`
   re-entrancy lock plus the `CallContext` singleton wrapper).

## F. Realtime/subscription map

All `supabase.channel(...)` call sites in `src/`, **[confirmed via
repo-wide grep, 27 call sites]**:

| File | Channel name(s) | Table(s)/event(s) | Purpose |
|---|---|---|---|
| `components/BottomNav.tsx` | `nav-unread-messages`, `nav-missed-calls` | `messages`, `call_history` | Badge counts — **dead code, see O.** |
| `components/FloatingDock.tsx` | `dock-msgs`, `dock-calls` | `messages`, `call_history` | Badge counts — the live equivalent of the above. |
| `components/IncomingCallOverlay.tsx` | `incoming-calls`, `call-cancel` | `call_history` | Ringing/cancel signaling for the app-wide incoming-call UI. |
| `components/chat/MessageReactions.tsx` | `reactions-convo-${sortedUserIds}` | `message_reactions` | Live reaction sync. |
| `components/MemoryWall.tsx` | `memories-rt-${userId}` | `memories` | Us-hub memory wall live updates. |
| `components/SurpriseOverlay.tsx` | `code-surprises-realtime` | `code_surprises` / `code_surprise_events` | **Dead code, see O** — duplicate of the next row. |
| `hooks/useChatSurprise.ts` | `code-surprises-realtime` | `code_surprises` / `code_surprise_events` | Live surprise resolution used by the actual mounted `ChatSurpriseHost`. |
| `contexts/GroicContext.tsx` | dynamic channel name + a "probe" channel | Broadcast (`{ config: { broadcast: { self: false } } }`) | Shared listening-session sync. |
| `contexts/ThemeContext.tsx` | `couple-theme-${userId}` | theme sync | Couple-shared theme push. |
| `pages/Us.tsx` | `presence-${sortedUserIds}`, `incoming-taps` | Presence + `taps` | Online-status presence and "tap" nudges. |
| `pages/Chat.tsx` | `call-history-rt`, `imported-rt-${sortedUserIds}`, `messages-rt-${userId}`, `typing-${name}`, `presence-${sortedUserIds}` | `call_history`, `imported_chats`, `messages`, typing broadcast, presence | Chat's five separate realtime concerns. |
| `pages/Shayari.tsx` | `shayaris-realtime` | `shayaris` | Live shayari sync. |
| `pages/Gallery.tsx` | `gallery-rt-${sortedUserIds}` | `gallery_items` (INSERT/UPDATE/DELETE) | Live gallery sync, including signed-URL resolution on insert. |
| `pages/Settings.tsx` | `partner-requests-rt` | `partner_requests` | Live pairing-request updates. |
| `pages/Playlist.tsx` | `blend-sync`, `blend-invites-rt` | playlist blend state | Shared playlist blending. |
| `pages/MapView.tsx` | `partner-location-${partnerId}` | `locations` | Live partner-location updates. |

**Duplicate-subscription finding [confirmed, now fixed]:** `BottomNav.tsx`
and `FloatingDock.tsx` independently subscribed to the *same two tables*
(`messages`, `call_history`) with *different channel names* but
*functionally identical* filter/count logic. Only `FloatingDock` was
actually rendered (`BottomNav` had zero imports anywhere in `src/` —
verified by repo-wide grep). This wasn't a runtime conflict (different
channel names avoid collision) but it was 100% duplicated, dead logic
that a redesign could have accidentally "fixed" by editing the wrong
file. **`BottomNav.tsx` has since been deleted — see Bug Register
BUG-01 (fixed).**

**Duplicate channel *name* finding [confirmed, now fixed]:**
`SurpriseOverlay.tsx` and `hooks/useChatSurprise.ts` both created a
channel literally named `"code-surprises-realtime"`. Because
`SurpriseOverlay.tsx` was never mounted (see O), this was harmless at the
time, but it was a landmine: had `SurpriseOverlay.tsx` ever been
re-introduced, two independent Supabase Realtime clients would have
competed for the same channel name from the same browser tab, which
Supabase's JS client does not support cleanly (it reuses/detaches the
existing channel object rather than running two independent
subscriptions). **`SurpriseOverlay.tsx` has since been deleted — see Bug
Register BUG-02 (fixed).** `useChatSurprise.ts` is now the sole owner of
the `"code-surprises-realtime"` channel name.

## G. Modal/dialog map

- 19 files use the shadcn/ui `Dialog` primitive; 3 use `AlertDialog`; 3 use
  `Sheet`. **[confirmed via grep]** No use of `window.confirm`/`alert`
  anywhere in `src/` (good — these would be unstyleable and
  platform-inconsistent on Capacitor WebViews).
- No shared "modal manager"/global modal stack exists; each dialog is a
  component-local `open`/`onOpenChange` boolean, which is the standard
  shadcn/Radix pattern and is **safe to restyle** (see Safety Map — dialogs
  are GREEN for visual redesign, as long as `open`/`onOpenChange` wiring
  and any `onConfirm` callback signatures are preserved).
- Notable dialogs tied to security-sensitive flows (these are RED for
  behavior changes, GREEN/YELLOW for chrome only): `PeekConfigDialog`,
  `FaceEnrollmentDialog`, `AddEmailPasswordDialog`, `PermissionDeniedSheet`.

## H. Navigation map

- **Primary tab bar:** `FloatingDock` — intentionally limited to exactly
  Chat + Calls, per an explicit in-source comment: *"Everything else
  (Gallery, Us, Map, Music, Shayari, Love Letter, Schedule Send) lives in
  the in-chat sparkle 'Hub' (GridMenu, opened from Chat.tsx)."*
  **[confirmed]** — Settings itself is reached via tapping the
  partner's name/avatar in the Chat header (Profile), not a tab.
- **Secondary navigation (in-chat hub):** `components/chat/GridMenu.tsx` —
  the fan-out menu for Gallery/Us/Map/Groic/Shayari/LoveLetter/Scheduled
  messages. This is the actual primary IA for most features and should be
  the focal point of any navigation redesign, not the two-item bottom bar.
- **Swipe navigation:** `AppLayout` implements left/right swipe between
  exactly `["/chat", "/calls"]` via `useSwipeNav`, with directional page
  transition animation synced to swipe vs. tap navigation (`direction`
  ref). Any redesign that adds more tabs to the primary bar must also
  extend `SWIPE_NAV_ORDER` in `AppLayout.tsx` or swipe will silently stop
  working for the new tabs.
- **Dock visibility:** `useDockVisibility` + a scroll-based auto-hide
  effect duplicated inside `BottomNav.tsx` (dead) and referenced by
  `FloatingDock`'s `isVisible`/`isHidden` props from `AppLayout`. The
  content `<main>` bottom padding is explicitly kept in sync with dock
  visibility (a prior bug — "gap between chat box and bottom when dock
  hides" — is documented and fixed in `AppLayout.tsx`'s inline comments).
  **This coupling (padding math ↔ dock visibility state) is a RED item**
  for redesign: changing dock height/position without updating the
  corresponding `paddingBottom` calc in `AppLayout.tsx` will reintroduce
  that exact bug.
- **Route preloading on nav-intent:** both `BottomNav` (dead) and
  `FloatingDock` call `routePreload[tab.path]?.()` on `onPointerDown`, so
  route chunks warm before the actual navigation/animation starts.

## I. Permission map

Runtime permission requests, by feature:

| Permission | Requested via | Consuming feature | Denial handling |
|---|---|---|---|
| Camera | `lib/mediaPermissions.ts` (`ensureMediaPermission`/`ensureMediaPermissions`) + `lib/cameraBus.ts` (pooled camera stream acquisition) | Peek Guard face enrollment/detection, Mood detection, Camera capture (`CameraWithFilters`), Lip reading | `PermissionDeniedSheet` component + `recoveryInstructions()`/`openAppSettings()` helpers in `mediaPermissions.ts`. |
| Microphone | Same `mediaPermissions.ts` path | Voice messages, Daily.co calls | Same. |
| Location | Capacitor `Geolocation` (native) / browser Geolocation (web) — orchestrated by `useLiveLocation.ts` | Live Location (`/map`) | Explicit `LiveLocationState` includes `requesting_permission` and `failed` states. |
| Push notifications | `@capacitor/push-notifications` via `usePushNotifications.ts` | Push/VoIP notifications | Registration failures are caught; token upsert is best-effort. |
| Biometric/Face ID/Fingerprint | Native bridge via `useBiometricLock.ts` + `Capacitor.isNativePlatform()` checks | App lock (`AppLockScreen`) | Falls back to PIN. |
| Photo library / Filesystem | `@capacitor/camera` + `@capacitor/filesystem` | Gallery upload/import, backup export/import, WhatsApp import | — |

**Central launch-time permission orchestration:** `useLaunchPermissions.ts`
is invoked once at the top of `App.tsx` (outside auth gating), meaning it
runs before the user is even authenticated. Any redesign of the splash/
onboarding sequence must confirm this hook's timing assumptions still
hold (see Safety Map — RED for timing).

## J. Storage map

- **Client-side persistence layers** (three distinct ones, used
  deliberately for different sensitivity levels — **[confirmed]** by
  reading `lib/storage.ts`, `lib/idbStore.ts`/`lib/keystore.ts`, and
  `lib/crypto.ts`'s comments):
  1. `lib/storage.ts` (`storage` default export) — a `localStorage`
     wrapper (or Capacitor `Preferences` on native, per `useCloudBackup.ts`
     usage) for non-sensitive UI prefs (theme, media-visibility toggle,
     "has seen splash" flag, etc.).
  2. IndexedDB (`lib/idbStore.ts`, wrapped by `lib/keystore.ts`) — used
     specifically for the E2E keypair (`lib/crypto.ts`'s
     `saveKeyPair`/`loadKeyPair`), explicitly *not* localStorage, with a
     one-time migration path that reads any legacy localStorage copy,
     migrates it into IndexedDB, and purges the localStorage copy.
     **[confirmed, `lib/crypto.ts` lines ~35–50]**
  3. Capacitor `Preferences` (native secure-ish storage) — used for the
     cloud-backup device secret (`useCloudBackup.ts`'s
     `getOrCreateDeviceSecret`) on native builds, falling back to
     something else on web (see that hook for the branch).
- **Server-side storage buckets:** `gallery` (photos/videos),
  `backups` (encrypted backup blobs, private bucket per migration
  `20260507180000_backups_bucket.sql`), plus chunked-upload staging
  handled by the `finalize-upload`/`cleanup-orphan-uploads` edge functions
  and the `pending_uploads` table (orphan chunks older than 24h are
  cleaned by cron). All access is via signed URLs
  (`lib/signedStorageUrl.ts`) — **never** `getPublicUrl()`, per an
  explicit comment in `docs/architecture.md` that matches what the source
  actually does.
- **Resumable/chunked upload:** `lib/resumableUpload.ts` (252 lines,
  paired with `lib/locationQueue.ts`'s offline-queue pattern for a
  different feature but the same general "queue + replay" shape) —
  chunks are uploaded to `.tmp/<objectPath>.part-NNNNN` and reassembled
  server-side by `finalize-upload`.

## K. Native integration map

- **Custom Capacitor plugins** (`native-plugins/`): `audio-route` (call
  audio routing — speaker/earpiece/Bluetooth), `callkit-bridge`
  (iOS CallKit / Android Telecom integration), `device-status` (native
  device state exposed to JS). Each has TS glue in `src/`, Android
  (Kotlin) in `android/`, iOS (Swift) in `ios/`.
- **Raw native call-handling sources** (`native/android/*.kt`,
  `native/ios/*.swift`): `DuoSpaceConnectionService.kt` +
  `DuoSpaceConnection.kt` + `TelecomHelper.kt` + `CallBridge.kt` +
  `CallRingingService.kt` + `CallNotificationService.kt` +
  `NotificationChannels.kt` on Android; `CallKitManager.swift` +
  `PushKitManager.swift` on iOS. These implement native-OS call UI
  (Telecom framework / CallKit) so incoming DuoSpace calls behave like
  real phone calls (lock-screen answer/decline, Bluetooth/car head-unit
  routing). **This is the single most redesign-risky native surface** —
  it's wired to `call_history` DB triggers and the `send-voip-push`/
  `send-push` edge functions on the backend, and to `CallContext`'s
  `duospace-call-control` custom window event on the frontend. None of
  this is reachable or testable from this sandboxed audit (no Xcode/
  Android SDK), so its current correctness is **[needs runtime/device
  validation]**, but its *existence and wiring* is **[confirmed]** from
  source and should not be touched by a UI redesign.
- Note: `native/android` and `native/ios` (top-level generated Capacitor
  project folders) are **not present** in this zip — only plugin/bridge
  *sources* are. A real native build would first require `npx cap add
  android`/`ios`, which is blocked in this environment (see Section 0).
- **Permission manifest patch script:** `scripts/patch-native-permissions.mjs`
  runs after `cap add`/`cap sync` to inject required permissions into the
  generated `AndroidManifest.xml`/`Info.plist`, since Capacitor's default
  generated manifests don't include everything this app needs (location,
  camera, push, VoIP, etc.). This script could not be executed in this
  environment (no generated native project to patch against).

## L. Security-sensitive areas (RED — do not touch during UI work)

1. **E2E chat crypto** (`lib/crypto.ts`) — ECDH P-256 key exchange +
   AES-256-GCM, keys in IndexedDB with base64 chunked encode/decode
   (explicitly documented fix for a "Maximum call stack size exceeded" bug
   on large buffers, since the naive spread-operator approach blows the
   stack past ~100KB on some engines). PBKDF2 (100,000 iterations) for PIN
   hashing, with a documented plaintext→hash migration path
   (`migratePinIfNeeded`).
2. **Passkey/WebAuthn flow** — 4 dedicated edge functions
   (`webauthn-register-options`, `webauthn-register-verify`,
   `webauthn-login-options`, `webauthn-login-verify`) using
   `@simplewebauthn/server`, with a shared `getWebauthnConfig()`
   (`_shared/webauthnOrigin.ts`) for correct RP ID/origin handling.
3. **QR pairing** (`issue-qr-token`, `redeem-qr-token`, `qr-anon-issue`) —
   tokens are single-use, short-lived (10 min for anon issue), and **only
   the SHA-256 hash is persisted server-side**; the raw token never
   touches the database. Session tokens are minted server-side via
   `admin.generateLink` + `verifyOtp`, never issued as a raw JWT over the
   QR channel itself. **[confirmed from source comments + code shape]**
4. **Peek Guard face recognition** (`hooks/usePeekDetection.ts`,
   `lib/faceRecognition.ts`, `lib/faceWorkerClient.ts`) — on-device
   MediaPipe FaceLandmarker, cosine-similarity matching against enrolled
   owner embeddings, off-main-thread via a Web Worker
   (`faceDetection.worker.ts`). A documented gotcha: `isPeeking` is only
   cleared by an explicit `dismiss()` call from host code — nothing in the
   hook clears it automatically, and skipping that call was flagged in
   the hook's own doc comment as "a real bug, not a cosmetic one" (it
   permanently disarms future re-locks for the session). **Any redesign
   of the lock-screen UI must preserve the exact call to `dismiss()`.**
5. **App lock / biometric / PIN** (`AppLockScreen.tsx`,
   `useBiometricLock.ts`) — gates the entire authenticated app shell in
   `App.tsx` (`if (isAppLocked) return <AppLockScreen />;`).
6. **Session/token handling** (`useAuth.tsx`, `useSessionGuard.ts`) — a
   background token-refresh `setInterval`, plus a separate session-guard
   interval that detects expiry/refresh failure/multi-device conflicts
   and surfaces them via toasts from `AppLayout`.
7. **RLS coverage** — confirmed 100% (35/35 tables) via the repo's own
   gate script; a redesign must not introduce new tables or bypass this
   without updating that script's expectations too.
8. **Backup encryption** (`useCloudBackup.ts`) — AES-GCM with a
   PBKDF2-derived key from a device-local secret; backups are opaque
   binary blobs server-side.
9. **Row-level abuse guards on edge functions** — e.g. `complete-signup`
   only works within 15 minutes of account creation and only if not
   already confirmed (explicitly documented as an anti-abuse measure so
   it "can't be used as a general 'confirm anyone's email' oracle").
   `notify-signin`, `music-search`, `send-email`, `issue-qr-token`,
   `qr-anon-issue`, `webauthn-login-options` all use a shared persistent
   (DB-backed, cold-start-surviving) rate limiter
   (`_shared/rateLimit.ts` / `consumeRateLimit`).

## M. Performance-sensitive areas

- **Chat.tsx (2050 lines)** — the single largest, most complex page.
  Owns 5 realtime channels simultaneously (F), per-message decrypt calls,
  a disappearing-message countdown that is deliberately implemented via
  `disappear_at` timestamp math inside `useMemo` rather than a per-second
  ticking state, specifically to avoid "a chat full of disappearing
  messages" re-rendering every bubble once a second — **[confirmed,
  explicit comment]**. Any redesign touching message-bubble rendering
  must preserve this pattern or reintroduce that perf regression.
- **usePeekDetection / MoodDetector / useLipReading** — all run
  per-frame (or near-per-frame, e.g. every ~300ms) camera-frame
  inference. `usePeekDetection` explicitly offloads to a Web Worker when
  supported (`faceWorkerClient.ts`) precisely to keep this off the main
  thread and out of contention with lock-screen animation.
- **Route-level code splitting** — all 10 protected pages are
  `React.lazy`, with per-route skeleton variants (`PageSkeleton`) and
  idle-time preloading of every chunk once authenticated (see B). A
  redesign should preserve this lazy-loading structure; converting pages
  to eager imports would regress first-load bundle size.
- **`useVirtualList` hook exists** (`src/hooks/useVirtualList.ts`) — its
  actual usage sites weren't exhaustively traced in this pass; confirm
  whether Chat/Gallery message/media lists use it before assuming any
  list in this app is virtualized by default.
- **Camera pooling** (`lib/cameraBus.ts`) — a reference-counted camera
  stream pool shared across Peek Guard, Mood Detection, and manual camera
  capture, with hard-stop on tab-hidden/`pagehide` to release the camera
  promptly. This is exactly the kind of cross-feature resource-sharing
  code that a naive "redesign the camera UI" pass could accidentally
  duplicate or bypass.

## N. Accessibility-sensitive areas

- `MotionConfig reducedMotion="user"` at the app root (see A) — the *real*
  `prefers-reduced-motion` fix for Framer-Motion-driven animation
  (chat bubbles, theme studio, gesture handles, splash), explicitly
  called out in a source comment as superseding an incomplete CSS-only
  attempt. **A redesign must not remove or narrow this provider's scope.**
- `aria-label`/`aria-current` present on nav tab buttons in
  `FloatingDock.tsx` (`aria-label={tab.label}`,
  `aria-current={isActive ? "page" : undefined}`).
- No further accessibility audit (screen-reader flow, focus trapping in
  dialogs, color-contrast of theme tokens, dynamic-type/font-scaling
  support) was performed in this pass — **[needs manual/runtime
  validation]**; flagging as an explicit gap rather than claiming
  coverage.

## O. Dead/duplicate/legacy components — confirmed

| Component | Status | Evidence |
|---|---|---|
| `components/BottomNav.tsx` | **Dead code — ✅ deleted post-audit (Bug Register BUG-01).** Was zero imports anywhere in `src/` (grep-confirmed). Fully duplicated `FloatingDock.tsx`'s unread/missed-call badge logic and realtime subscriptions under different channel names (`nav-*` vs `dock-*`), plus its own scroll-based auto-hide logic. | Repo-wide grep for `BottomNav` returned only the file's own definition, re-confirmed immediately before deletion. |
| `components/SurpriseOverlay.tsx` | **Dead code — ✅ deleted post-audit (Bug Register BUG-02).** Was zero imports anywhere in `src/`. Independently subscribed to a channel literally named `"code-surprises-realtime"` — same name `hooks/useChatSurprise.ts` uses for the *actually mounted* surprise flow (`ChatSurpriseHost`, rendered from `Chat.tsx`). `App.tsx`'s own comment states `ChatSurpriseHost` is "the only place" surprise deep links are resolved, confirming `SurpriseOverlay.tsx` was a superseded leftover. | Repo-wide grep for `SurpriseOverlay` returned only its own file; `App.tsx` comment; `ChatSurpriseHost` is what's actually rendered in `Chat.tsx`. Re-confirmed zero references immediately before deletion. |

No other dead/duplicate components were confirmed in this pass. Given the
size of the codebase (219 source files), this should be treated as a
**partial** dead-code inventory, not exhaustive — a full unused-export
sweep requires a working TypeScript/ESLint toolchain (blocked, see
Section 0) or a dedicated tool like `ts-prune`/`knip`, neither of which
could be installed here.

## P. Potential race conditions

All entries here are **[likely]** unless otherwise marked — they're
source-level reasoning about timing, not observed runtime failures.

1. **Partner-request accept flow already has a documented, fixed race**
   (`Settings.tsx`'s `acceptRequest`) — the in-source comment explicitly
   describes the original bug ("Between query 3 and 4, a concurrent
   accept could corrupt both users' partner_id") and its fix (atomic RPC
   `accept_partner_request`, with a `_v2` RPC fallback, and a
   last-resort manual path that re-checks `status === "pending"` before
   proceeding). **[confirmed, already fixed]** — flagged here only so a
   redesign doesn't accidentally revert to the old fallback-only shape
   while restyling this screen.
2. **Onboarding-check vs. timeout race** (`App.tsx`'s `ProtectedRoutes`)
   — deliberately raced against an 8s timeout with an explicit
   fail-open decision (see B). **[confirmed, already handled]** but worth
   noting: if a redesign changes this component's mount/unmount timing
   (e.g. wraps it in an additional Suspense boundary), the `cancelled`
   flag pattern needs to keep working correctly across remounts.
3. **`useDailyCall`'s `joinInProgressRef` re-entrancy lock** — guards
   against double-tap-join within one call session, and the
   `CallContext` singleton (see D) further guards against two *pages*
   creating competing `DailyCall` instances. **[confirmed, already
   fixed]** — same flag-for-awareness reasoning as above.
4. **Duplicate badge-count subscriptions (`BottomNav` + `FloatingDock`)**
   — not a live race today since `BottomNav` is unmounted/unused, but if
   ever re-mounted alongside `FloatingDock`, both would independently
   `UPDATE call_history SET status='seen'` on navigating to `/calls`,
   which is idempotent and therefore not itself dangerous, but doubles
   the query load for no benefit. **[likely, contingent on dead code
   being reintroduced]**.
5. **Chat message realtime channel (`messages-rt-${userId}`) vs. local
   optimistic send** — `Chat.tsx` both inserts a message via a direct
   `supabase.from("messages").insert(...)` call (implied by the presence
   of `send_at`, `message_type`, `disappear_at` fields being constructed
   inline) and listens for INSERT/UPDATE on the same table via realtime.
   Whether the local optimistic-append path and the realtime-echo path
   are properly deduplicated (e.g. by message id) was **not fully traced
   line-by-line** in this pass given the file's size (2050 lines) —
   **[needs deeper code read / runtime validation]** before treating
   Chat's message list as safe to restructure.
6. **Gallery realtime INSERT handler resolves a signed URL
   asynchronously** (`resolveGalleryUrl(rawItem.file_url).then(...)`)
   inside the realtime callback, then updates `partnerItems` state. If
   the component unmounted (user navigated away) or the effect re-ran
   (partner/user change) while that signed-URL fetch was in flight, the
   subsequent `setPartnerItems` call would run against a stale
   subscription. React 18+ tolerates the unmount case without throwing,
   so this was **low severity**, but it was a real, confirmed-from-source
   pattern, not a guess. **✅ Fixed post-audit (Bug Register BUG-04)** —
   `Gallery.tsx` now guards this callback with a `cancelled` flag set in
   the effect's cleanup, the same `mountedRef`-style pattern already used
   in `useDailyCall.ts`.

## Q. Error/loading/empty-state gaps

- **Route-level loading:** every lazy route has a dedicated
  `PageSkeleton` variant (`chat`, `grid`, `list`, `map`, `settings`,
  `default`) wired through `Lazy`/`PageFallback` in `App.tsx`.
  **[confirmed, good coverage at the route level.]**
- **Error boundary:** one `ErrorBoundary` wraps `<Outlet/>` in
  `AppLayout`, explicitly so "one crash doesn't kill the whole app"
  (comment: `FIX AUDIT #2`). This means a crash in any one page is
  isolated to that page's content area, not the whole shell (nav bar,
  Groic mini-player, etc. survive). **[confirmed]**
- **Per-feature empty/error states were not exhaustively enumerated** in
  this pass (e.g., does Gallery show a distinct empty-state illustration
  vs. a bare skeleton when a couple has zero shared photos? Does
  MapView handle "partner hasn't enabled location sharing" as a distinct
  state from "no GPS fix yet"?). This is flagged as an **open item**
  requiring a dedicated per-page pass, not claimed as either present or
  absent.
- **`send-push`/`send-voip-push` failures** — both edge functions are
  invoked from DB triggers server-side; whether a delivery failure
  surfaces *any* client-visible state (vs. silently failing) was not
  traced in this pass.

## R. Mobile keyboard/safe-area risks

- `capacitor.config.json` sets `Keyboard: { resize: "body", resizeOnFullScreen: true }`
  — the whole `<body>` resizes when the keyboard opens (rather than only
  the focused input scrolling into view), which is the correct setting
  for a chat-input-at-bottom layout but means **any fixed-position UI
  (dock, overlays) must be tested against keyboard-open state** — this
  wasn't runtime-verified here.
- `AppLayout.tsx` explicitly handles `env(safe-area-inset-bottom, 0px)`
  in its main-content padding calc, synced to dock visibility (see H).
  A comment documents a previously-fixed bug: iOS overscroll bounce could
  expose a white bar behind the notch, fixed via a `no-overscroll` CSS
  class. **[confirmed, already fixed — do not remove `no-overscroll`.]**
- Chat's bottom input bar, voice-recording UI, and the in-chat `GridMenu`
  hub are the highest-risk surfaces for keyboard-avoidance regressions
  given Chat.tsx's size and complexity — **[needs on-device validation]**,
  not verifiable from static source alone.

## S. Offline/reconnect risks

- **`OfflineBanner`** — rendered at the top of `AppLayout`, driven by
  `isOnline` from `useAppNative`. **[confirmed, exists and is wired.]**
- **Location offline queue** (`lib/locationQueue.ts`, 252 lines) —
  `useLiveLocation.ts`'s own doc comment states it has an "Offline write
  queue + replay on `online`/visibility/realtime resume." **[confirmed
  by hook's own documentation.]**
- **`lib/errors/recovery.ts`** — has a generic `online` event
  listener/cleanup pair for some recovery flow (exact scope not fully
  traced in this pass).
- **Resumable/chunked uploads** (`lib/resumableUpload.ts`) plus the
  `cleanup-orphan-uploads` cron edge function together imply the upload
  path is designed to survive a dropped connection mid-upload and clean
  up abandoned chunks after 24h — **[confirmed design intent from source
  comments; actual resume-after-reconnect behavior needs runtime
  validation.]**
- **Realtime channel reconnect behavior** — none of the 27 channel
  subscriptions inventoried in Section F were observed to have explicit
  custom reconnect/backoff logic beyond what the Supabase JS client does
  by default; whether any UI surfaces "reconnecting..." during a realtime
  drop (vs. silently missing updates until the next channel event) is
  **[needs runtime validation]**.

## T. Visual consistency problems

Not exhaustively catalogued in this pass — the brief's own instruction is
"do not redesign anything yet," so a full pixel/spacing/typography audit
was deprioritized in favor of the structural/behavioral map above, which
is the higher-risk area for a redesign to break silently. Recommend this
section be filled in as the *first* step of the actual redesign work
(a systematic screenshot pass per page/variant), rather than guessed at
here from source alone.

---

## Feature Matrix

Columns per the brief: Feature | Entry point | Components | Hooks |
Database tables | Edge functions | Realtime | Permissions | Loading state |
Empty state | Error state | Offline behavior | Native dependency | Known risks

| Feature | Entry point | Components | Hooks | DB tables | Edge functions | Realtime | Permissions | Loading state | Empty state | Error state | Offline behavior | Native dependency | Known risks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1:1 E2E chat** | `/chat` (`pages/Chat.tsx`) | `ChatSurpriseHost`, `MessageReactions`, `MessageStatus`, `TypingIndicator`, `QuotedMessage`, `ReplyPreview`, `MessageContextMenu`, `DisappearRing`/`DisappearGestureHandle`, `LoveLetter`, `ScheduledMessagePicker`, `GridMenu`, `PhotoViewer`, `CallEvent` | none dedicated (page-local state) + `useE2E` for key exchange | `messages`, `message_reactions`, `profiles`, `imported_chats`, `scheduled_messages` | `deliver-scheduled-messages` (cron) | 5 channels: `call-history-rt`, `imported-rt-*`, `messages-rt-${userId}`, `typing-${name}`, `presence-${sortedIds}` | Camera/mic (voice notes, attachments) | Route-level `PageSkeleton variant="chat"` | Not exhaustively verified — [needs validation] | `ErrorBoundary` at layout level catches page-level crashes; per-send error handling not fully traced | Not fully traced for message send queueing | none direct (haptics via `lib/haptics.ts`) | Largest/most complex page (2050 lines); optimistic-send vs. realtime-echo dedup not fully verified (P.5) |
| **Voice/video calls (Daily.co)** | `/calls` (`pages/Calls.tsx`) + app-wide `IncomingCallOverlay` | `IncomingCallOverlay`, call UI inside `Calls.tsx` | `useDailyCall` (via shared `CallContext`), `useAudioRoute` | `call_history`, `user_secrets` (Daily API keys) | `daily-call` | `incoming-calls`, `call-cancel` channels; `call-history-rt` in Chat | Camera, mic | `PageSkeleton variant="list"` | Not verified | Call-error classification exists (`lib/callErrors.ts`) | Not fully traced | `duospace-audio-route`, `duospace-callkit-bridge` plugins; native Telecom/CallKit sources | Previously-fixed "Duplicate DailyIframe" race (now guarded via `CallContext` singleton + `joinInProgressRef`) — **must stay a singleton** |
| **Gallery (shared/private)** | `/gallery` (`pages/Gallery.tsx`) | in-page (686 lines, no major sub-components split out) | none dedicated | `gallery_items`, `pending_uploads` | `finalize-upload`, `cleanup-orphan-uploads` | `gallery-rt-${sortedIds}` (INSERT/UPDATE/DELETE) | Camera, photo library, filesystem | `PageSkeleton variant="grid"` | Not verified | Not verified | Chunked/resumable upload (`lib/resumableUpload.ts`) implies offline-tolerant upload | `@capacitor/camera`, `@capacitor/filesystem` | Async signed-URL resolve inside realtime callback after possible unmount (P.6, low severity) |
| **Live location** | `/map` (`pages/MapView.tsx`, 815 lines) | in-page | `useLiveLocation` (578 lines) | `locations`, `profiles` (presence fields) | none dedicated | `partner-location-${partnerId}` | Location (native Geolocation via Capacitor) | `PageSkeleton variant="map"` | Not verified | Explicit `failed` state in `LiveLocationState` | Explicit offline write queue + replay (`lib/locationQueue.ts`) | `@capacitor/geolocation` | Adaptive accuracy + GPS smoothing/noise rejection already implemented; do not simplify away without checking `useLiveLocation`'s doc comment list of hardening measures |
| **Groic (music/playlist)** | `/groic` (`pages/Groic.tsx`), `/playlist` (`pages/Playlist.tsx`) | `GroicMiniPlayer`, `GroicFullPlayer`, `GroicInviteBanner` | `GroicContext` (419 lines, app-wide) | `playlist_songs`, `blend_invites` | `music-search` (rate-limited, auth-required) | Broadcast channel (dynamic name) + `blend-sync`, `blend-invites-rt` | none device-level (network only) | `PageSkeleton variant="list"` | Not verified | Not verified | Not fully traced | none | `GroicContext` only mounted inside `AppLayout` — unavailable if that provider boundary is restructured |
| **Us (relationship hub)** | `/us` (`pages/Us.tsx`, 469 lines) | `MemoryWall`, `MoodHistory` | none dedicated | `memories`, `mood_logs`, `countdowns`, `daily_answers`, `taps`, `menstrual_cycles` | none dedicated | `presence-${sortedIds}`, `incoming-taps`, plus `MemoryWall`'s own `memories-rt-${userId}` | none device-level | `PageSkeleton variant="list"` | Not verified | Not verified | Not fully traced | none | Broadest single-page table surface (6 tables) — highest blast radius if page state logic is touched |
| **Shayari** | `/shayari` (`pages/Shayari.tsx`, 312 lines) | in-page | none dedicated | `shayaris` | none dedicated | `shayaris-realtime` | none | `PageSkeleton variant="list"` | Not verified | Not verified | Not fully traced | none | Smallest/simplest feature — good low-risk candidate for early redesign |
| **Surprise Mode** | Inline in `/chat` via `ChatSurpriseHost`; deep-link `/surprise/:id` → `/chat?surprise=<id>` | `ChatSurpriseHost`, `CodeSurpriseFrame` (sandboxed `<iframe sandbox="allow-scripts">`), `CodeSurpriseEditor`, `surprise/SurpriseReveal`, `surprise/SurpriseScene3D` (WebGL) | `useChatSurprise` | `code_surprises`, `code_surprise_events` | none dedicated | `code-surprises-realtime` (via `useChatSurprise`) | none | Not verified | Not verified | Not verified | Not fully traced | WebGL (`SurpriseScene3D`) — GPU-dependent, needs device validation | **Dead duplicate exists**: `components/SurpriseOverlay.tsx` independently implements the same feature, unmounted, but reuses the identical channel name (F, O) |
| **Pairing/invites/QR** | `/settings` (primary), `/auth` (signup-time) | `QRSignInDisplay`, `QRSignInScanner` (correctly reused between both pages, not duplicated) | none dedicated | `partner_requests`, `qr_pairing_tokens`, `invite_links` | `issue-qr-token`, `redeem-qr-token`, `qr-anon-issue` | `partner-requests-rt` | Camera (QR scan) | Not verified | Not verified | Handled — partner-request accept has documented atomic-RPC race fix (P.1) | Not fully traced | Camera plugin | Token-hash-only server storage; single-use + short TTL; already-hardened accept flow — do not revert to old manual fallback while restyling |
| **Passkeys/biometric/PIN lock** | `/auth` (passkeys), app-wide `AppLockScreen` | `PasskeyLogin`, `PasskeyRegister`, `AppLockScreen` | `useBiometricLock` | `webauthn_credentials`, `webauthn_challenges` | `webauthn-register-options`, `webauthn-register-verify`, `webauthn-login-options`, `webauthn-login-verify` | none | Biometric (native) | Not verified | n/a | Not verified | Not fully traced | Native biometric APIs via Capacitor | PIN hashing is PBKDF2 (100k iter) with documented plaintext-migration path — RED |
| **Peek Guard** | App-wide, mounted once in `App.tsx` above the router | `PeekGuard`, `PeekConfigDialog`, `FaceEnrollmentDialog` | `usePeekDetection` (745 lines) | `mood_logs`(shares detection pipeline components), owner-embedding storage location not fully traced (likely local/IndexedDB, not a DB table — **needs confirmation**) | none dedicated | none (local camera pipeline only) | Camera | Not verified | n/a (always mounted) | Not verified | Runs purely on-device; no network dependency for detection itself | MediaPipe (WASM/WebGL), Web Worker (`faceDetection.worker.ts`) | `dismiss()` must be called by host UI or `isPeeking` never clears for the rest of the session (documented in hook's own comments) — RED, do not restyle the lock screen without preserving this call |
| **Mood detection** | App-wide (`MoodDetector` in `AppLayout`) + `/us` (`MoodHistory`) | `MoodDetector` (520 lines), `MoodHistory` (225 lines) | shares camera pipeline with Peek Guard via `cameraBus.ts` | `mood_logs` | none dedicated | none | Camera | Not verified | Not verified | Not verified | On-device only | MediaPipe | Shares the pooled camera resource (`lib/cameraBus.ts`) with Peek Guard — changing one's camera-acquisition timing can starve the other |
| **Cloud backup/restore** | `/settings` (`BackupManager`) | `BackupManager` (277 lines) | `useCloudBackup` (388 lines) | `backup_runs` | none dedicated (uses Supabase Storage `backups` bucket directly) | none | Filesystem (native export/import) | Not verified | Not verified | Explicit `BackupStatus` includes `"error"` | Not fully traced | `@capacitor/filesystem`, `@capacitor/preferences` (device secret) | AES-GCM encryption with device-local PBKDF2 key — losing the device secret makes existing backups unrecoverable by design (verify this is surfaced to the user somewhere before redesigning this flow's messaging) |
| **WhatsApp import** | `/chat` or `/settings` (exact single entry point not fully isolated in this pass) | Not isolated to a specific component in this pass — **[needs follow-up]** | Not isolated | `imported_chats` | none dedicated found | `imported-rt-${sortedIds}` (confirmed in `Chat.tsx`) | Filesystem (reading exported WhatsApp `.txt`/`.zip`) | Not verified | Not verified | Not verified | Not fully traced | Filesystem | Least-documented feature in this pass — flagged as an area needing a dedicated follow-up read before redesign |
| **Themes/wallpapers/icon customization** | `/settings` | `ThemeStudio` (354 lines), `IconStudio` (558 lines) | `ThemeContext` (app-wide) | none dedicated found (theme prefs likely in `profiles` or client-only) | none dedicated | `couple-theme-${userId}` | none | Not verified | Not verified | Not verified | Not fully traced | `iconGenerator.ts`/`safeIcon.ts`/`appIconConfig.ts` for dynamic app-icon generation — native icon swap needs on-device validation | Couple-shared theme sync means restyling one partner's UI can push state to the other in real time — test both sides |
| **Push/VoIP notifications** | App-wide (`usePushNotifications`, 213 lines) | `IncomingCallOverlay` (consumes VoIP-triggered call state) | `usePushNotifications` | `push_tokens`, `notification_history`, `notification_preferences`, `apns_push_log` | `send-push` (FCM HTTP v1), `send-voip-push` (APNs HTTP/2) | none direct (triggered by DB triggers on `messages`/`call_history`/`partner_requests`) | Push notification permission (native) | n/a | n/a | Not verified | Server-side dispatch is trigger-driven, independent of client connectivity at send time | `@capacitor/push-notifications`, native APNs/FCM wiring, `duospace-callkit-bridge`/PushKit for iOS VoIP | Android FCM and iOS VoIP paths are documented as **fully independent** — a dual-platform couple gets both; do not assume one implies the other when redesigning notification settings UI |
| **Capacitor Android/iOS support** | Cross-cutting | n/a | `useAppNative`, `useDeviceStatus`, `useAudioRoute` | n/a | n/a | n/a | Aggregates all native permission flows | n/a | n/a | n/a | `lib/networkState.ts` for connectivity detection | All native plugins + `native/android`, `native/ios` sources | Native build/verification is entirely blocked in this audit environment (Section 0) — treat all native-specific claims here as source-derived, not device-verified |

---

## Internal dependency map (text form)

```
ThemeContext ──┬─ AppLockScreen (isAppLocked)
               ├─ PeekGuard (theme tokens for lock UI)
               ├─ Settings → ThemeStudio, IconStudio
               ├─ couple-theme realtime channel (bidirectional w/ partner)
               └─ nearly every page (token consumption)

CallContext (wraps single useDailyCall instance)
   ├─ Chat.tsx (in-chat call controls / CallEvent)
   ├─ Calls.tsx (dedicated call screen)
   └─ IncomingCallOverlay (ring/answer/decline)
        └─ native duospace-callkit-bridge (Telecom/CallKit) via
           "duospace-call-control" window CustomEvent

GroicContext (mounted only inside AppLayout)
   ├─ GroicMiniPlayer / GroicFullPlayer / GroicInviteBanner (AppLayout children)
   ├─ Groic.tsx (full page)
   └─ Playlist.tsx (blend-sync / blend-invites-rt channels)

cameraBus.ts (pooled, refcounted camera stream)
   ├─ usePeekDetection (Peek Guard)
   ├─ MoodDetector
   ├─ CameraWithFilters (manual capture)
   └─ FaceEnrollmentDialog (owner enrollment)

useAuth ──┬─ ProtectedRoutes (App.tsx) — gates entire authenticated shell
          ├─ useSessionGuard (AppLayout) — expiry/refresh/conflict toasts
          └─ every page needing user.id for queries/channels

storage.ts / idbStore.ts (keystore) / Capacitor Preferences
   ├─ storage.ts        → UI prefs, splash-seen flag, media-visibility toggle
   ├─ idbStore/keystore  → E2E keypair (crypto.ts)
   └─ Preferences (native)→ cloud-backup device secret
```

---

## Summary of confirmed findings feeding the Bug Register

1. `components/BottomNav.tsx` — fully dead, duplicate of `FloatingDock.tsx`. **✅ Fixed — deleted (BUG-01).**
2. `components/SurpriseOverlay.tsx` — fully dead, duplicate of `ChatSurpriseHost`/`useChatSurprise`, and shared a realtime channel *name* with it. **✅ Fixed — deleted (BUG-02).**
3. Toolchain cannot run (`npm install` blocked by registry 403; `tsc`/`eslint`/`vitest` all downstream-blocked). Only the repo's own dependency-free `check-rls-coverage.ts` script could be executed, and it passed (35/35 tables, RLS + policies present). **⚠️ Still open (BUG-03)** — an environment constraint, not something a code change can resolve; re-confirmed still blocked after the fixes below were made, and every changed file was instead run through an isolated, dependency-free `tsc` syntax-only pass (zero `TS1xxx` errors) as a partial substitute.
4. Several previously-fixed races are extensively self-documented in source (Daily.co duplicate-instance crash, partner-request accept race, onboarding-check hang, iOS overscroll white-bar, dock-padding gap, missed-call badge not persisting to DB) — these are not open bugs, but they're exactly the kind of behavior a careless visual redesign could silently reintroduce, so each is cross-referenced above at its relevant section. No changes were made to any of this logic.
5. One low-severity, unconfirmed-severity async-after-unmount pattern in Gallery's realtime INSERT handler (P.6). **✅ Fixed — mounted-guard added (BUG-04)**, done as a small low-risk improvement even though the original register marked it "not required."
6. WhatsApp import feature's entry point/components were not fully isolated in this pass and needs a dedicated follow-up read. **Not addressed in this fix pass** — it wasn't a confirmed bug, just an audit gap; no code changed for this item.

See `docs/UI_REDESIGN_BUG_REGISTER.md` for these as individually numbered, severity-tagged issues (now with fix status), and the Redesign Safety Map at the end of that document for the GREEN/YELLOW/RED classification per area.
