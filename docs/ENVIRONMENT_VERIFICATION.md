# Environment Verification — Phase 8B

## Note on this snapshot

This repository is a different, earlier snapshot than a previous zip
reviewed in this same remediation session — it predates all three P0 fixes
(cross-device backup restore, cross-partner RLS, scheduled-message
scheduler) entirely, and its own `AUDIT_FIXES_SUMMARY.md` references
migration files (`20260501000001_rls_audit_hardening.sql`,
`20260501000002_query_performance.sql`, `20260501000003_SQUASH_GUIDE.sql`)
that do not actually exist anywhere in `supabase/migrations/` — that summary
document describes work that was not, in fact, committed. Treat
`AUDIT_FIXES_SUMMARY.md` as aspirational, not as evidence of applied fixes.

## Expected production project

`jzlpelxwzjjpddqcrtpu` — consistent across `supabase/config.toml`,
`src/integrations/supabase/client.ts`, `DEPLOY.md`, `.env.example`. No stale
or conflicting project refs were found in this snapshot's migrations (the
`lotznohocfmwmyyexoxp` stale-ref issue found in the other snapshot doesn't
apply here — this repo's scheduled-message cron didn't exist at all until
this session added it, correctly targeting `jzlpelxwzjjpddqcrtpu` via Vault
from the start).

## Fixes applied this session (see individual migration files for full
rationale — each is self-documenting)

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | P0 | No cross-device backup restore path existed at all (`restore()` took no key override; a new device would silently mint an unrelated encryption key and decryption would fail forever) | Added `manualKey` param to `useCloudBackup.restore()` + "this backup is from a different device" UI in `BackupManager.tsx` (reusing the already-present `exportDeviceSecret()`) |
| 2 | P0 | `countdowns`, `memories`, `taps`, `daily_answers`, `playlist_songs` had `SELECT USING (true)` — readable by any authenticated user, not just the couple; `invite_links` was similarly unrestricted | `20260811100000_fix_cross_partner_rls_exposure.sql` — scoped to owner/partner via `get_partner_id()`; invite lookup narrowed to creator-own-rows + one-at-a-time unused/unexpired lookup |
| 3 | P0 | No scheduler ever invoked `deliver-scheduled-messages` — scheduled sends silently never delivered | `20260811101000_schedule_deliver_scheduled_messages.sql` — pg_cron job via the repo's existing Vault-backed secret pattern (matches `fcm_push_notifications`/`ios_voip_push`) |
| 4 | P1 | `messages` UPDATE policy had a broad `sender_id OR receiver_id` policy coexisting with the tightened split policies, re-opening receiver's ability to rewrite `sender_id`/`created_at` etc. | `20260811102000_...sql` — drops the broad policy, re-asserts the split ones, extends the `guard_message_update()` trigger to also block identity/ordering field changes |
| 5 | P1 | `profiles` SELECT policy regressed to a self-referencing inline subquery — the exact "infinite recursion detected in policy" shape `get_partner_id()` was created to eliminate | `20260811103000_...sql` — routes back through `get_partner_id()` |
| 6 | P1 | `storage.objects`: a stale unscoped UPDATE policy (any authenticated user could UPDATE any object's metadata in 4 private buckets) never got dropped; `surprise-assets` INSERT/DELETE had no ownership scope at all | `20260811104000_...sql` |
| 7 | P1 | `resumableUpload.ts` chunk path (`.tmp/${objectPath}...`) put `.tmp` as the FIRST path segment, failing storage RLS (`foldername[1] = auth.uid()`) on both chunk upload and the resume-scan `.list()` call — the implementation could never actually work | Fixed chunk path scheme in `resumableUpload.ts` + matching `finalize-upload` edge function; wired into `Gallery.tsx` for files ≥6MB with real byte progress, honest `queued/uploading/processing/done/error` states |
| 8 | P1 | `acceptRequest()`'s non-atomic client-side fallback (4 separate writes) could leave a pairing asymmetric on partial failure; the two atomic RPCs it falls back from are not independent (v2 just wraps v1) | Removed the fallback in `PartnerSettings.tsx`; surfaces an error + retry instead |
| 9 | P2 | CI allowed TypeScript failures via `\|\| true` | Removed from `.github/workflows/ci.yml` |
| 10 | P2 | `useLiveLocation.ts` battery listener cleanup passed a fresh no-op function to `removeEventListener` instead of the original listener reference — never actually removed, leaked on every mount/unmount | Fixed to close over the same `sync` reference |

## Still required — `REQUIRES LIVE ENVIRONMENT` (cannot be done from source)

- `npm ci` / typecheck / lint / test / build — this sandbox has no network
  access to the npm registry at all; these come back **BLOCKED**, not PASS.
- Confirm Vault secrets `project_url` / `service_role_key` exist in the live
  project (needed for the new scheduled-message cron — same secrets push
  notifications already require).
- Confirm `pg_cron` + `pg_net` extensions are enabled.
- Authenticated cross-account RLS test for the six newly-scoped tables via
  PostgREST (two real test users, not service_role).
- Real device-A → device-B backup restore round trip.
- Real Android/iOS call-notification testing (Phase 8J — not reached this
  session; flagging as untouched, not as verified).
