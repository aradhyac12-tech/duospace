# Phase 2C — Multi-runtime AI routing (local / E2E cloud / rules)

Date: 2026-09-23. Built on the merged repository (see §0). No UI redesign; the only UI change is that the existing Reflection toasts now state the actual processing mode.

## 0. Repository merge (done first)
The inputs were three zips: `duospace-phase-2b` (my delivery), `Duospace-fixed-photos-upload`, and `duospace-livekit-cloud-migration`.

**Lineage.** The LiveKit zip already contains every photos-upload change, and both were built from the **pre-2B** repo. They lacked Phase 2B entirely, including the share-revocation security migration.

**Method.** A 3-way merge with the pre-migration upload as common ancestor:
- 15 Phase-2B AI files taken from 2B (the other side never touched them).
- Calling, infra and `Chat`/`Gallery` taken from the LiveKit zip (authoritative; contains the calling migration plus LiveKit Cloud).
- `.ai` notes unioned.
- The `Reflection.tsx` import conflict resolved by hand.
- `package.json`/`package-lock.json` taken from the LiveKit zip, with `@huggingface/transformers` and `@electric-sql/pglite` re-added **via npm**.

**Verified.** The merged tree reproduces the Phase 2B results exactly (727 passed / the same 6 pre-existing failures) before any Phase 2C change.

**Found in the LiveKit zip.** `MoodDetector.tsx` read `pool` outside the block that declares it, a **ReferenceError on every mood save**. Fixed with a minimal variable hoist.

## 1. Existing architecture (audit)
- **Providers:** `local-rule-v1` (deterministic) and `local-model-v1` (transformers.js/ONNX, SmolLM2-360M-Instruct q4, lazy, SHA-256-verified manifest, **unpinned**) behind `RelationshipAIProvider`.
- **Pipeline:** PrivacyGate → minimization → schema → provenance → safety validator → encrypted local store.
- **Crypto already in DuoSpace:** WebCrypto ECDH P-256 + AES-GCM-256 (chat E2E, `src/lib/crypto.ts`, private keys in IndexedDB) and AES-GCM secureStorage. No TEE, no attestation, no inference service, no cloud-AI consent flow.

## 2. Changes
- **New:** `executionMode.ts` (modes, labels, failure policy, capability assessment, pure router), `service.ts` (`RelationshipAIService`, the single orchestrator), `e2eCloud/envelope.ts` (client envelope crypto), `e2eCloud/e2eCloudProvider.ts` (BLOCKED provider).
- **Changed:** pipeline (keeps the raw runtime error as `cause` for classification), errors (+`E2E_CLOUD_UNAVAILABLE`, `AI_UNAVAILABLE`), outputValidator (+8 subtle-inference pattern groups), `Reflection.tsx` (all 3 calls via the service; toast shows the mode).
- **Tests:** `executionRouting`, `e2eEnvelope`, `privacyRedTeam`, and 17 more safety phrases.

## 3. Execution modes
`LOCAL`, `E2E_CLOUD`, `RULE_BASED`, `UNAVAILABLE`. The UI calls only the service. Screens never touch providers, ONNX, cloud or rules.

## 4. Capability detection (local only, nothing uploaded)
Signals used: platform runtime support, WebAssembly, WebGPU, `navigator.deviceMemory` when exposed (→ memoryClass low/mid/high/unknown), pinned model + https origin, SubtleCrypto, and **this device's own past runtime failures**. No brand, model name or OS-version heuristics. The result is `{capable, localModelReady, runtime, memoryClass, confidence, reason}`. Unknown memory does not by itself make a device incapable.

## 5–6. Local model artifact and hashes
- **Expected artifact:** SmolLM2-360M-Instruct ONNX export, `onnx/model_q4.onnx` plus `config.json`, `generation_config.json`, `tokenizer.json`, `tokenizer_config.json`.
- **Not obtained:** Hugging Face returns HTTP 403 from this environment. The only npm packages mentioning SmolLM2 (`cli-ai-smollm2` 86 KB, `smollm2-1.7b-runner` 6 KB) contain **no weights**; they download from Hugging Face at runtime. Third-party republishes would not be an acceptable artifact anyway.
- **Hashes:** **not pinned** (none fabricated). The manifest stays unpinned, so the model is unavailable in every build.
- **Manual action required:**
  1. On an unrestricted machine, download the exact files from `HuggingFaceTB/SmolLM2-360M-Instruct` (ONNX q4).
  2. Record `sha256sum` and byte sizes into `localModel/manifest.ts`, and set `modelVersion` to the commit revision.
  3. Host the files on the DuoSpace https origin (`VITE_LOCAL_MODEL_BASE_URL`).
  4. Build with `VITE_LOCAL_MODEL_ENABLED=true`.
- Transformers.js compatibility of that exact export is **unverified** until then.

## 7. Local inference results
**None. No real inference was executed.** The scripted runtime used in tests is a test double and is **not** evidence of model function.

## 8. Safety evaluation (real, on the validator and the full pipeline)
- **Coverage:** 23 categories and 70 prohibited phrases (direct, euphemistic, conditional love tests, generalization/typology, overconfidence, hidden blame, coercive advice, fabricated history, probability-framed accusations, prompt-injection echoes). Each is rejected in observation, explanations and context.
- **Allowed cases:** legitimate grounded reflections stay accepted.
- **local-rule-v1:** passes all gates on the 25-case dataset.
- **Adversarial model outputs:** every one is rejected through the real `local-model-v1` + pipeline path.

## 9–12. E2E cloud: architecture, crypto boundary, keys, provider visibility
**Conclusion: E2E_CLOUD is BLOCKED.** A model cannot run on ciphertext, so the inference boundary must decrypt. That is end-to-end only if the boundary is an **attested TEE**, meaning confidential VM/GPU inference whose enclave public key the client verifies through remote attestation before sealing a request. DuoSpace has none of: an inference service, a TEE, an attestation verifier, or a cloud-AI consent flow.

Why the alternatives were rejected:
- **Option B (DuoSpace-trusted server):** that is encrypted-in-transit, not E2E. It would let operators read plaintext and has no consent model, so it was **not built**.
- **Option A:** "client decrypts before inference" *is* local inference.
- **Option D (FHE/MPC for LLMs):** not practical.

What exists:
- **Client envelope** (real, tested, never called in production): ephemeral ECDH P-256 → HKDF-SHA-256 → AES-GCM-256. The AAD binds purpose, requestId, issuedAt and the ephemeral key. The recipient rejects replays and stale requests.
- **Blocked provider:** `E2E_CLOUD_STATUS = {available:false, userConsented:false}`. It makes no network requests.

Who can see plaintext **today**: only the user's device. No relationship content leaves it.
- DB admins: no
- DuoSpace operators: no
- AI providers: none are used

On server or DB compromise: AI content is never sent, so there is nothing to expose. (Explicitly shared snapshots are a separate, pre-existing, RLS-protected feature.)

**Required future keys** (not created now):
- Enclave key pair, generated inside the TEE and never exported.
- Per-request ephemeral client keys.
- Client-side attestation roots.

Rotation equals a new enclave key with fresh attestation. Revocation means refusing attestations below a minimum measurement. Multi-device needs no user key sync (envelopes are per request). Recovery is not applicable (nothing stored server-side).

## 13. Privacy guarantees (verified by tests)
- No network in LOCAL or RULE_BASED mode.
- The blocked cloud provider is never invoked.
- No console logging, analytics or error-SDK imports in the AI layer.
- The only fetch is the integrity-verified model fetch.
- `localStorage` holds only the content-free runtime-state record.
- The runtime never persists files (browser cache off, cache `put` is a no-op).
- No secrets or `VITE_*` keys.
- Telemetry carries only op/outcome/latency/providerType/errorCategory/count.

## 14. Performance
**Not measured. No model was executed, and no Galaxy S24 Ultra or low-end device was available here.** No routing threshold numbers were invented. The current policy is based on capability signals plus measured on-device failures: 2 consecutive timeouts mark the device too slow for 24h. The runtime records `loadMs`/`lastInferenceMs`/counts for later device measurement.

## 15–16. Routing policy and failure handling
Per request: one primary attempt plus at most one RULE_BASED fallback. There is never LOCAL→CLOUD or a loop. A capable device whose model is missing or failed goes to RULE_BASED, **never cloud**. Consent/privacy denial is final, with no fallback.

| Failure | This request | Future routing |
|---|---|---|
| model missing (404) | RULE_BASED | LOCAL off 6h |
| download/HTTP | RULE_BASED | LOCAL off 30 min |
| integrity mismatch | RULE_BASED | LOCAL off until the model version changes |
| tokenizer | RULE_BASED | LOCAL off 24h |
| ONNX/runtime, unsupported, OOM | RULE_BASED | device marked incapable 24h |
| timeout | RULE_BASED | 2 consecutive → incapable 24h |
| malformed / unsafe output | RULE_BASED | not disabled (content-dependent) |

A new model version resets failure history. Incapable device with cloud blocked goes to RULE_BASED. No safe path gives UNAVAILABLE.

## 17–19. Tests, build and pre-existing failures (exact exit codes)
- `check:lock`: 0
- `check:rls`: 0
- `eslint`: 0 (0 errors, 90 warnings, pre-existing)
- `vitest`: exit 1, **790 passed, 6 failed**. The same 6 pre-existing, unrelated failures (connectivity ×4, networkQualityClassifier, playHistory).
- AI tests: 181, all pass.
- `tsc`: exit 2, only pre-existing errors. The PhotoViewer/faceRecognition entries are the same errors shifted by the photos changes. MoodDetector's `pool` error is fixed.
- `build`: 0. The entry bundle has 0 model-runtime references; `transformers.web` and `transformersWebRuntime` are lazy chunks.
- `npm ci` with the committed lock: BLOCKED here (private registry URLs → 403). It works against an identical lock with public URLs.

## 20. Security findings
- **Fixed:** MoodDetector ReferenceError (from the LiveKit zip); 17 validator gaps.
- **Confirmed restored:** the Phase 2B share-revocation migration was missing from the newer zips and is present again after the merge.

## 21. Remaining blockers
1. Model artifact and hashes (manual download).
2. Real inference and evaluation.
3. Device performance measurement (S24 Ultra plus a low-end device).
4. Native Android/iOS runtime.
5. Any E2E cloud needs an attested-TEE inference service plus an attestation verifier plus a consent UI.

## 22. Native runtime recommendation (for Phase 2D)
| | llama.cpp (GGUF) | MediaPipe LLM Inference | ONNX Runtime Mobile |
|---|---|---|---|
| SmolLM2 compatibility | Yes (GGUF conversions standard) | Only its supported model list/converted formats | Yes (same ONNX as web) |
| Android / iOS | Both (NDK / Metal) | Both | Both |
| Quantization | Q4/Q5/Q8 mature | int4/int8 | int4 (MatMulNBits)/int8 |
| Capacitor integration | Custom plugin (C++ bridge) | Custom plugin (Kotlin/Swift SDK) | Custom plugin (Kotlin/Swift SDK) |
| Size impact | Small native lib | Moderate SDK | Moderate SDK |
| License | MIT | Apache-2.0 | MIT |
| Main risk | C++ build/maintenance | Model-list lock-in | Weaker LLM decode performance than llama.cpp |

**Recommendation:** **llama.cpp**, which gives the best on-device LLM performance and model flexibility across both platforms, with a thin Capacitor plugin implementing `LocalModelRuntime`. Keep **ONNX Runtime Mobile** as the alternative if one artifact for web and native is preferred. All numbers must come from device benchmarks.

## 23. Phase 2D plan
1. Pin the real artifact.
2. Run a web evaluation (`runEvaluation`) plus latency p50/p95, memory and failure rate.
3. Derive the routing threshold from the data.
4. Build the llama.cpp Capacitor plugin and evaluate on an S24 Ultra plus a low-end device.
5. Only then consider promoting `local-model-v1`.
6. E2E cloud stays out of scope until an attested-TEE inference design is approved.

## Production status: **PARTIAL / BLOCKED**
- LOCAL AI: BLOCKED (no artifact / no inference).
- RULE-BASED: available, safe local fallback, and what users get today.
- E2E_CLOUD: BLOCKED until attested E2E-compatible inference infrastructure exists.
