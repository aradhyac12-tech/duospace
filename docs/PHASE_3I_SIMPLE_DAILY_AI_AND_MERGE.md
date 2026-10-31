# Phase 3I — Simple daily AI, monetization merge, staging guard (2026-09-26)

## Why
Owner feedback: the Insights area felt like a survey (long forms, many choices). Nobody fills 12 steps during a fight, so the core feature went unused. Goal: minimal, daily, trustworthy.

## Product change (no new AI engine — reuses the tested ones)
1. **Chat → long-press partner's message → "Help me reply"** (`src/components/chat/QuickReplySheet.tsx`). One suggested reply from the existing response-support engine (same safety gate, grounding, multilingual limited mode). Chips: Another / Shorter / Ask first / More casual. "Use this reply" fills the composer as a reply to that message — **never sends**. If consent is missing, one tap "Allow on-device help". Nothing saved.
2. **"Today" tab (now first and default)** (`DailyCheckIn.tsx`, `src/lib/relationship/checkin.ts`): tap mood (4 emoji) + optional up to 2 needs → one fixed, reviewed tip + a draft message; "Send in chat" puts the draft in the composer via router state (cleared immediately; never auto-sent). No free text, no inference, no streaks. Last check-in stored on-device (encrypted backend).
3. Existing tools (Compare, Help me respond, Repair, Memory, insights) moved behind **"More tools"** — unchanged, not removed.
Tests: `checkin.test.ts` — all 148 tap combinations pass the Phase 2/3B safety validators; deterministic; repair offered only on "hard"/"sort something out".
Not verified on a device.

## Monetization overlay (uploaded zip) — merged, 3 defects fixed
| # | Defect | Fix | Evidence |
|---|---|---|---|
| M0a | New `duospace-billing` dependency missing from `package-lock.json` → `npm ci` (Vercel/Lovable/CI) fails | lockfile regenerated | `npm ci` exit 1 → 0; `check-lock-sync` exit 0 |
| M0b | `duospace-billing` not aliased like the other local plugins → `tsc`/build fail | added to vite, vitest, tsconfig paths | tsc exit 0 |
| M1 | `get_effective_entitlement`: `_user_id <> auth.uid()` is NULL for anonymous callers, so the guard was skipped; Supabase's default privileges also grant EXECUTE to `anon` → **anyone could read any user's plan** | `auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid()` + `REVOKE … FROM anon` (migration not yet deployed anywhere, fixed in place) | reproduced on staging (anon saw FOUNDER); after fix anon DENIED, own/partner/stranger correct; `monetizationEntitlements.db.test.ts` (4) fails on the original, passes fixed |
Reviewed OK: no client INSERT/UPDATE policies on entitlements/purchase_events; purchase verifier takes the user from the JWT, hashes tokens, and fails closed (Google API call is still a stub → no free entitlements).
**Not deployed.** Production has no monetization tables.

## Staging build guard
`npm run build:staging` requires `VITE_SUPABASE_URL` + key and refuses production values (`scripts/staging-env-guard.mjs`). Plain `npm run build` unchanged (main bundle hash identical). `stagingEnvGuard.test.ts` (4).

## Production lint cleanup (prepared, NOT applied to production)
`supabase/migrations/20260926200000_harden_legacy_function_lints.sql`: pins search_path on 3 trigger functions; revokes RPC EXECUTE on 2 SECURITY DEFINER trigger functions. Verified on staging with verbatim production function bodies: 11/11 behaviours unchanged, playlist push still dispatched after the revoke. `is_couple_realtime_topic_authorized` deliberately untouched (live chat depends on it). Needs owner approval to apply.

## Gates (this run)
vitest 104 files / 1179 passed / 2 skipped / 0 failed; DB 36 passed; tsc app 0 / node 0; eslint 0 errors (95 warnings, unchanged); build 0; lock-sync 0; Android deps gate 0; check:rls 0; bundle secret scan clean (only prefix checks, no key values).
