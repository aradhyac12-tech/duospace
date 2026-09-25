# DuoSpace — Phase 1: Privacy, Consent & Local-First Intelligence Foundation — Final Report

## 1. Executive Summary

This phase built the infrastructure future relationship-AI features will
depend on: a data-sensitivity classification, a feature-specific
revocable consent system enforced at both the app layer and the database
layer, a privacy gate every sensitive processing step must pass through,
a canonical AI-insight contract with a safety validator that structurally
prevents bare-certainty claims, a local-processor interface, local
encrypted storage, and a settings UI to control it all. No
relationship-AI feature was built — that was never this phase's job, and
the feature freeze from the prior phase is still fully in effect.

Everything described as "done" below is real code, hand-verified against
its own call sites and against the rest of the codebase. Nothing has been
compiled, linted, or executed — `npm ci` still returns a 403 from the
package registry in this sandbox, the same as every prior pass. That
distinction is maintained throughout this report rather than blurred.

## 2. Initial Architecture (what existed before this phase)

Discovery pass (§4 of the brief) found: no consent/privacy/data-
classification system of any kind; a real E2E message-encryption layer
(`src/lib/crypto.ts`, ECDH P-256 + AES-GCM, private keys in IndexedDB —
pre-existing, not touched); plain (unencrypted) local storage via
`prefs.ts`/`storage.ts`; a lightweight telemetry/error-logging system
(`telemetry.ts`) with no redaction; no AI/insight types or tables of any
kind. This phase did not duplicate any of the above — it built new,
separate infrastructure and, where it made sense, wired into the
existing telemetry system rather than replacing it.

## 3. Data Classification

`src/lib/privacy/dataClassification.ts` — the 7-tier `DataClassification`
enum (PUBLIC/PRIVATE/COUPLE/SENSITIVE/HIGHLY_SENSITIVE/SECRET/
DEVICE_ONLY) plus `ABSOLUTE_DENY_RULES`, a small table of
(classification, destination) pairs that can never be allowed regardless
of consent (DEVICE_ONLY→CLOUD_AI, DEVICE_ONLY→SUPABASE, SECRET→CLOUD_AI).
See `.ai/DATA_CLASSIFICATION.md` for how this maps onto the app's actual
existing data.

## 4. Consent Implementation

`src/lib/privacy/consent.ts` — 11 `ConsentFeature` values, one record per
(user, feature) in the new `user_consents` table (server-of-record, RLS
owner-only, no DELETE policy — revocation, not erasure, is the supported
action). `hasConsent()` fails closed on any read error. A 30-second
in-memory cache avoids a round-trip on every gated check;
`grantConsent`/`revokeConsent` invalidate it immediately, and — found and
fixed this phase — sign-out now also clears it explicitly. See
`.ai/CONSENT_MODEL.md`.

## 5. Privacy Gate

`src/lib/privacy/privacyGate.ts` — `canProcess(request)` runs: absolute
deny rules → capability gate (`FEATURE_CAPABILITIES`, every
relationship-AI capability `false` right now per the freeze) → consent
check → a second independent destination check on the two highest-risk
classes. `requireCanProcess()` throws for fail-fast call sites. See
`.ai/PRIVACY_MODEL.md`.

## 6. Local AI Abstraction

`src/lib/ai/localProcessor.ts` — `LocalAIProcessor` interface (no
concrete implementation; none was supposed to exist yet) and
`runLocalProcessor()`, which runs the privacy gate before and the safety
validator after any processor's `run()`, so a future feature author gets
both checks by construction. See `.ai/LOCAL_AI_ARCHITECTURE.md`.

## 7. AI Insight Contract

`src/lib/ai/types.ts` — the full `AIInsight` shape: observation,
confidence (LOW/MEDIUM/HIGH only), uncertainty, context,
possibleExplanations (≥2), suggestedAction, source (six-value enum
distinguishing user statements from every flavor of AI derivation),
modelVersion, dataClassification, processingLocation, consentReference,
lifecycle (TEMPORARY/ACTIVE/EXPIRED/CORRECTED/DELETED), expiresAt,
correction, sharing (PRIVATE/SHARE_PENDING/SHARED/REVOKED),
sharedWithUserId, sharedAt. See `.ai/AI_OUTPUT_CONTRACT.md` for the
field-by-field rationale.

## 8. AI Safety Validator

`src/lib/ai/outputValidator.ts` — two independent layers, per the
brief's own instruction not to rely solely on string matching:
structural validation (required fields, ≥2 explanations, model source
requires a version, confidence capped per source type at MEDIUM unless
the source is the user's own words) and a prohibited-phrase scan
(cheating/lying/"definitely angry"/"doesn't love you"/"will fail"/
"break up"/toxic/"100%"/"hiding something"/"proves deception", matched
case-insensitively against every free-text field including each
possible explanation). A `suggestedAction` directed at the partner
("your partner should...") is also rejected. Honestly scoped limitation,
stated in `.ai/AI_SAFETY_SPEC.md`: a determined generator could likely
phrase an unsupported claim around the exact denylist — the structural
layer (no field exists for bare certainty) is the stronger defense for
exactly that reason.

## 9. Provenance

The `source` field (`InsightSource`) is the mechanism: USER_REPORTED,
USER_ENTERED, LOCAL_MODEL, LOCAL_RULE, SHARED_COUPLE_DATA, CLOUD_MODEL.
An AI-derived interpretation can never be stored or queried as if it were
a user statement — the field is immutable after creation (see §15).

## 10. Confidence/Uncertainty

Three-level confidence (never a percentage), a required non-empty
`uncertainty` field, and a per-source ceiling enforced by the validator —
see §8. No source type may claim more certainty than the evidence tier it
actually represents.

## 11. User Correction

`AIInsight.correction: { verdict, note?, correctedAt } | null` — additive,
not destructive. The database's immutability trigger (§15) specifically
permits this field to change while blocking every other field, so a
correction can never accidentally overwrite the original provenance data
future calibration would need. No UI for this yet — nothing exists to
correct.

## 12. Insight Lifecycle

`lifecycle: TEMPORARY | ACTIVE | EXPIRED | CORRECTED | DELETED` +
`expiresAt`. No automated expiry job exists yet (nothing to expire) — see
`.ai/RELATIONSHIP_MEMORY_SPEC.md`'s Known Gap.

## 13. Secure Local Storage

`src/lib/privacy/secureStorage.ts` — software AES-256-GCM (Web Crypto
API), master key generated once and held in the same IndexedDB store the
pre-existing E2E crypto already trusts, values written through the
existing `prefs.ts` wrapper. **Honestly not hardware-backed**: real
Android Keystore/iOS Keychain integration needs a native Capacitor
plugin, which needs a native toolchain and a physical device to build and
verify — neither available in this environment. Building that blind was
judged worse than shipping a clearly-labeled software-only version. See
§17 and `.ai/KNOWN_ISSUES.md` KI-02.

## 14. Key Management

Master key: generated once per (user, device), stored in IndexedDB, never
synced. Rotation: not implemented (would need a re-encryption migration
strategy this phase didn't design). Invalidation: `secureWipeAll(userId)`
deletes the key (irrecoverable ciphertext, correct behavior) — wired into
sign-out this phase (found unwired, fixed), **not** wired into account
deletion (that flow wasn't located this pass). Device loss: no recovery
path, by design — this storage is meant for data that shouldn't survive a
lost device; the separate cloud-backup system is unaffected and already
user-key-encrypted before upload.

## 15. Supabase Changes

One migration:
`supabase/migrations/20260917100000_privacy_consent_ai_foundation.sql`.
Two new tables (`user_consents`, `ai_insights`), 7 RLS policies, 3
triggers:
- `touch_user_consents_updated_at` — housekeeping.
- `enforce_ai_insight_consent` (BEFORE INSERT) — independently re-verifies,
  at the database layer, that an insight's `consent_reference` is real,
  belongs to the same user, and is currently granted. A client-side
  PrivacyGate bug or a direct API call cannot bypass this.
- `enforce_ai_insight_immutability` (BEFORE UPDATE) — only lifecycle,
  expires_at, correction, sharing, shared_with_user_id, and shared_at may
  ever change after an insight is created.

Pattern deliberately mirrors the already-audited
`call_history_transition_guard`/`partner_requests_transition_guard`
triggers from the security-audit track.

## 16. RLS

`user_consents`: owner SELECT/INSERT/UPDATE, no DELETE (audit-trail
design). `ai_insights`: owner SELECT/INSERT/UPDATE/DELETE, plus SELECT
for a partner the insight was explicitly `SHARED` with — nobody else,
never by default. Two-account isolation was reasoned through by hand
(user_id = auth.uid() everywhere, no couple-wide default visibility) but
not tested against a live database — see §26.

## 17. Sharing Architecture

`sharing: PRIVATE | SHARE_PENDING | SHARED | REVOKED`. Nothing shares
automatically — every insight defaults to PRIVATE. `shared_with_user_id`/
`shared_at` record who and when. No UI to actually change sharing state
exists yet (nothing to share).

## 18. Deletion / Export

Deletion: RLS DELETE policy on `ai_insights` gives owners deletion by
row; no bulk "delete all AI data" action built yet. Consent: revocation
is supported and enforced; consent-record deletion is not (see §4).
Export: not built this phase for either consent or insights — flagged in
`.ai/KNOWN_ISSUES.md` KI-05.

## 19. Analytics Privacy

`src/lib/privacy/redact.ts` — denylist-of-key-names (token/secret/
password/api_key/private_key/jwt/authorization/credential/raw-audio-or-
video/message-content, etc., matched case-insensitively) plus a
JWT-shape string-value check, applied recursively through nested objects
and arrays, with circular-reference protection. Wired into
`telemetry.ts`'s `formatExtra()` — the single choke point every
`logError`/`logWarn`/`logInfo` call already passed through — covering
both the stored ring-buffer event (what a future real crash-reporting
backend would receive) and the dev-console echo, not just one or the
other.

## 20. Error Logging / Redaction

Same mechanism as §19. `Error` instances get their `.message`/`.stack`
redacted too (`redactString()` strips JWT-shaped substrings from stack
traces), not just plain-object `extra` payloads.

## 21. Security Tests

None specifically for the two new RLS policies / three triggers — no
live database in this environment. See §26.

## 22. RLS Tests

Not run — no Supabase access. The policies and triggers were designed by
directly mirroring an already-audited, already-live pattern
(`call_history_transition_guard`) rather than invented fresh, which is
the best available substitute for live testing in this environment, not
a replacement for it.

## 23. Performance

No heavy initialization added at app startup — `PrivacyAISettings.tsx` is
lazy-loaded (matches every other settings sub-page's existing pattern);
`consent.ts`'s cache means a gated check after the first one is a
synchronous map lookup, not a network call; `secureStorage.ts`'s AES-GCM
operations are `async` (non-blocking) Web Crypto calls, not
main-thread-blocking work. Not benchmarked — no build to benchmark.

## 24. UI Changes

One new page: `src/pages/settings/PrivacyAISettings.tsx`, reachable via a
new "Privacy & AI Data" row in `Settings.tsx`'s existing list (same
`SettingsHubRow`/`matches()` search-filter pattern every other row uses).
Existing navigation, layout, calling UI, chat UI, and visual language
untouched — no redesign, as instructed.

## 25. Accessibility

The new toggle rows use the existing `Switch` component (already
accessible in this codebase's usage elsewhere) with an explicit
`aria-label` stating the feature name and current on/off state. Plain-
language descriptions for every consent feature, no color-only state
indication (the "Not built yet" badge is text, not just a color change).
Not tested with an actual screen reader — no device/browser access in
this environment.

## 26. Remaining Issues

See `.ai/KNOWN_ISSUES.md` for the full, IDed list (KI-01 through KI-06).
Summary: recurring `.ai/` file loss between sessions (KI-01, P2); secure
storage isn't hardware-backed (KI-02, P2); its IndexedDB path is untested
in this sandbox's jsdom environment (KI-03, P3); pre-existing mood/face
features haven't been re-audited against the new classification system
(KI-04, P3); no consent/insight export path (KI-05, P3); and the standing,
project-wide P0 — nothing has ever been build/lint/test/device-verified
in any sandbox this project has run in (KI-06).

## 27. P0/P1/P2 Issues

P0: KI-06 (standing, not new to this phase). P1: none newly introduced
this phase. P2: KI-01, KI-02. P3: KI-03, KI-04, KI-05.

## 28. Blockers

Same as every prior pass: no network egress (`npm ci` 403s), no live
Supabase/Postgres access, no Android/iOS toolchain, no physical device.
Nothing in this phase's own design depends on those being resolved to be
useful — it's usable infrastructure now — but nothing in it can be
verified working until they are.

## 29. Files Changed

New: `src/lib/privacy/{dataClassification,consent,privacyGate,redact,secureStorage}.ts`,
`src/lib/ai/{types,outputValidator,localProcessor}.ts`,
`src/pages/settings/PrivacyAISettings.tsx`,
`src/test/{outputValidator,redact,privacyGate,secureStorageCrypto}.test.ts`,
`supabase/migrations/20260917100000_privacy_consent_ai_foundation.sql`,
13 `.ai/*.md` files (listed in §CHANGELOG). Modified:
`src/lib/telemetry.ts` (redaction wiring), `src/pages/Settings.tsx`
(privacy-settings entry + sign-out now clears consent cache and wipes
secure storage), `src/App.tsx` (new route), `README.md` (doc-map + new
section). Nothing deleted; nothing in the existing chat/calls/native
architecture touched.

## 30. Next Phase

**Phase 2 — Relationship AI, P0 (self-report) tier only**, gated on the
still-open security queue in `.ai/NEXT_PHASE.md`. See that file for the
full detail.

---

## FINAL STATUS

CURRENT PHASE
PRIVACY + CONSENT + LOCAL-FIRST AI FOUNDATION

IMPLEMENTATION STATUS
PARTIAL

CONSENT
PASS (implemented + DB-enforced; not live-tested)

PRIVACY GATE
PASS (implemented; not live-tested)

LOCAL STORAGE
PARTIAL (software encryption implemented; hardware Keystore/Keychain NOT implemented — KI-02)

AI CONTRACT
PASS (implemented; no feature uses it yet, by design)

AI SAFETY
PARTIAL (two-layer validator implemented and unit-tested in source; adversarial robustness beyond the tested phrase list not established)

SUPABASE
PASS (migration written; not live-applied or tested)

RLS
PASS (policies + triggers written, mirror an already-audited pattern; not live-tested)

SECURITY
PARTIAL (unchanged overall project verdict — this phase didn't re-run the standing security audit)

TESTS
BLOCKED (4 suites written; `npm ci` still 403s in this sandbox)

ANDROID
BLOCKED (no SDK/device)

IOS
BLOCKED (no toolchain/device)

PRODUCTION STATUS
NOT READY

NEXT PHASE
PHASE 2 — RELATIONSHIP AI, P0 (SELF-REPORT) TIER ONLY
