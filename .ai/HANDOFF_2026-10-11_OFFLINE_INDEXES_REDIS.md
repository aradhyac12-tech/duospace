# Handoff: offline polish, DB indexes, Redis cache (v3.22.14)

## Reported
Offline: loader stuck on loading, images not handled; the "MB saved for offline" settings should go and offline
should be automatic like WhatsApp; remove dead buttons. Then: add database indexing, then a Redis cache.

## What changed
**Stuck loader (src/pages/Chat.tsx).** Offline with nothing cached, none of the branches that end the message
skeleton fired (no partner id / failed local read / failed request). New effect on `messagesLoading`: offline → end
now; goes offline while loading → end; online → hard cap 10 s. `readLocalChatPage(...).catch` added. The existing
reconnect refetch fills the list when data arrives. Other screens (Shayari, Us, Memories, Calls) already end their
loader in a `finally`.

**Images offline (MessageBubble.tsx PhotoThumb, lib/photoThumbs.ts).** `getThumb` returns null at once for a network
URL while offline (not marked permanent) and the fetch has a 12 s abort. A photo that can't load now settles into a
static "Photo" tile via `onError`; it resets when the source changes or connectivity returns. Photos already opened
online are still served from the on-device cache (mediaCache.ts, unchanged).

**Automatic offline (lib/offlineSettings.ts).** `OfflineStorageCard.tsx` deleted; Data & Backup no longer shows it
(no switches, no MB used, no Clear). `getOfflinePref(s)` return constants; `setOfflinePref` is a no-op; stored values
from the old switches are ignored. Trimming is still automatic (LRU, 400 MB cap in mediaCache.ts). Sign-out/unlink wipe
still removes local data. docs/OFFLINE_FIRST.md and docs/memory.md still describe the old card (historical).

**Dead buttons.** Static scan of every `<button>`/`<Button>`/`motion.button` found no handler-less buttons except
Radix triggers (fine). Removed: hover-only reply button on own bubbles (invisible/untappable on touch; swipe and the
long-press menu still reply) and two permanently-disabled placeholders on the Plus screen (now plain text). NOT
covered: buttons that have a handler which does nothing useful at runtime — that needs a device walkthrough.

**Indexes.** supabase/migrations/20261011100000_performance_indexes.sql. Additive, IF NOT EXISTS, each guarded by a
table/column existence check (RAISE NOTICE and skip otherwise). Does not duplicate idx_messages_pair_created,
idx_messages_not_deleted, idx_messages_client_message_id, idx_call_history_pair_created. Rollback = DROP INDEX IF EXISTS.
Columns were taken from the migrations' CREATE TABLE statements, not a live schema.

**Redis (infrastructure/signaling).** Where it applies: the gateway's `signaling_get_call_facts` lookup. Only facts of
calls in a FINAL status (completed/failed/cancelled) are cached (1 h). Live calls are never cached — CALL_ACCEPTED must
see the current `claimed_by` — and neither are unknown calls or missed/seen. Fail-open: any Redis problem = cache miss,
10 s circuit, 250 ms command timeout. Optional: no `REDIS_URL` = no cache. No new npm dependency (hand-written RESP
client) so package-lock is untouched. Compose now includes a memory-capped, non-persistent `redis` service; set
`REDIS_URL=` (empty) in the env file to run without it. /healthz reports cache status and hit/miss counters.
Supabase Edge Functions and the app do NOT use Redis (no Redis reachable from them; would need a hosted one like Upstash).

## Honest expectations
The Redis win is small by design: it removes repeat lookups for finished calls only. The indexes are the bigger
database win. Neither has been measured.

## Verified here / not verified
- RUN: new signaling tests (11) via a local vitest shim; a socket-level test of RedisCacheStore against a fake RESP
  server (round-trip, 100 KB values, pipelining order, AUTH/SELECT, unreachable host → fail-open, bounded time).
- Syntax-checked only (TypeScript transpile, 0 errors): all changed app files and server.ts.
- NOT RUN: `npm run verify:lock && npm run build`, tsc, eslint, `npm test` (no node_modules/network), the SQL migration
  (no Postgres), real Redis, any device. Please run the build and test on a device: airplane mode → force-quit → reopen
  → chat opens with no endless skeleton; an uncached photo shows the quiet tile; reconnect → it loads.

## Deploy order
1) `supabase db push` (indexes). 2) Deploy signaling with the new compose (Redis starts alongside). 3) Check
`/healthz` → `cache.status: "ok"` once a call has ended and been looked up twice. 4) Build the APK.

## Addendum (v3.22.15, "Continue")
- Playlist.tsx: offline snapshot (screenCache "playlist"), quiet failed refresh, refetch on reconnect. Song thumbnails
  are remote URLs, so offline they simply don't paint (no broken UI); they are not saved on-device.
- Gallery.tsx MediaThumbnail: onError hides the broken image, grey tile stays.
- Still open: Groic/music home rails, imported WhatsApp messages, message reactions are not cached offline.
- Verification: syntax-checked only; run build + test on a device (airplane mode → open Playlist → songs show).

## Addendum 2 (v3.22.16)
- Reactions: see CHANGELOG (7). Offline view only; offline react/unreact is not queued (would need an outbox like pendingSendQueue.ts — say "Continue" for that).

## Addendum 3 (v3.22.17)
- Imported WhatsApp chat offline: see CHANGELOG (8). Test: online open chat (imported history visible) → airplane mode → force-quit → reopen: imported messages present; photos you had opened online show, others show as text.
- Still not cached/queued: offline add/remove reaction, Groic/music home rails.

## Addendum 4 (v3.22.18) — cache storing hardening
- See CHANGELOG (9). New: lib/storagePersistence.ts; mediaCache quota-aware cap + evict-and-retry on QuotaExceededError; screenCache flushes pending writes when the app is hidden.
- Test on a device: open Shayari/Us/Gallery online, change something, immediately background the app, force-quit, go airplane mode, reopen → the latest data shows. Fill the phone's storage near-full, open many photos → media cache keeps working (oldest evicted) instead of failing repeatedly.
- Still open: offline add/remove reaction (needs an outbox like pendingSendQueue.ts); Groic/music home rails not cached; media blobs stored unencrypted at rest (see mediaCache.ts header); no per-row storage for very large WhatsApp imports (one snapshot record).
- Session rule (owner): deliver the updated zip at the end of every session working on an uploaded zip — recorded in AGENTS.md and .ai/IMPLEMENTATION_RULES.md rule 11.

## Addendum 5 (v3.22.19) — stored offline, like WhatsApp
- See CHANGELOG (10). Sources used for the research: WhatsApp privacy policy (messages deleted from servers after delivery; undelivered kept up to 30 days; "Your messages are stored on your own device"); forensic write-ups of WhatsApp's on-device layout (msgstore.db SQLite on Android / ChatStorage.sqlite on iOS; media as files in the app's media folders; encrypted backups separate); WhatsApp's Manage storage + Media auto-download settings; Capacitor "Data Storage" guide (WebView storage reclaimable; IndexedDB on iOS; persist() on Android; native storage / SQLite for large data).
- Device test (needs a phone): (1) Chat with photos + voice notes, open them online. (2) Airplane mode, force-quit, reopen → all present. (3) Simulate reclaim: Android Settings > Apps > DuoSpace > Storage > Clear cache does NOT clear IndexedDB; use `adb shell run-as com.duospace.app rm -rf app_webview/Default/IndexedDB` then reopen offline → messages and snapshots should come back from files (watch logcat for "restored N stored messages from the native mirror"), photos from chat-media. (4) Sign out → files gone (`run-as … ls files/chat-store files/chat-media`) and a second sign-in on the same phone sees nothing of the first user.
- Kill switch: in localDb/index.ts return the plain IDB backends (drop the mirror wrappers) and in mediaCache.ts set nativeMediaStore usage off (export `null`); the OS-keystore key backup is independent — remove the masterKeyBackup calls in secureStorage.ts to disable it.
- Open: E2E key is server-synced (offline decrypt after a reclaim waits for one online launch; see CHANGELOG 10 correction); deviceVault key is IndexedDB-only; secureKey.ts hardware path FIXED in 3.22.21 (CHANGELOG 12) — verify on a device; Storage card shipped in 3.22.22 (CHANGELOG 13); messages are not downloaded while the Chat page is closed (push could prefetch).
