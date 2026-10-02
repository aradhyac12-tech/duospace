# Phase 2D — Real local model runtime: final report

Date: 2026-09-23. Base: `duospace-phase-2c-merged.zip`. Execution model unchanged: RelationshipAIService → LOCAL | RULE_BASED, with no LOCAL→CLOUD path. No UI change, no new relationship features, no cloud inference.

## Status

| Item | Status | Evidence |
|---|---|---|
| MODEL ARTIFACT | **BLOCKED** | huggingface.co (page, API, resolve), cdn-lfs.hf.co and modelscope.cn all HTTP 403; the official `huggingface/smollm` GitHub repo does not distribute weights; npm "SmolLM2" packages contain no weights (86 KB / 6 KB). Per §4 the model implementation stopped here. No placeholder weights. |
| MODEL INTEGRITY | **BLOCKED** (mechanism verified) | Verification code is tested (tamper / size / HTTP / non-https rejected). No real hash exists to pin; none fabricated. |
| REAL INFERENCE | **BLOCKED** | No weights. The real-model runner exists and **skips** (2 skipped), not passes. |
| WEB | **BLOCKED** | Runtime + capability detection tested; never executed on real weights. |
| ANDROID | **BLOCKED** | Not built: §15 orders native after web inference is proven. No device available. |
| S24 ULTRA | **BLOCKED** | No device in this environment. |
| LOW-END ANDROID | **BLOCKED** | No device in this environment. |
| IOS | **BLOCKED** | No runtime, no device. |
| SAFETY | **PASS** (validator/pipeline level) | 204 AI tests pass. Not evaluated on real model output. |
| GROUNDING | **PASS** (validator level) | New grounding validator + tests. Not evaluated on real model output. |
| PRIVACY | **PASS** (static + unit) | Red-team tests pass. On-device network inspection (§26) not possible without a device. |
| PERFORMANCE | **NOT MEASURED** | No inference ran. No p50/p95/p99 exists; none invented. |
| ROUTING | **PARTIAL** | All routing cases verified with the real service and pipeline, using a scripted runtime (test double). Not verified with real inference. |
| REGRESSION TESTS | **PASS** | 806 passed, 2 skipped (real-model runner), 6 failed. The 6 are the same pre-existing, classified failures. |
| PRODUCTION LOCAL AI | **NOT READY** | |

## What was done (no artifact required)
1. **Grounding validator** (`src/lib/ai/groundingValidator.ts`, wired into the pipeline for generated output):
   - Rejects history, recurrence and frequency ("several times", "keeps", "last month", "always", …) and any number the user's minimized input does not contain.
   - Input-relative: allowed if the user wrote it.
   - `local-rule-v1` is exempt, since its counts are produced by code.
   - Example: input "My partner cancelled dinner." with output "They have cancelled plans several times." is **rejected** and never persisted.
2. **Versioned manifest + compatibility gate** (§24): `runtimeVersion`, `tokenizerVersion`, `outputSchemaVersion`, `safetySpecVersion` (now 3). Capability detection refuses any mismatch, so an incompatible or un-re-evaluated model never loads. A new model version already resets failure history (2C).
3. **`.ai/MODEL_MANIFEST.json`** — status BLOCKED; all hashes and sizes `null`; exact unblock procedure.
4. **Real-model evaluation runner** (`src/test/ai/realModel.eval.test.ts`, no test doubles):
   - SHA-256 verification before loading (network disabled).
   - Real transformers.js/onnxruntime-node inference through the real provider and pipeline over the 25-case synthetic dataset.
   - Records load ms, p50/p95/p99, timeouts, model-answered vs rejected cases, every gate, and RSS.
   - Fails unless all gates are 0.
   - `LOCAL_MODEL_PIN=1` prints the hashes to pin.
   - **Never executed here.**

## Integrity behaviour (§6)
Web: files are verified in memory before the runtime sees them. Nothing unverified is ever written (browser cache off, cache `put` is a no-op), so on a mismatch there is no invalid artifact on disk to delete. Result: `INTEGRITY` failure → LOCAL disabled until the model version changes → RULE_BASED.

## Timeout policy (§14)
The 2C policy (2 consecutive timeouts → too slow for 24h) is **unverified**; no latency data exists. It must be re-derived from the runner's p95/p99 on real devices before any promotion.

## Native runtime (§15/§21)
Not implemented, by the phase's own ordering. The Phase 2C comparison stands (llama.cpp preferred; ONNX Runtime Mobile as the single-artifact alternative). The final choice needs web evidence first.

## Pre-existing failures (unchanged, unrelated to AI)
- **Tests:** connectivity ×4, networkQualityClassifier ×1, playHistory ×1.
- **tsc:** 18 distinct pre-existing errors (0 new).

## Exact next action (for someone with an unrestricted network)
1. `git lfs`/`huggingface-cli download HuggingFaceTB/SmolLM2-360M-Instruct --revision <commit> --include "onnx/model_q4.onnx" "*.json"`
2. `LOCAL_MODEL_DIR=<dir> LOCAL_MODEL_PIN=1 npx vitest run src/test/ai/realModel.eval.test.ts` → pin the hashes, sizes and revision (manifest.ts + MODEL_MANIFEST.json).
3. `LOCAL_MODEL_DIR=<dir> LOCAL_MODEL_REPORT=eval.json npx vitest run src/test/ai/realModel.eval.test.ts` → real gates + latency.
4. Only if all gates are 0: web browser test, then the llama.cpp plugin, then S24 Ultra + low-end device measurements.

## Next-phase decision (§31)
None of the 11 preconditions for new AI features is met. **The next phase remains Local AI stabilization.**
