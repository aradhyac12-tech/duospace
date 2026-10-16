> **Phase 3J canonical extraction (2026-09-27):** one extraction engine for QuickReply/Understand/Today; engine domain+ambiguity moved into it; test harness fixed (8 DB tests); 1330 passed. See docs/PHASE_3J_CANONICAL_EXTRACTION.md.

> **Phase 3J (2026-09-27):** calling readiness-wait bug fixed (CONNECT_TIMEOUT / stuck connecting), location-based ringback (India / Kyrgyzstan-CIS / NA / default), chat-first relationship AI on one canonical extractor. Tests 1285 passed; tsc/eslint(0 errors)/build pass. Device NOT VERIFIED. See docs/PHASE_3J_CHAT_FIRST_AI_AND_CALLING.md.

# DuoSpace — Production Readiness (CURRENT)

**This is the single current-status reference.** Last verified: 2026-09-26, repository version 3.17.0 (Phase 3I). Historical phase reports are kept unchanged; where they conflict with this file, this file wins (see "Stale claims").

## Status matrix
| Area | Status | Evidence (this run unless stated) | Remaining gap |
|---|---|---|---|
| Code | PASS | `npm ci` exit 0 (clean), `npm ls` exit 0, `tsc` app+node exit 0, `eslint .` 0 errors / 95 warnings, `vite build` exit 0 | npm 10.9.7 used vs declared 10.9.2 (same minor) |
| Automated tests | PASS | `vitest run`: 104 files, 1179 passed, 2 skipped, 0 failed (Phase 3I run); DB 36 | — |
| Supabase DB/RLS | PASS (DB level) | 66 real-Postgres tests on staging (Phase 3F); production post-deploy structure check + rolled-back smoke test (2026-09-26); PGlite DB suite 32 passed (this run) | HTTP path not exercised |
| HTTP auth | BLOCKED | sandbox → `*.supabase.co` `host_not_allowed`; ready-to-run script `scripts/verify/http-rls-e2e.mjs` (24 checks) | run kit §1 and send JSON |
| Session isolation | NOT_TESTED | code: Settings sign-out runs `secureWipeAll`; per-user keys | account switch on a device |
| Relationship sharing | PARTIAL | server: PASS (staging matrix, production deployed); client: unit + F1 regression | app-level end-to-end with two real accounts |
| Android | BLOCKED | pipeline blocker G1 fixed (deps gate now passes); no SDK/device here | run `docs/DEVICE_TEST_KIT.md` §3–4 |
| iOS | BLOCKED | no Xcode / device | — |
| Calling | NOT_TESTED | unit/integration tests only | two-device smoke test |
| Notifications | NOT_TESTED | — | device test |
| Encryption | PARTIAL | AES-256-GCM (Web Crypto), software key in app sandbox, not hardware-backed; Android `allowBackup="false"` | Keystore/Keychain decision |
| Local AI | BLOCKED | manifest unpinned; `scripts/verify/fetch-local-model.mjs` ready | run kit §2, then device runtime test |
| Multilingual safety | PARTIAL | automated suites pass (this run); all languages NOT_REVIEWED | native review |
| I18N | PARTIAL | architecture + 8 P0 keys; ~1,460 strings English | translations after review |
| Privacy | PARTIAL | observed zero network in private AI paths (test); no service-role/JWT/test credentials in `dist` (scan this run) | device network capture; screenshots not protected (`PrivacyScreen.enable = false`) |
| Security | PARTIAL | D1–D4, E1–E6, F1–F2 fixed with regressions; production advisor unchanged by deploy | HTTP/device verification; pre-existing npm advisories; production lints (below) |
| **Overall** | **NOT READY** | critical gates BLOCKED/NOT_TESTED | see blockers |

## Release-build findings (this run)
- `dist/` contains no `service_role`, no JWTs, no test credentials (`example.invalid`, `TEST_USER_`). The only `service_role` strings are a code comment inside **hidden** sourcemaps (`sourcemap: "hidden"`, not referenced by the JS).
- `src/integrations/supabase/client.ts` falls back to the **production** URL when `VITE_SUPABASE_URL` is missing. A staging build without that variable would silently talk to production. (P2 — documented, not changed.)
- `native/android/google-services.json` is committed (Firebase client config; not a secret by Google's model, but ties builds to one Firebase project).
- Release keystore comes from a CI secret (`scripts/patch-android-signing.mjs`); none committed.

## Local AI candidate (NOT verified)
`HuggingFaceTB/SmolLM2-360M-Instruct`, ONNX weights added in commit `028493f` (31 Oct 2024; seen on the model's commit history page). Byte sizes and SHA-256 **not computed** — download is blocked here. Next step: on a networked machine, download at a full immutable commit hash, compute SHA-256 locally, compare with the LFS pointer, then fill `src/lib/relationship/localModel/manifest.ts`.

## Stale claims in historical documents (do not rely on them)
| Claim | Where | Current truth |
|---|---|---|
| Relationship migrations not deployed to production | `docs/PHASE_3F_LIVE_RLS_VERIFICATION.md` (body) | Deployed 2026-09-26 (same file's appendix) |
| "revoke is idempotent" | `docs/PHASE_3E_PRODUCTION_HARDENING_FINAL_REPORT.md` | False until F1 fix (3.16.3) |
| Tests never run / NOT RUN | older `.ai/TEST_STATUS.md` sections, early phase reports | 1163 passing this run |
| Live RLS BLOCKED | Phase 3E report | DB-level PASS (3F); HTTP still BLOCKED |
| Version numbers < 3.16.4 | all earlier reports | 3.16.4 |

## Production database observations (unchanged, owner decision)
`location_push_credentials` RLS with no policy (deny-all), 3 functions with mutable search_path, 3 trigger functions exposed via RPC, leaked-password protection off.

## Monetization
Merged (Phase 3I), M1 privacy leak fixed before any deploy; **not deployed**; Google Play verification still a stub (fails closed). Status: NOT_TESTED on device, BLOCKED on Play credentials.

## Daily AI (Phase 3I)
"Help me reply" in Chat + "Today" check-in. Automated safety: PASS (148 combinations). Device: NOT_TESTED.

## Runbook
`docs/DEVICE_TEST_KIT.md` — the exact commands and matrix for every remaining gate.

## Blockers in priority order
1. HTTP auth + session isolation with two real accounts (needs a networked machine or device).
2. Android build + install on the S24 Ultra; run the Phase 3G device matrix.
3. App-level relationship-sharing end-to-end (A↔B, C) on real accounts.
4. Calling + notifications two-device smoke test.
5. Local AI artifact: download, hash, runtime test.
6. Native-language review.
7. Encryption: hardware-backed key decision; `PrivacyScreen` decision.
8. iOS.
