# Migration record: Daily.co → self-hosted (2026-09-23)

This is the ONLY document that intentionally mentions the removed provider.
Older dated audit reports in `docs/` describe the system as it was then.

## Removed
- **Package:** `@daily-co/daily-js` (plus its transitive `@sentry/browser`, `@sentry-internal/*` and `bowser` lock entries).
- **Code:** `src/hooks/useDailyCall.ts`, `src/lib/callEngine/DailyCallEngineAdapter.ts`, `src/components/DailyKeyManager.tsx` (the onboarding "Daily key" step and the Settings → Data card).
- **Edge function:** `supabase/functions/daily-call/`.
- **Provider switching:** the provider switch (`VITE_CALL_PROVIDER`, the `duospace_call_provider_override` localStorage key, `setCallProviderOverride`) and every Daily branch in `Calls.tsx`, `Chat.tsx` and `CallContext.tsx`.
- **Messages:** the user-facing "No Daily.co API key" message (HTTP 402 mapping).

## Kept on purpose
- **Historical rows:** `call_history` rows with `provider='daily'` (history). New rows must be `self_hosted` (trigger in `20260923120000_self_hosted_only_call_provider.sql`), and dangling live Daily rows are closed as `failed/provider_removed`.
- **Partner key storage:** the partner Daily-key DB columns/RPC from older migrations. These are unused; dropping them is destructive and should be done in a reviewed follow-up migration once no pre-migration client is in use.
- **Applied migrations:** historical SQL migrations (they are the database's applied history and must not be edited).

## Behavioural fixes shipped with the migration
- LiveKit join stages are bounded, and failures are classified.
- Failure cleanup is deterministic on caller, callee and recovery paths (media released, session cancelled over signaling, history updated).
- Duplicate-join and cancel-while-joining guards.
- Unexpected-disconnect handling.
- `livekit-token` now enforces mutual current partnership and decline status via `signaling_get_call_facts`, validates callId, and clamps the TTL.
- The gateway rejects messages from a replaced socket (`STALE_CONNECTION`).
