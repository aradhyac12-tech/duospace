# Phase 8 Release Decision

> **Phase 8.5 note:** a subsequent scoped pass (source-level integrity
> closeout, not a redesign or a new audit) fixed 4 more things the Backend
> Hardening Pass below either hadn't covered or had flagged as low-priority
> residual: `finalize-upload` trusting client-supplied `totalChunks`
> (new finding — a real destructive-overwrite path, outside that pass's
> RLS-only scope), the `invite_links` enumeration residual (removed
> entirely, not just left as low-priority), `messages` sender-side identity
> field mutability (closed the "needs product input" comment left by the
> earlier fix), and an `apns_push_log` RLS-policy consistency gap (found by
> actually *running* the rewritten `scripts/check-rls-coverage.mjs`, this
> doc chain's first automated-not-static result). None of these change the
> **BACKEND CONDITIONALLY READY** verdict below — they're the same class of
> "source-correct, live-verification-still-required" fix as everything else
> here. Full detail: `docs/PHASE8_5_FINAL_REPORT.md`.
>
> **Superseding note (Supabase Backend Hardening Pass):** a later,
> dedicated backend audit on this same repo found a **critical** issue this
> pass's RLS review missed entirely — `profiles` had a stale, differently-
> named `USING(true)` SELECT policy coexisting with the properly-scoped
> one since April, making every profile field (including `phone_number`)
> bulk-readable by any authenticated user the whole time. That pass also
> found `cleanup-orphan-uploads`'s cron auth is still broken in this
> snapshot (never fixed here, unlike a different snapshot reviewed
> earlier). See `docs/SUPABASE_FINAL_AUDIT.md` for the authoritative
> current status — **BACKEND CONDITIONALLY READY** with a 58/100 score,
> not the "no known P0/P1" picture this document describes below. This
> document is kept for its Phase 8 (app-level) history but should not be
> read as the current full picture on its own.

## Decision: **CONDITIONALLY READY**

Updated from an initial BLOCKED assessment earlier this session, now that
Phase 8J (native call trace) and Phase 8L (dead code, light pass) have also
been completed. Per the task's own criteria:

> CONDITIONALLY READY: No known P0/P1 in source, but critical live/device
> verification remains.

That's an accurate description of where this now stands: **every P0 and P1
this session found has a fix in source** (see the table below), and
everything left is live-environment or real-device verification that this
sandbox cannot perform.

## What changed this session (11 fixes total)

3 P0, 6 P1, 2 P2/P3 — full list and rationale in
`docs/ENVIRONMENT_VERIFICATION.md`. In addition to the 10 listed there, this
continuation added:

| # | Severity | Issue | Fix |
|---|---|---|---|
| 11 | P1 | `usePushNotifications.ts`'s generic `pushNotificationReceived` toast handler didn't exclude call-lifecycle push types, duplicating the native full-screen ringing UI with a redundant toast when the app is foregrounded | Excluded `incoming_audio_call`/`incoming_video_call`/`missed_call`/`call_ended`/`call_rejected` from the generic toast (Phase 8J) |

Phase 8J also produced a full source-level trace of the Android/iOS call
stack (`docs/NATIVE_CALL_AUDIT.md`) with no further bugs found in the
portions read — but explicitly flags several timing/OS-behavior items as
**REQUIRES REAL DEVICE**, since source review can't observe them.

Phase 8L did a light dead-code pass (`docs/PHASE8L_DEAD_CODE_CLEANUP.md`) —
clean (no orphaned GDrive-backup code, no dead-code-named files), but a full
dependency-graph sweep needs `npm ci` access this sandbox doesn't have.

## Why not READY FOR UI CONTINUATION

The task's own bar for that tier is explicit and this session cannot clear
several items in it regardless of code quality:

- [ ] install / typecheck / lint / test / build all PASS — **cannot run at
      all** in this sandbox (no network access to the npm registry). CI's
      config is now correctly strict (the `|| true` bypass is gone), but
      that only means a *future* run will be honest — it hasn't produced a
      PASS here.
- [ ] live Supabase migrations verified
- [ ] scheduled messages verified (real delivery, not just a correctly-
      written cron migration)
- [ ] RLS cross-account test verified (real two-user PostgREST test against
      the six newly-scoped tables + `messages` + `profiles` +
      `storage.objects`)
- [ ] backup cross-device test verified (real device A → device B round
      trip)
- [ ] REAL ANDROID TESTED / REAL IOS TESTED for the call stack

None of these are in-source problems — they're exactly the live/device
category CONDITIONALLY READY is meant to describe as the remaining gap.

## Path to READY FOR UI CONTINUATION

1. Run `npm ci && npm run lint && npx tsc -b --noEmit && npm test && npm run build` somewhere with registry access. Fix anything that surfaces — a scoped RLS/trigger rewrite and a chunk-path scheme rewrite this session made are exactly the kind of change worth a real typecheck pass before trusting them further.
2. Confirm Vault secrets (`project_url`, `service_role_key`) exist in the live project and pg_cron/pg_net are enabled; apply the new migrations; check `cron.job_run_details` for both the scheduled-message and (pre-existing) cleanup-orphan-uploads jobs.
3. Two real Supabase-authenticated test users, not service_role: attempt cross-account reads/writes against `countdowns`, `memories`, `taps`, `daily_answers`, `playlist_songs`, `invite_links`, `messages`, `profiles`, `storage.objects` per `docs/PHASE8_RELEASE_VERIFICATION.md`.
4. Real device-A → device-B backup restore, using the new "this backup is from a different device" flow.
5. Real Android + iOS devices for the call stack, focused on the specific `REQUIRES REAL DEVICE` items in `docs/NATIVE_CALL_AUDIT.md` (lock-screen full-screen intent behavior across OEM skins, ringtone timeout behavior, cold-start delivery, real Bluetooth/CarPlay answer).
6. If registry access becomes available, a proper `knip`/`depcheck` pass to finish Phase 8L rather than the light manual pass done here.

## On this repo's own prior claims

This snapshot's `AUDIT_FIXES_SUMMARY.md` claims a `7.8/10` baseline and 20
applied fixes, but cites three migration files that don't exist in
`supabase/migrations/` — that score cannot be taken at face value; some of
what it describes doesn't appear to have actually landed. No replacement
numeric score is given here for the same reason a score wasn't useful in
the original task's 51/100 case: **CONDITIONALLY READY** plus the concrete
checklist above is the accurate, actionable status — a number invites
comparing to the old 7.8 in a way that would overstate how close this is to
shippable, given that install/build have literally never run against this
code.
