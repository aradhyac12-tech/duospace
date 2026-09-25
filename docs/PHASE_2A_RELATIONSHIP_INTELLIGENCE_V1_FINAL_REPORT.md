# Phase 2A — Relationship Intelligence V1 — Final Report

## 1. Implementation summary

Built the full Phase 2A scope from the brief: Values Reflection,
Expectations, Communication Reflection, a local-rule AI provider behind
a provider-neutral interface, the safety-validated local-first pipeline,
explicit per-item partner sharing, and one new UI page reached from the
existing Hub. Nothing on `.ai/DO_NOT_BUILD.md`'s freeze list was built or
approached — no scoring, no multimodal inference, no cheating/deception
detection of any kind.

## 2. Files changed

**New — domain (`src/lib/relationship/`, ~1,900 lines):**
`types.ts`, `errors.ts`, `questions.ts`, `classification.ts`,
`validation.ts`, `telemetry.ts`, `deps.ts`, `stores.ts`, `provider.ts`,
`providers/localRuleProvider.ts`, `registry.ts`, `pipeline.ts`,
`correction.ts`, `sharing.ts`, `production.ts`, `index.ts`.

**New — UI:** `src/pages/Reflection.tsx` (684 lines; Values/
Expectations/Reflect/Insights tabs).

**New — tests:** `src/test/relationshipSafety.test.ts` (211 lines, 24
cases).

**New — migrations:** `supabase/migrations/20260922100000_relationship_shares.sql`,
`supabase/migrations/20260922100100_unlink_revokes_relationship_shares.sql`.

**New — docs:** `.ai/VALUES_SPEC.md`, `.ai/EXPECTATIONS_SPEC.md`, this
file, `docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1.md`.

**Modified:**
- `src/lib/ai/types.ts` — additive `evidence`/`analysisKind` on
  `AIInsight`, `PARTLY_ACCURATE`/`NOT_RELEVANT` on `InsightCorrection`.
- `src/lib/ai/outputValidator.ts` — `checkRelationshipRules()` +
  ~15 new prohibited-claim pattern groups + a numeric/ratio/
  "compatibility" score block; `uncertainty`/`evidence` now scanned too.
- `src/lib/ai/localInsightStore.ts` — added `updateLocalInsight()`
  (re-validates + re-checks provenance; refuses to touch
  id/userId/createdAt) for the correction flow.
- `src/lib/ai/localProcessor.ts` — `runLocalProcessor()` takes an
  optional injectable `PrivacyGateDeps` (testability, no behavior change
  for existing callers).
- `src/lib/privacy/privacyGate.ts` — `FEATURE_CAPABILITIES.AI_PROCESSING`,
  `.RELATIONSHIP_INSIGHTS`, `.SHARED_INSIGHTS` → `true` (only these
  three; everything else stays `false`).
- `src/lib/privacy/redact.ts` — new key/field patterns so any
  relationship-related field name is redacted from telemetry as
  defense-in-depth (the feature's own `telemetry.ts` never logs free
  text in the first place — this is a second net, not the only one).
- `src/lib/errors/DuoSpaceError.ts`, `package.json` — version 3.11.1 →
  3.12.0 (MINOR, new phase, per `docs/rules.md`'s convention).
- `src/pages/settings/PrivacyAISettings.tsx` — updated the three
  affected rows' descriptions from "not yet built" to what they now do.
- `src/App.tsx`, `src/lib/duoHubItems.ts` — one new lazy route
  (`/reflection`) and one new Hub entry ("Reflection"). No other route,
  the dock, or any existing screen touched.
- `src/test/privacyPolicy.test.ts`, `src/test/privacyGate.test.ts` —
  updated to match the new capability values (moved their
  "stays off" assertions off `RELATIONSHIP_INSIGHTS` onto
  `VOICE_PROCESSING`, added a new assertion for the three now-true
  capabilities).
- `.ai/DATA_CLASSIFICATION.md`, `.ai/AI_OUTPUT_CONTRACT.md`,
  `.ai/RELATIONSHIP_MEMORY_SPEC.md`, `.ai/PHASE_STATUS.md`,
  `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`, `.ai/TEST_STATUS.md`,
  `.ai/CHANGELOG.md` — see each file's Phase 2A section/entry.

**Read, unmodified:** every `.ai/*.md` the brief's step 1 listed that
exists in this repo; `DO_NOT_BUILD.md` in particular governed several
decisions below (no score, no multimodal, no DuoPulse-style feature).
Several files the brief named don't exist in this snapshot
(`ARCHITECTURE.md`, `PRODUCT_VISION.md`, `SECURITY_MODEL.md`,
`AI_SAFETY_SPEC.md` under those exact names, `COMPATIBILITY_SPEC.md`,
`TRUST_SPEC.md`, `RELATIONSHIP_HEALTH_SPEC.md`, `LOCAL_AI_ARCHITECTURE.md`,
`CONFLICT_REPAIR_SPEC.md`) — this matches `.ai/KNOWN_ISSUES.md` KI-01's
already-documented pattern of files missing from this snapshot, not a
gap introduced this phase. The two the brief specifically anticipated
needing creation for (Values/Expectations) were created; the others'
closest existing equivalents (`.ai/PRIVACY_MODEL.md`,
`.ai/CONSENT_MODEL.md`, `.ai/DATA_CLASSIFICATION.md`,
`.ai/RELATIONSHIP_MEMORY_SPEC.md`) already existed and were read/updated
instead.

## 3. Values architecture

See `.ai/VALUES_SPEC.md`. Key point for review: "prefer not to answer"
is enforced structurally in `validateValueAnswerInput` (throws away
choice+note, not just hides them in the UI), and editing an answer
always resets `visibility` to PRIVATE.

## 4. Expectations architecture

See `.ai/EXPECTATIONS_SPEC.md`. Key point for review: `BOUNDARY_NOT_CONFIRMED`
is a real thrown error requiring `confirmedBoundary === true`, which the
UI only sets from a second, separate confirmation dialog. No AI or
default path can produce a boundary.

## 5. Communication reflection architecture

Five-field free text (`ReflectionFields`), all optional individually, at
least one required (`validateReflectionInput`). Analysis always runs
through the same pipeline (validation → gate → provider → safety
validator) whether or not the user opts to keep the raw text on-device
(`saveReflection`, gated by a separate UI toggle, off by default).

## 6. AI provider architecture

`RelationshipAIProvider` interface, one registered implementation
(`localRuleProvider`, `kind: LOCAL_RULE`, `isProduction: true`). Every
input builder minimizes data (category/type labels and selected-choice
labels only, never free text unless a caller explicitly opts in — no
caller does). `parseProviderResponse` treats every provider response as
untrusted: fixed field allowlist, length/count caps, hedge-word check
happens later in the validator, and anything outside the allowlist is
silently dropped rather than trusted.

## 7. Privacy architecture

`PrivacyGate.canProcess()` re-checked on every single analysis and every
single share — not cached. `RELATIONSHIP_INSIGHTS`/`SHARED_INSIGHTS` are
the only two capabilities this phase turned on; `CLOUD_AI_PROCESSING`
stays `false` (no cloud provider exists). Sharing additionally checks
`destination: PARTNER` against the classification-destination policy
matrix (`.ai/DATA_CLASSIFICATION.md`), which requires `explicitShare` —
consent alone is not sufficient to reach `PARTNER` for SENSITIVE/
HIGHLY_SENSITIVE data by design.

## 8. Consent behavior

Both feature flags are evaluated fresh on every call
(`gateOrThrow`/`confirmShare` both call `canProcess` directly, no
memoization). A revoke takes effect on the very next analysis or share
attempt — there is no "session-cached consent" for this feature.

## 9. Data classification

See `.ai/DATA_CLASSIFICATION.md`'s Phase 2A table. Nothing in this
feature is classified PRIVATE (the ordinary default) — everything is
SENSITIVE or HIGHLY_SENSITIVE, escalating to HIGHLY_SENSITIVE for any
free text, any boundary, or the Intimacy/Boundaries/Finances/Family
categories. A shared snapshot is COUPLE once (and only once) it exists
in `relationship_shares`.

## 10. Sharing behavior

Preview → confirm, with the confirm step re-hashing the payload and
rejecting a mismatch (`PREVIEW_MISMATCH`) — this is what makes "show
exactly what will be shared, before sharing" a real guarantee rather
than a UI convention that a stale screen could violate. One active share
per source item (DB unique index); re-sharing an edited item requires a
fresh preview. Revoke is owner-only, takes effect immediately (RLS), and
partner unlink revokes every share between the two people in the same
transaction as the unlink itself.

## 11. Safety validator behavior

`checkRelationshipRules()` (structural: user-attributed observation,
hedged explanations, required evidence + analysisKind, non-imperative
suggested action, length caps) plus ~15 new regex pattern groups mapped
1:1 to the brief's §8 prohibited-claims list, applied only when
`feature === RELATIONSHIP_INSIGHTS` — other features' insights are
unaffected. `uncertainty` and `evidence` are now scanned by the base
`checkFreeText` pass too (previously only `observation`/`context`/
`suggestedAction`/`possibleExplanations` were).

## 12. Tests

`src/test/relationshipSafety.test.ts`, 24 cases: structural rules (5),
every prohibited-claim category from §8 (13), the brief's own §16
worked examples verbatim — both the BAD text that must be blocked and
the GOOD text that must pass (6), uncertainty/evidence field coverage
(2), and confirmation that a non-relationship feature is unaffected (1).
See `.ai/TEST_STATUS.md` for what's NOT yet tested (pipeline, stores,
sharing — all have injectable seams making this straightforward, just
not done this pass).

## 13. Build results

**Not run:** `npm ci`, lint, `vitest`, `npm run build` — no network
egress in this sandbox, the same standing limitation as every phase in
`.ai/CURRENT_STATE.md` before this one.

**What was actually done instead:** an isolated `tsc --noEmit` pass
covering every file this phase touched or added
(`src/lib/relationship/**`, `src/lib/ai/**`, `src/lib/privacy/**`,
`src/lib/errors/**`, plus their transitive dependencies —
`src/integrations/supabase/*`, `src/lib/telemetry.ts`,
`src/lib/prefs.ts`, `src/lib/keystore.ts`, `src/lib/connectivity.ts`),
with the handful of external npm packages this scope touches
(`@supabase/supabase-js`, `@capacitor/core`, `@capacitor/network`,
`@capacitor/preferences`, `react`) stubbed by hand (no `node_modules` —
same network limitation). Result: **zero errors** in any file this
phase touched. The single remaining error in the whole scratch
compile is inside the pre-existing, untouched `src/integrations/supabase/client.ts`,
and is an artifact of the hand-written `ImportMetaEnv` stub being looser
than Vite's real one — not a defect in this phase's code.

This caught two real bugs before they shipped: a non-generic helper
function typed as `string[]`-only being called with an array of insight
drafts (`localRuleProvider.ts`), and a file created in the wrong
directory (`registry.ts` briefly under `providers/` instead of
`relationship/`, which would have broken its own relative imports).
Both fixed; the clean compile above is after both fixes.

The UI page (`Reflection.tsx`) and the files it was merged alongside
from other in-flight work this session (`Chat.tsx`, `LoveLetter.tsx`,
`LetterReader.tsx`, `ConnectionStatusPill.tsx`, `App.tsx`,
`duoHubItems.ts`) were **not** run through the same isolated `tsc` pass
— their dependency graph (react-router-dom, framer-motion, dozens of
`@/` imports) was judged disproportionate to stub by hand. They were
instead verified by full manual line-by-line diff review against each
prior known-good version (documented in this session's merge history)
plus a bracket-balance sweep. `Chat.tsx` shows a pre-existing paren
imbalance of 1 that traces back to the original pristine baseline
(confirmed by checking the count across every lineage back to Phase
1.6) — almost certainly a string/comment containing a literal `(` — not
something introduced by this phase or this merge.

## 14. Known limitations

Same list as `docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1.md`'s Known
Limitations section — not duplicated here. In short: not
runtime-verified, provider is intentionally simple, no pipeline/stores/
sharing unit tests yet, no expired-share cleanup job, no compare-with-
partner view yet.

## 15. Next recommended phase

Phase 2B, narrowly: (a) pipeline/stores/sharing unit tests using the
existing `RelationshipDeps`/`ShareCtx` injection seams — the highest-
value next step, since only the validator is tested today; (b) a
"compare with your partner" read view over `relationship_shares`
(brief §10 — differences only, never a ranking; no new server work
needed, the table already carries everything); (c) real device/runtime
verification once network access exists, same standing ask as every
other open phase in this project. Explicitly NOT next: any multimodal
signal, any relationship score, or anything else on
`.ai/DO_NOT_BUILD.md` — this V1 should be used and verified before any
of that is even scoped, per the brief's closing instruction.
