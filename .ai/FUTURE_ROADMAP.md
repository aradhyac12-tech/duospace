RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01).

| Phase | Goal | Depends on |
|---|---|---|
| 0 — Stabilization | Repo discovery, `.ai/` creation, initial audit | — |
| 0.5 — Scientific + Product Spec | Relationship-science research, do-not-build list | Phase 0 |
| Security hardening (ongoing) | Close real findings as discovered | Phase 0 |
| 1 — Privacy/Consent/Local-AI Foundation | Data classification, consent, privacy gate, AI insight contract — infrastructure only | 0.5 |
| 1.5 — Production verification (this pass) | Real build/dependency/RLS/TS-safety audit, honest BLOCKED/NOT VERIFIED status everywhere | 1 |
| 2 — Relationship AI, P0 tier | Self-report check-ins, first real `LocalAIProcessor`/`AIInsight` | 1 + still-open security queue closed or explicitly triaged |
| 2.5+ | Conflict/repair, compatibility/values/expectations, multimodal research (opt-in only), DuoAutoAnswer | 2, each gated on real usage data from the prior tier |
| Production validation | Real build/lint/test/device/live-DB verification closing every BLOCKED-BY-ENVIRONMENT gap | All of the above |

Do not prioritize novelty over reliability. Each phase, when it actually
starts, gets its own GOAL/DEPENDENCIES/FILES/DATABASE CHANGES/SECURITY
CHANGES/PRIVACY CHANGES/TESTS/DEVICE TESTS/RELEASE GATE/ROLLBACK PLAN
written at that time, not spec'd in advance here.
