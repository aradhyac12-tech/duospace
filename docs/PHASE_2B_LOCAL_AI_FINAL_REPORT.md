# Phase 2B — Local AI engine, evaluation harness, Phase 2A hardening

Date: 2026-09-23. Scope: self-report relationship reflection only (Values,
Expectations, Communication Reflection, Insights). No multimodal AI, no UI
redesign, no chatbot, no cloud AI.

## Status (honest)

| Area | Status |
|---|---|
| Phase 2A hardening | **PASS** (see §1) |
| Local model (`local-model-v1`) | **PARTIAL**: implemented and wired end to end; real inference never executed (weights unreachable from the build sandbox: Hugging Face → HTTP 403) |
| Web local model | **UNVERIFIED** (runtime code exists, never executed on a real model) |
| Android local model | **BLOCKED**: no native runtime; capability layer reports unsupported → local-rule-v1 |
| iOS local model | **BLOCKED**: same as Android |
| Safety | **PASS** (validator + 52 adversarial outputs + 25-case evaluation, all gates) |
| Privacy | **PASS** for implemented paths (device-only enforced, cloud refused, minimization + telemetry tests) |
| Evaluation | **PARTIAL**: harness + dataset complete, local-rule-v1 passes all gates; the real model has not been evaluated |
| Build | **PASS** with pre-existing exceptions (`tsc` has 18 pre-existing errors; 6 pre-existing unrelated test failures) |
| Production AI | **NOT READY**: no model has been executed |

## 1. Phase 2A hardening

### Bugs found and fixed (all pre-existing in the 2A code)
- **Every `local-rule-v1` output was rejected by the safety validator.** Values, Expectations and Communication Reflection all ended in "No suggestions passed the safety check" in the shipped build.
  - It emitted `confidence: HIGH` above the MEDIUM cap for derived sources.
  - Two explanations were not phrased as possibilities.
  - **Fixed** in `localRuleProvider.ts`.
- **Validator false negative: "Your partner ignored…".** It counted as user-attributed because it starts with "Your"; it now excludes "Your partner/spouse/…".
- **Validator false negative: "They don't care about you".** The pattern covered "doesn't" but not "don't/didn't/won't".
- **Expectations evidence catalog listed all three item types even when absent.** This let a provider cite evidence that did not exist. It now lists only the types present.
- **`relationship_shares` resurrection and extension (security).** Verified **exploitable** before the fix on real Postgres: an owner could un-revoke a share and extend it 50 years, and the partner could read it again.
  - Fix: migration `20260923130000`:
    - revoke is one-way (NULL → server `now()`), never cleared or re-dated
    - `expires_at` is immutable
    - lifecycle fields are server-owned on INSERT (created_at, revoked_at=NULL, expiry ≤180d)
    - recipient SELECT also requires a current partnership
  - RLS was only tightened.
- **Test bugs.**
  - A privacyGate mock was never cleared between tests.
  - A non-relationship fixture violated the general ≥2-explanations contract.
  - The pipeline had **no tests at all** before this phase.

### Package lock
- Root version: 3.12.0 in both `package.json` and `package-lock.json`.
- `npm run check:lock` passes.
- New dependencies were added only via npm: `@huggingface/transformers` ^3.8.1, and `@electric-sql/pglite` ^0.2.17 (dev).
- `npm ci` against the delivered lock is **BLOCKED here**: its `resolved` URLs point at a private registry cache that returns 403. `npm ci` was run against an identical copy of the lock with the host rewritten to registry.npmjs.org (same integrity hashes); it succeeded.

## 2. Architecture

```
PrivacyGate (consent + destination = provider.processingLocation, DEVICE only)
  → data minimization (build*Input: no ids, notes/statements excluded by default, skipped/"prefer not" dropped)
  → RelationshipAIProvider
       ├─ local-model-v1  (opt-in build + verified model only; isProduction=false)
       ├─ local-rule-v1   (default + guaranteed deterministic fallback)
       └─ cloud-model-v1  NOT IMPLEMENTED — pipeline throws CLOUD_NOT_SUPPORTED for any non-DEVICE provider
  → strict JSON parse (parseProviderResponse)
  → provenance check (every evidence ref ∈ the input's own evidenceCatalog)
  → safety validator (outputValidator)
  → provenance stamping by the pipeline (source, modelVersion, consentReference, processingLocation, classification, createdAt, expiresAt)
  → encrypted local store (secureStorage) → optional explicit share (RLS)
```

**Fallback.** On `LOCAL_MODEL_UNAVAILABLE`, failure, timeout, malformed output or no valid insight, the pipeline uses `local-rule-v1`. On consent/privacy refusals there is **no** fallback. If both fail, a safe error is returned. There is never a path to the cloud.

## 3. Local model

| Property | Value |
|---|---|
| Runtime | `@huggingface/transformers` 3.x (ONNX Runtime Web; WebGPU, else WASM), in-page, on-device |
| Model | SmolLM2-360M-Instruct, ONNX q4 (Apache-2.0) |
| Version string | `local-model-v1/smollm2-360m-instruct-q4@unpinned` |
| Size / memory | ~250–300 MB weights (estimate, **not measured**); `approxMemoryMB` 600 (estimate) |
| Context | 2048 tokens; ≤384 new tokens; temperature 0 |
| Structured output | Strict JSON contract, parse + schema + safety + provenance validation (not grammar-constrained decoding) |
| Loading | Lazy: dynamic import on first analysis only. Verified in the build: the entry bundle has 0 runtime references; transformers is a separate 880 KB chunk. |

**Model storage and integrity (`localModel/manifest.ts`)**
- Weights are never committed.
- They are fetched only from a DuoSpace-controlled https origin (`VITE_LOCAL_MODEL_BASE_URL`), and each file is SHA-256- and size-checked before the runtime sees it.
- The runtime is served only verified bytes through a custom cache; any other file request throws (fail closed).
- The shipped manifest has **empty hashes**, so no model can load until a release engineer pins real hashes. This is deliberate.
- Update means a new manifest version plus new hashes. Delete means clearing the browser cache and the in-memory runtime (`unload()`).

**Capability layer (`localModel/capabilities.ts`).** It reports `supported`, `modelAvailable`, `modelVersion`, `maxContext`, `approxMemoryRequirementMB`, `modelSizeBytes`, `supportsStreaming` (false), `supportsStructuredOutput`, `accelerator` and `reasons`. It fails closed on: Android/iOS (no native runtime), unknown platform, no WASM, build flag off, unpinned manifest, missing or non-https origin, no SubtleCrypto, and low `deviceMemory`.

## 4. Confidence semantics
`confidence` measures how directly the **user's own supplied information** supports the **observation**. LOW means partial or indirect; MEDIUM means directly stated. It is **never** a probability that any theory about the partner is true. Model and rule sources are capped at MEDIUM.

## 5. Evaluation (`src/test/ai/`)
- **Dataset:** 25 synthetic cases (values ×5, expectations ×5, communication ×8, safety ×7: suspected cheating, lying, anger, jealousy, manipulation concern, breakup, abuse concern). No real data.
- **Checks per insight:** schema validity after persistence, prohibited claims, user-attributed observation, stated uncertainty, evidence ⊆ supplied catalog (no fabrication), no partner mind-reading, no affirmation of the user's suspicion as fact, no identifiers in output or telemetry.
- **Gates** (binary, counts must be 0): schemaInvalid, safetyViolations, fabricatedEvidence, privacyViolations, ungroundedObservations, missingUncertainty, forbiddenAffirmations. There is no aggregate "AI score".
- **Results:**
  - `local-rule-v1`: 25/25 cases, 26 insights, **all gates 0**.
  - Adversarial scripted outputs through the real `local-model-v1` provider and pipeline: a **test double, not a model**. All 52 prohibited claims plus prose, fabricated evidence, HIGH confidence, partner-attributed observations and truncated JSON were rejected, the fallback took over, and gates held. A valid grounded draft is accepted.
- **Promotion rule:** `local-model-v1` may become the default only after `runEvaluation()` passes all gates with the **real** runtime on target devices and the measurements in §6 are recorded.

## 6. Performance
**Not measured. The model was never executed here.** The runtime records `loadMs`, `lastInferenceMs`, inference count and failures (`runtimeMetrics()`) so these can be captured on devices: initialization, first/average inference latency, failure rate. Peak memory and battery impact need browser/device profiling; nothing was fabricated.

## 7. Tests executed (real)
- Full suite: **727 passed, 6 failed**. All 6 are pre-existing and unrelated to AI (connectivity ×4, networkQualityClassifier, playHistory); 4 previously failing 2A/privacy tests now pass.
- New:
  - `src/test/ai/`: pipeline 18, safety 52, evaluation 5, capabilities/integrity/lazy 12
  - `src/test/db/relationshipShares.db.test.ts`: **real Postgres (PGlite) running the actual migrations with RLS**, 10 tests
- `npm run check:lock` PASS, `npm run check:rls` PASS, `eslint` 0 errors, `npm run build` PASS, `tsc` 18 pre-existing errors / 0 new.

## 8. Known blockers
1. **Real model execution:** weights must be downloaded (blocked here), published to the DuoSpace model origin, and hashes pinned. Then run `runEvaluation(localModelProvider)` in a real browser.
2. **Android/iOS:** a native runtime plugin (llama.cpp or MediaPipe LLM Inference) implementing `LocalModelRuntime` is needed; until then these platforms use local-rule-v1.
3. **Small-model output quality** is unknown. The pipeline guarantees that bad output is never shown, but a model that is rejected too often provides no value over local-rule-v1. Only a real evaluation can tell.
4. **Correction feedback** is stored locally only (unchanged). It does not train anything and does not upload.
