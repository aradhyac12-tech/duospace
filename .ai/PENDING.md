# PENDING — consolidated open work (as of 2026-10-02, v3.20.6)
Source of truth for details is KNOWN_ISSUES.md (KI-n). Nothing below was compiled, linted, tested or run on a device in the sandbox (no network). Live Supabase project: jzlpelxwzjjpddqcrtpu.

## 0. Done this session (don't redo)
KI-40 ring window 40 s (v3.18.5) · KI-43 shayari partner favorite/delete RPCs (v3.18.6, migration live) · KI-27/28/39-lockfile (v3.18.7, other session) · KI-28 CI workflow (v3.18.8) · KI-21 mood_logs own-rows SELECT (v3.18.9, migration live) · KI-23 lip-reading partner notice (v3.19.0, migration live) · KI-22 face template/snapshots encrypted (v3.19.0). Also applied live: ai_gateway_quota, music_profiles, shayari_partner_actions, mood_logs_own_select_only. KI-14/13/17 already resolved earlier.

## 0b. Added 2026-10-02 (v3.20.6) — written only, NOT applied, NOT run (KI-44)
Stop sharing (immediate, unilateral) + 14-day scheduled unilateral unlink; resolves KI-42. Migrations 20261002110000 + 20261002120000, `send-push` types, Partner-screen UI, `ScheduledUnlinkHost`. Next: diff re-declared `apply_unlink` vs live → apply to staging → run docs/STOP_SHARING_AND_SCHEDULED_UNLINK.md matrix → deploy send-push → apply to production → app build.

## 1. First thing to do next
1. Push the repo; read the FIRST GitHub Actions run of `.github/workflows/ci.yml` (never run; tsc/lint/vitest/build have never been confirmed green). Fix what it reports.
2. Two real accounts (A,B): (a) A favorites/requests-delete on B's shayari, B approves (KI-43); (b) A cannot SELECT B's mood_logs (KI-21); (c) A cannot read B's surprise_library rows (KI-17).
3. Deploy the `ai-gateway` edge function if not yet deployed (needs the applied gateway_* functions) and smoke-test one call.

## 1b. New this version needing verification
Two-device lip-reading banner (appears ≤5 s after partner enables, clears ≤12 s after they stop/disconnect) · Peek Guard enrol → reload → still recognises owner (vault migration) · open Security Dashboard: old snapshots still render · vitest for deviceVault/useLipReadingNotice not written.

- Mood profile (v3.20.0): confirm 👍 x3 on one mood then re-read shifts that mood's score; confirm profile is gone after sign-out/sign-in as another user; measure 👍 rate before/after (no accuracy claim exists). Real vitest run of `moodProfile.test.ts`. License read before ever bundling an AffectNet-derived model.

## 2. Needs a device / staging (cannot be done in sandbox)
KI-19 incoming-call fixes · KI-31 music now-playing notification · KI-32 QR link (server deployed; app build + device test) · KI-33 signaling end-to-end · KI-34 caller UI vs CALL_ACCEPTED (deliberately unchanged, UI behaviour change) · KI-35 realtime recovery path · KI-36 TURN unverified · KI-18 surprise media on device · KI-29 iOS Xcode step · clean `supabase db push` of all migrations on staging · local AI model artifact (pin + host) · Docker build of signaling.

## 3. Needs an owner DECISION
- (KI-23 and KI-22 decided + implemented v3.19.0; remaining: test on two devices; hardware-backed key = KI-25.)
- KI-25 hardware key storage · KI-24 mood-save consent (deliberate, informational) · KI-26 30 s consent cache (informational)
- KI-37 mixed-provider pairs · KI-38 single gateway instance · KI-30 telemetry backend
- KI-39 gateway uses full-power service-role key — consider scoped DB role
- KI-16 remaining deliberately-unapplied local migrations (get_partner_id lock, is_partner_on_call, etc.)
- KI-43 choice made autonomously: favorite = ONE shared flag per shayari (change if per-viewer wanted)

## 4. Non-engineering / review
Native-speaker + support-organisation review of the 11 Indian languages · UI translation framework decision (~1,470 strings) · owner review of undocumented Phase 3D memory module · external review of repair safety gate · major dependency upgrades (vite, @capacitor/cli→tar, transformers, sharp) as separate changes.

## 5. Rules carried forward
No new relationship-AI features until §1–§2 verification exists. Bump version in package.json AND src/lib/errors/DuoSpaceError.ts per change. Record in CHANGELOG + KNOWN_ISSUES. Supabase MCP stamps migrations with apply time (names match local files, versions don't).
