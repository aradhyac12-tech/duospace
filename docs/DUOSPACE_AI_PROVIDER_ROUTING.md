# DuoSpace AI — provider routing (Phase 3M, Stage 1)

Status: code IMPLEMENTED and unit-tested with mocked providers. **No live OpenAI / Gemini / Sarvam call has been made** — every provider is NOT VERIFIED until `npm run test:ai-live` passes against a staging project.

## Flow
`UI → RelationshipAIService → src/lib/ai/cloud/gatewayClient → ai-gateway (edge function) → router → provider adapter → Zod schema → guard → response`

The client never contacts a provider and holds no provider key. Identity comes from the verified JWT; the request body cannot name a user.

## Gateway order (supabase/functions/_shared/ai/gateway.ts)
1. verified user (else 401) → 2. strict, size-capped request schema (unknown keys rejected) → 3. route plan → 4. server-side consent (`CLOUD_AI_PROCESSING` + `RELATIONSHIP_INSIGHTS`), fail closed → 5. quota reserve (`AI_STANDARD` / `AI_DEEP`), fail closed → 6. provider call → 7. Zod validation → 8. guard (banned claims, grounding, number support, consistency with the deterministic compatibility result) → 9. fallback only if the request allowed it → 10. refund the reservation if the user got no result.

A rejected or failed result is never repaired or shown. Generic tasks return "Couldn't analyze that right now." (client may use its on-device path). Compatibility tasks return "Not enough information right now." and never a fabricated result.

## Model configuration (`AI_MODEL_CONFIG`, config.ts)
No model id exists in source. Each tier is configured by Supabase secrets; an unset tier is skipped (fail closed).

| Tier | Prefix | Used by |
|---|---|---|
| STANDARD_HIGH_VOLUME | `AI_STD_FAST` | QUICK_REPLY, TODAY, FACT_EXTRACTION, MEMORY_SUGGESTION, NORMALIZE_LANGUAGE |
| STANDARD_REASONING | `AI_STD_REASON` | UNDERSTAND, ADAPTIVE_QUESTION, COMPATIBILITY_EXPLAIN |
| DEEP_RELATIONSHIP | `AI_DEEP` | COMPATIBILITY_DEEP, LONGITUDINAL_ANALYSIS, COMPLEX_CONFLICT (quota `AI_DEEP`) |
| INDIC_SPECIALIST | `AI_INDIC` | Indic / code-mixed standard tasks, only if `AI_INDIC_ROUTING=specialist` |
| SECONDARY_REASONING | `AI_SECONDARY` | extra fallback / benchmark |

Per tier: `<PREFIX>_PROVIDER` (`openai|gemini|sarvam`), `<PREFIX>_MODEL`, optional `<PREFIX>_FALLBACK_PROVIDER` + `_FALLBACK_MODEL` (both or neither), `_MAX_OUT`, `_TIMEOUT_MS`, `_TEMPERATURE`.
Keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `SARVAM_API_KEY` (server secrets only). Optional: `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `SARVAM_BASE_URL`, `OPENAI_SEND_REASONING=1`, `AI_ENV=staging`.

## Privacy rules enforced in code
- A different provider is used only when the request has `allowProviderFallback: true` (default false).
- Sarvam specialist routing is **off by default**; turn it on only after DuoSpace's own evaluation (Stage 4) shows an advantage.
- The provider used is returned in `meta` and recorded in telemetry. Telemetry never contains message text.
- `debugForceProvider` is ignored unless the server runs with `AI_ENV=staging`.

## Not yet verified / not yet true
Provider request shapes (OpenAI `json_schema`, Gemini `responseSchema`, Sarvam endpoint and `api-subscription-key` header) are written from documentation knowledge and have not been executed. Sarvam does not use server-side strict schema; Zod is its only enforcement.
