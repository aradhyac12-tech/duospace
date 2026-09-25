RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01). Not
independently re-derived from scratch; spot-check against current source
before treating any specific line as still accurate, but this is real
authored history, not a placeholder.

Architectural and product rules. These are load-bearing — violating any
of them is a regression even if it "fixes" something else.

## Product / AI safety (non-negotiable)

- DO NOT implement any feature that secretly monitors, records, or
  exposes one partner's device/messages/location/accounts to the other
  without that partner's own active, visible action.
- DO NOT implement or claim cheating, lying, deception, or hidden-intent
  detection as factual/certain, from any signal (face, voice, eye
  contact, text).
- DO NOT collapse relationship health into a single score. Use
  multidimensional, uncertainty-aware framing if this is ever built.
- DO NOT auto-activate camera or microphone without an explicit,
  visible, in-the-moment user action.
- DO NOT implement DuoAutoAnswer beyond specification. If implemented
  later: audio-only by default, fail-closed on any uncertainty.

## Security / data (non-negotiable)

- DO NOT weaken or remove Row Level Security on any table.
- DO NOT expose `service_role` credentials or any secret to
  client-reachable code.
- DO NOT delete existing migrations. Additive migrations only.
- DO NOT perform destructive schema changes without a validation pass
  against every current call site.
- DO NOT remove or weaken E2E encryption.
- DO NOT claim a test passed, or that live-DB/real-device behavior is
  verified, when it was not actually run. Use NOT TESTABLE / BLOCKED BY
  ENVIRONMENT / NOT VERIFIED honestly.

## Architecture

- DO NOT reintroduce a second calling provider, a provider switch, or a
  fallback. Calls are self-hosted only: WebSocket signaling for call control,
  LiveKit for media, embedded TURN, FCM/APNs/PushKit for wake-up, native
  Telecom/CallKit preserved (see docs/calling-architecture.md). DO NOT make
  Supabase Realtime part of the normal call lifecycle.
- DO NOT reintroduce a second/duplicate calling implementation —
  `CallContext.tsx` is the single global call manager by design.
- DO NOT commit `android/`/`ios/` unless a deliberate decision is made
  to switch the native-project strategy from generated to committed.
- DO NOT commit keystores, provisioning profiles, private signing keys,
  or production secrets of any kind.
- DO NOT unnecessarily redesign the UI or rename large systems as a side
  effect of an unrelated fix.

## Process

- Read `.ai/PROJECT_CONTEXT.md`, `.ai/CURRENT_STATE.md`,
  `.ai/NEXT_PHASE.md`, `.ai/IMPLEMENTATION_RULES.md`, and this file
  before changing code.
- Check what environment/tool access you actually have before assuming
  the constraints logged in `CURRENT_STATE.md` still apply.
- Update `.ai/CURRENT_STATE.md`, `CHANGELOG.md`, and the relevant `docs/`
  file for any change that touches security, privacy, or a documented
  claim.


## Added in Phase 1.6
- Do not add a camera/microphone consumer without registering it in
  `src/lib/privacy/sensorPolicy.ts`; the inventory test will fail otherwise.
- Do not call `cameraBus.acquireCamera` without a purpose, and do not pass
  `userInitiated: true` from anything that isn't a direct user tap.
- Do not change a `POLICY_MATRIX` cell from X to anything else without a
  security review; never add an "allow" fallback for unknown values.
- Do not write camera-derived (or any AI-derived) data to `profiles` or another
  partner-visible surface before the user has confirmed it.
- Do not persist `duo-settings` before dependent flags are cleared
  (`ThemeContext.updateSetting`).
- Do not hand-edit `package-lock.json`; regenerate with npm.
