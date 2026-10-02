Consent model. Implementation: `src/lib/privacy/consent.ts` (types +
`ConsentService`-equivalent functions), server-of-record:
`public.user_consents` (migration
`20260917100000_privacy_consent_ai_foundation.sql`).

## Feature list

`ConsentFeature`: AI_PROCESSING, RELATIONSHIP_INSIGHTS, MOOD_PROCESSING,
VOICE_PROCESSING, VIDEO_PROCESSING, CAMERA_ANALYSIS, MICROPHONE_ANALYSIS,
CLOUD_AI_PROCESSING, SHARED_INSIGHTS, ANALYTICS, CRASH_DIAGNOSTICS — one
row per (user, feature) in `user_consents`, not one global toggle.

## Record shape

id, userId, feature, granted, version, source, grantedAt, revokedAt,
updatedAt. `version` is the *consent-language* schema version
(`CONSENT_SCHEMA_VERSION` in code) — bump it when a feature's disclosure
text materially changes; `hasConsent()` treats a record with a version
below the current one as not-granted, so people get re-prompted rather
than silently kept opted-in to language they never actually saw.

## Enforcement, not just a UI setting

`hasConsent(userId, feature)` fails closed on any read error (treats it
as not-granted). `privacyGate.ts`'s `canProcess()` calls it as one stage
of a fixed pipeline — see `.ai/PRIVACY_MODEL.md`. A short (30s) in-memory
cache exists so a gated call doesn't round-trip to Supabase every time;
`grantConsent`/`revokeConsent` invalidate it immediately. Revoking stops
*future* processing immediately — it does not retroactively delete
already-created insights (that's `.ai/RELATIONSHIP_MEMORY_SPEC.md`'s
deletion path, a separate explicit action).

## Database-layer backstop

`user_consents` has its own RLS (own-row only, no DELETE policy — see the
migration's comment on why revocation, not erasure, is the supported
action). More importantly, `ai_insights` has a trigger
(`enforce_ai_insight_consent`) that independently re-checks, at the
database layer, that any inserted insight's `consent_reference` is a
real, currently-granted consent belonging to that same user — so a bug in
the client-side PrivacyGate check, or a direct API call bypassing it
entirely, still can't produce a consent-less insight. This is the
concrete answer to the phase brief's "Do not assume frontend filtering is
security" instruction for this specific system.

## UI

`src/pages/settings/PrivacyAISettings.tsx` (new this phase, linked from
Settings as "Privacy & AI Data"). Every relationship-AI feature is
capability-gated off right now (see `.ai/DO_NOT_BUILD.md` / the feature
freeze), so most of these toggles are currently inert with respect to any
real feature — they still write a genuine record now, so nobody is
silently defaulted to "on" the day a real feature ships behind one of
them. ANALYTICS/CRASH_DIAGNOSTICS are the two already-live capabilities
(`telemetry.ts`).

## Not done this phase

No UI or backend path for consent *export* yet (§24 of the phase brief).


## Phase 1.6 note
"Is this consent currently active" is one pure function,
`isConsentActive()` in `consentFeatures.ts` (missing, not granted, revoked, or
older disclosure version = NOT active). `hasConsent` and the telemetry
upload flag both use it. `PrivacyGate.canProcess(req, deps?)` accepts an
injectable `hasConsent` purely so revocation can be tested without a database.
On-device-only sensor toggles are a separate, local mechanism (DECISIONS D-1.6-3).
