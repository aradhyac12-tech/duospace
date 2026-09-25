Architectural decisions log. Only genuinely-made decisions, not
aspirational ones — see each entry's date/context.

## Consent is per-feature, server-of-record, not device-local
Decided this phase. A person's consent choices should follow them across
devices the same way the rest of their account state does; `user_consents`
is a normal RLS-protected Supabase table, not a local-only setting.
Trade-off: requires a network round-trip (mitigated with a 30s cache) and
means consent state doesn't exist offline-first — accepted, since consent
correctness matters more than offline availability here.

## Absolute deny rules live in code, checked before consent, not as a consent option
Decided this phase. DEVICE_ONLY → cloud and SECRET → cloud can never be
consented into. This is a design choice, not just an oversight-avoidance
measure: some things shouldn't be offerable as a toggle at all.

## Local encrypted storage is software AES-GCM, not hardware-backed, for now
Decided this phase, with the limitation stated plainly rather than
implied away (`.ai/SECURITY_MODEL.md`, `.ai/KNOWN_ISSUES.md` KI-02).
Building real native Keystore/Keychain integration blind, with no device
to test it on, was judged worse than being honest about not having it
yet — a broken security feature that looks secure is worse than an
honestly-labeled partial one.

## AI insight immutability is enforced by a database trigger, not just app convention
Decided this phase, matching the established pattern from
`call_history_transition_guard`/`partner_requests_transition_guard`
(prior security-audit passes). "Don't assume frontend filtering is
security" (this phase's own brief) applies to the AI contract's integrity
guarantees just as much as to authorization.

## A correction never overwrites the original insight
Decided this phase (`AIInsight.correction` is additive, DB-enforced).
Rationale: silently editing history is how model calibration data gets
lost and how a user's trust that a correction actually did something gets
undermined.

## No relationship-AI feature ships this phase
Restated from the phase brief itself, not new: this phase is
infrastructure only. The first feature to use `LocalAIProcessor`/
`AIInsight`/`PrivacyGate` is future work, gated on this foundation
existing and (per `.ai/NEXT_PHASE.md`) on the still-open security queue
being closed first.

## Existing decisions (carried forward, not re-litigated this phase)
E2E encryption preservation, no surveillance, no factual cheating/
deception detector, native calling remains native, Supabase RLS
mandatory, native android/ios projects generated-not-committed — see
`docs/PHASE_4_SECURITY_AUDIT.md` and earlier `.ai/` history where present
in your snapshot.


## Phase 1.6 decisions (2026-09-20)
- **D-1.6-1 npm is canonical.** `vercel.json` (`npm ci`), `netlify.toml` (`npm run build`; Netlify picks npm from `package-lock.json`),
  `packageManager: npm@10.9.2`, `engines.node>=22`. There is no `bun.lock` in the
  repo; do not add one. Stale `check-rls-coverage.ts` mentions bun (KI-28).
- **D-1.6-2 The policy matrix is the single source of truth** for "may class X go
  to destination Y" (`POLICY_MATRIX`). `ABSOLUTE_DENY_RULES` is derived from it.
  Unknown class/destination = DENY. New destinations PARTNER/ANALYTICS/LOGS exist
  so leaks to them can be refused, not merely undescribed.
- **D-1.6-3 Two authorities, split by where data goes.** Data that stays on the
  device (Peek Guard, the on-device half of Daily Mood) is governed by the *local,
  synchronous* opt-in toggles, enforced in `cameraBus.acquireCamera` — it must keep
  working offline and must not depend on a network round-trip. Anything that
  leaves the device (server, cloud AI, partner, analytics) is governed by the
  server-side `user_consents` model through `PrivacyGate`, failing closed.
- **D-1.6-4 Capabilities now match reality:** `CAMERA_ANALYSIS` and
  `MOOD_PROCESSING` are true (those features ship); relationship-AI capabilities
  stay false.
- **D-1.6-5 Camera-derived output is a guess until confirmed.** It is stored with
  `features.source`, and reaches the partner-visible profile only after the user
  confirms it.
- **D-1.6-6 Telemetry uploads fail closed** until `CRASH_DIAGNOSTICS`/`ANALYTICS`
  consent is read from the server; `clearConsentCache()` resets to off.
- **D-1.6-7 Native projects are GENERATED, not committed** (already the design;
  confirmed by the scripts). No `android/`/`ios/` were generated here.
