# Handoff 2026-10-07 — Calls screen crash DS-UNKNOWN-001 (v3.22.9)

Error: `cannot add postgres_changes callbacks for realtime:recoverable-call:caller_id:<uid> after subscribe()` → ErrorBoundary on /calls.

## Root cause
supabase-js keeps channels in a registry keyed by topic: `channel(name)` returns the EXISTING channel while a same-named one is still registered, and `removeChannel()` is async. useRecoverableCall (mounted via RecoverableCallBanner on Calls) re-runs its effect (userId/refresh/refreshKey change, StrictMode remount, fast navigation); the second `channel(sameName)` got the old, already-subscribed channel and `.on()` threw inside an effect → whole screen unmounted.

## Fix
- NEW src/lib/realtimeChannel.ts: `uniqueChannelName(base)` (per-run suffix). Use ONLY for local postgres_changes channels; never broadcast/presence (topic must match across phones).
- useRecoverableCall: unique topics, plus try/catch around channel setup and cleanup (realtime is only a freshness hint; 10s poll + foreground refresh remain), so a realtime failure can no longer reach the ErrorBoundary.
- Same latent bug, same fix: IncomingCallOverlay (incoming-calls, call-cancel), useCallHistory, DockBadgesContext (fixed names "dock-msgs"/"dock-calls").
- NEW test src/test/recoverableCallRealtime.test.ts (fake reproduces registry + async removal); verified it FAILS on the old code and passes on the fix.

## Follow-up (same day): all remaining channels audited and fixed
Every postgres_changes-only channel now uses uniqueChannelName: BlockedGate, UserNoticeHost, MessageReactions, MemoryWall, useUnlinkRequests, useScheduledUnlink, useOurPlaylist, useChatSurprise, useImportedMessages, useChatRealtimeMessages, useCallOutcome (instance id alone was not enough), ThemeContext, LocationContext (partner-location), Us, Shayari, Gallery (x2), PartnerSettings, Playlist (blend-invites-rt, playlist-songs-rt).
Deliberately NOT changed (broadcast/presence/private, topic must match on both phones): Playlist blend-sync, useChatTyping, useChatPresence, useLipReadingNotice, GroicContext.
NEW guard test src/test/realtimeChannelNames.test.ts statically fails the build if a postgres_changes-only `.channel(` is added without uniqueChannelName (it caught useCallOutcome).
Rule for new code: local postgres_changes channel -> uniqueChannelName(); shared broadcast/presence -> plain shared name.

## Verification
vitest: 180 files, 2343 tests, 2341 passed, 2 skipped, 0 failed. 