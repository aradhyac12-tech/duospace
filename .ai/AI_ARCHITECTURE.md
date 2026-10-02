# AI Architecture (canonical, as of Phase 3C)

UI → `RelationshipAIService` (src/lib/relationship/service.ts) → routing (LOCAL / E2E_CLOUD / RULE_BASED / UNAVAILABLE) → deterministic core → optional LOCAL rephrase → validators → UI. No UI calls a model or cloud directly.

| Feature | Entry | Deterministic core | LOCAL hook (provider method) | Validators |
|---|---|---|---|---|
| Values/Expectations/Reflection insights (2A–2D) | analyzeValues/…Expectations/…Reflection | local-rule-v1 | provider analyze* | outputValidator, groundingValidator |
| Dyadic comparison (3A) | compareWithPartner | dyadic/compare.ts | explainDyadic | dyadic/explain.ts |
| Response support (3B) | supportResponse | responsiveness/engine.ts | rephraseResponse | responsiveness/validate.ts |
| Conflict repair (3C) | prepareRepair | repair/{machine,reflect}.ts | rephraseRepair | repair/validate.ts (+3B +Phase 2) |

Rules: consent `RELATIONSHIP_INSIGHTS` required; models may only rephrase, never change status/evidence/safety; any model failure → rule result; E2E_CLOUD never used by Phase 3 features; every result carries model version, execution mode and (3C) validator + contract versions. The real local model is BLOCKED (Phase 2D), so users get RULE_BASED.

## Phase 3E (2026-09-25)
Local model: manifest unpinned (no hashes/bytes, no artifact) → LOCAL never selected; RULE_BASED serves all features. Real inference BLOCKED. UI strings: `tr()` catalogs in src/lib/i18n.ts (docs/I18N_ARCHITECTURE.md).
