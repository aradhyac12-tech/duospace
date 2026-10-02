Privacy enforcement architecture. Implementation:
`src/lib/privacy/privacyGate.ts`.

## The pipeline

```
FEATURE REQUEST
  -> CAPABILITY CHECK   (FEATURE_CAPABILITIES — is this even built?)
  -> ABSOLUTE DENY RULES (dataClassification.ts — cannot be overridden by consent)
  -> CONSENT CHECK      (consent.ts's hasConsent() — fails closed)
  -> DESTINATION SANITY CHECK (second, independent check on the two highest-risk classes)
  -> ALLOW / DENY, with a reason
```

`canProcess(request)` returns `{ allowed, reason }`; `requireCanProcess()`
throws instead, for call sites that want fail-fast. Neither function
"processes" anything — this is a pure decision service so it can be
called from a React hook, a local processor, or a future edge function
without pulling in UI/processing code.

## Absolute deny rules (cannot be unlocked by consent)

DEVICE_ONLY → CLOUD_AI, DEVICE_ONLY → SUPABASE, SECRET → CLOUD_AI. See
`dataClassification.ts`'s `ABSOLUTE_DENY_RULES` — checked *first*, before
capability or consent, specifically so a consent bug can never become a
privacy breach on its own.

## Capability gate

`FEATURE_CAPABILITIES` is a second, independent lock: a feature can be
fully consented-to and still capability-off. As of this phase, every
relationship-AI capability is `false` (the feature freeze —
`.ai/DO_NOT_BUILD.md`); only ANALYTICS/CRASH_DIAGNOSTICS are `true`
(they're the two capabilities that already exist, `telemetry.ts`).
Flipping one to `true` should only happen when the feature behind it is
actually implemented and reviewed.

## Who actually calls this

As of this phase: nothing does yet — there's no relationship-AI feature
to gate. The `PrivacyAISettings.tsx` toggle screen writes consent records
via `consent.ts` directly, which is correct (consent state itself isn't
gated by the pipeline that reads it). `runLocalProcessor()` in
`../ai/localProcessor.ts` is the wrapper the first real feature should
call through — it runs `canProcess()` before invoking a processor and
`validateInsight()` after, so a feature author gets both checks by
construction rather than having to remember to call them.

## Analytics/logging boundary

See `.ai/DATA_CLASSIFICATION.md` and `src/lib/privacy/redact.ts` — wired
into `telemetry.ts`'s `formatExtra()` (the path everything logged through
`logError`/`logWarn`/`logInfo` goes through, both the stored ring-buffer
event and the dev-console echo) so a secret-shaped field or a JWT-shaped
string value never reaches a log line or a future real crash-reporting
backend, regardless of which call site forgot to sanitize it themselves.

## Known gap

No feature yet exercises this pipeline end-to-end with a real user
decision — see `.ai/TEST_STATUS.md` for what is and isn't covered.


## Phase 1.6 additions
- **Destinations.** `ProcessingLocation` = DEVICE, SUPABASE, CLOUD_AI, PARTNER,
  ANALYTICS, LOGS. The full class x destination matrix is in
  `dataClassification.ts` (`POLICY_MATRIX`) and mirrored in `DATA_CLASSIFICATION.md`.
- **Gate order:** policy matrix -> capability -> user present -> feature consent
  -> destination consent (CLOUD_AI needs `CLOUD_AI_PROCESSING`; PARTNER needs
  `SHARED_INSIGHTS`; ANALYTICS needs `ANALYTICS`; LOGS needs `CRASH_DIAGNOSTICS`)
  -> explicit per-item share for partner egress of SENSITIVE/HIGHLY_SENSITIVE.
- **Sensors.** Every camera/microphone consumer is a registered purpose in
  `src/lib/privacy/sensorPolicy.ts` with activation model, raw/derived
  handling and known gaps. `cameraBus.acquireCamera(facing, purpose)` enforces it
  at runtime; a static test fails if any `src/` file opens the camera/mic
  without being registered. Direct `getUserMedia` users (voice message, QR,
  permission probe, call engines) are registered but not runtime-enforced.
- **Item-level sharing:** `src/lib/ai/sharing.ts::authorizeInsightShare`.
- **Telemetry:** `redact()` key list widened (JWK, embeddings, transcripts,
  coordinates, SDP, PIN/OTP); free-text `context`/`message` and flattened object
  extras are redacted; upload is consent-gated.

## Phase 3C — conflict-repair data classification (2026-09-25)
| Class | Default | Where it lives |
|---|---|---|
| A raw private reflection | PRIVATE | React state only; never stored or sent |
| B partner-provided message (pasted) | PRIVATE | React state only |
| C AI/rule-derived interpretation | PRIVATE | React state only; never shareable |
| D repair draft | PRIVATE | React state only |
| E safety-sensitive content / safety state | PRIVATE | never stored, logged or shared |
| F shared repair content | SHARED only after explicit preview + confirm | `relationship_shares` kind REPAIR_MESSAGE; DB constraint allows exactly {v, kind, message}; owner can withdraw (revoke) |
| G metadata | minimised | share row ids/timestamps only |
No analytics, crash reports or model telemetry contain repair content (static test on the repair core).

## Phase 3E (2026-09-25) — encryption, precisely
AES-256-GCM (Web Crypto), random 96-bit IV per write, 128-bit tag; per-user key, extractable JWK in IndexedDB; ciphertext in Capacitor Preferences. Wiped (key deleted) on Settings sign-out. Not hardware-backed: protects against casual inspection/backups (Android backup disabled), NOT against rooted devices or code running in the app. Observed: private relationship-AI paths make zero network calls (test with fetch/XHR/WebSocket/Supabase recorders).
