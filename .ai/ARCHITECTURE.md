System architecture reference. First time this file has existed in
`.ai/` — prior passes covered architecture within `PROJECT_CONTEXT.md`/
`CURRENT_STATE.md` (see those, where present — note: several `.ai/` files
referenced by this project's own phase briefs, including those two, are
missing from the snapshot this phase started from; see
`.ai/KNOWN_ISSUES.md`).

## Frontend
React + TypeScript, Vite, Tailwind, Framer Motion, shadcn/ui.

## Backend
Supabase: Postgres + RLS, Realtime (postgres_changes safe-by-RLS;
broadcast/presence channels Authorization-gated as of 2026-09-16 — see
`docs/PHASE_4_SECURITY_AUDIT.md` §18), Storage, ~22 Edge Functions.

## Native
Capacitor. `android/`/`ios/` generated on demand, not committed (see
`.ai/NATIVE_PROJECTS.md` if present in your snapshot). Five custom
plugins under `native-plugins/`.

## Calling
Self-hosted only (no provider switch, no fallback): authenticated WebSocket
signaling (`infrastructure/signaling/`, `src/lib/signalingEngine/`) for
ring/accept/reject/cancel/end; self-hosted LiveKit (`src/lib/callEngine/`,
edge function `livekit-token`) for media; LiveKit embedded TURN; FCM /
APNs+PushKit for wake-up; native Telecom/ConnectionService (Android) and
CallKit (iOS) unchanged. Supabase = auth, authorization, history. Not yet
verified on real devices. Authoritative: `docs/calling-architecture.md`.

## Privacy / AI foundation (new this phase — Phase 1)

```
src/lib/privacy/
  dataClassification.ts   7-tier sensitivity enum + absolute deny rules
  consent.ts               ConsentFeature enum + hasConsent/grant/revokeConsent
  privacyGate.ts            canProcess() pipeline: capability -> deny-rules -> consent -> destination
  redact.ts                 log/telemetry redaction (wired into telemetry.ts)
  secureStorage.ts          software AES-256-GCM local storage (see SECURITY_MODEL.md's honest caveat)
src/lib/ai/
  types.ts                  AIInsight contract (observation/confidence/uncertainty/provenance/lifecycle/sharing)
  outputValidator.ts        structural + prohibited-phrase safety validator
  localProcessor.ts         LocalAIProcessor interface + runLocalProcessor() wrapper (gate -> run -> validate)
src/pages/settings/PrivacyAISettings.tsx   consent toggle UI
supabase/migrations/20260917100000_privacy_consent_ai_foundation.sql
  user_consents, ai_insights tables + RLS + 3 enforcement triggers
```

No relationship-AI feature exists yet — everything above is the
foundation a future feature will build on top of, per the feature freeze
in `.ai/DO_NOT_BUILD.md`.

## For each subsystem: input / processing / output / dependencies / security boundary / failure modes

See the file-level doc comments in the files listed above — each was
written with this framing rather than duplicated here, to avoid two
copies of the same reasoning drifting apart.
