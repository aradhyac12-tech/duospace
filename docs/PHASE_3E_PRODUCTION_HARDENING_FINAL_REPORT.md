# Phase 3E — Production Hardening: Final Report (2026-09-25)

No new relationship-AI capability was added.

## 1. Baseline
`docs/PHASE_3E_BASELINE.md`: v3.16.1, no git metadata, 1136 passed / 0 failed, local model artifact absent, no native SDKs, no devices.

## 2. Phase 3D second review — new defects found and fixed
| # | Severity | Defect | Fix | Evidence |
|---|---|---|---|---|
| E1 | High (privacy) | `listSharedByMe` returns `[]` on error, so **offline "Delete all" / consent-off skipped withdrawing shared copies and still wiped local memory** — the D2 fix was ineffective offline. | `listSharedByMeStrict` (throws) + `withdrawAllMemorySharesVerified` (list → withdraw → re-list must be empty; delete only if ok). | `phase3eHardening.test.ts` offline + concurrent-share cases |
| E2 | Medium | After unlink (server auto-revokes all shares) or a partial failure, local memories still showed SHARED (stale state). | `reconcileSharedState` on load, only from a successful list; never resurrects deleted memories. | 3 tests |
| E3 | Medium | Lost update: actions awaiting the network used a render-time snapshot and could overwrite a change made meanwhile. | Serialized write queue from latest state in `MemoryPanel`. | code review; pure pieces tested |
| E4 | Medium | Consent-off during an in-flight share could leave a new share live. | Consents re-read from storage before and after sharing; share undone if sharing was turned off. | code review |
| E5 | High (deploy) | Migration `20260925210000` (from the previous audit, never applied anywhere) **failed** on any database already holding a non-conforming MEMORY share. | Made upgrade-safe: withdraws non-conforming live rows, adds constraints `NOT VALID`. | `migrationUpgrade.db.test.ts` failed before, passes after; idempotent re-run |
| E6 | Low (FP) | Hinglish "saare paise" flagged "saare paise kharch ho gaye". | Narrowed to "saare paise le leta/rakh leta…". | probe test |
Race conditions/idempotency: revoke is idempotent (owner-scoped update, no-op if already revoked); duplicate active shares blocked by `uq_relationship_shares_active_item`.

## 3. D1–D4 regression — PASS
D1 `phase3dAudit.test.ts` (correct/outdated/delete withdraw first; failure → no change). D2 now plus E1 (verified, offline-safe). D3 `phase3dAudit.db.test.ts` + upgrade test. D4 multilingual share gate test.

## 4–5. Database / RLS
Fresh DB (all relationship_shares migrations in order): PASS. Upgrade path: PASS (after E5). IDOR / cross-user / non-partner insert / partner cannot modify-delete-withdraw / stranger sees nothing / withdrawn invisible: PASS on **PGlite (real Postgres engine) with RLS as `authenticated`** — 32 DB tests.
**Live Supabase RLS: BLOCKED** — no project credentials or test accounts in this environment. Smallest unblock: two test users on a staging project + anon key; run the same 32 scenarios through `supabase-js` with real sessions.

## 6. Encryption — what "device encrypted" actually means
AES-256-GCM via Web Crypto; random 96-bit IV per write; 128-bit auth tag (Web Crypto default); key generated per user with `generateKey`, **extractable**, stored as a JWK in IndexedDB (`duo-keystore`); ciphertext in Capacitor Preferences (SharedPreferences / UserDefaults). Key lifetime: until logout (Settings sign-out calls `secureWipeAll` → key deleted → data unrecoverable). No key derivation from a password. Android app-data backup disabled (`allowBackup="false"` via the patch script). Reinstall / new device: data is lost (by design). **Limitations:** the key sits in the same app sandbox as the ciphertext and is not hardware-backed (no Android Keystore / iOS Keychain), so this protects against casual inspection and backups, **not** against a rooted/compromised device or malicious code running in the app. Server-forced sign-outs do not run the wipe. Status: PARTIAL (sound primitive, software key storage).

## 7. Multilingual review — NOT_REVIEWED (all 11 languages)
`docs/NATIVE_LANGUAGE_REVIEW_PACK.md` generated from the code (961 lines): every safety phrase, context-gated verb, safety/limited-mode/repair/response template, emergency text, with structured columns A–L and sign-off rules. No native review took place.

## 8. I18N architecture
`docs/I18N_ARCHITECTURE.md`: catalogs + `tr()` + fallback chain + plurals + no-RTL, extending `src/lib/i18n.ts`; safety keeps its own explicit fallback. 8 P0 keys adopted; no unreviewed non-English P0 text added (deliberate).

## 9–10. Devices and native calling — BLOCKED
No physical Android/iOS device, Android SDK or Xcode. Device matrix A–R, Telecom/CallKit/PushKit, locked-screen/killed-app calls: NOT VERIFIED. Smallest unblock: a Samsung + a low-end Android with a debug APK built via `npx cap sync android && ./gradlew assembleDebug` on a machine with the Android SDK, running the matrix in the prompt.

## 11–12. Local model / real inference — BLOCKED
Manifest unpinned (empty sha256, 0 bytes, tokenizer "unpinned"); no weights in the repo; integrity check correctly refuses. No inference was run or simulated. Smallest unblock: pin one model revision (files + sha256 + bytes) in `localModel/manifest.ts` and host the artifact.

## 13. Privacy / network
**Observed** (not just grepped): with fetch / XHR / WebSocket / Supabase replaced by recorders, response support (EN, Hindi limited, safety hold), conflict repair (EN, Tamil), dyadic comparison, memory model + summary, language detection and safety lexicon made **zero** network calls; the explicit share path did reach Supabase (control). `networkInstrumentation.test.ts`. On-device network capture: NOT VERIFIED.

## 14. Performance (sandbox Node.js, not a phone — `docs/eval/phase3e_perf.json`)
Response support EN p50 0.25 ms / p95 0.69 ms; Hindi limited 0.03 / 0.07; repair review 0.31 / 0.50; memory summary (200 records) 0.42 / 0.74; safety + language detection per message 0.007 / 0.010. App startup, Chat open, send, call connection, model latency: NOT MEASURED.

## 15–18. Gates
| Gate | Result |
|---|---|
| `npx vitest run` | 99 files, **1160 passed**, 2 skipped, 0 failed (was 1136; +24 new, none removed) |
| DB/RLS (PGlite) | 32 passed |
| `tsc -p tsconfig.app.json` / `tsconfig.node.json` | exit 0 / exit 0 |
| `eslint .` | exit 0, 0 errors, 95 warnings (unchanged) |
| `vite build` | exit 0 |
| `check:rls` | exit 0 |

## 19. Remaining blockers (smallest action each)
Live RLS → staging project + 2 test users. Android/iOS → physical devices + SDKs. Local AI → pin and host a model artifact. Native review → recruit reviewers with the pack. UI localization → reviewed P0 translations, then P1. Encryption hardening → native secure-storage plugin (Keystore/Keychain) — a design decision for the owner.

## 20. Production-readiness matrix
| Subsystem | Status | Evidence |
|---|---|---|
| Phase 3D | PARTIAL | code + PGlite PASS; device/live NOT VERIFIED |
| Multilingual safety | PARTIAL | tests PASS; native review NOT done |
| I18N | PARTIAL | architecture PASS; ~1,460 strings untranslated |
| Live RLS | BLOCKED | no staging access |
| Android | BLOCKED | no SDK/device |
| iOS | BLOCKED | no Xcode/device |
| Local AI | BLOCKED | no artifact |
| Privacy | PARTIAL | observed zero network in private paths; software-only key storage |
| Security | PARTIAL | D1–D4 + E1–E6 fixed; live/device NOT VERIFIED; 20 pre-existing npm advisories (see Phase 3C report) |
| **Overall** | **NOT READY** | critical gates BLOCKED |
