# DUOSPACE_INDEX.md — read THIS instead of the zip

> **How to use (for Claude):** Read only this file at the start of a session. Do NOT unzip/read the full repo.
> Open a specific file from the zip ONLY when the task needs it (use `unzip -p <zip> <path>`), never the whole archive.
> **How to update:** after every change/new zip, append a row to §10 "Update log" and edit any section that changed. Bump the version in §1.

---

## 1. Snapshot
| Item | Value |
|---|---|
| Zip | `duospace-v3_21_0-admin-console.zip` (admin console on top of `duospace-v3_20_6-with-index.zip`; no node_modules) |
| App | DuoSpace — privacy-first, couples-only app (chat, calls, media, music, map/location sharing, relationship AI) |
| Version | **3.21.0** (package.json + `src/lib/errors/DuoSpaceError.ts` must both be bumped per change) |
| Date | 2026-10-03 |
| Owner | Aradhya, solo dev; AI works session-to-session via zip snapshots |
| Stage | Pre-launch, hardening. **NOT production-ready.** |
| Live Supabase (prod) | `jzlpelxwzjjpddqcrtpu`; staging `otaficrlkiscaihdwxnt` |
| This build contains | **v3.21.0 admin console (source only: migration `20261003100000_admin_console` NOT applied, `admin-user-action` NOT deployed; see `docs/ADMIN_CONSOLE.md`)**, v3.20.6 Stop sharing + 14-day scheduled unilateral unlink (source only, NOT applied/run), Phase 3M AI-eval fixtures (Stage 4, partial), merged earlier 3.18–3.20.5 work |

## 2. Stack
React + TS, Vite (SWC plugin only), Tailwind, Framer Motion, shadcn/ui. Supabase (Postgres/RLS/Realtime/Storage, ~36 edge functions). Capacitor 8 (Android/iOS; `android/` and `ios/` are generated — `native/` + `native-plugins/` hold custom code). Calling = self-hosted only: WebSocket signaling + LiveKit + embedded TURN + FCM/APNs/PushKit + native Telecom/CallKit. Monetization: Razorpay + Google Play Billing + AdMob (UMP consent). Node 22, npm only. Deploy targets: Vercel / Netlify / Cloudflare / Lovable.

## 3. Top-level layout (what lives where)
| Path | Files | Purpose |
|---|---|---|
| `src/` | 678 | App source (see §4) |
| `supabase/` | 209 | `migrations/` (137, additive only), `functions/` (edge fns), `tests/`, `config.toml` |
| `infrastructure/` | 27 | `signaling/` (Node/TS WS signaling server + vitest), `deployment/` (docker-compose, env examples), `coturn/`, `livekit/` |
| `native/`, `native-plugins/` | 139 / 83 | Custom native code; 7 local plugins: admob, audio-engine, audio-route, background-geolocation, billing, callkit-bridge, device-status |
| `android/` | 345 | Generated Capacitor project (do not commit native strategy change without decision) |
| `docs/` | 131 | Phase reports, audits, architecture, QA (see §7) |
| `.ai/` | 40 | **Canonical code-verified project memory** (see §6). `.ai/` wins over `docs/` when they disagree |
| `scripts/` | 26 | Build/verify gates (§8) |
| `public/`, `resources/`, `drizzle/`, `whitelabel/` | | static assets, icons, drizzle config, white-label apps |
| Root docs | | `AGENTS.md`, `DEPLOYMENT_INVARIANTS.md` (MUST read before touching build/deploy config), `BUILD.md`, `DEPLOY.md`, `SETUP_GUIDE.md`, `PUSH_NOTIFICATIONS.md`, `TEST_PAYMENTS.md`, `brain.md`, audit reports |

## 4. `src/` map
- **pages/** (16): Auth, Calls, Chat, Gallery, Groic (music), Index, MapView, Onboarding, Playlist, Profile, Reflection, ResetPassword, Settings, Shayari, Us, NotFound; `settings/` (11: **Admin (7-tab console; parts in `components/admin/`)**, Appearance, DataBackup, Devices, DuoSpacePlus, Import, Language, Notifications, **Partner**, PrivacyAI, Security); `legal/`.
- **contexts/** (7): Auth, BottomSurface, **Call** (single global call manager — never duplicate), DockBadges, Groic, **Location**, Theme.
- **components/**: `ui/` (50 shadcn), `chat/` (29: MessageTimeline/Bubble/Composer, surprise, letters, reactions…), `calls/` (6), `relationship/` (8: TodayInsight, PartnerComparison, ResponseSupportPanel, RepairPanel, MemoryPanel, DailyCheckIn, AdaptiveQuestionCard, CompatibilityOverview), `surprise/`, `auth/` (passkey, QR sign-in), `settings/`, `monetization/`, `errors/`, `skeletons/`, `dock/`; top-level: AppLayout, FloatingDock, PeekGuard, MoodDetector, FaceEnrollmentDialog, **UnlinkRequestHost, ScheduledUnlinkHost**, **UserNoticeHost, AppUpdateHost, BlockedGate** (admin-console surfaces), Groic players, ThemeStudio, IconStudio, BackupManager, etc.
- **hooks/** (50): e.g. useE2E, useLiveLocation, useCloudBackup, useCallOutcome, **useSharingState, useScheduledUnlink, useUnlinkRequests** (unlink/sharing), useAiQuota, useEntitlement, useBiometricLock…
- **lib/** (124 files + subdirs):
  - `ai/` (gatewayClient in `cloud/`, groundingValidator, outputValidator, provenance, sharing, localProcessor, localInsightStore)
  - `relationship/` (pipeline, service, stores, sharing, questions, compatibility/{engine,adaptive,cloud}, dyadic, repair, memory, contextual, responsiveness, i18n, localModel, e2eCloud, providers)
  - `privacy/` (consent, dataClassification, privacyGate, sensorGate/Policy, secureStorage, deviceVault, redact, derivedMoodGate)
  - `callEngine/` + `signalingEngine/` (self-hosted call + WS signaling clients)
  - `music/` (YouTube/SoundCloud/Audius providers, queue logic, native audio engine, offline downloads)
  - `monetization/` (adConsent, adPolicy, admobProvider, billingCopy, paymentRouting, config)
  - `errors/`, `legal/` (ageGate, legalConfig), `localDb/`, root utilities (crypto, keystore, partnerUnlink, **scheduledUnlink**, surprise*, theme, i18n, telemetry, mood*, …)
- **integrations/supabase/** (client, types, auth middleware), **types/**, **workers/** (face worker).
- **test/** (148 test files; subdirs ai, ai-eval, compatibility, contextual, db (PGlite RLS), dyadic, i18n, legal, memory, monetization, perf, privacy, repair, responsiveness). Newest: `scheduledUnlink.test.ts`, `ai-eval/fixtures.test.ts`.

## 5. Backend map
- **Edge functions** (`supabase/functions/`): ai-gateway, send-push, send-voip-push, send-email, signaling-ticket, livekit-token, call-decline, QR (issue/check/redeem/qr-anon-issue), webauthn-* (4), music (music-search, music-trending, audius-search, soundcloud-search), billing (create/verify/cancel Razorpay, razorpay-webhook, google-play-rtdn, verify-google-play-purchase, get-billing-account-token), uploads (finalize-upload, cleanup-orphan-uploads), purge-vanish-messages, deliver-scheduled-messages, location-push-*, complete-signup, set-email-password, notify-signin. `_shared/` = cors, fcm/apns, **pushTypes**, rateLimit, signalingTicket, etc.
- **Latest migrations** (137 total): `…20261001100000_ai_gateway_quota`, `…120000_music_profiles`, `…130000_shayari_partner_actions`, `…150000_mood_logs_own_select_only`, `…160000_realtime_lipread_prefix`, `20261002100000_blend_collab_push`, **`20261002110000_stop_sharing`**, **`20261002120000_scheduled_unilateral_unlink`** (last two NOT applied anywhere).
- **Signaling server** `infrastructure/signaling/src/`: gateway, server, auth, authorizer, callRegistry, session, rateLimit, origin, types (+ vitest suites). Docker build NOT verified.

## 6. `.ai/` memory files (canonical) — which to open for what
| Need | File |
|---|---|
| What is this / rules | `PROJECT_CONTEXT.md`, `IMPLEMENTATION_RULES.md`, `DO_NOT_CHANGE.md`, `DO_NOT_BUILD.md`, `DECISIONS.md` |
| Current state / status | `CURRENT_STATE.md` (34 KB), `PHASE_STATUS.md`, `TEST_STATUS.md` |
| Open work | `PENDING.md` (start here), `NEXT_PHASE.md`, `KNOWN_ISSUES.md` (KI-01…KI-44, 45 KB) |
| History | `CHANGELOG.md` (115 KB — read only the top entries) |
| Last session | `HANDOFF_2026-10-02.md` |
| AI/privacy specs | AI_ARCHITECTURE, AI_SAFETY_SPEC, AI_OUTPUT_CONTRACT, DYADIC_AI_SPEC, RELATIONSHIP_MEMORY_SPEC, VALUES_SPEC, EXPECTATIONS_SPEC, CONSENT_MODEL, PRIVACY_MODEL, DATA_CLASSIFICATION, SAFETY_MODEL, SECURITY_MODEL, DATABASE_CONTRACT, MEMORY_MODEL, LOCAL_AI_ARCHITECTURE, MODEL_MANIFEST.json |

## 7. `docs/` highlights
Calling: `calling-architecture.md` (current), `CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`, `CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md`. Status: `PRODUCTION_READINESS_CURRENT.md` (single status ref), `PHASE_4_SECURITY_AUDIT.md`. Latest feature: `STOP_SHARING_AND_SCHEDULED_UNLINK.md` (design + 18-case manual matrix). AI (Phase 3M): `DUOSPACE_AI_1_0_ARCHITECTURE`, `DUOSPACE_AI_PROVIDER_ROUTING`, `DUOSPACE_ADAPTIVE_QUESTIONS`, `DUOSPACE_COMPATIBILITY_MODEL`, `DUOSPACE_AI_EVALUATION` (+ fixtures `docs/ai-eval/*.json`). Security/DB: `RLS_SECURITY_MATRIX`, `SUPABASE_*` (schema inventory, checklist, reconciliation). Others: MONETIZATION_ARCHITECTURE, LEGAL_CHECKLIST, I18N_ARCHITECTURE, OFFLINE_FIRST, PARTNER_UNLINK_CONSENT, PASSKEYS_SETUP, IOS_NATIVE_SETUP, phase reports PHASE_1…3J.

## 8. Commands / gates
`npm run verify:lock && npm run build` before every push · `npm test` (vitest) · `npm run lint` · `check:rls` · `check:lock` · `check:ai-secrets` · `check:monetization -- --target staging|production` · `check:calling` · `test:ai-live` · `cap:sync` / `cap:verify:*` · `whitelabel:apply` · `fonts:fetch` (needs network, not yet run). CI: `.github/workflows/ci.yml` (never run yet).

## 9. Current status & open work (as of v3.20.6)
**Verified earlier (3I run, 2026-09-26):** 104 test files, 1179 passed, tsc/eslint/build exit 0 in that sandbox. **Since then (3.18–3.20.6) real tsc/lint/vitest/build have NOT been run** — only stand-in runners.
**Next steps, in order:** (1) `npm ci && npx tsc --noEmit && npx vitest run` and fix; (2) diff re-declared `private.apply_unlink` vs LIVE function; apply the two `20261002*` migrations to staging; run the 18-case matrix; (3) deploy `send-push` BEFORE app build, then production; (4) device check Map when partner `locations` row deleted; (5) push repo and read first CI run.
**Pending owner decisions:** hardware-backed keys (KI-25), mixed-provider pairs (KI-37), single gateway instance (KI-38), service-role key scope (KI-39), telemetry backend (KI-30), favorite=one shared flag (KI-43); Stop-sharing product calls (no push on stop, stopped state survives unlink, both unlink options visible).
**Needs device/staging:** KI-19, 31, 32, 33, 34, 35, 36, 18, 29; clean `supabase db push` of all migrations; local AI model artifact; signaling Docker build.
**Hard rules:** no new relationship-AI features until verification exists · RLS never weakened · additive migrations only · no service_role in client · no secret partner monitoring · no second calling provider · never claim PASS for unrun checks (use BLOCKED/NOT VERIFIED) · never hand-edit `package-lock.json` · log WHY/WHAT/RISK/TEST/RESULT in CHANGELOG + KNOWN_ISSUES.
**Known lockfile gap:** `package-lock.json` version still 3.18.1.

## 10. Update log (append newest on top)
| Date | Version | Change summary | Files touched |
|---|---|---|---|
| 2026-10-03 | 3.21.0 | Admin console: Overview/Users/Couples/Access/Payments/Announce/Activity tabs; partner link shown everywhere access is granted; grant triggers a user notice card + push; block/verify via `admin-user-action`; announcements/offers; app-update gate; audit log. Source only, unverified. | `supabase/migrations/20261003100000_admin_console.sql`, `supabase/functions/admin-user-action/`, `src/components/admin/*`, `src/pages/settings/AdminSettings.tsx`, `src/lib/admin/adminApi.ts`, `src/lib/semver.ts`, `src/components/{UserNoticeHost,AppUpdateHost,BlockedGate,AppLayout}.tsx`, `src/hooks/useEntitlement.ts`, `src/lib/authErrors.ts`, `docs/ADMIN_CONSOLE.md` |
| 2026-10-02 | 3.20.6 | Index created from `duospace-v3_20_6-merged-unlink-sharing-aieval.zip`. Contents: Stop sharing + 14-day scheduled unlink (source only), AI-eval Stage 4 fixtures (adaptive_stopping, grounding, banned_claims, explain_state_preservation, compatibility_states), legal checklist (v3.20.5), billing copy (3.20.4), monetization preflight (3.20.3), ads UMP (3.20.2) | see `.ai/HANDOFF_2026-10-02.md` |
