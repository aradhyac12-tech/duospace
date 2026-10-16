# Database contract (Supabase / Postgres)

Source of truth: `supabase/migrations/` (84 files as of Phase 1.6). The live
project may differ — several local migrations are deliberately NOT applied
(KNOWN_ISSUES KI-16, KI-13, KI-17). Never assume a table exists live because it
is in a migration.

## RLS presence (verified this phase by `npm run check:rls`, static replay)
- 42 live public tables + `storage.objects` (17 active policies): PASS.
- One table is intentionally service-role-only: `location_push_credentials`
  (RLS on, zero policies, `REVOKE ALL ... FROM anon, authenticated`). The check
  now recognises that pattern explicitly instead of failing on it.
- This is a presence check only. It does not read policy clauses. Clause
  correctness is reviewed by hand in `docs/RLS_SECURITY_MATRIX.md`.

## Privacy-relevant tables
| Table | Owner | Notes |
|---|---|---|
| `user_consents` | self only | server-of-record for `ConsentFeature` grants (migration `20260917100000_privacy_consent_ai_foundation.sql`) |
| `ai_insights` | owner; partner only by explicit share | nothing writes to it yet; trigger requires a consent reference |
| `mood_logs` | self + PARTNER (SELECT) | camera-derived rows carry `features.source` = `camera_detected` / `background`; `user_selected` for manual picks. **KI-21: the partner-read policy is broader than any UI needs.** |
| `profiles.mood_emoji/mood_text` | partner-visible | since Phase 1.6 written from the camera only after the user confirms |
| `location_push_credentials` | service role only | per-device secret hash, see KI-12 |

## Rules for any new server data
Migration + FK + index + RLS + ownership + partner access + deletion + retention
must all be explicit, and `npm run check:rls` must pass. Do not weaken an
existing policy. Do not add AI tables until a feature genuinely needs
server persistence (local-first is the default — `LOCAL_AI_ARCHITECTURE.md`).
