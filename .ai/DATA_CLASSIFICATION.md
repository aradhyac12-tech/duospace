Data sensitivity classification. Implementation: `src/lib/privacy/dataClassification.ts`
(the `DataClassification` enum is the single source of truth other code
imports — this file explains it, it doesn't redefine it).

## The seven tiers

PUBLIC, PRIVATE, COUPLE, SENSITIVE, HIGHLY_SENSITIVE, SECRET, DEVICE_ONLY
— see the code comment on each for the one-line definition. Below: how
this repo's *actual* tables/data map to them, as of this phase.

| Data | Classification | Where it lives today |
|---|---|---|
| App version, feature flags | PUBLIC | client bundle |
| `profiles` display name, gender, phone | PRIVATE | Supabase, RLS-scoped to self+partner |
| Shared memories, playlists, `Us` content | COUPLE | Supabase, RLS-scoped to the couple |
| Call-history rows (type/status/timestamps/duration; no content) | COUPLE | Supabase; last list also cached on-device via secureStorage (`callHistoryCache.ts`), `room_name` dropped, wiped on sign-out |
| Chat messages (decrypted, whole loaded history up to 20k/conversation, non-disappearing only) | COUPLE / SENSITIVE | Supabase (E2E ciphertext); also stored on-device, one AES-256-GCM record per message under the secureStorage master key (`localDb/messageStore.ts` via `chatCache.ts`, `PERSIST_CHAT_CACHE`); rows deleted + key destroyed on sign-out and on unlink. Widened from "latest 60" on 2026-09-21 (offline-first) at the owner's request |
| Screen snapshots on-device: Shayari list, Us (profiles, mood, countdowns, daily answers, streak), Memories rows, Gallery item rows + albums (paths only, never signed URLs) | COUPLE / PRIVATE | Supabase; on-device AES-256-GCM snapshot per screen (`localDb/collectionStore.ts` via `screenCache.ts`, switch `screenData`), wiped on sign-out / unlink |
| Chat media cached on-device (photos, voice notes, small videos; `chat-files` only) | COUPLE / SENSITIVE | Supabase private bucket (not E2E-encrypted server-side either); on-device copy in IndexedDB (`mediaCache.ts`, `MEDIA_CACHE_ENABLED`), **unencrypted at rest inside the app sandbox**, LRU-capped at 400 MB, wiped on sign-out |
| Mood check-ins (existing `MoodDetector`/`MoodHistory`) | SENSITIVE | Supabase — **not yet re-audited against this classification, see Known Issues** |
| Any future AI-derived observation (`ai_insights` table, this phase) | HIGHLY_SENSITIVE | Supabase, RLS owner+explicit-share only, immutable after creation |
| Auth tokens, refresh tokens, Daily/LiveKit API keys, encryption keys | SECRET | Supabase secrets / Edge Function env / IndexedDB (E2E keys) — never client-readable in plaintext beyond the owning device |
| Raw camera/mic/video frames, local-model intermediates | DEVICE_ONLY | Nowhere persistent yet — no feature currently captures/stores these; `ABSOLUTE_DENY_RULES` in code exists pre-emptively for when one does |

## Enforcement

`ABSOLUTE_DENY_RULES` in `dataClassification.ts` encodes the
non-negotiable pairs (DEVICE_ONLY → CLOUD_AI, DEVICE_ONLY → SUPABASE,
SECRET → CLOUD_AI) that `privacyGate.ts`'s `canProcess()` checks *before*
consent — consent can never unlock one of these. See `.ai/PRIVACY_MODEL.md`.

## Known gap

This table was built by re-reasoning about what data exists, not by
re-auditing every existing table's actual RLS against these labels one
by one — that full audit (every table in `docs/PHASE_4_SECURITY_AUDIT.md`'s
scope, re-read through this classification lens) has not been done. Flagged
in `.ai/KNOWN_ISSUES.md`, not silently assumed complete.


## Phase 1.6: destination matrix (from `POLICY_MATRIX`)
A = allowed by class alone (feature/destination consent still required by the
gate) · C = needs the destination's own consent · S = explicit per-item share +
`SHARED_INSIGHTS` · X = never.

| Class | DEVICE | SUPABASE | CLOUD_AI | PARTNER | ANALYTICS | LOGS |
|---|---|---|---|---|---|---|
| PUBLIC | A | A | A | A | A | A |
| PRIVATE | A | A | C | X | X | X |
| COUPLE | A | A | C | A | X | X |
| SENSITIVE | A | A | C | S | X | X |
| HIGHLY_SENSITIVE | A | A | C | S | X | X |
| SECRET | X | X | X | X | X | X |
| DEVICE_ONLY | A | X | X | X | X | X |

Correction to the table above: the "Mood check-ins" row is now audited. Manual
picks are SENSITIVE (self-reported). Camera-derived mood labels are
HIGHLY_SENSITIVE (AI-derived); the raw frames behind them are DEVICE_ONLY.
Face templates and Peek breach photos are DEVICE_ONLY (currently stored
unencrypted — KI-22). E2E private keys and the secureStorage master key are SECRET.

## Phase 2A: relationship reflection

| Data | Classification | Where it lives |
|---|---|---|
| Values answers (choice only, no free text) | SENSITIVE — HIGHLY_SENSITIVE if the category is Intimacy/Boundaries | On-device only (secureStorage), see `src/lib/relationship/classification.ts` |
| Values answers with free text attached | HIGHLY_SENSITIVE (any note can contain anything) | On-device only |
| Expectation items | SENSITIVE, or HIGHLY_SENSITIVE if type=BOUNDARY or category is Intimacy/Boundaries/Finances/Family | On-device only |
| Communication reflections kept on-device (opt-in) | HIGHLY_SENSITIVE, always | On-device only |
| Relationship insight (AI-derived) | HIGHLY_SENSITIVE | On-device only (`ai_insights` local store — this phase never added a server `ai_insights` table; see `.ai/CURRENT_STATE.md`) |
| An explicitly shared snapshot (one value answer / expectation / insight) | COUPLE | Supabase `relationship_shares` — the ONLY server-side row this feature creates, and only after the owner previews and confirms it |

None of the above is ever PRIVATE (the ordinary default for regular
app data) — the brief was explicit that these need a stronger tier than
that, so `stores.ts` always calls `classifyValueAnswer`/
`classifyExpectation` rather than defaulting.
