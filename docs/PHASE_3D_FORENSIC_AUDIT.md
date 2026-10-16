# Phase 3D — Forensic Audit (2026-09-25)

**Final classification: KEEP + FIX.** The discovered implementation is architecturally sound and matches the intended principles; four verified defects were fixed (two privacy, one security, one safety). It is not production-ready (see §15).

## 1. Discovery and provenance
A complete "Phase 3D relationship memory / longitudinal" system was found in the repository. File timestamps show it was written 2026-09-25 19:19–19:32 (sandbox time), between the Phase 3C build (19:07) and the RESPONDED build (19:38), and it shipped inside `duospace-phase3c-complete.zip`. The Phase 3C report stated 3D had not started; there is no phase report, owner sign-off or scientific review for it in the record. Historical reports were left unchanged; this discrepancy is recorded in `.ai/CURRENT_STATE.md`. **How it was produced cannot be established from the repository.**

## 2. Inventory (no files were modified during inventory)
| File | Purpose | DB dependency | AI dependency | Privacy class | User visible | Partner visible | Risk |
|---|---|---|---|---|---|---|---|
| `src/lib/relationship/memory/types.ts` | Record/agreement/consent model, evidence levels 1–5, no numeric score | — | — | Relationship-sensitive | — | — | Low |
| `memory/model.ts` | create / confirm / correct (supersede) / mark outdated / delete chain / retention / currency | — | — | Sensitive | via panel | no | Low |
| `memory/store.ts` | Encrypted on-device store (`rel_memory_v1`), 4 consents, revoke-store deletes | Local secure storage only | — | Sensitive | — | no | Low |
| `memory/longitudinal.ts` | Descriptive summaries, topic comparison (ALIGNED/DIFFERENT/UNKNOWN/NOT_YET_DISCUSSED), context selection, validators | — | Optional rephrase only | Sensitive | yes | no | Low |
| `memory/share.ts` | Explicit per-item share of MEMORY / AGREEMENT / AGREEMENT_RESPONSE | `relationship_shares` | — | Shared on explicit action | yes | yes (that item only) | **Medium → fixed (D4)** |
| `memory/sync.ts` | Turns RLS-visible rows into partner records; merges confirmations | reads under RLS | — | Shared | yes | — | Low |
| `memory/index.ts` | Repair feedback, summary pipeline (+ audit fixes D1/D2) | — | via service | Sensitive | — | — | Low |
| `src/components/relationship/MemoryPanel.tsx` | UI (Insights tab) | via share.ts | via service | — | yes | — | **Medium → fixed (D1, D2)** |
| `RepairPanel.tsx` (feedback block) | Optional "did it help?" → repair history | local | — | Sensitive | yes | no | Low (disclosure improved) |
| `service.ts` `longitudinalSummary` | Routes summaries through RelationshipAIService | — | LOCAL hook, RULE fallback | — | — | — | Low |
| `supabase/migrations/20260925200000_relationship_shares_memory_agreements.sql` | New share kinds + key-set constraints | yes | — | — | — | — | **Medium → fixed (D3)** |
| `src/test/memory/{memory,memoryEval}.test.ts`, `src/test/db/memoryShares.db.test.ts` | Existing tests | — | — | — | — | — | — |

## 3. What it actually does (traced, not inferred)
Functional, local-first, user-controlled. Memories are created only from the panel's form (`createMemory` has one caller) or from the explicit repair-feedback buttons (one caller). **No path from chat messages, moods, calls, media or AI output creates memory** (grep + static test). Nothing is persisted without consent A (`store`). Private memory never reaches the server: there is **no table** for it (proved on PGlite). Sharing is per item, previewed, through the existing consent gate and RLS. Summaries go through `RelationshipAIService` (rule-based; optional local rephrase validated; no cloud).

## 4. Gap table
| Requirement | Status | Evidence |
|---|---|---|
| No compatibility / health score, no ranking | IMPLEMENTED | no numeric field (static test); score/prediction/profiling validators |
| No breakup / cheating prediction, no personality profiling | IMPLEMENTED | `validateSummary` PREDICTION/PROFILING/PATHOLOGY; template scan test |
| No surveillance / hidden profiling | IMPLEMENTED | no chat/mood/call sources; static test |
| User-controlled memory | IMPLEMENTED | only explicit creation paths |
| Provenance (sourceId, sourceType, sourceTimestamp, owner, evidence level, model version, createdAt, lastConfirmedAt, visibility, status) | IMPLEMENTED | `MemoryRecord`; `createMemory` throws NO_SOURCE |
| Evidence levels | IMPLEMENTED | 1–5; AI-suggested stays 5 |
| Temporal validity | IMPLEMENTED | `currency()`: CURRENT / MAY_BE_OUTDATED (180 d) / HISTORICAL / WITHDRAWN / EXPIRED |
| Correction | IMPLEMENTED; **was INCORRECT for shared items → fixed (D1)** | supersede chain |
| Deletion | IMPLEMENTED; **incomplete for shared copies → fixed (D1, D2)** | hard delete incl. chain; retention deletes |
| Partner asymmetry | IMPLEMENTED | §9 tests |
| ALIGNED / DIFFERENT / UNKNOWN | IMPLEMENTED (+ NOT_YET_DISCUSSED) | structured `position` only |
| Explicit sharing | IMPLEMENTED; **server shape check incomplete → fixed (D3)**; **no safety gate → fixed (D4)** | |
| Privacy-first processing | IMPLEMENTED | on-device; share.ts only network path |
| Descriptive, not predictive | IMPLEMENTED | "came up in N records… don't establish why" |

## 5. Defects found and fixed
| # | Severity | Defect | Fix | Proof |
|---|---|---|---|---|
| D1 | Privacy (high) | Correcting or marking a **shared** memory "no longer true" left the old statement shared; the partner kept seeing it as current. | `changeMemory()` withdraws the share first; if that fails nothing changes locally; corrected version starts private. | `src/test/memory/phase3dAudit.test.ts` (4) |
| D2 | Privacy (high) | Revoking memory storage/sharing consent or "Delete all" wiped only this device; shared memories/agreements stayed readable by the partner, undisclosed. | `withdrawAllMemoryShares()` on revoke/delete-all; aborts (nothing deleted) if any withdrawal fails; confirm text discloses it. | unit tests (2) |
| D3 | Security (medium) | `position` accepted **any JSON** (e.g. `{hidden: "full chat history…"}`): an unbounded hidden channel to the partner; ids/timestamps/topic untyped. | Migration `20260925210000_memory_share_payload_hardening.sql` constrains value shapes. | PGlite test fails **without** the migration (hidden payload accepted) and passes with it |
| D4 | Safety (high) | A memory/agreement like "He threatens to hurt me" could be shared with the partner — the Phase 3C safety gate wasn't applied. | `previewMemoryShare`/`previewAgreement` run the multilingual fail-closed gate; flagged items stay private. | unit test (EN/HI/Hinglish/TA) |
Minor: repair-feedback silently saved "what I'm willing to do" text — disclosure added to the UI note.

## 6. Database / RLS (real Postgres, PGlite, all migrations in order)
Owner = `owner_id`; viewer = `recipient_id` (current partner) only; INSERT only to current partner; SELECT owner or recipient; UPDATE owner revoke only; DELETE owner; unlink revokes all (existing trigger). No service-role use in client code. Proved: partner reads only explicit shares; stranger reads nothing; partner can't modify/delete/withdraw owner's share; another user can't insert as owner; withdrawn share invisible; no memory/longitudinal tables exist. `src/test/db/phase3dAudit.db.test.ts` (6) + existing `memoryShares.db.test.ts`.

## 7. Deletion trace
Database: owner revoke (row kept with `revoked_at`, unreadable by recipient — existing design of `relationship_shares`, disclosed). Local encrypted store: removed. Derived summaries: computed on demand, never stored. AI context: selected per request, never cached. Search indexes / analytics / logs: none exist for memory (static test). Unavoidable retention: revoked share rows remain server-side (owner-readable) per the existing permanent-revoke design; partner devices may have displayed content before withdrawal.

## 8. Tests
Before audit: 90 files / 1105 passed. After: 94 files / 1136 passed, 2 skipped, 0 failed. New: phase3dAudit (unit, 13), phase3dAudit.db (6), multilingual audit files. One pre-existing test intentionally changed (it required "112" for every locale).

## 9. Scientific alignment
Descriptive only; agreement requires both explicit confirmations; staleness prompts ("Is this still true?") rather than silent assumptions. Temporal thresholds (180 d stale; 90/365 d retention) are **product defaults, not empirically derived** (as the code states). No longitudinal claims about relationship outcomes.

## 10. Status
| Component | Status |
|---|---|
| Inventory / architecture | PASS |
| Consent, provenance, temporal, asymmetry | PASS |
| Deletion & revocation | PASS (after D1/D2) |
| Payload security | PASS (after D3) |
| Sharing safety | PASS (after D4) |
| RLS | PASS (PGlite) — production Supabase NOT VERIFIED |
| UI on device | NOT VERIFIED |
| Local-model summaries | BLOCKED (no model) |
| Scientific validation | NOT VERIFIED |

## 11–15. Remaining uncertainty
Origin of the code is unknown; it was reviewed as untrusted and should get owner review. Migrations not applied to the live Supabase project. No device testing. Memory panel UI is English-only.
