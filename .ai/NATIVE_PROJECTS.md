> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01).

## Are android/ and ios/ committed?

No, by design. Generated via `npm run cap:add:android` / `cap:add:ios` /
`cap:sync`, wrapped with permission-patching and asset-generation scripts
(`scripts/patch-native-permissions.mjs`,
`scripts/patch-native-kotlin-versions.mjs`) that run automatically via
Capacitor's own lifecycle hooks and `postinstall`.

## Manually maintained (outside the generated tree)

`native/android/`, `native/ios/` — raw resources (icons, sounds).
`native-plugins/*/android/`, `native-plugins/*/ios/` — five custom
Capacitor plugins with real Kotlin/Swift (audio-engine, callkit-bridge,
background-geolocation, device-status, audio-route). A `cap sync` should
not touch these directly, but verify before trusting that on any given
pass.

## Self-hosted calling scaffold (parallel track)

`infrastructure/signaling/` (a custom Node signaling server),
`src/lib/callEngine/`, `src/lib/signalingEngine/` — a LiveKit-based
alternative to Daily.co, explicit opt-in via a feature flag, never the
default. Wired end-to-end by static analysis in the most recent passes
that touched it; never runtime-verified (no LiveKit/device access in any
sandbox so far). See `docs/calling-architecture-v2.md` if present.

## Build/signing

Not verified in any sandbox — no Android SDK or Xcode available. No
keystores/provisioning profiles/production secrets present in any
snapshot (confirmed by repeated searches across sessions).


## Phase 1.6 verification (static only)
- `android/` and `ios/` are NOT in the repo; strategy is GENERATED (confirmed).
  Reproduce: `npm ci && npm run build && npm run cap:add:android` (verifies deps,
  `cap add`, patches manifest/permissions, copies `native/android/*.kt`, runs
  `cap:verify:native`, generates assets) and `npm run cap:add:ios` (macOS only).
  `npm run cap:sync` repeats the sync + patch. **None of this was executed** (no
  network, no SDKs) — NOT VERIFIED.
- `capacitor.config.json`: appId `com.duospace.app`, webDir `dist`.
- Local plugins (`native-plugins/*`): each has package.json with a `capacitor`
  block, a podspec, an Android `build.gradle` (own namespace, Kotlin pinned via
  the root's `kotlinVersion` when present, else 2.1.0), and a `@CapacitorPlugin` /
  `CAPBridgedPlugin` class. They are linked by `file:` deps and registered in the
  lock as links (`check:lock` verifies their dependency lists match). Their
  `main` points at a `dist/` that is never built; the web build resolves them
  through aliases in `vite.config.ts`, `tsconfig.app.json` and (added in Phase
  1.6) `vitest.config.ts`.
- Signing keys, keystores, provisioning profiles: none in the repo.
- Manual step remaining on iOS: add `CallKitManager.swift` / `PushKitManager.swift`
  to the Xcode App target (KI-29).
