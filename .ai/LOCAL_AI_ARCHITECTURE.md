Local-first AI pipeline. Implementation: `src/lib/ai/localProcessor.ts`.

```
LOCAL INPUT -> LOCAL PROCESSOR -> STRUCTURED RESULT -> VALIDATION -> ENCRYPTED LOCAL STORAGE
```

`LocalAIProcessor` is an interface (`feature`, `modelVersion`, `run()`) —
no concrete implementation exists (feature freeze,
`.ai/DO_NOT_BUILD.md`). `runLocalProcessor(processor, input, gateContext)`
is the one required entrypoint: it calls `privacyGate.canProcess()`
first, runs the processor, then `validateInsight()` on the result before
returning it — a feature author gets the privacy check and the safety
check by construction, not by remembering to call them separately.

A `LocalAIProcessor` implementation must not require network access — if
a future feature needs a remote model, it's a distinct, separately
consent-gated capability (`CLOUD_AI_PROCESSING`), never this interface.

## Local encrypted storage

`src/lib/privacy/secureStorage.ts` — see `.ai/SECURITY_MODEL.md`'s Key
Management section for the honest limitation (software AES-GCM, not
hardware Keystore/Keychain-backed).

## What's NOT built

The actual on-device inference. This phase is infrastructure only, per
the phase brief's own instruction not to build the relationship AI yet.

## Phase 2B (2026-09-23) — local-model-v1
- Providers: local-rule-v1 (default + deterministic fallback), local-model-v1 (on-device, opt-in build `VITE_LOCAL_MODEL_ENABLED=true` + verified model only, isProduction=false), cloud-model-v1 NOT IMPLEMENTED (pipeline refuses any non-DEVICE provider: CLOUD_NOT_SUPPORTED).
- Runtime seam: `src/lib/relationship/localModel/runtime.ts`. Web impl: transformers.js/ONNX (WebGPU→WASM), lazy dynamic import (separate chunk; entry bundle has none).
- Capability layer: `localModel/capabilities.ts` (fails closed; Android/iOS unsupported — no native runtime yet).
- Model files: never in Git; fetched only from `VITE_LOCAL_MODEL_BASE_URL` (https), SHA-256 + size verified (`localModel/manifest.ts`); shipped manifest is UNPINNED → model unavailable until real hashes are pinned.
- Fallback: unavailable/failure/timeout/malformed/no-valid → local-rule-v1; consent/privacy denial → no fallback; never cloud.
- NOT RUNTIME-VERIFIED: weights unreachable in the build sandbox. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## Phase 2C (2026-09-23)
All requests: UI → RelationshipAIService → decideExecutionMode → one primary attempt → ≤1 RULE_BASED fallback. Capable-but-failed device never goes to cloud. E2E_CLOUD blocked (needs attested TEE + attestation verifier + consent). See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## Phase 2D (2026-09-23)
Pipeline now: schema → provenance → grounding (generated output only) → safety → persist. Manifest carries runtime/tokenizer/outputSchema/safetySpec versions; any mismatch blocks loading. Real-model runner: src/test/ai/realModel.eval.test.ts. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.
