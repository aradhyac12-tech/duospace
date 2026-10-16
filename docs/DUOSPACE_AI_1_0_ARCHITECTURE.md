# DuoSpace AI 1.0 architecture (Phase 3M)

UI -> RelationshipAIService -> server-side AI gateway (Supabase Edge Function `ai-gateway`) -> task router -> provider adapters (OpenAI, Gemini, Sarvam) -> Zod structured output -> deterministic guard. No provider key in the client or VITE_* variables (`npm run check:ai-secrets`).

| Stage | Status |
|---|---|
| 0 Audit | done |
| 1 Cloud AI foundation | IMPLEMENTED, live providers NOT VERIFIED |
| 2 Deterministic engines (16 dimensions, compatibility, adaptive selection) | IMPLEMENTED, see DUOSPACE_COMPATIBILITY_MODEL.md |
| 3 Product wiring | IMPLEMENTED (not run in a browser): `compatibility/cloud.ts` bridge; `AdaptiveQuestionCard` in Reflection "More tools"; `CompatibilityOverview` inside PartnerComparison |
| 4 Evaluation | PARTIAL: deterministic fixtures, guard, adaptive-stopping and scripted-grounding suites added (stand-in runner only); multilingual, live grounding and provider comparison NOT STARTED, see DUOSPACE_AI_EVALUATION.md |
| 5 Live staging (`npm run test:ai-live`) | NOT VERIFIED |

Untouched by design: calling, notifications, five-tier monetization. Provider routing: DUOSPACE_AI_PROVIDER_ROUTING.md. Not production ready until live provider verification passes.
