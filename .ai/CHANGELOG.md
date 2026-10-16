## 2026-10-12 (session) — music palette/queue/back fixes + native stall watchdog
See HANDOFF_2026-10-12_MUSIC_STARTUP_TRACE.md Parts 2–3.

## 2026-10-12 (session: music audit + R2 plan) — tap-to-audio startup trace
See HANDOFF_2026-10-12_MUSIC_STARTUP_TRACE.md. Instrumentation only; no playback behaviour changed.

## 2026-10-12 (late) — Full-page Liked Songs / My Files with Play + Shuffle + filter
See HANDOFF_2026-10-12_JAMENDO_LOCAL_FILES.md Part 6.

## 2026-10-12 (night) — Artwork everywhere: fallback covers, file-backed covers, M4A/FLAC tags
See HANDOFF_2026-10-12_JAMENDO_LOCAL_FILES.md Part 5.

## 2026-10-12 (evening) — My Files tags + covers, Back closes genre page
See HANDOFF_2026-10-12_JAMENDO_LOCAL_FILES.md Part 4.

## 2026-10-12 (later) — Deployed jamendo-search v1 + soundcloud-search v21
SoundCloud: failure diagnostics, 5-min dead-track cache, dead tracks hidden from search, limit 30. See HANDOFF_2026-10-12_JAMENDO_LOCAL_FILES.md Part 3.

## 2026-10-12 — Free Music (Jamendo) + My Files
Added Jamendo provider (edge function jamendo-search + client) and local file import/playback; both play through the native engine in the background. See HANDOFF_2026-10-12_JAMENDO_LOCAL_FILES.md. Not built/tested here.

## 2026-10-11 (14) — Music: SoundCloud playback fixed, faster start, less lag

WHY: owner: music section laggy, SoundCloud songs not playing, long wait after tapping play.
WHAT: soundcloud-search now picks a transcoding ExoPlayer can play (no Opus/Ogg HLS), scrapes client_id with a browser UA in parallel (+ optional SOUNDCLOUD_CLIENT_ID secret), runs the rate-limit check in parallel, reuses transcodings from search results (1 hop instead of 2), drops SNIP/BLOCK tracks. Client: 8s timeout + one retry, warmStreams() prefetch of on-screen songs, stable memoised cards (no whole-page re-render), cheaper header/chips, 300px thumbnails, content-visibility on rails. Native: ExoPlayer starts after 0.8s buffered. Details + root causes: .ai/HANDOFF_2026-10-11_MUSIC_SPEED_SOUNDCLOUD.md.
LIMIT: edge function must be redeployed and the APK rebuilt. Not built, not run on a device.
RESULT: NOT RUN — syntax-checked only (no node_modules/network).

## 2026-10-11 (13) — Storage card: see what is saved, clear it, Wi-Fi-only media (v3.22.22)
WHY: owner chose option A. With media now kept as durable files that are never auto-deleted (CHANGELOG 10), the person needs WhatsApp's two controls: Manage storage (see / free space) and Media auto-download (not on mobile data). NOTE: an earlier session had REMOVED the "Offline & storage" card, its switches and its "MB used" line on the owner's request; this brings back a deliberately SMALL version at the owner's current instruction, and leaves the three automatic behaviours (chat history, screen data, media saving) non-configurable as decided then.
WHAT: NEW components/settings/StorageCard.tsx, mounted at the top of Settings > Data & Backup: total saved + rows by kind (Photos / Voice notes / Videos / Other, only those that exist); "Download media on Wi-Fi only" switch; "Clear downloaded media" via the existing ConfirmActionDialog (removes saved COPIES only — they re-download when opened online; messages, snapshots and server data untouched). offlineSettings.ts: wifiOnlyMedia is now the ONE persisted preference (localStorage duo-offline-wifi-only-media, default OFF = previous behaviour); chatHistory / screenData / mediaCache stay forced on. The gate itself already existed in mediaCache.cacheMediaInBackground (wifiOnlyMedia && onCellular()) — it only needed a way to be switched on. NEW nativeMediaStore.stats() + mediaCache.getMediaCacheStats() (durable files by MIME kind; browser-store leftovers counted as "Other"); NEW lib/formatBytes.ts. Tests: storageCard (5), nativeMediaStore stats (1), settingsCache offline-prefs contract updated (the old test asserted setOfflinePref could not change wifiOnlyMedia).
BEHAVIOUR: Wi-Fi-only only delays SAVING a copy on mobile data (positively reported "cellular" by @capacitor/network or navigator.connection); it never blocks showing media and never uses the network plugin to veto requests (connectivity.ts's rule). Unknown connection type = treated as not cellular.
LIMIT: no per-chat or "larger than 5 MB" lists (one conversation); no storage cap / auto-trim on the durable media (clear is manual); "Other" is browser-store leftovers whose type is not indexed. Wi-Fi-only is a per-device setting (not synced). Not run on a device.
RESULT: RUN — new/updated tests pass; tsc + eslint clean on every touched file; full suite in 3 shards (see handoff).

## 2026-10-11 (12) — Face-template hardware key actually works (v3.22.21)
WHY: owner chose option B. privacy/secureKey.ts called NativeBiometric.isCredentialsSaved, which capacitor-native-biometric 4.2.2 does not have (types or native code). The call threw inside a try/catch, loadHardwareKey returned null, and every device silently sealed the face template with the software deviceVault while the code and comments claimed Keystore/Keychain custody.
WHAT: NEW resolveHardwareKeyBytes(store, marker, random) in secureKey.ts. Because getCredentials rejects for BOTH "nothing saved" and "read failed", a durable marker (Preferences key duo-hw-key-created-v1) records that a key was created: (1) readable well-formed 32-byte key → use it, heal a missing marker; (2) unreadable + marker set → return null (vault fallback) and NEVER regenerate; (3) unreadable + no marker → first use: create, READ BACK to verify the keystore kept it, only then set the marker; (4) anything stored that is not a 32-byte key is never overwritten; unreadable marker = "was created" (safe side). destroyHardwareKey also clears the marker. fromB64 now returns Uint8Array<ArrayBuffer> (clears the two pre-existing tsc errors in this file). Tests: src/test/hardwareKey.test.ts (8).
USER-VISIBLE EFFECT (expected, not a side effect): on the phone apps the existing faceRecognition upgrade path (needsHwUpgrade in loadFromStorage) now becomes live — the next load re-seals an existing vault-sealed face profile under the hardware key, and Face "hardwareBacked" reports true. Before this it always reported false. Vault-sealed copies still open (faceUnseal handles both formats).
LIMIT: residual risk stated in the code — marker lost AND keystore read failing at the same moment AND a key existing → a new key would be created and templates sealed under the old one become unreadable (the person re-enrols the face; nothing server-side is affected). If the keystore is wiped (e.g. OS "clear data"), hardware-sealed templates are unreadable by design. Not run on a device — Android Keystore / iOS Keychain behaviour of NativeBiometric credentials is untested here.
RESULT: RUN — hardwareKey + faceTracker tests pass; tsc/eslint clean on secureKey.ts; full suite in 3 shards (see below).

## 2026-10-11 (11) — E2E key read made strict (v3.22.20)
WHY: owner chose option A. lib/crypto.ts loadKeyPair used the non-strict idbGet, so a failed IndexedDB read returned null — indistinguishable from "this device has no key" — and useE2E could then generate a replacement identity key (resolveAccountIdentityKey step 2 / the sync-table-unavailable fallback). Same bug class the master key had.
WHAT: loadKeyPair now uses idbGetStrict with 3 retries (300/600 ms) and THROWS if the read cannot be completed; null now means "checked, no key". Legacy localStorage migration unchanged. Callers already cope: useE2E.applyLocal is try/catch, init() retries with backoff. Test: src/test/loadKeyPairStrict.test.ts (5).
LIMIT: when the server key exists (normal case) the old behaviour was already harmless; the fix matters in the first-run race and when the sync table is unavailable. Not run on a device.
RESULT: RUN — new + e2eAccountWideKey + secureStorageCrypto + masterKeyRestore tests pass (26); tsc/eslint checked on crypto.ts and the new test.

## 2026-10-11 (10) — Offline data is STORED like WhatsApp, not just cached (v3.22.19)
WHY: owner: "research how WhatsApp does it with no storage problem… it should not only be cache but also be stored offline". RESEARCH (see handoff for sources): WhatsApp keeps messages in a database and media as real files inside the app's own storage, never auto-deletes them (the person manages space via Settings > Storage and data > Manage storage; auto-download rules decide what is fetched), and its servers drop a message once delivered (up to 30 days if undeliverable) — the device is the long-term copy. Capacitor's own storage guide says WebView storage (localStorage; IndexedDB on iOS) is reclaimed by the OS when space is low and that native storage avoids this. DuoSpace kept everything in IndexedDB (reclaimable) and trimmed media at a fixed cap (auto-deleting) — a cache, not a store. WORSE: the AES master key for all stored data lived ONLY in IndexedDB, so a reclaim would take the key with the data.
WHAT: (1) NEW lib/nativeFiles.ts — Directory.Data file facade + in-memory fake for tests. (2) NEW lib/nativeMediaStore.ts — chat media as real files (chat-media/<sha256>.<ext> + index.json), never auto-evicted; mediaCache.ts now reads native first, then IndexedDB, writes new downloads to native (IndexedDB only as fallback / on web), PROMOTES old IndexedDB blobs into native on first read, and deleteLocalMedia / wipeMediaCache / getMediaCacheSize cover it. (3) NEW lib/localDb/nativeMirror.ts — write-through mirror of the encrypted message store (chat-store/<uid>/<partner>/<yyyy-mm>.json, debounced 2 s, flushed on hide) and of screen snapshots (collections/<uid>/<name>.json); if IndexedDB comes back EMPTY for a conversation/snapshot the mirror is copied back. Wired in localDb/index.ts on native only. (4) NEW lib/privacy/masterKeyBackup.ts + secureStorage.ts — master key copied to the OS keystore (capacitor-native-biometric credential store); restored ONLY when IndexedDB was read fine and held no key (the retry-before-generate guard is unchanged: a read failure still throws); backup removed by secureWipeAll. (5) Tests: nativeMirror, nativeMediaStore, masterKeyBackup, masterKeyRestore.
FOUND, NOT FIXED: capacitor-native-biometric 4.2.2 has no isCredentialsSaved (types or native code). src/lib/privacy/secureKey.ts calls it inside a try/catch, so its "hardware-backed" face-template key path has been silently falling back to the software device vault on every device. masterKeyBackup uses only real methods (get/set/deleteCredentials). Fixing secureKey.ts changes how face templates are sealed — separate decision.
E2E KEY (corrected after reading useE2E.ts): the E2E identity key is local in IndexedDB BUT is also the account-wide canonical key in Supabase (user_e2e_identity_keys), and resolveAccountIdentityKey fetches it first whenever the local store is empty. So an IndexedDB reclaim does NOT lose it — only OFFLINE decryption is unavailable until the next ONLINE launch (and in the sync-table-unavailable fallback a new key could be minted). Deliberately NOT backed up to the OS keystore: it is a long-lived private key, the keystore copy could outlive an iOS uninstall, and no sign-out wipe exists for it today. Still true: crypto.ts loadKeyPair uses the non-strict idbGet, so a failed read looks like 'absent' (same bug class the master key had) — harmless while the server key exists, worth hardening separately. deviceVault key (face-template fallback) is IndexedDB-only.
LIMIT: web build is unchanged (IndexedDB only; no app-private filesystem). Native files hold ciphertext for messages/snapshots but media files are unencrypted inside the app sandbox (same as before). Media is never auto-deleted on native, so storage can grow until the chat is cleared / unlink / sign-out — there is no "Manage storage" screen (owner removed the storage card earlier); say so if you want one. Per-file 25 MB cap and the "wait until the chat loads it" download trigger are unchanged. Writes inside the debounce when the process is killed are not mirrored. Android Keystore/iOS Keychain behaviour of NativeBiometric credentials was NOT tested on a device (iOS Keychain items can outlive an uninstall).
RESULT: RUN — full vitest suite in 3 shards: all pass (34 new tests included); vite build OK; tsc/eslint clean on every new/changed file (pre-existing tsc errors elsewhere unchanged). android/app/build.gradle stamped 32219 / 3.22.19 by hand — it was stale at 3.22.9, which made appUpdate.test fail even before this change. NOT run on a device.

## 2026-10-11 (9) — Offline cache: durable storage, quota-aware media, no lost snapshots (v3.22.18)
WHY: owner: "continue improving offline cache storing". Audit of the cache layer found three real gaps. (1) Nothing ever asked for persistent storage, so under storage pressure the OS could evict the whole origin (chat history, snapshots, media) silently. (2) mediaCache used a fixed 400 MB cap regardless of the device's real quota, and a QuotaExceededError on write just set a 5-minute back-off, so the same download kept failing. (3) screenCache wrote 800 ms after the last change; backgrounding or swiping the app away inside that window lost the newest snapshot (the next offline open showed older data).
WHAT: NEW src/lib/storagePersistence.ts — requestPersistentStorage() (once per launch, called from main.tsx; result only logged), getStorageEstimate(), computeMediaCap(hardCap, quota) (min(400 MB, 50% of quota), floor 50 MB), isQuotaError(). mediaCache.ts — cap = computeMediaCap (quota looked up at most every 10 min); store() on a quota error evicts half of what is held (LRU) and retries once; evictIfNeeded takes {force, fraction}. screenCache.ts — pending writes tracked; NEW flushScreenCache(); flushed on visibilitychange→hidden and pagehide; clearScreenCache also cancels a pending write; sign-out guard (no persisted session → drop) kept. Tests: src/test/storagePersistence.test.ts, src/test/screenCache.test.ts.
LIMIT: persist() is a request — Chrome decides by heuristics and many Android WebViews refuse or lack it, so durability there is not guaranteed. flush-on-hide is best effort: if the OS kills the process before the encrypt+IndexedDB write completes, that write is still lost. The quota-retry path in mediaCache (real IndexedDB) has no automated test; only the pure helpers do.
RESULT: RUN — the new tests (17) plus collectionStore/messageStore/photoThumbs tests: 46 pass; vite build OK; eslint on changed files 0 errors. tsc reports errors only in files this change does not touch (admin tabs, MessageContextMenu, AdaptiveQuestionCard, GroicContext, secureKey, Auth, three test files) — present before this change. Full vitest suite NOT run. Not run on a device.

## 2026-10-11 (8) — Uploaded WhatsApp chat available offline (v3.22.17)
WHY: owner: the imported WhatsApp data must also work offline (useImportedMessages fetched live only; offline the imported history vanished). WHAT: src/hooks/useImportedMessages.ts — saves the RAW imported_chats rows (file_url as stored, NOT signed URLs, which expire) in lib/screenCache.ts (key chat-imported-<partnerId>, encrypted on the phone); paints them first on open, then the server result replaces them (full replace, so rows cleared/undone elsewhere disappear after the next online refetch); a failed/offline refetch keeps the saved copy; realtime insert/delete update the saved copy; refetch on reconnect/resume; clear() (Clear chat) also deletes the saved copy so a cleared chat cannot return offline. Media rows: resolved at display time — photos/voice already opened online come from the on-device media cache, anything else shows as the text row only while offline (file_url null → isMedia false), never a broken image. Wiped on sign-out/unlink (collectionStore wipe). LIMIT: one snapshot record per chat — a very large import (tens of thousands of rows) rewrites that record (debounced 0.8 s) on change; if it feels heavy on a big import, move to per-row storage like lib/localDb messageStore. RESULT: syntax-checked only; not built/run on device.

## 2026-10-11 (7) — Chat reactions available offline (v3.22.16)
WHY: owner: reactions in the chat should work offline too (they were only fetched live; offline bubbles showed none). WHAT: MessageReactions.tsx useReactionsChannel — paints the last known reactions from lib/screenCache.ts (key chat-reactions-<partnerId>, encrypted on the phone) as soon as the chat opens, writes the on-screen set back (debounced; never before real data is in state, so an empty array can't overwrite a good copy), keeps the saved copy when a fetch fails (previously error was ignored), and refetches on reconnect/resume (useReconnectRefetch). Wiped on sign-out/unlink via wipeLocalConversationData (collectionStore). LIMIT: this is VIEWING offline; adding/removing a reaction while offline is still not queued (tap does nothing until online). Imported WhatsApp messages (useImportedMessages) still not cached. RESULT: syntax-checked only; not built/run on device.

## 2026-10-11 (6) — Offline: Playlist opens from a saved copy; Gallery tiles never show broken-image icons (v3.22.15)
WHY: "Continue" on the offline pass; OFFLINE_FIRST.md listed Playlist as still fetching on every open (offline = error card). WHAT: Playlist.tsx paints the last known songs/profiles/partner from lib/screenCache.ts (key "playlist"), keeps them on a failed refresh (no error card when data is already on screen), refetches on reconnect/resume (useReconnectRefetch). Gallery.tsx MediaThumbnail: an image that can't load is hidden so the grey tile shows instead of a broken-image icon. RESULT: syntax-checked only; not built/run on device. NOT DONE: Groic/music home rails and imported WhatsApp messages still fetch live.

## 2026-10-11 (5) — Offline: automatic like WhatsApp, no stuck loaders, dead buttons removed; DB indexes; Redis cache (v3.22.14)
WHY: offline the chat sat on its loading skeleton forever, photos pulsed "Loading" forever, Settings showed an "Offline & storage" card with MB used and switches, a few buttons did nothing. Owner also asked for database indexing, then a Redis cache. WHAT: (1) Chat.tsx — loading watchdog: skeleton ends immediately when offline / the moment we go offline, hard 10 s cap online; readLocalChatPage has a .catch. (2) MessageBubble PhotoThumb + photoThumbs.ts — offline short-circuit (no hanging fetch), 12 s fetch timeout, onError → quiet static "Photo" tile (not a pulse) that retries when the connection returns. (3) Offline storage is AUTOMATIC: OfflineStorageCard.tsx deleted and removed from Data & Backup; offlineSettings.ts now returns fixed values (history/screens/media always on, Wi-Fi-only off), old stored switches ignored; LRU 400 MB trim unchanged; sign-out wipe unchanged. settingsCache.test.ts updated. (4) Dead buttons: removed the hover-only (invisible on touch) reply button on own bubbles (swipe + long-press still reply); the two disabled placeholder buttons on the Plus screen ("Apple In-App Purchase — coming soon", "Not available on this install yet") are now plain notes. (5) supabase/migrations/20261011100000_performance_indexes.sql — additive composite indexes (owner/user + created_at DESC) for call history, gallery, memories, shayaris, mood log, playlist, surprises, push tokens, plus partial unread-messages index; each only created if table+columns exist; ANALYZE after. (6) Redis: infrastructure/signaling/src/redisCache.ts (dependency-free, fail-open RESP client), cachedAuthorizer.ts (caches ONLY completed/failed/cancelled call facts), wired in server.ts via optional REDIS_URL, redis service in infrastructure/deployment/docker-compose.yml, 11 new vitest cases. See .ai/HANDOFF_2026-10-11_OFFLINE_INDEXES_REDIS.md. RESULT: client files syntax-checked only; signaling cache tests + a socket-level Redis client test were RUN against a fake Redis (pass); migration, Redis against a real server, tsc/lint/npm test/build and on-device behaviour NOT run.

## 2026-10-11 (4) — Chat performance with many photos/files (v3.22.13)
WHY: long chats with many photos felt heavy/laggy and the phone lagged afterwards (S24 Ultra originals are 12–200 MP and photos are sent at ORIGINAL quality on purpose). WHAT: (1) src/lib/photoThumbs.ts — bubbles show a ≤720 px WebP made on-device via createImageBitmap(resizeWidth) (2 at a time, idle-scheduled, only when within ~700 px of the viewport, LRU 160); original still opens in PhotoViewer and is what is saved/downloaded; GIF/SVG/small/undecodable fall back to the original. (2) MessageBubble PhotoThumb: framer layoutId only on the photo being opened (was on every photo → layout measurement across the whole list), 2-frame delay before open so the shared transition still has a measured source. (3) mediaCache: background original downloads wait for idle and run 1 at a time. Videos/files already render as a single file row (no inline video). NOT CHANGED: send quality (originals), server-side. RESULT: syntax-checked + one vitest added; not built/run on device — measure on the S24 Ultra (scroll a 200-photo chat, watch memory in Chrome remote debugging). Shared-element open animation may degrade to a fade if framer doesn't pick up the late layoutId — check on device.

## 2026-10-11 (3) — Peek Guard: 25 s auto-try, THEN the biometric screen (v3.22.12)
WHY: owner wants all options trying automatically for ~25 s, and only after that the system biometric screen. WHAT (PeekGuard.tsx): auto OS biometric prompt now opens at AUTO_WINDOW_MS (25 s) after lock instead of 0.2–1.8 s (immediately only when face unlock is paused/stale); stranger/dark locks follow the same timing; weak face-only Android biometric still never clears a stranger lock; "Try automatic scan again" restarts window + prompt timer. RESULT: syntax-checked only; not run on device.

## 2026-10-11 (2) — Peek Guard: automatic recovery capped at 25 s, then manual (v3.22.11)
WHY: owner wanted the fingerprint/face prompt manual or time-limited (20–30 s). WHAT (PeekGuard.tsx only): AUTO_WINDOW_MS=25 s per lock — auto face scan (peekConfig.autoUnlockOnOwner) and the auto OS-biometric prompt only run inside it; after that status reads "Auto-unlock paused" and Unlock with biometric / Scan my face / Use PIN stay as manual buttons; "Try automatic scan again" reopens the window. OS biometric prompt wait is capped (25 s auto, 30 s manual): UI is freed, PIN offered; a late success on a lingering dialog still unlocks. LIMIT: capacitor-native-biometric 4.2.x has no cancel API, so the system dialog itself can stay on screen until dismissed. RESULT: syntax-checked only; not built/run on device.

## 2026-10-11 — Surprise: complete zip import, no duplicate library items, calmer save/discard (v3.22.10)
WHY: zip import sometimes dropped CSS/JS; re-importing created duplicate library rows; Discard/Replace prompts and toasts repeated. WHAT: surpriseImport.ts now merges css/js in the zip the page doesn't link (skips sw.js, ES modules reported) and resolves same-name files by best path match; surpriseLibrary.ts `saveToLibraryDeduped` updates an existing row (same id / source file name / title) instead of inserting; CodeSurpriseEditor.tsx: Escape no longer re-opens Discard, prompts only when something is unsaved AND not already in the library, one toast per import, double-tap/Ctrl+S save lock. RESULT: written + new vitest cases added; tsc/lint/vitest NOT run (no node_modules in sandbox).

## 2026-10-09 — Music: playback race/spinner fixes + artwork→mini-bar morph
WHY: play/pause lag, stuck spinner, jumpy seek; pull-down only slid a slab. WHAT/RISK/TEST: see .ai/HANDOFF_2026-10-09_MUSIC_PLAYBACK_MORPH.md. RESULT: syntax-checked only; build/tests/device NOT run.

## 2026-10-08 (2) — Groic next-song / suggestion quality: same-name repeats, off-taste jumps, "out of queue" (no version bump)

- REPORTED: after a song called "payal" the next songs were also "payal"; sometimes the next song matched neither the queue nor the listener's taste.
- ROOT CAUSES (all in code, confirmed by reading it):
  1. Tapping a SEARCH result queued the whole search pool (`buildUpNextPool` dedups only IDENTICAL titles) — a "payal" search is all "payal" songs.
  2. `buildSeedQueries` fell back to searching the song's own TITLE when the artist was unusable; every seed search was fuzzy, and `rankCandidates` had no relevance test, so unrelated artists whose names/titles matched were queued.
  3. Labels/uploader channels (T-Series, "… Records") counted as artists and as taste seeds; a single stray play counted as taste.
  4. NATIVE queue window: `syncNativeQueue` ran once when a track started and always handed ExoPlayer a plain sequential slice. The native player auto-advances through that window and has NO shuffle/repeat handling, so with shuffle or repeat-one — or after Play next / Add to queue / remove / auto-next top-up — the song that played was not the one the queue showed.
- WHAT:
  - `queueQuality.ts`: `sameNameFamily` (whole-word contiguous containment on trackKeys, ≥4 chars), `withoutSameName`, `buildSearchUpNext` (search taps queue ≤4 DIFFERENT songs, ≤2/artist, none containing the search words; autoNext tops up the rest).
  - `autoNext.ts`: no title seed; label/channel detection; min affinity 0.6 for seeds/related; `rankCandidates` hard-rejects the same-name family of the current + last 5 played, tiers candidates as related (current artist / taste / seed artist) vs unrelated (−2.5, or dropped with `relatedOnly`), prefers the current track's script (Devanagari, Gurmukhi, …). `fetchAutoNext` ladder is now: strict-related → relaxed-related → language trending → last-resort search hits. With no artist and no taste it goes straight to language trending.
  - `queueLogic.ts`: pure `pickNativeWindow` (repeat-one → current only; shuffle → current + ONE remembered unplayed pick; else 1 back / current / 2 ahead). `GroicContext.tsx`: `syncNativeQueue` uses it, plus a debounced (300 ms) resync effect on queue / shuffle / repeat / current changes.
  - `Groic.tsx`: search results use `playFromSearch`; rails use `playFrom` with `withoutSameName`.
- RISK: (1) The native-window fix is verified only by unit tests of the pure function; ExoPlayer/AVPlayer behaviour was not run on a device. Re-sync swaps neighbours of the playing item (existing plugin path) — watch for any audible hiccup. (2) Shuffle now gives the native player ONE lookahead item, so lock-screen "previous" while shuffling restarts the track instead of going back. (3) Stricter relevance can return fewer suggestions for a thin catalogue; the ladder then falls through to language trending and finally unrelated hits so playback does not stop. (4) The same-name rule treats "Love" vs "Love Story" as one family (≥4 chars, whole words) — intended. (5) iOS native code was not read.
- TEST: +20 tests (groicAutoNext.test.ts, musicLibraryAndPlayNext.test.ts). 9 music test files, 116/116 pass. tsc: no new errors. eslint: 0 errors. vite build ok.
- NOT VERIFIED: real providers, real devices, real listening data.

## 2026-10-08 — Groic (music) premium redesign — Spotify/Apple-Music-style home, search, actions sheet (no version bump — bump before OTA, rule 12)

- WHY: the music page was a sparse list of 128px cards with tiny "+" buttons, no hero, no per-song menu, no library. Research (Spotify, Apple Music, YouTube Music UX/patch notes) pointed at the same patterns: time-of-day greeting, a six-tile "familiar" quick-pick grid on top and recommendations below, large cover shelves, a Top result + row list on search, one "…" menu per song (Play next / Add to queue / Add to playlist / More by artist), hairline progress on the mini player, a like button beside the title, Clear on the queue.
- WHAT (presentation only — search/trending/playlist/download DATA logic in Groic.tsx is unchanged):
  - `src/pages/Groic.tsx`: new home (greeting, quick picks, "Your mix" hero, mood gradient tiles, Recently played, Because you searched, Made for you, Our Playlist with Play/Shuffle, Liked Songs, Downloads, language chips + trending shelves) and new search (provider chips, Top result card, per-provider row lists with "Show all"). All provider shapes are normalised to GroicTrack; one `playFrom` replaces three near-identical onPlay handlers. Dead handlers removed.
  - `src/components/music/MusicUI.tsx` (new): Cover, Equalizer, Shelf/ScrollRow, CoverCard, QuickTile, MoodTile, TrackRow, TopResult, TrackActionsSheet (vaul Drawer).
  - `src/lib/music/libraryStore.ts` (new): local Liked Songs + Recently played tracks, per account, hooks. Never stores streamUrl.
  - `src/contexts/GroicContext.tsx`: new `playNext(track)` (pure helper `insertAfterCurrent` in queueLogic.ts); `recordRecentTrack` at both play choke points.
  - `GroicMiniPlayer.tsx`: hairline progress (own component, so the position tick does not re-render the bar). `GroicFullPlayer.tsx`: heart beside the title, "Clear queue" in the open queue. Pull-to-minimize gesture code untouched.
- RISK: (1) Liked Songs / Recently played are LOCAL to this phone + account — not synced to the partner or other devices (needs a table + RLS; not added). (2) Layout was never rendered on a device or browser — spacing/safe-area on small phones is unverified. (3) Title block in the full player got `pl-11` to stay optically centred next to the heart; check long titles.
- TEST: new `src/test/musicLibraryAndPlayNext.test.ts` (7 tests). Ran the 8 existing music test files + new one: 97/97 pass. `tsc --noEmit -p tsconfig.app.json`: no new errors (pre-existing TS2367 at GroicContext.tsx ~1017 remains). eslint on changed files: 0 errors. `vite build`: succeeds.
- NOT VERIFIED: device/browser run, live provider calls, TalkBack/VoiceOver, full vitest suite (not run).

## Fix: DS-UNKNOWN-001 "Cannot access 'T' before initialization" (IncomingCallOverlay crash) (no version bump)
- WHY: ErrorBoundary crash on Android (app 3.22.9), 6 occurrences. ReferenceError (TDZ) thrown inside a component during render, not a network/native error.
- ROOT CAUSE: `src/components/IncomingCallOverlay.tsx` — the 3s ringing-watchdog `useEffect` (added in the 2026-10-06 calls session) listed `ringingCallId` in its dependency array, but `const ringingCallId = incomingCall?.id ?? null` was declared ~25 lines BELOW it. Dependency arrays are evaluated at render, so the overlay threw on every render (minified name `T`). Found with `tsc -p tsconfig.app.json --noEmit` (TS2448); it was the only TS2448/2454/2449 in the project.
- WHAT: moved the `ringingCallId` declaration above the watchdog effect (comment explains why). No behaviour change otherwise.
- VERIFIED: tsc reports zero use-before-declaration errors; `vitest run src/test/callBusyOutcome.test.ts` 4/4 pass. NOT RUN: full vitest, vite build, device.
- RULE: after editing a component, run tsc and grep TS2448 — a hook dependency array referencing a later `const` only fails at runtime.

## 2026-10-06 — Layered multi-pulse haptics everywhere (JS-only, no native rebuild) — no version bump

- `hapticEngine.ts` PATTERNS: every tap/tick/selection/swipe/sheet/dialog pattern is now a 2-4 pulse layered sequence (strike + settle) instead of one pulse. New patterns: delivered, reactionScrub, replyArmed/replyCommit, copy, pin, deleteMsg, nudge, scrollBottom, voiceStart/Lock/Cancel/Play, menuOpen, callConnect, callEnd. Send = wind-up + release + whoosh fall; receive = knock-knock-settle.
- `haptics.ts`: new exports + HapticKind entries for all of the above.
- Wired: message swipe-to-reply (armed + commit), context menu (copy/pin/reply/react/delete each distinct), long-press, voice record start/cancel + playback, incoming message receive + nudge, slash-command pick, disappear-pull threshold/commit, call end. HapticLab has buttons for the new patterns.
- Follow-up polish: swipe-to-reply now has progressive detents (30 % / 65 % soft ticks, then the armed click); dropdown menus and the reaction picker play `menuOpen` on open; reaction picker scrubs with `reactionScrub` on touch; call connect plays `callConnect` when the call joins.
- NOT compiled/tested in this environment (no node_modules/network). Run `npm ci && npx tsc --noEmit && npx vitest run` before shipping.

## 2026-10-06 — Premium haptics (native plugin + design language) — no version bump (bump before OTA, rule 12)

**Why it felt cheap/hard:** @capacitor/haptics on Android plays a fixed `createWaveform` buzz (no HAL primitives); iOS only has Light/Medium/Heavy; `hapticSelection()` (selectionStart/End) never ticked because `selectionChanged` was never called.

**Changes**
- New local plugin `native-plugins/haptics` (`duospace-haptics`): Android VibrationEffect.Composition primitives -> predefined effects -> short waveform; iOS UIImpact (Soft/Rigid + intensity)/Selection/Notification generators + Core Haptics. Wired in package.json, lockfile (regenerated by npm, additive), vite/vitest aliases, tsconfig, android capacitor.* sync files. Needs a NEW APK/IPA.
- `src/lib/hapticEngine.ts` (new): tier ladder duo -> capacitor -> web, named pattern catalog, priority gating (weaker haptic within 45 ms of a stronger one is dropped), prefs (on/off + Subtle/Standard/Strong).
- `src/lib/haptics.ts`: all existing exports kept; new hapticReaction/Heartbeat/PullThreshold/SliderStep/SliderCommit/SheetOpen/SheetClose/DialogOpen. Call ring = one native `ringPulse` per 1.5 s; stop cancels native only if it was running.
- `src/lib/globalHaptics.ts`: one delegated listener gives buttons/tabs/switches/menu items a haptic; skips if a haptic fired <120 ms ago or press >350 ms; opt out with `data-haptic="off"`. Started in main.tsx.
- Slider, Sheet, Drawer, Dialog, AlertDialog now give haptics. HeartBurst = heartbeat; reactions = reaction pop.
- Settings -> Security: "Feel the haptics" lab + active engine label.

**Verified:** npm ci OK; vite build OK; tsc errors only in pre-existing untouched files; haptic tests pass. 16 unrelated tests (appUpdate, selfHostedCallEngineAdapter, surpriseDocument, i18n multilingualRelationship) fail identically on the original zip.
**NOT verified:** Kotlin/Swift not compiled (no SDK/Xcode); never felt on a device. Untouched: messageAlert.ts / notificationSounds.ts vibration, toasts.

## Music: Bluetooth / notification transport buttons (no version bump)
- WHY: owner reported the Bluetooth (headset) controls and the now-playing notification buttons not working.
- ROOT CAUSES (from source; no device available): (1) native-engine tracks: "Next" (and "Previous" at the start of the window) did nothing whenever the native queue window (prev + 2 ahead, list order) had no such item - end of window, single-item queue, shuffle - because the command never reached JS; (2) `GroicContext` dropped every remote command unless the current track was YouTube, so even a forwarded command would be ignored; (3) `setPlaybackToLocal()` was re-applied on every ~1 s session refresh, making the OS re-publish the session's audio info continuously; (4) `stopPlaybackNotification()` toggled the session inactive->active in one call, and nothing re-activated it later if that was skipped.
- WHAT: `MediaPlaybackService.dispatchTransport` forwards next/previous to JS (existing `webKeepAliveCommand` event) when ExoPlayer cannot satisfy them; previous restarts the track if >3 s in; `setPlaybackToLocal` once at session creation; session deactivated on stop and re-activated in `updateSessionState`; `GroicContext` onWebKeepAliveCommand honours next/previous for any provider (play/pause/seek still YouTube-only, native handles those itself).
- NOT VERIFIED: nothing compiled, linted, tested or run on a device/headset (no network/Gradle). Test: pair a headset, play an Audius/SoundCloud track and a YouTube track, press play/pause/next/prev from the headset and from the notification, including on the last track of a short queue and with shuffle on.
- NOT CHANGED: a YouTube track while the WebView is frozen in the background cannot receive commands (platform limit, see GroicContext keep-alive comments).

## Theme visual system: neutral surfaces, themed first paint, real previews (no version bump)
- WHY: owner asked for a visual-only improvement pass on the existing theme system (premium, calm, neutral surfaces, wine/accent used for meaning) without changing any feature. Reading source: surfaces took saturation straight from the preset primary (22-30% on dark Midnight) so every background/card/muted tile was painted in the theme hue; static `:root`/`.dark` defaults were a violet palette while the default theme is Midnight blue; splash/boot/location gate hardcoded `#121316`/`#F6F6F9`, so the first frame ignored the persisted theme (incl. AMOLED/custom).
- WHAT (engine, no second theme engine): `themeEngine.ts` — internal `THEME_TINT_STRENGTH = 0.35` + optional `DeriveOptions.tintStrength`; neutral surface ladders (dark bg 7 / card 11 / muted 13 / secondary 16, light bg 95 / card 99), capped accent washes, popover one step above card, scrim saturation capped, new `--ambient-glow` token, advisory `auditThemeTokens()` (surface tint, saturated primary, weak muted text, accent overpowers, red-primary collision, bright gradient; never blocks/mutates). `applyTokens` now also stores a versioned snapshot under `duo-boot-tokens`. Preset ids/identities, HSL storage and the import/export format are unchanged (HSL kept; OKLCH not used).
- WHAT (custom themes): `customThemes.ts` — `buildCustomThemeTokens()` extracted unchanged from `applyCustomTheme` (pure, used for previews); AMOLED now gets a neutral 0/2/4/8/12% elevation ladder and zero ambient glow; `--ambient-glow` added to the cleared-override list.
- WHAT (startup): new `src/lib/themeBoot.ts` (called in `main.tsx` beside bootFontPreset/bootTextDensity/bootPerfProfile) applies the persisted theme synchronously with the same engine/keys as ThemeProvider; inline script in `index.html` sets `.dark` and restores the last snapshot before the bundle loads (ignored if its mode disagrees with the resolved mode; corrupt snapshot = old path). `AppBootScreen`, `SplashScreen`, `LocationAccessGate` use `hsl(var(--background|--foreground|--muted-foreground))`. `ThemeContext.resolveThemeId` / `THEME_DEFAULT_MODE` are now exported (no logic change). Static CSS defaults + `theme-color` meta regenerated from the engine (Midnight): dark `#101113`, light `#F1F2F3`.
- WHAT (material/ambient): `index.css` glass saturation reduced (1.3-1.5 -> 1.15-1.3), material hierarchy documented, `.dark .ambient-light` static radial wash (no animation/blur/DOM) applied to the `AppLayout` root. Pages with their own solid `bg-background` cover it by design.
- WHAT (UI): new `components/settings/ThemePreview.tsx` (mini header/avatar/bubbles/composer/nav painted from real tokens, purely visual) used by `ThemePicker` cards and Theme Studio. Theme Studio: Preview + Appearance + Presets first; Typography, Text size & spacing and the custom builder moved into `CollapsibleSection`s ("Advanced · Build your own"). Every control, handler, saved theme, import/export and reset is kept. Studio preview shows the builder only after the person edits it, otherwise the applied look.
- WHAT (semantics): fixed emerald/amber icon colours in `CallHistoryRow`, `NotificationsSettings`, `Profile`, `MessageComposer` now use `success`/`warning` tokens (fixed colours, not theme-driven).
- NOT DONE: micro-grain (adds a full-screen composited layer; not measurable without a device). `capacitor.config.json` / native splash still `#121316` (would seam against splash art). Remaining palette classes in chat/admin/map/etc. and `black/white` media overlays (Gallery, camera, PeekGuard, lip-reading) were audited and left: media/semantic. No visual QA in a browser/device.
- RISK: neutral surfaces change how every theme looks (intended) — judge on a phone. Colourful presets keep their hue in primary/accent/ambient glow, not in large surfaces. 2 extra react-refresh lint warnings from the new exports.
- TEST: new `src/test/themeVisualSystem.test.ts` (neutrality, ladder order, tint control, semantics fixed, border/primary contrast, legacy ids, 33 presets, dynamic endpoints, AMOLED/custom/export round-trip, audit advisory, boot snapshot, no hardcoded boot hex) + existing `themeCatalog.test.ts` (4.5:1 for all presets): 25 passed. tsc: 19 errors, identical to pristine v3.22.10 (none introduced). Full vitest: 14 failed / 2272 passed; 13 of the failures reproduce on pristine v3.22.10 (selfHostedCallEngineAdapter, surpriseDocument, privacyRedTeam, mediaValidation, mediaService) — the 14th was my own test, fixed. `npm run build` passes. Inline boot script exercised in node across system/manual/schedule/dynamic/corrupt-snapshot cases.
- No package.json/version change; native versionCode untouched. Bump before shipping OTA (rule 12).

## UI language: follow system + app-shell translations (no version bump)
- WHY: owner asked for language to be available all over the app and to support multiple languages following the device language.
- WHAT: `src/lib/i18n.ts` — stored value may be `"system"` (the default): resolves from the whole `navigator.languages` list (was first entry only), re-evaluated live on `languagechange`; explicit choice still wins; `<html lang>` now tracks the effective language. New `useLanguage()` / `useT()` (`src/hooks/useLanguage.ts`, useSyncExternalStore) so screens re-render on change; `AppContent` also subscribes so existing `tr()` callers update. New `LanguageButton` (chip + sheet) on Auth and Onboarding; Settings → Language gains "Match device language". Shell catalogs in `src/lib/uiCatalogs/<lang>.ts` (56 keys x en + 11 Indian languages): dock tabs, Hub menu, Settings hub, language page, Auth tagline (existing splash taglines).
- NOT DONE: ~1,400 other UI strings (chat, calls, gallery, map, music, profile, admin, dialogs, toasts, auth forms, Settings subpages) are still English and fall back silently. Love Letter / Schedule Send hub rows still English.
- RISK: all non-English strings are machine-authored and NOT native-reviewed (same status as existing taglines). Device languages outside the 11 (e.g. ru, ky) fall back to English by the existing owner decision (2026-09-25); adding languages = new catalog file + SPLASH_LANGUAGES entry.
- TEST: `src/test/i18n/uiShellCatalogs.test.ts` (key/placeholder parity for all 11, system-vs-explicit resolution). i18n + phase3k tests 78 passed; tsc: no errors in touched files (pre-existing errors elsewhere); full vitest NOT completed (timed out in session). Not verified on a device/UI.
- No package.json/version change; native versionCode untouched. Bump before shipping OTA (rule 12).

## Security audit v3.22.9 remediation (no version bump)
- SIG-001: `infrastructure/signaling/src/auth.ts` makes tickets single-use (jti cache until exp, fail-closed when full, jti+exp required). Client already fetches a fresh ticket per attempt. Per-process cache: multiple replicas need sticky routing or a shared store.
- RLS-001/RLS-002/RLS-003/ADM-001: new migration `20261004110000_security_audit_v3_22_9_hardening.sql` (additive). BEHAVIOUR CHANGE: `search_users` is now an exact username (case-insensitive) or exact phone match, so partial-name search no longer returns results.
- ADM-002: docs only (`docs/ADMIN_BOOTSTRAP_RECOVERY.md`); single admin is intentional.
- Tests added, NOT RUN (no node_modules/network): `infrastructure/signaling/test/auth.test.ts`, `src/test/db/securityAuditV3229.db.test.ts`, `src/test/security/adminTableGrants.test.ts`. Migration not applied to a live DB. Audit statuses set to NEEDS_MANUAL_VERIFICATION.

## v3.22.9 — Calls: stuck "Ringing", vanishing Answer/Decline, lingering ring, video screen
- WHY: owner reported (1) call answered and audio/video flowing but the caller stays on "Ringing" and never goes to connected, (2) the incoming-call Answer/Decline notification hides after a few seconds (only visible by swiping down), (3) video-call screen looks wrong, (4) ring + notification linger for a few seconds after hang-up.
- ROOT CAUSES (read from source; no device available):
  1. STUCK RINGING: `SelfHostedCallEngineAdapter` set `participantCount` from `room.numParticipants`, which LiveKit only fills from server room-metadata updates and can still read 1 when `ParticipantConnected` fires (or never refresh on a self-hosted server). `callUiState` only leaves "ringing" when `participantCount > 1`, so the caller stayed on Ringing over live audio. Now `remoteParticipants.size + 1` (SDK-local, always current). Belt and braces: `deriveCallUiState` treats `remoteAudioReady === true` on a not-yet-connected call as connected, and Calls.tsx / Chat.tsx set `everConnected` from `remoteAudioReady` too (partner-left still works after first connect).
  2. VANISHING ANSWER/DECLINE: Android collapses any heads-up banner after ~5-10s; the full-screen intent that makes it sticky was deliberately removed earlier (it auto-launched the app). `CallRingingService` now re-posts the same notification id every 3s while ringing (`IncomingCallNotification.build(reAlert = true)` -> `setOnlyAlertOnce(false)`), which resets the banner timer. Channel is silent/no-vibration so it is visual only; stops with the ring (stopRinging) and is callId/isRinging-guarded.
  3. LINGERING RING: (a) the caller's synth ringback schedules a whole ring period of oscillators ahead on the AudioContext timeline; `stopRingtoneLoop()` only cleared the repeat interval, so the already-scheduled tones kept playing for seconds. Scheduled oscillators are now tracked and faded out on stop (`src/lib/sounds.ts`). (b) `call_ended` / `call_rejected` pushes (the "stop ringing" signal for a backgrounded/dozing phone) were FCM NORMAL priority, which Doze defers; now HIGH (`supabase/functions/_shared/fcm.ts`). **Needs `send-push` redeployed.**
  4. VIDEO SCREEN: `CallStage` root had both `fixed` and `relative`; `relative` wins in Tailwind output order, so the "full-screen" stage was an in-flow block under the page chrome (cut-off video, controls below the fold). Removed `relative`, added `overflow-hidden`. Also new: when the partner's camera is off/not sending, show their avatar + "Camera is off" instead of a black/frozen rectangle (`remoteVideoOn` added to the engine: set on attach, TrackMuted/TrackUnmuted/TrackUnsubscribed for the partner's camera only).
- RISK: heads-up refresh behaviour depends on the OEM skin (some may flash the banner every 3s); fallback is to set a full-screen intent only when the screen is locked/off. Camera-off placeholder relies on LiveKit mute events.
- TEST: two new cases in `src/test/callingReliabilityPhase5.test.ts` (live audio => connected despite lagging counter; partner-left preserved). No node_modules / network in this session: vitest, tsc, eslint and Gradle were NOT run — only a TS syntax pass and Kotlin brace balance. Not verified on a device.
- Version 3.22.8 -> 3.22.9 (package.json, package-lock, build.gradle versionCode 32209).

## v3.22.8 — Groic: rails no longer vanish, language chips, smarter auto-next
- WHY: owner reported (1) tapping a song in Suggestions / a language rail made the whole row disappear, (2) picking a language made the row disappear, (3) auto-next / suggestions weak.
- ROOT CAUSES (read from source, then reproduced in tests):
  1. `Groic.tsx` `dedupedHome` hid every song that was in the live queue or playing. Tapping a card queues its whole rail, so the rail filtered itself to nothing. Playback state is no longer an input; cross-rail de-dupe lives in `src/lib/music/railDedupe.ts` and can never drop a rail below 4 items.
  2. `songKey()` is "" for non-Latin titles (Devanagari/Gurmukhi/Tamil/Arabic/Hangul), so every Hindi/Marathi/Haryanvi/Punjabi song "equalled" every other: rails collapsed to one card, and `buildUpNextPool` dropped every non-Latin song but the tapped one from the queue. New shared `trackKey()` (queueQuality.ts; identical to songKey for Latin titles so stored history stays valid) is used by buildUpNextPool, getTrendingRail, playHistory, autoNext and the home rails.
  3. Language chip tap re-fetched ALL languages behind one `trendingLoading` flag that swapped the entire home for a shimmer. Now per-language load/fail/retry; only the missing language shows a placeholder, existing rails stay put, a failed refresh keeps what is on screen. Toggle persistence moved out of the setState updater.
- AUTO-NEXT: `fetchAutoNext` now has a fallback ladder (strict -> relaxed recent window, newest 10 stay excluded -> the user's language trending, only when something is playing). Prefetch at 3 tracks left (was 2) and also when the queue itself changes; end-of-queue with nothing found now shows an error message instead of stopping silently. Rail taps use buildUpNextPool (shuffled, no recent repeats) instead of raw rail order.
- RISK: home rails no longer hide songs already queued (intended). Old play-history keys for non-Latin titles were raw lowercase; new keys are normalized, so at most the 40-entry window forgets those once.
- TEST: new `src/test/musicRailsAndFallback.test.ts` (13) + all 8 music test files pass (89). Full vitest: 12 failures, identical in the untouched uploaded zip (privacyRedTeam, selfHostedCallEngineAdapter, surpriseDocument). eslint: 0 errors. tsc: no errors in Groic.tsx / music libs; one TS2367 in GroicContext.tsx:1007 is pre-existing (guest narrowing).
- NOT VERIFIED: no device/browser run; provider network paths (SoundCloud/Audius/YouTube/music-trending) not exercised live. Version 3.22.0 -> 3.22.8 (package.json, package-lock, build.gradle versionCode 32208).

## v3.22.0 — OTA / in-app updates (admin-published APK/IPA)
- WHAT: admin uploads an APK/IPA in Admin -> Updates; every sideloaded install is notified, downloads over Wi-Fi only / Wi-Fi+mobile data (user policy, default "ask on mobile data") through Android's DownloadManager, then installs through a verified installer hand-off. iOS opens an itms-services (ad-hoc/enterprise IPA) or store link.
- DB: `20261003190000_app_releases_ota.sql` (table `app_releases`, private bucket `app-releases`, `is_app_admin()`, `get_latest_app_release()`, `admin_create/set_status/delete_app_release`; all admin actions audited). Edge: `app-release-download`, `app-release-ios-manifest` (both `verify_jwt = false` in config.toml, on purpose).
- App: local plugin `native-plugins/app-update` (Android), `src/lib/appUpdate/*`, `UpdatePrompt` (global sheet; blocking overlay when the release is marked Required), Settings -> App updates (Wi-Fi/cellular policy), admin `AdminReleasesTab`. `AppUpdateHost` (link-only notice from `app_update_config`) now stands down whenever a published release exists; it remains the fallback.
- FIX (real bug found on the way): `versionCode` was hard-coded to 1 and nothing stamped it, so an updater would loop forever. `scripts/patch-native-permissions.mjs` now stamps versionCode/CURRENT_PROJECT_VERSION from package.json (`scripts/native-version.mjs`); `android/app/build.gradle` committed at 32200 / 3.22.0.
- WHY: owner asked for OTA + in-app update with notifications, Wi-Fi/cellular choice, admin-only upload.
- APPLIED live (Duospace jzlpelxwzjjpddqcrtpu) 2026-10-03: `app_releases_ota`, then `app_releases_revoke_default_grants` (fix: default privileges had granted `authenticated` TRUNCATE etc.; found by reading live grants, now covered by a test that fails without the fix).
- RISK: installer path is untested on a device; SQL never run on a Postgres (see HANDOFF_2026-10-03_OTA.md). Version bumped 3.21.1 -> 3.22.0.
- TEST: `src/test/appUpdate.test.ts` (33) + `src/test/db/appReleasesOta.db.test.ts` (17, real migration on PGlite), real vitest, pass. tsc: no new errors vs the uploaded zip (16 pre-existing). eslint clean on changed files.

## v3.21.2 — Groic collaboration, sync & notifications
- Both partners can play/pause/seek/skip (guest next/prev go to host via `cmd`); last press wins when both tap at once (clock-offset-gated).
- Sync: NTP-style clock offset (both directions, refreshed ~every 32s), flight-time compensation for play/seek, 1s ticks, hard-seek 1.0s / nudge 0.3s, 2.5s seek cooldown, post-control grace window, instant `sync-req` on foreground/online.
- Presence: `hb` heartbeat, host watchdog (12s) marks partner gone, guest auto-resubscribes after 10s silence; join/leave/pause/resume toasts.
- Push: `groic_listening` via `notify_partner_listening()` RPC (60s rate limit). Migration 20261003180000 + redeploy `send-push`.
- Unverified on real devices.

## 2026-10-03 — v3.21.1 DB side applied to live Duospace project
- WHAT: applied `admin_console_hardening` and `admin_console_pin_est_fee_bps_search_path` to Supabase project Duospace (`jzlpelxwzjjpddqcrtpu`); `admin_console` (v3.21.0) was already live. Added repo file `20261003171000_admin_console_pin_est_fee_bps_search_path.sql` to match.
- WHY: owner asked to apply the migrations. Pre-checked: prior migrations present, signatures to DROP matched, no dependents, column types matched.
- TEST (live DB): rates seeded; fee maths correct; grants correct (`admin_revoke_sessions` service_role only); couples / transactions / summary / rates callable as admin; non-admin refused and a non-admin rate write did not change the table; security advisor shows only intended findings for the new objects.
- NOT DONE: edge function not deployed; app not rebuilt; no device run; staging project is inactive so nothing was staged first (applied straight to the live project at the owner's request).
- NOTED, NOT MINE/NOT CHANGED: advisor ERROR `security_definer_view` on `public.my_entitlement` and `public.admin_entitlements_view`; WARN mutable search_path on `public.scheduled_unlinks_guard`; WARN anon-executable SECURITY DEFINER `notify_push_on_blend_*` and `is_couple_realtime_topic_authorized`; leaked-password protection disabled.

## 2026-10-03 — v3.21.1: admin console hardening (block revokes sessions, editable commission, unlink countdown, honest grant card)
- WHY: owner asked to continue on the updated zip with researched decisions. Research showed a Supabase ban does NOT end existing sessions; Razorpay's real rate is 2.36 % (2 % + GST) and it keeps the fee on refunds; and the v3.21.0 grant card listed perks that are not enforced.
- WHAT: migration `20261003170000_admin_console_hardening.sql` (`admin_revoke_sessions` service_role-only, `commission_rates` table + 2 admin RPCs, fee logic reads it, `admin_list_transactions` + provider txn id, `admin_list_couples` + unlink countdown; the two lists are DROP/re-created); `admin-user-action` now also deletes the user's sessions on block; Payments tab rate editor; Couples tab countdown; `UserNoticeHost` perks now `PLAN_MARKETING.PRO.highlights`; version 3.21.1. Decisions table in `docs/ADMIN_CONSOLE.md`.
- RISK: DROP/re-create of two admin-only read functions (no data touched); new service_role-only function deleting `auth.sessions` rows for a named user (only reachable from the edge function after the Postgres admin check). RLS untouched.
- TEST: syntax-only `tsc` over changed files (no syntax errors); fee arithmetic and `formatBps` re-run under node (pass); semver tests as before. Type-check, vitest, lint, build NOT run (no node_modules/network).
- RESULT: NOT VERIFIED beyond that. SQL desk-checked only (no Postgres in sandbox). Migrations unapplied, function undeployed, no device run.

## 2026-10-03 — v3.21.0: admin console (users, couples, access, payments, announcements, app update, audit)
- WHY: owner asked for a full admin panel (video: view / verify / block / manage users, payments & refunds, announcements & offers, analytics, app update) fitted to DuoSpace, with partner links visible where access is granted and a "admin granted you Pro" card for the recipient.
- WHAT: migration `20261003100000_admin_console.sql` (user_moderation, user_notices, admin_announcements + dismissals, app_update_config, admin_audit_log, ~15 admin RPCs, grant-notice + audit triggers); edge function `admin-user-action` (block/unblock/verify via Auth admin API after a Postgres admin check); `AdminSettings` is now 7 tabs (`components/admin/*`); app-wide `UserNoticeHost`, `AppUpdateHost`, `BlockedGate` in AppLayout; `useEntitlement` listens for `duo:entitlement-changed`; friendlier "blocked" sign-in error. Details: `docs/ADMIN_CONSOLE.md`.
- RISK: new write surface for the single ADMIN account (all server-checked, audited, RLS on, additive migration, no RLS weakened, no service_role in client). Block is an Auth ban + client gate, not RLS (see KI-45).
- TEST: `src/test/admin/semver.test.ts` (logic re-run under node: pass). Syntax-only `tsc` over all new/touched files: no syntax errors; type-check NOT run (no node_modules/network).
- RESULT: NOT VERIFIED beyond that. Migration not applied, function not deployed, no vitest/tsc/lint/build, no device. SQL was desk-checked only (no Postgres in sandbox). 10-case manual matrix in the doc is unrun.

## 2026-10-02 — v3.20.5: legal checklist from the video (see docs/LEGAL_CHECKLIST.md)
- Age gate: `lib/legal/ageGate.ts`; Auth signup has a date-of-birth field (validated, <MIN_AGE=18 blocked, 24h device block, DOB never stored, only `age_gate` metadata); Google/Apple sign-in require an "I am 18 or older" box and honour the block.
- Fonts self-hosted: index.html + `fontLoader.ts` now load `/fonts/*.css`; `scripts/fetch-fonts.mjs` (`npm run fonts:fetch`, needs network, run once, commit `public/fonts`) generates them. `scripts/fonts-lib.mjs` is the tested pure part. NOT run here (no network): until it runs, fonts use fallbacks.
- `/legal/copyright` public page + `lib/legal/legalConfig.ts` (agent from VITE_DMCA_AGENT_*); link on the Auth screen; preflight warns on production when unset.
- `send-email` refuses marketing-type mail (no unsubscribe/postal address exists).
- Guards: `test/legal/noThirdPartyLoads.test.ts` (no Google Fonts host, no replay/analytics deps). Tests added: ageGate (7), fontsLib, legalConfig. Run green under a vitest shim where noted; real vitest/tsc/lint/build NOT run.

## 2026-10-02 — v3.20.4: truthful billing copy on the Plus screen
- New `lib/monetization/billingCopy.ts` (pure): `priceCaption()` and `methodNote()`. Plan cards no longer say "per month" for a Razorpay-only one-time pass ("for 30 days"); each payment button gets a note: Play = renews monthly, cancel in Google Play; Razorpay order mode = one-time 30 days, does NOT renew; Razorpay subscription mode = renews monthly until cancelled here. "Renews" is only ever shown where it is true.
- Tests: `src/test/monetization/billingCopy.test.ts` (5; green under a vitest shim, real vitest NOT run). Screen wiring is type/syntax-checked only; not seen on a device.

## 2026-10-02 — v3.20.3: monetization go-live preflight
- `scripts/monetization-preflight.mjs` (+ `npm run check:monetization -- --target staging|production [--client-env F] [--secrets-file F]`): pure `runPreflight` + CLI. Fails on: secret-looking VITE_ vars, live key on staging / test key on production client, missing monetization functions, missing `verify_jwt=false` for razorpay-webhook/google-play-rtdn, missing migrations, bad AdMob App ID, weak/missing/reused server secrets, bad Play JSON, missing Pub/Sub vars, test AdMob unit in production. Warns on unset `VITE_RAZORPAY_ENABLED` (code default is TRUE), subscription mode prerequisites, live ad unit on staging. Never prints secret values.
- Tests: `src/test/monetization/preflight.test.ts` (8; run green under a vitest shim, real vitest NOT run). Cannot see live Supabase/Razorpay/Play state: it checks inputs and the repo only.

## 2026-10-02 — v3.20.2: ads — Google UMP consent + gallery/plans banners
- Plugin `duospace-admob`: new `requestConsent()` (UMP `requestConsentInfoUpdate` + `loadAndShowConsentFormIfRequired`) and `showPrivacyOptions()`; `initialize()` now REFUSES (`consent_required`) unless UMP says `canRequestAds`. Fails closed on any consent error. UMP classes come transitively from play-services-ads 23.6.0.
- `admobProvider.initAds()`: consent first, SDK only if `mayStartAdSdk()`; `lib/monetization/adConsent.ts` (pure, tested). Banner height published as `--ad-banner-height`; `FloatingDock` bottom and `--dock-reserve` add it so the banner sits below the dock.
- Placements: `<AdSlot surface="gallery_grid_footer" suppressed={viewItem||selectionMode}/>` in Gallery, `<AdSlot surface="plans_screen_footer"/>` on the Plus screen (padding reserves space). `AdSlot` gained `suppressed`. New `AdPrivacyChoices` link at the end of Settings (renders only when Google says privacy options are required).
- Tests: `src/test/monetization/adConsent.test.ts`. Verified: adConsent strict tsc + its logic under node; syntax-only transpile of touched files. NOT verified: real vitest/tsc/lint/build, Kotlin compile, any device, UMP form, banner vs dock on a device. `NO_ADS` stays PENDING until a banner is seen rendering.

## 2026-10-02 — v3.20.0: personal mood profile (mood "database") + dataset research
- Research -> `docs/MOOD_DATASET_RESEARCH.md`: AffectNet/RAF-DB are non-commercial, FER2013 unlicensed, so no third-party dataset is shipped.
- New `lib/moodProfile.ts` (pure) + `lib/moodProfileStore.ts` (secureStorage, per-user, cleared on sign-out) + wiring in `MoodDetector.tsx` (blend baseline, personalize evidence, learn on 👍) and `useBackgroundMoodDetection.ts` (baseline + personalize only).
- Verified: pure logic 6/6 tests via transpile+shim; store typechecks against stubs. NOT verified: real vitest, app tsc/lint/build, device, any accuracy gain (no labelled data).

## 2026-10-01 — v3.19.0: KI-23 lip-reading partner notice + KI-22 device vault
- KI-23: `hooks/useLipReadingNotice.ts`, `LipReadingNoticeBanner` (CallStatusBanner.tsx), wired in `CallStage.tsx`; migration `20261001160000_realtime_lipread_prefix.sql` applied live (verified function body identical to repo before the one-word change).
- KI-22: `lib/privacy/deviceVault.ts`; face template + Peek snapshots encrypted at rest; legacy plaintext migrated on read. Node test of the crypto passed; `tsc --strict` on the module passed in isolation.
- `sensorPolicy.ts` gap text updated. NOT verified: app tsc/vitest/build, device, two-device notice test, no unit tests added for the vault/notice hook.

## 2026-10-01 — handoff consolidation
- Added `.ai/PENDING.md` (single prioritised list of open work); NEXT_PHASE.md points to it; KI-22 assessment recorded. Docs only, no version bump.

## 2026-10-01 — v3.18.9: KI-21 mood_logs partner read removed (live)
- Migration `20261001150000_mood_logs_own_select_only.sql` applied to prod and verified via pg_policies. `sensorPolicy.ts` gap notes updated. Revert path: recreate the old two-clause SELECT policy.

## 2026-10-01 — v3.18.8: KI-28 CI workflow
- Added `.github/workflows/ci.yml`. YAML parses; workflow NOT run (no GitHub here). The typecheck/lint/test/build steps have never been green in this repo's history, so the first run may fail on pre-existing issues.

## 2026-10-01 — v3.18.7: KI-27, KI-28, KI-39 (lockfile)
- `apply-whitelabel.mjs`: patches `capacitor.config.json` (was looking for a non-existent `.ts`).
- Removed stale `scripts/check-rls-coverage.ts`.
- `infrastructure/signaling/Dockerfile`: `npm ci` with the committed lockfile.
- Verified: whitelabel rename on a temp copy, `check:rls` run, signaling `npm ci --dry-run`. Not verified: Docker build, tsc/vitest/build of the app.

## 2026-10-01 — v3.18.6: KI-43 shayari partner favorite/delete
- Migration `20261001130000_shayari_partner_actions.sql` (applied live 2026-10-01 as `shayari_partner_actions`) + `Shayari.tsx` now calls the RPCs and only updates local state on success.
- Not verified: no tsc/vitest/build, migration not applied, no live test.

## 2026-10-01 — v3.18.5: KI-40 ring window aligned (overlay 45s -> 40s)
- `IncomingCallOverlay.tsx`: `RING_WINDOW_MS = 40_000` replaces the two hardcoded 45 s values (auto-decline + cold-start poll cutoff) to match `call_history.expires_at`.
- KI-34 (caller UI vs CALL_ACCEPTED) deliberately NOT changed: outgoing UI is already "ringing from tap" and flips on participant join; wiring accept in would be a UI-behavior change needing device testing.
- Not verified: no tsc/vitest/build/device run (no network).

## 2026-10-01 — v3.18.4: surprise "screen goes blurry after tap" fix

- Root cause (source-level): the in-frame "Tap for sound" chip (`surpriseDocument.ts`) used `backdrop-filter: blur(6px)`; on Android WebView that blurs the WHOLE sandboxed frame and can linger after the chip is removed on tap. Now an opaque chip, no filter. Same class of bug `codeSurprises.ts` already documents for templates.
- `SurpriseReveal.tsx`: the idle float (`y` loop) now runs only during the intro. It used to keep the live iframe on a perpetually moving fractional-px layer = soft/blurry rendering.
- Test: `surpriseDocument.test.ts` asserts the generated document has no `backdrop-filter`/`blur(`.
- Not verified: no device run, no build/vitest run here (no network). If blur persists it comes from the creator's own CSS (backdrop-filter / filter: blur in their code).

## 2026-10-01 — Supabase side applied live (v3.18.3)
- Deployed `location-push-upload` **v17** (verify_jwt=false; battery/ringer/status-only support; 2 s rate limit).
- Migration `publish_profiles_to_realtime` applied: `public.profiles` was NOT in `supabase_realtime`, so the partner battery/ringer/presence subscription never fired. Now published (RLS: own + partner row only).
- Live findings: native upload already returns HTTP 200 end-to-end for the one Android device holding a credential (location lands within ~3 s of a push). The partner account has NO push token, NO credential and `ringer_mode='unknown'` (web/PWA-style client) -> it cannot receive pushes or upload while closed; its location only updates while its app/tab is open. Needs the Android APK (v3.18.3) installed, opened once while signed in, and "Allow all the time".

## 2026-10-01 — v3.18.3: push-triggered GPS location actually updates (deep-dive fix)

See docs/BACKGROUND_LOCATION_NATIVE.md "2026-10-01" for the root-cause list. Summary of changes:
- `DuoSpaceLocationService`: push one-shots run in a short-lived location-type foreground service (`startForegroundService` from the FCM handler, `enterForeground()` first in `onStartCommand`, `stopForeground` in `stopIfIdle`); staged HIGH -> BALANCED -> lastLocation fix; hard deadline; always exactly one upload (status-only if no fix). Falls back to plain `startService`, then to a status-only upload, if the foreground start is refused.
- `supabase/config.toml`: `[functions.location-push-upload] verify_jwt = false` (prevents CLI redeploy from re-enabling JWT and 401-ing every native upload). **Redeploy `location-push-upload` after pulling this.**
- `location-push-upload`: min interval 8 s -> 2 s.
- `PushUploadCredentialStore.markInvalid` + `LocationUpdateReceiver`: a 401 invalidates the stored credential so JS re-registers; clearer logcat lines.
- Correction to the v3.18.2 note: "redeploy location-push-upload" is only safe WITH the config.toml entry above; without it a CLI deploy would have broken native uploads.

Not verified: no compile, no device run, edge function not deployed from here.

## 2026-10-01 — v3.18.2: every call/text push now refreshes location, battery and status instantly (app closed or open)

**Audit result (source-level):** incoming calls already do NOT auto-open the app (no `setFullScreenIntent`, `onShowIncomingCallUi` is a no-op, `CallBridge` only launches on an explicit Accept); tapping the notification opens the app through `MainActivity` (`singleTask`) → `duospace-call-action` / `duospace-notification-tap`. Gaps found and fixed below: only location was refreshed on push — battery/ringer were never sent from a closed app, and nothing refetched the partner's status on tap/resume while the app was visible.

**Native:**
- `LocationUpdateReceiver.uploadFix` takes a nullable fix and ALWAYS adds battery level/charging/ringer mode. `fix == null` = status-only upload.
- `DuoSpaceLocationService.requestOneShotFix`: exactly one upload + one `stopIfIdle` per request (AtomicBoolean guard); on timeout / null / failure / permission denied it now sends a status-only upload instead of dropping everything.
- `CallBridge.pushSink` + `notifyPush(type)`: both FCM services fire it for every non-typing push → running WebView gets `duospace-push-arrived` (wired in Kotlin AND Java MainActivity templates in `patch-native-permissions.mjs`, cleared in `onDestroy`). Needed because Android delivers a push to ONE FCM service, so the JS `pushNotificationReceived` listener alone is unreliable.
- `DuoSpaceMessagingService.handlePush`: replaced the companion's direct `attachBaseContext` call (protected in `ContextWrapper`, likely compile error) with a public in-class `bindAndShow`.

**Edge function** `location-push-upload`: fix is optional; accepts `battery_level` (0–100), `battery_charging`, `ringer_mode` and writes `profiles` (+ `device_status_updated_at`). A status-only body is valid; a failed status write never fails a landed location. Same auth, 8 s per-credential rate limit. **Redeploy this function.**

**JS:** new `src/lib/statusRefresh.ts` (push / tap / call-action / resume). `useDeviceStatus` force-publishes my battery/ringer on each (≥5 s apart). `LocationContext` refetches partner location + status on each (≥3 s) and takes a fresh own fix on tap/resume (≥15 s). `usePushNotifications` raises the same event from `pushNotificationReceived`.

**Not verified:** Kotlin/Java proofread + brace-balanced only, TS syntax-checked only, edge function not deployed; nothing run on a device. Background-location "Allow all the time" and a saved push credential are still required for location from a closed app; battery/ringer need only the credential.

## 2026-09-24 — /important and /urgent alerts: distinct long ringtones + haptics that get through silent mode and Do Not Disturb

**Symptom:** `/urgent` and `/important` messages "still send like a normal message".

**Root causes (all four were real):**
1. **Live DB trigger regressed.** Live `notify_push_on_message()` was the 20260824 definition — no `important`, no `urgent` in the send-push payload, and `'preview', NEW.content` (E2E ciphertext in push bodies) restored. That migration had been applied on the live project *after* 20260921120000, overwriting it (`CREATE OR REPLACE FUNCTION` migrations clobber each other when applied out of file order). Fixed by `20260924100000_message_push_alert_levels.sql` (also applied live): carries every prior change + `important = important OR urgent` + `urgent`. **Any future edit to this function must be a later-dated migration starting from that body.**
2. No urgent tier: both flags shared one channel and one short sound.
3. Android ignores an app's own `setBypassDnd(true)` (only the person's per-channel "Override Do Not Disturb" counts) and mutes notification sound/vibration on a silent ringer — no channel setting can make a plain notification ring through silent/DND.
4. With the chat open the server skips the push (`recipient_viewing_chat`), and the realtime insert only played the plain ping.

**Fix:**
- `_shared/messageAlert.ts` (new, testable): tier resolution, per-tier channel (`duospace_alert_{important,urgent}_v2`), title (`⚡ Important · X` / `🚨 URGENT · X`), `data.alertLevel`, iOS sound + interruption level. `fcm.ts`/`pushTypes.ts` use it; `urgent` added to the request type.
- Android `MessageAlertService.kt` (new foreground service, `mediaPlayback`): rings a looped tier sound on the **alarm stream** (independent of ringer mode; DND priority mode lets alarms through), vibrates with **alarm audio attributes** (not gated by ringer mode), raises alarm volume while ringing and restores it, and — only if the person granted Do Not Disturb access — lifts the interruption filter for the alert and restores it (persisted, so a killed process still restores). important: 3 bells + 3×700 ms pulses, ≤20 s; urgent: siren + beeps + 2×1500 ms heavy pulses, ≤60 s. Stops on Stop/notification tap/swipe/app resume/timeout. Pushes older than 10 min are shown as normal messages. If the OS refuses the service start, falls back to the audible `_v2` alert channel (never silent). Old `duospace_urgent_message` channel deleted.
- Bridge plugin: `stopMessageAlert`, `previewMessageAlert`, `getMessageAlertStatus`, `openDndAccessSettings` (Android only). `useAppNative` stops a ringing alert when the app becomes active.
- In-app: `lib/messageAlert.ts` + `useChatRealtimeMessages` play the tier sound + long haptic pattern for flagged messages while the chat is open (first tap silences).
- Settings → Notifications: "Important & urgent alerts" card with real-service **Test** buttons, ringer/DND status, and a button for Do Not Disturb access.
- Assets: `alert_{important,urgent}` as m4a/ogg/caf (`scripts/generate-alert-sounds.py`; iOS files ~21 s / 27 s, under Apple's 30 s cap). Manifest/permission (`ACCESS_NOTIFICATION_POLICY`)/file-copy wired in `scripts/patch-native-permissions.mjs` (three-way merged with the CallActionReceiver registration).
- Tests: `src/test/messageAlert.test.ts` (tier logic, payloads, Kotlin↔client vibration patterns, channel ids, assets, migration); catalog test allows the two alert assets.

**Honest limits:** Android "Total silence" / DND with Alarms off still blocks alarm audio unless DND access is granted; the system "alarm vibration" setting can suppress vibration; a force-stopped app receives nothing. iOS: Time Sensitive breaks through Focus but cannot override the silent switch — that needs Apple's Critical Alerts entitlement (server side ready behind `IOS_CRITICAL_ALERTS=true`, do not enable before the entitlement is in the provisioning profile). Kotlin was proofread, not compiled, and nothing has run on a device yet.

**Live changes made this session (project jzlpelxwzjjpddqcrtpu):** migration `message_push_alert_levels` applied; `send-push` redeployed (v14) from this tree, including the call-decline token minting.

## 2026-09-23 (b) — Merged: Mood Detection "always Surprised" fix + Peek Guard auto-unlock

Merged incoming work (`duospace-merged.zip`), built on this session's
Phase 2A output — 7 files, entirely orthogonal to Phase 2A, no
overlap: `lib/moodScoring.ts` gains `sessionBrowBaseline()` (mood
detection previously compared raw browRaise against a fixed 0.15
constant that most people's RESTING eyebrow position already clears,
so "Surprised" fired on nearly every frame at its ×20 weight — now
normalized per-session against the face's own resting position),
wired into both `MoodDetector.tsx` and
`useBackgroundMoodDetection.ts`. Peek Guard gains real auto-unlock
(`usePeekDetection.ts`/`PeekGuard.tsx`/`ThemeContext.tsx`
`peekAutoUnlockOnOwner`/`peekAutoUnlockConsistencyFrames`/
`peekAutoUnlockDelay`, default on): the lock now clears itself the
instant the owner alone is confidently recognized back in frame, no
tap or OS biometric prompt required, with manual dismiss as the
fallback path when that can't confirm. Defaults tightened
(`peekConsistencyFrames` 3→1, `peekLockDelay` 150ms→30ms) for a
faster true-instant lock. `PeekConfigDialog.tsx` exposes the new
sliders. Verified by diff review only — see this session's merge
history; not independently re-verified against a device.

## 2026-09-23 — Phase 2A: Relationship Intelligence V1 (Values, Expectations, Communication Reflection)

First real relationship-AI capability, scoped to the Phase 2A brief.
New `src/lib/relationship/` domain: 30-question Values questionnaire
across all 15 categories, Expectations (preference/expectation/boundary
— boundary only ever user-confirmed, never AI-set), Communication
Reflection (5 prompts, opt-in local retention), a local-only rule-based
`RelationshipAIProvider` behind a provider-neutral interface + registry,
and the full USER INPUT -> LOCAL VALIDATION -> PRIVACY GATE -> AI
PROCESSOR -> SAFETY VALIDATOR -> ENCRYPTED LOCAL STORAGE -> DISPLAY
pipeline. Safety validator (`outputValidator.ts`) extended with
relationship-specific structural rules (user-attributed observations,
hedged explanations, required evidence, non-imperative suggested
actions) and ~15 new prohibited-claim pattern groups (cheating/
attraction, abuse, diagnostic labels, toxicity, relationship-failure,
breakup-necessity, partner-guilt, partner-mental-state, deception,
partner-disrespect verdicts) plus a hard block on any numeric/ratio/
"compatibility" score — no relationship score exists anywhere in this
feature. `FEATURE_CAPABILITIES` flips `AI_PROCESSING`,
`RELATIONSHIP_INSIGHTS`, `SHARED_INSIGHTS` on (only these three; every
other capability stays frozen per `.ai/DO_NOT_BUILD.md`). New explicit,
per-item partner sharing (`sharing.ts`): preview -> hash-bound confirm
-> new `relationship_shares` table (RLS'd, immutable except revoke,
auto-revoked on unlink via `apply_unlink`). New `/reflection` page
(Values/Expectations/Reflect/Insights tabs), reached only from the
existing Hub — no app-shell or nav change. Full report:
`docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md`.
NOT VERIFIED at runtime (standing sandbox limitation, every phase) —
verified via isolated `tsc --noEmit` (stubbed external packages) across
every file this phase touched, which is clean.

## 2026-09-22 (later) — Fix: sent love letters didn't reliably appear in chat

Root cause: `handleSendLoveLetter` in `Chat.tsx` was the one remaining send
path with **no optimistic local echo** — it closed the dialog and inserted
straight into `messages` via a bare `supabase.from("messages").insert(...)`,
with zero local state update. Every other send path (`handleSend` for text,
`attemptSendMedia`) shows a `pending-…` bubble the instant Send is tapped and
only relies on the realtime channel to *reconcile* it afterward; letters had
no bubble at all, so they were entirely dependent on the `postgres_changes`
INSERT event round-tripping back to the sender's own client. Any latency, or
a missed/delayed event, meant the letter had actually sent (row was in the
table) but visibly appeared to do nothing.

Fix: `handleSendLoveLetter` now follows the exact same pattern as
`handleSend` — an optimistic `message_type:"letter"` bubble (`_sendStatus:
"sending"`) is added to `messages` immediately, the insert now goes through
the shared `insertMessageIdempotent` (same `client_message_id` scheme
`useChatRealtimeMessages`'s dedup already understands), and the bubble is
swapped for the canonical row in place on success or marked `"failed"` (using
the same generic `MessageStatus`/`isFailed` UI every other bubble type
already has) on any failure — instead of the letter silently vanishing with
only a toast. NOT verified against a live Supabase project in this sandbox
(no network) — reviewed by hand against `attemptSendText`'s established
pattern; parses clean under `typescript`'s own parser (no bundler/vitest
available here to run a full build).

## 2026-09-22 — Love Letter: real envelope open/close animation

New `components/chat/Envelope.tsx` (shared, controlled: flapOpen /
letterLift / showSeal props — a 3D-flap pocket envelope with a wax seal,
used by both surfaces below) and `components/chat/LetterReader.tsx` (tap a
letter bubble → envelope appears sealed → seal breaks, flap opens, letter
slides out → expands into a full readable letter card; closing reverses the
same sequence before unmounting). `LoveLetter.tsx` composer now plays the
same envelope shut/sealed on Send before the message actually goes out.
Both respect `prefers-reduced-motion` (snap straight to end state).

New `lib/letter.ts`: single source of truth for the `💌 **subject**\n\nbody`
wire format (`buildLetterContent` / `parseLetterContent`), replacing the
inline template literal in `Chat.tsx` and the manual `split("\n")` render in
`MessageBubble.tsx`. Wire format on the wire (and in the DB / encryption) is
unchanged, so existing letters still parse and render correctly. New
`src/test/letter.test.ts` covers round-tripping and the old composer's
literal default-subject string.
NOT verified: no npm/build/vitest run in this sandbox (no network access to
install dependencies) — reviewed by hand (brace/paren balance, prop
threading) instead. Run `npm run verify:lock && npm run build` and
`npm test` before shipping.

## 2026-09-21 (later still) — Gallery, Us (+Memories), Shayari offline

New `lib/localDb/collectionStore.ts` + `idbCollectionBackend.ts`, `lib/screenCache.ts`;
`screenData` switch added to Offline & storage; `gallery` and `memories` buckets
now local-first in `signedStorageUrl.ts`. Fixed empty-on-error in Gallery/albums,
0-streak-on-error in Us, favourite flip on failure in Shayari. Data classification:
per-screen snapshots (COUPLE / PRIVATE) now stored encrypted on-device.

## 2026-09-21 (later) — Settings offline pass

Sign-out no longer depends on the network for identity and no longer wipes before
the session is gone; Settings hub / Profile / Partner screens no longer read a
failed load as "not linked"; server-only actions guarded with `requireOnline`;
couple-theme share deferred until online; new "Offline & storage" card
(Data & Backup). New: `lib/settingsCache.ts`, `lib/offlineGuard.ts`,
`lib/offlineSettings.ts`, `components/settings/OfflineStorageCard.tsx`. Merged
onto the v3.11.1 snapshot (notification-sound sync kept as the user's version).

## 2026-09-21 — Vanish Mode: unseen messages survive, media really deleted

Root causes: (1) `Chat.tsx` fetchMessages filtered rows with
`new Date(disappear_at) > now`; for the sentinel `"vanish"` that is an Invalid
Date, so every vanish message was dropped from every fetch (anyone not in the
chat with a live realtime socket never saw it); (2) turning Vanish Mode off
hard-deleted every vanish row in both directions, seen or not; (3) media files
were never removed from storage (storage RLS only lets an uploader delete their
own files) and were also cached on-device by `mediaCache.ts`.

Changes: new sentinel `vanish_after_seen` (unseen messages are kept, deleted
once read + chat left); `lib/vanishPlan.ts` (pure rules, tested in
`src/test/vanishPlan.test.ts`), `lib/vanishPurge.ts` (server call + client
fallback), `lib/vanishMedia.ts`; `mediaCache.ts` ephemeral registry +
`deleteLocalMedia`; DELETE handler in `useChatRealtimeMessages.ts` wipes local
media; vanish messages only marked read while the page is visible; cloud backup
skips vanish rows. New edge function `purge-vanish-messages` and migration
`20260921120000_vanish_after_seen.sql` (sweep now CASE-guards the timestamptz
cast). Deploy the migration and the function before shipping the client.
NOT verified: no build / vitest / device / live-DB run in the authoring sandbox
(only the pure planner was executed).

## 2026-09-21 — Notification sounds: selection fixed, applied everywhere, 16 new sounds (v3.11.0 → 3.11.1)

See `docs/NOTIFICATION_SOUNDS.md` (root causes, changes, deploy order, what is
NOT verified). Local-first pref store + sync hook, picker rewrite (never locked),
chosen sounds now played in-app (chat ping, incoming-call ring), 12+12 catalog
with 16 new synthesized sounds in 3 formats, migration relaxing the id CHECKs to
a shape check, Android silent call-visual channel + non-alerting group summary,
`isIncomingRinging` plugin method, parity test `notificationSoundCatalog.test.ts`.
Apply the migration before shipping the client.

## 2026-09-21 — Offline-first launch, message store, media cache, outbox

See `docs/OFFLINE_FIRST.md` (root causes, changes, privacy trade-offs, what is
NOT verified). New: `lib/connectivity.ts`, `lib/persistedSession.ts`,
`lib/mediaCache.ts`, `lib/localDb/*`; rewritten `lib/chatCache.ts`; changed
`AuthContext`, `useE2E`, `useSessionGuard`, `useCallHistory`, `Chat.tsx`,
`signedStorageUrl.ts`, `client.ts` (offline fast-fail + REST read timeout),
`secureStorage.ts` (exported, memoised master key), sign-out/unlink wipes.
Data classification updated (history + media now on-device).

## 2026-09-16 — Stabilization pass (partial, scoped)

Ran against the uploaded snapshot (`Helllloo-updated.zip`), no network/DB/
device access available in this sandbox.

### Done

- Full repository inventory (667 files) and mtime-based delta against the
  prior baseline snapshot, to identify what had changed since the last
  stabilization pass without inventing history.
- Read `docs/PHASE_PRE_IMPLEMENTATION_STABILIZATION_FINAL_REPORT.md` and
  `docs/PHASE_4_SECURITY_AUDIT.md` (most recently modified audit docs)
  in full before writing anything new, to avoid contradicting or
  duplicating already-honest prior findings.
- Attempted `npm ci` — confirmed BLOCKED BY ENVIRONMENT (403 from the
  package registry; no network egress in this sandbox).
- Heuristic secrets scan (`src/`, `supabase/`, `native-plugins/`): no
  hardcoded API keys/passwords/tokens found. Confirmed the one
  `service_role` string match is a comment, not a leaked value.
- Checked `dangerouslySetInnerHTML`/`eval` usage: one instance, shadcn's
  `chart.tsx`, CSS-variable injection only — not an issue.
- Created `.ai/` (did not exist in any prior snapshot despite being
  referenced by `README.md` and the prior final report) with
  `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `NEXT_PHASE.md`,
  `IMPLEMENTATION_RULES.md`, `DO_NOT_CHANGE.md`, `NATIVE_PROJECTS.md`,
  this file.
- Fixed one of the explicitly-still-open findings from
  `docs/PHASE_4_SECURITY_AUDIT.md` (P1-3's secondary note): invite-link
  code generation in `src/pages/settings/PartnerSettings.tsx` switched
  from `Math.random().toString(36)` to `crypto.getRandomValues` over a
  32-symbol unambiguous alphabet (~40 bits of entropy per 8-char code).
  Code change only — no migration needed, `invite_links.code` was already
  a plain text column. NOT TESTABLE live (no DB access), reviewed by hand
  against the one call site.

### Explicitly not done this pass (see `.ai/NEXT_PHASE.md` for the queue)

- `partner_requests` UPDATE policy `WITH CHECK` gap — needs a trigger
  (same pattern as `call_history_transition_guard`), left for a session
  with the ability to test it, since it's schema-level and this pass
  didn't have DB access to verify a trigger's behavior.
- Attachments/backups MIME allowlist, Realtime channel audit, full
  edge-function audit, push-token RLS review, exhaustive docs-vs-source
  discrepancy matrix (50 files in `docs/`, only spot-checked).
- No build/lint/typecheck/test run (BLOCKED BY ENVIRONMENT, see above).
- No live Supabase or real-device verification of anything, this pass or
  any prior one recorded in this repo.

### Production readiness

Unchanged from the prior pass's own verdict: **NOT READY**. This pass
closed one small, low-severity, previously-flagged gap and added the
missing `.ai/` context layer; it did not change the security posture
enough to revisit that verdict, and did not re-run enough of the checklist
to justify doing so either way.

## 2026-09-16 — Scientific + Product Specification phase

Ran against the same snapshot as the stabilization pass above, same
sandbox (no network for code/build, but web search available for
research this time).

### Done

- Researched and cited real scientific literature for the core
  relationship-science, deception-detection, and emotion-recognition
  claims this phase depends on (Reis et al. on perceived partner
  responsiveness; Gottman's Four Horsemen, including the contested
  "90%+ divorce prediction accuracy" statistic; Bond & DePaulo 2006 on
  human lie-detection accuracy (~54%, near chance); Barrett et al. 2019
  on the unreliability of facial-expression-to-emotion inference; Finkel
  et al. 2012 on the lack of evidence for compatibility-matching
  algorithms, with the nuance that DuoSpace's already-paired-couple case
  differs from that critique's target but doesn't escape its deeper
  lesson).
- Researched EU AI Act Article 5(1)(f) (emotion recognition), GDPR
  biometric special-category treatment, India's DPDP Act 2023 + 2025
  Rules, and Kyrgyzstan's Law on Personal Data — flagged Kyrgyzstan as
  the weakest-covered jurisdiction and recommended local counsel there
  specifically. All regulatory content marked explicitly as not legal
  advice.
- Wrote `docs/DUOSPACE_SCIENTIFIC_PRODUCT_SPECIFICATION_FINAL_REPORT.md`
  and 19 new `.ai/*.md` spec files (scientific foundation, relationship
  science, compatibility/values/expectations/conflict-repair/trust/mood
  specs, multimodal AI spec, local AI architecture, AI output contract,
  consent model, relationship memory spec, relationship health spec,
  DuoAutoAnswer spec, calling latency spec, competitive analysis,
  regulatory review, future roadmap, do-not-build list).
- Updated `.ai/NEXT_PHASE.md` to point at Phase B (data/consent
  architecture), gated on closing the still-open security queue from the
  prior pass first.
- No code was changed. No frozen feature was implemented.

### Explicitly not done this pass

- No real-numbers calling-latency measurement (needs a live build/device,
  see `.ai/CALLING_LATENCY_SPEC.md`).
- No exhaustive per-dimension field definitions for every compatibility/
  values/expectations dimension — the structure and rules are specified,
  individual dimension write-ups are left for Phase F.
- No re-audit of existing mood/lip-reading/face-detection code
  (`MoodDetector`, `useLipReading`, `PeekGuard`, etc.) against the new
  specs — flagged as a to-do in `.ai/MOOD_SPEC.md` and
  `.ai/LOCAL_AI_ARCHITECTURE.md` rather than assumed compliant.
- No user research, no A/B data, no IRB-reviewed study — this is a
  literature synthesis and product specification, not primary research.

## 2026-09-16 — Security queue item 1: partner_requests transition guard

Closed the first item on the security queue blocking Phase B
(`.ai/NEXT_PHASE.md`).

### Done

- Added a `BEFORE UPDATE` trigger on `partner_requests`
  (`supabase/migrations/20260916120000_partner_requests_transition_guard.sql`)
  freezing `sender_id`/`receiver_id` and restricting UPDATEs to the one
  real `pending → accepted` transition — same pattern as the existing
  `call_history_transition_guard`.
- While tracing the exploit this closes, found `accept_partner_request`
  was also missing the already-partnered guard its sibling
  `accept_invite` has — fixed in the same migration (same function,
  same exploit chain).
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (table row + Remaining Risks
  list + new §15 addendum) and `.ai/CURRENT_STATE.md` to reflect the fix
  rather than leaving stale "flagged, not fixed" language in place.
- Removed the item from `.ai/NEXT_PHASE.md`'s blocking queue.

### Not done

- Live/DB verification (still no DB access in this sandbox — same
  BLOCKED BY ENVIRONMENT as every prior pass). Verified by hand against
  every `partner_requests` call site instead.
- The rest of the security queue (MIME allowlist, Realtime auth audit,
  full edge-function audit, push-token RLS, docs-vs-source matrix) —
  next up, per `.ai/NEXT_PHASE.md`.

## 2026-09-16 — Security queue item 2: finalize-upload bucket allowlist (found a bigger bug than expected)

Set out to do the queued "MIME allowlist for attachments/backups" task
and found the allowlist itself was wrong in a way that mattered much more.

### Done

- Discovered `finalize-upload`'s bucket allowlist (`avatars`/`attachments`/
  `backups`, added 2026-09-10) doesn't match the buckets the app's real
  upload code uses. The only two callers of `resumableUpload()` anywhere
  in `src/` (`Chat.tsx`, `Gallery.tsx`) pass `"chat-files"` / `"gallery"`
  — neither bucket was in the allowlist, so every chat attachment and
  gallery upload would be rejected at finalize with `Unknown bucket`.
  There's no size-based bypass; every upload goes through this path.
- Fixed `supabase/functions/finalize-upload/index.ts`'s `ALLOWED_BUCKETS`
  to include the real buckets: `chat-files` (50MB, matching `Chat.tsx`'s
  own existing client-side cap) and `gallery` (500MB — a judgment-call
  ceiling, flagged as such; no client-side cap exists to match against).
  Kept the original `avatars`/`attachments`/`backups` entries rather than
  deleting them (no dependency analysis done on whether anything else
  relies on them).
- Added a MIME allowlist for `gallery` (`image/`, `video/` — matches its
  file-picker's own `accept` attribute). Deliberately left `chat-files`
  unrestricted — its file picker has no `accept` attribute at all by
  product design (users can send any file type).
- Fixed the MIME-check logic itself: it compared by exact string equality
  despite the field being named `allowedMimePrefixes` — switched to real
  `startsWith` prefix matching (kept `avatars`' list as exact strings,
  which still works correctly under prefix matching).
- Flagged `scripts/sql/storage_buckets.sql` as stale in its own header
  (it describes a bucket set that doesn't match reality) rather than
  deleting it.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (P1-6 entry + new §16
  addendum), `.ai/CURRENT_STATE.md`, and `.ai/NEXT_PHASE.md`.

### Not done

- Live/Storage verification — no DB or Storage access in this sandbox,
  same as every prior pass. The 500MB gallery ceiling and the "no MIME
  restriction on chat-files" choice are both judgment calls grounded in
  what the client code actually does, not confirmed against a live
  upload.
- Did not investigate whether `attachments` is used anywhere outside
  `src/` (edge functions, native plugins) before leaving it in the
  allowlist — flagged, not resolved.

## 2026-09-16 — Security queue: Realtime channel authorization

Closed the next queue item. Started from a snapshot missing the
scientific-spec `.ai/` files and final report (noted at the top of
`.ai/NEXT_PHASE.md` — same "session got the narrative but not all the
artifacts" pattern documented in `docs/PHASE_4_SECURITY_AUDIT.md` §17,
this time affecting the scientific-spec phase's output instead of the
partner_requests migration).

### Done

- Found: broadcast/presence Realtime channels (unlike postgres_changes
  channels, which are RLS-gated automatically) had no server-side
  authorization at all — this project never configured Realtime
  Authorization (RLS on `realtime.messages` + `private: true`), so every
  broadcast/presence channel was fully public by default.
- Three channels (`typing-<pair>`, `presence-<pair>`,
  `groic:<uid1>:<uid2>`) embed both partners' UUIDs in the topic name —
  exploitable by anyone who already knows both IDs, which includes an
  **ex-partner indefinitely** (UUIDs don't rotate on unlink) — a real
  surveillance-adjacent risk specific to this product.
- `blend-sync` was worse: one single, unscoped, global channel name for
  every active blend session app-wide — any authenticated client could
  observe or inject spoofed events into any other couple's session.
- Fixed via `supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql`
  (RLS on `realtime.messages`, keyed to the caller's *current*
  `partner_id` — not just any two UUIDs) plus client changes to
  `useChatTyping.ts`, `useChatPresence.ts`, `GroicContext.tsx` (x2
  channels), and `Playlist.tsx` — all four now use a colon-delimited
  `<prefix>:<uid1>:<uid2>` topic (unambiguous to parse, unlike the old
  hyphen-joined format) and `private: true`.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (§18 addendum + Remaining Risks
  line), `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`.

### Flagged, not done (can't be done from code)

- Disabling "Allow public access" under Supabase Realtime Settings — a
  dashboard-only project setting. The migration + client changes are
  inert without it. This is called out explicitly in §18 rather than
  left implicit — it's the one action item in this whole effort that
  needs Aradhya to do something outside of a code deploy.
- Live/Realtime verification — no DB or dashboard access in this sandbox.

## 2026-09-17 — Phase 1: Privacy, Consent & Local-First Intelligence Foundation

Full report: `docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md`.

### Done

- `src/lib/privacy/`: `dataClassification.ts` (7-tier enum + absolute
  deny rules), `consent.ts` (feature-specific consent, server-of-record,
  fail-closed, cached), `privacyGate.ts` (capability -> deny-rules ->
  consent -> destination pipeline), `redact.ts` (key-pattern + JWT-shape
  log redaction — wired into `telemetry.ts`'s `formatExtra()`, covering
  both the stored ring-buffer event and the dev-console echo, not left as
  an unused utility), `secureStorage.ts` (software AES-256-GCM local
  storage — explicitly documented as NOT hardware Keystore/Keychain-
  backed, see Known Issues).
- `src/lib/ai/`: `types.ts` (`AIInsight` contract), `outputValidator.ts`
  (structural + prohibited-phrase + per-source-confidence-ceiling
  validation), `localProcessor.ts` (`LocalAIProcessor` interface +
  `runLocalProcessor()` wrapper that runs the privacy gate and the
  validator automatically).
- `supabase/migrations/20260917100000_privacy_consent_ai_foundation.sql`:
  `user_consents` + `ai_insights` tables, 7 RLS policies, 3 triggers
  (`touch_user_consents_updated_at`, `enforce_ai_insight_consent` —
  DB-layer consent verification at insert time, `enforce_ai_insight_immutability`
  — only lifecycle/correction/sharing fields may change post-creation).
- `src/pages/settings/PrivacyAISettings.tsx` + routing in `App.tsx` +
  entry in `Settings.tsx`'s list — one new page, existing components/
  tokens only, no redesign.
- 4 new test suites: `outputValidator.test.ts`, `redact.test.ts`,
  `privacyGate.test.ts`, `secureStorageCrypto.test.ts`. Written and
  reasoned through carefully; NOT executable in this sandbox (`npm ci`
  still 403s — confirmed again this pass).
- Found and fixed two small real gaps while implementing this phase:
  `signOutAndClearPushTokens()` in `Settings.tsx` now also calls
  `clearConsentCache()` and `secureWipeAll(user.id)` — previously neither
  existed to call, but leaving them unwired once they did exist would
  have been its own small bug.
- Restored 13 `.ai/` files this phase directly needed
  (`DATA_CLASSIFICATION.md`, `CONSENT_MODEL.md`, `PRIVACY_MODEL.md`,
  `SECURITY_MODEL.md`, `ARCHITECTURE.md`, `AI_SAFETY_SPEC.md`,
  `LOCAL_AI_ARCHITECTURE.md`, `AI_OUTPUT_CONTRACT.md`,
  `RELATIONSHIP_MEMORY_SPEC.md`, `TEST_STATUS.md`, `KNOWN_ISSUES.md`,
  `DECISIONS.md`, `PHASE_STATUS.md`) after finding only 3 `.ai/` files
  existed in this phase's starting snapshot (`KNOWN_ISSUES.md` KI-01).

### Explicitly not done

- No relationship-AI feature — out of scope for this phase by design.
- Hardware-backed (Keystore/Keychain) secure storage — needs native
  development + a physical device, neither available here (KI-02).
- `secureStorage.ts`'s IndexedDB-dependent integration path untested —
  jsdom doesn't implement IndexedDB; the crypto primitive is tested
  directly instead, honestly scoped in the test file's own header (KI-03).
- Live verification of the new migration/triggers/RLS — no DB access.
- `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`,
  `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, and the 19 scientific-spec
  files were NOT recreated this pass (out of scope for this phase's own
  work, and expensive to re-derive from memory again) — flagged in
  `.ai/NEXT_PHASE.md` for Phase 2 to actually resolve at the source
  (fix the export pipeline) rather than paper over again.

## 2026-09-18 — Security queue: push-token / device-table RLS review

Closed the last remaining specifically-named item on the security queue.

### Done

- Reviewed `public.push_tokens` and `public.known_devices` in full.
  **Both clean — no fix needed.** Neither table grants `authenticated`
  clients INSERT or UPDATE at all (only SELECT/DELETE of their own
  rows), removing an entire class of potential bugs by design; the only
  write path for either is a SECURITY DEFINER trigger or an already-
  audited service-role edge function, both correctly scoped to the
  acting user's own `auth.uid()`.
- Noted one minor, low-priority observation (not fixed): `push_tokens`'
  `ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id` would
  reassign a token row's ownership if a different user ever submitted
  the same literal token value — but exploiting that requires already
  possessing another user's live device push token, a meaningfully
  higher bar than anything else found in this audit, and not something
  the database layer alone can fully close (no token-attestation
  mechanism FCM/APNs commonly exposes to app backends).
- Also spot-checked `_shared/fcm.ts`/`_shared/apns.ts` logging — tokens
  are already truncated before being logged, no raw-token leak found.
- Updated `docs/PHASE_4_SECURITY_AUDIT.md` (§20 addendum),
  `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`. Also corrected a stale
  line in `.ai/CURRENT_STATE.md` that still listed the full
  edge-function audit as "remaining" despite it having been completed
  (§19) in an earlier session whose docs update didn't fully carry
  forward into that specific line.

### Remaining on the queue

Encryption lifecycle threat model, session/clock-skew handling, a
general telemetry review beyond Phase 1's client-side redaction pass,
TypeScript `any`/unsafe-cast audit, and the docs-vs-source discrepancy
matrix. Live/DB verification remains blocked in every sandbox this
project has run in.

## 2026-09-19 — Phase 1.5: Production Verification

Full report: `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md`.

### Done

- **New P0 found**: `package.json` declares `livekit-client: ^2.7.0`;
  `package-lock.json` has zero references to it anywhere — confirmed by
  direct grep and corroborated by `npm ci`'s own request order. Not
  hand-fixed (would mean fabricating lockfile entries, explicitly
  against this pass's own instruction) — documented with the exact real
  fix (`npm install`, run somewhere with registry access) instead.
- **New integration gap found**: re-checked the four pre-existing
  mood/face features against the Phase 1 privacy system for the first
  time (genuinely not done before) — none of them call
  `privacyGate`/`consent` at all, so the corresponding new settings
  toggles don't actually control them yet. Flagged, not fixed (needs its
  own careful pass, not a drive-by edit to shipped features).
- Restored 6 governance `.ai/` files from real prior-session content:
  `PROJECT_CONTEXT.md`, `DO_NOT_CHANGE.md`, `IMPLEMENTATION_RULES.md`,
  `NATIVE_PROJECTS.md`, `DO_NOT_BUILD.md`, `FUTURE_ROADMAP.md`.
- TypeScript safety sampled (183 `any`/`as any` occurrences) — majority
  traced to one systemic, already-documented cause (broken generated
  Supabase types), judged JUSTIFIED as a class rather than exhaustively
  classified one-by-one; 3 redundant casts in `consent.ts` removed as a
  real, trivial fix; one low-severity, unrelated observation noted in
  `MinimizedCallBubble.tsx` (client-supplied call duration), not fixed.
- Confirmed `npm ci` still BLOCKED BY ENVIRONMENT (ran it again, same
  403 — this time on `livekit-client` specifically, which is itself
  informative, see the P0 finding above).
- Re-confirmed (hand-verification, not live testing) that Realtime
  authorization ties to current `partner_id`, the privacy gate's
  fail-closed behavior, and secure storage's honest non-hardware-backed
  documentation — all still accurate.
- Wrote `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md` with
  the full Production Readiness Matrix (A–G) and 20-question Final Gate,
  every answer backed by an explicit PASS/FAIL/BLOCKED/NOT VERIFIED
  status and, where relevant, the exact external verification procedure
  needed.
- Updated `.ai/CURRENT_STATE.md`, `.ai/PHASE_STATUS.md`,
  `.ai/KNOWN_ISSUES.md` (KI-07, KI-08, KI-09 added; KI-01 updated),
  `.ai/TEST_STATUS.md`, `.ai/NEXT_PHASE.md`.

### Explicitly not done

- No live build/lint/test/RLS-attack/device verification — same
  environment constraints as every prior pass, confirmed again rather
  than assumed.
- No calling-latency instrumentation or measurement — would need a live
  app.
- No chat-reliability live reconnect/retry testing.
- 19 scientific-spec files + their final report not restored (out of
  scope for this specific verification pass).
- No consent/insight export implementation (judged optional per the
  brief's own phrasing, deferred to Phase 2 or a dedicated pass).

### Final status

**NOT READY.** Closer in two concretely-documented ways than before this
pass; the standing blocker (nothing in this project has ever actually
been executed in any sandbox) is unchanged.

## 2026-09-19 — Launch-flow fixes + Chat/Calls skeletons

Scope: four user-reported issues on the APK. No network/`npm ci`/device
access in this sandbox — see "Not verified".

### Changed

- **"Location access required" flashing on launch** —
  `src/components/LocationAccessGate.tsx`. `useLiveLocation`'s permission
  state starts at `"unknown"` (async native check) and the gate treated
  anything but `"granted"` as blocked, so it rendered the full-screen
  requirement for the duration of that check even with permission already
  granted. `"unknown"` is now a distinct checking state that never shows the
  requirement screen: known-granted devices (flag `duo-location-permission-granted`,
  written only on a confirmed `granted`, cleared on confirmed `denied`/`prompt`)
  render the app immediately; first-ever launch shows a blank themed surface;
  a 4s timeout falls back to the normal gate. `denied`/`prompt` still hard-block —
  the mandatory-location decision is unchanged.
- **"Setting up..." on every launch** — `src/App.tsx` (`ProtectedRoutes`).
  The profile/onboarding check gated the whole app on a network round trip
  every launch. Confirmed onboarding is now remembered per user
  (`duo-onboarded-<userId>`); the check still runs in the background and
  overrides the cache if the server says otherwise. A request *error* is no
  longer read as "not onboarded" when the account is already known-onboarded.
- **Chat skeleton** — new `src/components/skeletons/MessageListSkeleton.tsx`
  replaces the "Loading messages…" text in `MessageTimeline.tsx`. Also
  `Chat.tsx`: a resolved "no partner linked" state now clears
  `messagesLoading` (it previously stayed true forever, which was invisible
  behind the text and would have been an endless skeleton).
- **Calls skeleton + instant paint** — new
  `src/components/skeletons/CallHistorySkeleton.tsx`; `Calls.tsx` gets
  `historyLoading` so "No calls yet" no longer flashes before data arrives.
  New `src/lib/callHistoryCache.ts` persists the last call list (metadata
  only, `room_name` dropped) via `secureStorage` (AES-GCM, per-user, removed
  by `secureWipeAll` on sign-out) and paints it immediately on launch while
  the normal fetch refreshes it.

### Deliberately NOT done

- Chat messages are still NOT persisted across launches. `Chat.tsx`'s
  `messageCache` is memory-only by design (decrypted E2E plaintext); this
  change does not alter that. Chat shows the skeleton on a cold launch.
- The ~0.3s branded hand-off `SplashScreen` (once per cold start) is
  unchanged.

### Not verified

- `npm run build`, `npm test`, lint and any on-device behavior were NOT run
  (no dependencies installable here). Edited files were only syntax-checked
  with the TypeScript transpiler. No new automated tests were added.

## 2026-09-19 (later) — Round 2: launch loading, "Setting up...", notifications

Input: `duospace-redesign-final-2-updated.zip` (round-1 fixes + a separate
edit to `MediaPlaybackService.kt`, left as-is). No `npm ci`/Android SDK/device
in this sandbox — see "Not verified".

### Why round 1 didn't fully work

- **"Setting up..." still shown**: the remembered flag only exists after one
  successful check on this install, so the first launch after updating, cleared
  WebView storage, or any launch where the profile request timed out (8s) still
  blocked. Fix (`src/App.tsx`): accounts older than 24h are treated as
  onboarded immediately; the background check still corrects it.
- **Visible "scrolling" load in Chat**: two causes. (1) `Chat.tsx`'s cold-start
  jump was marked done on call-history rows alone (they arrive before messages,
  which wait on E2E + decrypt), so the messages that followed got a *smooth*
  scroll. Now the first jump waits for `messagesLoading === false`, and every
  scroll within `SETTLE_WINDOW_MS` (2.5s) of it is instant. (2) Nothing was
  persisted, so every cold launch showed skeleton -> messages. Added
  `src/lib/chatCache.ts` (see below). Calls rows also lost their per-row
  stagger delay (`CallHistoryRow.tsx`).

### Chat cache — deliberate privacy exception (owner's request)

`src/lib/chatCache.ts` persists the latest 60 decrypted messages through
secureStorage (AES-GCM at rest, per-user key destroyed by `secureWipeAll` on
sign-out). Never persisted: any message with `disappear_at`, optimistic/failed
bubbles, local blob previews. `PERSIST_CHAT_CACHE = false` disables it entirely.
This is the first place decrypted E2E plaintext touches disk; the key lives in
IndexedDB on the same device (software AES, not hardware-backed — see
secureStorage.ts). Transport E2E is unchanged.

### Notifications

- **Location notification removed (Android)**: `DuoSpaceLocationService` no
  longer calls `startForeground()` (it was the always-on "DuoSpace" entry with
  no text, and re-appeared briefly on every push via ACTION_ONE_SHOT). Callers
  (`CallNotificationService`, `BackgroundGeolocationPlugin`) now use
  `startService`. Cost: background location is best-effort — see
  `docs/BACKGROUND_LOCATION_NATIVE.md`. The legacy channel is deleted on start.
- **Blank notifications**: `DuoSpaceMessagingService` no longer posts a
  notification when the push has no body.

### Not verified

- Kotlin was NOT compiled; nothing was run on a device. JS/TS was only
  syntax-checked. Build (`npm run build`), tests and lint were not run. No new
  tests added.
- `MediaPlaybackService.kt` still contains temporary diagnostic `Toast`s
  ("notification posted OK ...") from the uploaded snapshot; not touched.

## 2026-09-20 — E2E fix: messages undecryptable across platforms for the same account

User-reported bug, directly diagnosed and fixed (not part of an audit
pass).

### Root cause

`src/hooks/useE2E.ts`'s old `init()` generated a brand-new ECDH keypair
any time a device's local IndexedDB was empty, then unconditionally
overwrote the single `profiles.public_key` column with it. Every new
platform the same account was opened on (APK, website, a second browser)
minted its own keypair and silently invalidated every other already-
signed-in device's ability to decrypt — both going forward (partner
starts encrypting against the newest key) and retroactively (old
messages stay encrypted under whichever key was current when they were
sent).

### Fix

- `supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`:
  new `user_e2e_identity_keys` table, owner-only RLS, one row per
  account.
- `src/hooks/useE2E.ts`: new `resolveAccountIdentityKey()` — checks for
  an existing account-wide key first; if none, adopts this device's
  local key if it has one (or generates fresh if truly first-ever);
  registers it via a race-safe ignore-on-conflict upsert; always
  re-fetches to find the actual winner, even if it wasn't this device's
  candidate. `profiles.public_key` untouched (still partner-visible,
  now actually consistent across devices).
- `src/test/e2eAccountWideKey.test.ts`: 6 tests covering server-has-key /
  local-key-registers-and-wins / local-key-loses-a-race /
  truly-first-run / error propagation. Written, not executable in this
  sandbox (no `npm ci`).
- Updated `.ai/CURRENT_STATE.md`, `.ai/KNOWN_ISSUES.md` (KI-10: the
  accepted security trade-off — private key now syncs via Supabase,
  `service_role`-readable, no longer purely device-local; KI-11: one
  extra lightweight Supabase round-trip per app launch, low priority).

### Honest trade-off, stated directly to Aradhya as well as in the docs

Private keys used to never leave the device (stronger against a
compromised Supabase project). Making cross-device sync actually work
without new user-facing recovery-passphrase UX means giving that up —
`service_role` can now read the table. This was the pragmatic, correctly
-scoped fix for what was asked; a passphrase-wrapped stronger version is
possible later if wanted, flagged as a real option, not silently assumed
unwanted.

### Not done

- No retroactive recovery of messages already orphaned by pre-existing
  key mismatches across devices — not possible without a device's
  original local key material, which may no longer exist anywhere.
- No live testing (no DB access, as always).
- No local-first fast-path optimization for the new extra round-trip
  (KI-11).

## 2026-09-20 — Merge of duospace-redesign-final-3 + duospace-e2e-cross-platform-fix; Map "Location timed out" fix

### Merge

Compared the two uploaded snapshots file by file (`diff -r`, excluding
`node_modules`). `duospace-e2e-cross-platform-fix` is a strict superset of
`duospace-redesign-final-3`: every file is byte-identical except
`.ai/CHANGELOG.md`, `.ai/CURRENT_STATE.md`, `.ai/KNOWN_ISSUES.md`,
`src/hooks/useE2E.ts` (each of which only *adds* the E2E account-wide-key
work on top of the redesign version), plus two files that exist only in the
E2E snapshot (`src/test/e2eAccountWideKey.test.ts`,
`supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql`).
The redesign snapshot contributes nothing the E2E snapshot lacks, so the
merged tree is the E2E snapshot as the base — no conflicts to resolve, no
hunks dropped. The location fix below is layered on top.

### Bug: Map screen showed "Location Access Required / Location timed out. / Request Permission"

Three separate problems combined:

1. **Wrong screen for a non-permission error.** `MapView.tsx` showed its
   blocking permission screen whenever `locationError` was *any* string —
   including a plain GPS timeout on a device where permission was already
   granted. `Request Permission` cannot fix a timeout.
2. **The button was a no-op on web.** `useLiveLocation.retryPermission()`
   called `navigator.geolocation.getCurrentPosition(() => {}, () => {}, …)`
   — a successful fix was discarded and the error never cleared, so the
   screen stayed up forever.
3. **Timeouts were reported but never recovered from.** The 20s/30s
   per-fix budget is short for a cold GPS start indoors or desktop Wi-Fi
   positioning, and after a timeout nothing tried a cheaper position source
   or restarted a wedged watcher.

Also found: the native error normaliser mapped "Location services are not
enabled" (GPS toggle off) to a *timeout* — it only matched "unavailable"/
"disabled".

### Fix

- `src/lib/locationErrors.ts` (new, import-free): `LocationErrorKind`
  (`denied | unavailable | timeout`), `normalizeNativeGeoError`,
  `describeGeoError`. Unrecognised native messages fall back to `timeout`,
  never `denied`. "Services not enabled" now maps to `unavailable`.
- `src/hooks/useLiveLocation.ts`: exposes `errorKind`; timeouts never touch
  `permission`; HIGH/ECO timeouts raised to 30s/45s; new one-shot coarse
  `fallbackFix()` (fed through the normal `onPos` noise gates) fired on a
  timeout; after 3 consecutive timeouts the watcher is restarted in
  low-accuracy mode; `retryPermission()` now clears the stale error,
  restarts the watcher and takes a fallback fix on both platforms.
- `src/contexts/LocationContext.tsx`: exposes `myLocationErrorKind`.
- `src/pages/MapView.tsx`: the blocking "Location Access Required" screen
  now shows only for a real denial (`permission === "denied"` or
  `errorKind === "denied"`). While there is no fix yet, a timeout/unavailable
  shows the pulsing "Still looking for your location…" overlay with a
  **Try again** button (and a services-off hint). Once any fix exists, later
  timeouts no longer cover the map at all.
- `src/test/locationErrors.test.ts`: new.
- Unchanged on purpose: `LocationAccessGate` (mandatory-location product
  decision), the noise gates, write throttling, the offline queue, the
  background-geolocation layer.

### Verification status (honest)

- `locationErrors.ts` compiled under `tsc --strict` and its assertions were
  executed in plain Node: PASS (the vitest file itself was NOT run — no
  `npm ci` here).
- `useLiveLocation.ts` type-checked clean against minimal hand-written
  stubs for react/@capacitor/supabase; `MapView.tsx` and
  `LocationContext.tsx` were only syntax-checked. NOT a full project build.
- NOT VERIFIED on a device or browser: real timeout recovery, the fallback
  fix, the watcher restart, and the exact wording of native plugin errors
  ("services not enabled" matching is best-effort against the plugin's
  messages, not a documented contract).

## 2026-09-20 (later) — Blank "DuoSpace" notification hardening; location-on-push verification

### Blank notification on app open

Screenshot: a notification headed "DuoSpace" with no text. No code path in this
snapshot that runs at app launch posts one except the Media3 automatic
notification path, so the source could NOT be identified with certainty
without a device. Known historical source: the old `DuoSpaceLocationService`
foreground notification (already removed 2026-09-19; `LocationContext` starts
that service on every app open, which matches "every time I open the app" —
an APK built before that change would still show it).

Defense in depth, so the media services can never produce one:
- `MediaPlaybackService.onUpdateNotification()` is now a no-op. This service
  has always posted its own notification; nothing had actually disabled
  Media3's automatic one, which is built from player metadata (blank title =
  bare "DuoSpace").
- `WebKeepAliveService.onUpdateNotification()` holds back the automatic
  notification until JS has supplied a real track title (`MirrorPlayer`'s
  placeholder title is literally "DuoSpace").
To identify a persisting one: long-press it -> Notification settings shows the
channel name; or `adb shell dumpsys notification --noredact | grep -A25 com.duospace.app`.

### Location on message / call arrival

Traced end to end; findings are KI-12 (three gaps, none run on a device).
Code changes: `DuoSpaceLocationService.requestFixForPush()` (shared, 15s
debounce, skips "typing" pushes) now called from BOTH `CallNotificationService`
and `DuoSpaceMessagingService`. Previously only the former triggered a fix and
it fired for every push including typing indicators.

### Not verified
- Kotlin NOT compiled; nothing run on a device (same as every native change here).
- `onUpdateNotification` override signature written against Media3 1.4.1 from
  memory of its API — a compile error there is possible; both overrides are
  small and self-contained if they need adjusting.

## 2026-09-19 (this session) — "Securing connection…" on text send; block screenshots + screen recording on Android

Input: `duospace-merged.zip`. Reports: after tapping send, only "Securing
connection… Please wait a moment." appears and the text never goes; and "no
screenshot or screen recording should be available on apk".

### 1. "Securing connection…" — WHY
`Chat.handleSend` refused to send unless `useE2E().ready` (own key AND partner
public key). `ready` never became true when key init kept failing: the
2026-09-20 account-wide-key change made `init()` depend on the new
`user_e2e_identity_keys` table, and `init()` retried on EVERY error. If
`20260920100000_e2e_account_wide_identity_key.sql` had not been applied to the
Supabase project (table missing -> PostgREST 404 / PGRST205), it retried
forever, `myKeys` stayed null, and the only visible symptom was that toast.
Secondary contributors found on the way: `profiles.update({public_key})`
errors were never checked (the partner could be left with no key to encrypt to,
silently), and a slow key exchange made the user re-tap with no bubble shown.
This is the most likely cause from reading the code; it could NOT be confirmed
against the live project (no DB access) — see "Not verified".

### WHAT (files)
- `src/hooks/useE2E.ts`: new `isSyncTableUnavailable()` +
  `resolveIdentityKeyWithFallback()`. Missing/unreadable sync table -> use this
  device's local key (or mint one) instead of retrying forever; transient errors
  still retry (capped backoff 15s -> 5s). Own keys are set as soon as they
  resolve; publishing the public key is a separate, retried, error-checked
  best-effort step. Partner-key query errors are now logged once. Hook also
  returns `hasOwnKeys` / `hasPartnerKey`.
- `src/pages/Chat.tsx`: removed the hard stop in `handleSend`. The optimistic
  bubble appears immediately; `attemptSendText` waits up to 12s for the key
  exchange (via refs, so it never uses a stale `encrypt`), then encrypts. If
  still not ready the bubble is marked failed (tap to retry) with a reason
  ("Your partner needs to open DuoSpace once…" vs "Secure setup isn't finished
  yet…"). Text is now NEVER sent as plaintext from this path (previously
  `e2eReady ? encrypt(text) : text`, reachable via the pending-text replay on
  mount and tap-to-retry). Edit-message path gets the same guard.
- `src/test/e2eAccountWideKey.test.ts`: tests for the two new functions.

### 2. Screenshots + screen recording (Android) — WHAT
- `scripts/patch-native-permissions.mjs`: new `patchSecureWindow()` adds
  `FLAG_SECURE` to `MainActivity.onCreate` right after `super.onCreate()`
  (Java and Kotlin variants). Independent of the existing push-additions marker
  so an already-patched MainActivity still gets it. Exits non-zero, loudly, if
  it cannot insert it.
- `scripts/verify-android-build.mjs`: `--native` now fails if MainActivity lacks it.
- `src/components/PeekGuard.tsx`: on Android the privacy-screen plugin is always
  `enable()`d and never `disable()`d (it previously disabled it whenever both
  Privacy and Peek Guard toggles were off, which would have cleared the flag).
  iOS behaviour unchanged.

### RISK
- Fallback key mode: until the migration is applied, cross-device decryption is
  only as good as before the account-wide-key change (device-local keys). The
  fallback saves the local key; once the table exists the next launch registers
  that key as canonical.
- FLAG_SECURE also blanks Recents, Cast/mirroring and third-party screen
  recorders, and blocks the user's own screenshots for bug reports. It cannot
  stop photographing the screen with another device, or rooted/modified devices.
- Still-open plaintext fallbacks with the same `e2eReady ? encrypt : text`
  pattern: scheduled messages and love letters in `Chat.tsx` (not changed).

### TEST / RESULT
- Executed in plain Node against mocks: the fallback logic (12 assertions incl.
  missing table on SELECT and on UPSERT, transient error rethrow): PASS.
- Executed: `patch-native-permissions.mjs` against stub Java and Kotlin
  MainActivity files (fresh, already-patched-by-old-script, idempotent re-run,
  and the no-`super.onCreate` failure case): PASS.
- `node --check` on both scripts; TypeScript syntax-only parse of the touched
  .ts/.tsx: PASS. Type-check, vitest, lint, build, Gradle/APK build: NOT RUN
  (no `npm ci` / network here). The Java/Kotlin insertion was not compiled.
- Real device: NOT VERIFIED (send flow, screenshot block, screen recorder block).

## 2026-09-19 (later) — Supabase migrations applied to the live project

Project `jzlpelxwzjjpddqcrtpu` (Duospace). Diffed repo migrations against the live
schema first (migration names differ from the repo's, so state was probed directly).
Applied, in order: `e2e_account_wide_identity_key` (table was missing — this was the
cause of the "Securing connection…" send failure), `call_history_provider_column`
(columns only; client already writes `provider`), `messages_replica_identity_full`
(client filters DELETE realtime by sender/receiver), `lock_get_partner_daily_key_to_service_role`
(only caller is the edge function via service role), `message_reactions_atomic_upsert`,
`search_users_enumeration_guard` (rate-limit path exercised in a rolled-back test),
`realtime_authorization_couple_channels` (client uses private channels; live had RLS on
with no policies), `privacy_consent_ai_foundation`. Post-apply catalog check: all present.
Held back: see KI-16. Not done: KI-09 dashboard toggle "Allow public access" (manual).
Not verified: end-to-end behaviour from a running app.

## 2026-09-20 (this session) — Merge of 3 uploads + Surprise section rebuild (v3.10.0 → 3.11.0)

### Merge (diffed, not assumed)
Three uploads: `duospace-redesign-final-3.zip` (B), `duospace-e2e-cross-platform-fix.zip` (A),
`duospace-merged-fixed.zip` (C). All three are v3.10.0.
- B ⊂ A: A = B + the E2E cross-platform fix (6 lines replaced in `useE2E.ts`; every other
  difference was added lines: CHANGELOG/CURRENT_STATE/KNOWN_ISSUES entries, the migration,
  the test, hook changes). Nothing in B was missing from A.
- A ⊂ C: C = A + the later sessions' work (location error handling / `locationErrors.ts` +
  its test, `useLiveLocation`, `LocationContext`, `MapView`, `Chat.tsx` send-path wait for
  key exchange, `useE2E` sync-table fallback + `publishPublicKey`, `PeekGuard`, native
  `DuoSpaceLocationService`/`CallNotificationService`/`DuoSpaceMessagingService`/audio-engine
  services, `patch-native-permissions.mjs`, `verify-android-build.mjs`, notes). Lines A had
  that C lacks are only in-place replacements (checked file by file: `CallNotificationService.kt`
  now delegates to `DuoSpaceLocationService.requestFixForPush`; `useE2E` retry cap 15s→5s;
  one SETUP_GUIDE line reworded).
- So **C is the merged baseline**; no file was taken from A or B. None of the 7 surprise files
  this session edited differ between A, B and C, so the surprise work below applies cleanly.

### Surprise section — what was wrong (reproduced in headless Chromium against the OLD code)
1. Creator JS was wrapped in `try { … }` → top-level `const`/`let` block-scoped → `const go = () => …`
   + `onclick="go()"` threw ReferenceError. (Function declarations happened to survive via Annex B.)
2. Creator CSS sat after app rules in one `<style>` → a leading `@import` (Google Fonts, animate.css)
   was silently ignored.
3. `new Audio(src).play()` on load was refused by autoplay policy and never recovered, even after a
   tap; the iframe also had no `allow="autoplay"` delegation.
4. `localStorage`/`sessionStorage` throw SecurityError in the sandboxed frame → any library touching
   them crashed.
5. Link taps inside the frame did nothing.
6. (Mirrored-CSS layout check, not the real Tailwind tree) In the glass phase the card has no
   definite height, so the iframe's `h-full` resolved to auto = 150px: every surprise ran in a
   ~254×150 window.
7. The iframe mounted during the ~1.5s blur/fade entrance, so CSS animations, timers and one-shot
   effects ran mostly unseen.
Not reproducible / ruled out: pasted full HTML documents keep `<html>`/`<body>` attributes (the HTML
parser merges them) — an earlier hypothesis that they were lost was WRONG and is not claimed.

### Surprise section — changes
- `src/lib/surpriseDocument.ts` (new; builder moved out of `codeSurprises.ts`, still re-exported):
  plain global user script (omitted entirely when JS is blank), separate user `<style>`, in-frame
  runtime (error report, storage shims, autoplay recovery "Tap for sound" chip + AudioContext resume,
  link forwarding, white page background fallback for imported pages), `no-referrer` +
  `upgrade-insecure-requests` metas, media URL normalisation (Drive/Dropbox/GitHub share links,
  protocol-relative → https; media contexts only), `findUnresolvedLocalRefs` lint, import marker.
- `CodeSurpriseFrame.tsx`: `allow="autoplay *; accelerometer; gyroscope; magnetometer; fullscreen"`,
  `referrerPolicy="no-referrer"`, verifies `event.source` is its own iframe, opens forwarded
  http(s)/mailto/tel links (Capacitor Browser on native, `window.open` on web), `onRuntimeError` prop
  replaces the editor's global `message` listener.
- `SurpriseReveal.tsx`: real height for the glass-phase content area; iframe mounted only after the
  entrance finishes (3.5s backstop timer); `filter` cleared after the entrance.
- `surpriseImport.ts` (new): one .zip OR any mix of .html/.css/.js. Finds the entry page
  (index.html preferred), moves `<style>` + linked/`@import`ed CSS into CSS, classic
  `<script>`/`<script src>` into JS (**JS stays "" if the page has none**), keeps remote
  `<link>`/`<script src>`/module scripts as tags, inlines local images/audio/video/fonts as data:
  URIs (CSS `url()`, HTML attrs, `srcset`, inline `style`, and JS string literals that are exactly an
  uploaded file's path). Budgets: 1.5 MB/asset, 3 MB total, 4.5M chars, zip ≤25 MB / ≤600 entries /
  ≤60 MB expanded. Large PNG/JPEG re-encoded (WebP, ≤1600px) when the browser can. Everything not
  embedded is reported by name + reason; nothing is silently dropped. Path traversal / `__MACOSX` /
  dotfiles ignored. ES modules with `import`/`export` are skipped with a reason.
- `surpriseAssets.ts` (new): editor shows `ds-asset://aN` tokens instead of multi-MB base64 in the
  text areas; expanded on preview/save/library.
- Library ("save the uploaded code in our database"): `supabase/migrations/20260920110000_surprise_library.sql`
  (`surprise_library`, owner-only RLS, no partner policy, size CHECK, updated_at trigger),
  `surpriseLibrary.ts`, `SurpriseLibraryPanel.tsx`, editor UI (Import zip/files, Library, Save to
  library, "Save uploads to my library" switch — default ON — replace-confirmation when there are
  unsaved edits). It is separate from `code_surprises` on purpose: that table's SELECT policy
  exposes every row, active or not, to the partner.
- Because imported surprises can be MBs: `fetchSurprisesForConversation` now returns metadata only
  (`body_loaded:false`), `ensureSurpriseBody()` fetches html/css/js once on open;
  `useChatSurprise` opens/auto-opens through it and also refreshes the list when a Realtime payload
  lacks `creator_id`; `analyzeSurpriseContent` strips data: URIs before scanning.
- Tests added: `surpriseDocument.test.ts`, `surpriseAssets.test.ts`, `surpriseImport.test.ts`.
- Version 3.10.0 → 3.11.0 (`package.json` + `APP_VERSION`).

### Verification actually performed
- Headless Chromium (Playwright): old vs new builder side by side for items 1–5 above; imported a
  real multi-file zip and rendered it in a `sandbox="allow-scripts"` frame (body class/onload,
  external JS file, inlined image, running CSS animation, inline handler over a `const`, blank-JS
  page emits no user script); canvas re-encode took a 1.3 MB PNG to 27 KB.
- The 3 new test files (38 tests) executed in Chromium through a ~60-line vitest-compatible shim:
  38/38 pass. **They have NOT been run under vitest/jsdom** (not installed here); jsdom differences
  (TextDecoder/Blob.arrayBuffer/JSZip realm) are possible.
- Isolated `tsc --noEmit` of every touched file against stubs for third-party modules: no errors in
  the touched files (stub-caused noise filtered). No real project typecheck/lint/build (no `npm ci`).
- `node scripts/check-rls-coverage.mjs`: passes with the new table (advisory only).
### NOT verified
Android/iOS WebView behaviour (autoplay, mixed content, Drive/Dropbox direct links, Referer), any
network-hosted media, the new migration against a live DB (NOT applied — see KI-17), Realtime's
oversized-payload behaviour (assumed, see the `creatorId === undefined` guard), the real Tailwind
layout of the glass-phase fix, and framer-motion's `transitionEnd` in the actual bundle.

## 2026-09-20 (later) — Incoming calls: can't answer / keeps vibrating / lag

Symptoms reported: can't pick up calls, app lags, phone keeps vibrating, tapping
Accept does nothing, continues after the call ends. Found by reading code only —
NOT built, NOT run on a device (no network/device in the sandbox).

### Root causes (source-level)
1. `useCallEngine()` returns a new object every render, so `acceptIncomingCall`
   (deps `[call, ...]`) changed identity every render. `IncomingCallOverlay`'s
   subscribe + cold-start-poll effect depended on it, so it re-ran constantly:
   re-subscribed channels, stopped/restarted ringtone + vibration, and the poll
   re-hydrated the same still-`in_progress` call — re-opening the incoming
   screen after Accept (second tap hit `acceptLockRef` = no-op).
2. `haptics.startCallVibration()` was not idempotent and only stored the last
   interval handle → orphaned vibration loops that `stopCallVibration()` could
   not clear.
3. Android: `CallRingingService` (ringtone + vibration), notification 9911 and
   the ringing Telecom connection were started by the FCM push but never stopped
   by in-app accept/decline/end (only by notification buttons, call_ended/
   missed/rejected pushes, or the 45s timeout).
4. Native call actions did `window.location.href = "/chat"` (hard reload; twice
   on cold start because the pending-action replay re-ran the handler).
5. `handleAccept` returned silently when `room_url` was empty.

### Changes
- `src/components/IncomingCallOverlay.tsx`: refs for callbacks, effects keyed on
  user id only, handled-call-id set, accept/decline/auto-accept rewritten
  (auto-accept no longer runs inside a setState updater), missing-room fallback
  + toast, native stop on every dismiss path, opaque backdrop (no full-screen blur).
- `src/contexts/CallContext.tsx`: `acceptIncomingCall` now identity-stable via refs.
- `src/lib/signalingEngine/callSignalingBridge.ts`: returned bridge memoized.
- `src/lib/haptics.ts`: idempotent start, tracked timeouts, 60s safety cap.
- `src/lib/nativeIncomingCall.ts` (new) + `dismissIncomingCall` in
  `native-plugins/callkit-bridge` (TS definition, Android, iOS no-op).
- `native/android/CallRingingService.kt` (`ACTION_DISMISS_INCOMING`),
  `CallNotificationService.kt` (public `NOTIFICATION_ID`, end Telecom connection
  on call_ended/missed/rejected), `DuoSpaceConnectionService.kt`
  (`endConnectionForCall`, keep ref after Telecom-side answer),
  `CallOngoingService.kt` (always end the Telecom connection on hang-up).
- `scripts/patch-native-permissions.mjs`: MainActivity (Kotlin + Java variants)
  cancels the ringing notification on Accept/Decline.
- `src/hooks/usePushNotifications.ts` / `nativeCallActionBridge.ts`: soft
  navigation instead of reload, live handler clears the durable pending-action
  slot, iOS `callAction` listener removed on cleanup.

### Verified vs not
- Verified: TS syntax of all edited files; vibration logic (single loop, full
  cancel, safety cap) via a fake-timer harness.
- NOT verified: `vite build`, `tsc`, vitest, any Kotlin/Swift compile, any
  on-device behaviour. Run `npm run cap:sync` so the MainActivity patch
  re-applies, then test: answer in-app, answer from notification, caller
  cancels while ringing, hang up, and a second call right after.


## 2026-09-20 — Appearance: theme picker, collapsible wallpapers

Source-level only; nothing compiled, linted, or run in the app (no
node_modules / no network here — KI-06 still stands). What WAS run: the real
`themeEngine.ts` under Node against all 33 theme identities × light/dark ×
6 text/background pairs (396 checks, 0 below 4.5:1), and a syntax +
best-effort type pass over the touched files.

- **Theme picker rebuilt** (`components/settings/ThemePicker.tsx`, shared by
  Appearance settings and Theme Studio). Category chips (Cool / Romantic /
  Warm / Nature / Neutral) and 3-column cards that each draw a mini
  conversation from the theme's own derived tokens. Previews now render in the
  *current* color mode — previously swatches always showed a theme's "home"
  mode while selecting a theme never changed the mode, so the picker could
  show a dark Wine Red and apply a light one.
- **5 new themes**: Peony, Mulberry, Aurora, Meadow, Noir (33 total). Every
  theme now has a `category`; `THEMES` is derived from one ordered
  `THEME_META` list so preview/accent/dark can't drift from
  `THEME_IDENTITIES` / `THEME_DEFAULT_MODE`. `couple_theme` is free text, so
  partners on an older build fall back to Midnight instead of erroring.
- **Collapsible sections** (`CollapsibleSection.tsx`): Theme colors and Chat
  wallpaper collapse from a full-width header (aria-expanded, height animation
  skipped under reduced motion). Open/closed persists in one localStorage key
  (`duo-appearance-sections`). The header keeps a thumbnail + name of the
  current selection while collapsed. Wallpaper defaults to collapsed, theme to
  open.
- **Wallpaper picker** (`WallpaperPicker.tsx`): live chat preview behind the
  current theme's bubbles, category chips, 3-column tiles with names, an
  explicit "Default" (none) tile, Live badge for Dynamic Sky.
- Added `src/test/themeCatalog.test.ts` (unique ids, one category each,
  4.5:1 contrast on every preset in both modes, wallpaper pairs present).

## 2026-09-20 — KNOWN_ISSUES pass: KI-14 and KI-17

Source-level only; nothing compiled, linted, or run (KI-06 still stands).

- **KI-14 fixed** — `src/pages/Chat.tsx`: `handleScheduleMessage` and
  `handleSendLoveLetter` no longer fall back to plaintext when E2E isn't ready.
  They wait for the key exchange (6 s), encrypt through `e2eEncryptRef`, and
  abort with a toast unless the result passes `isEncrypted()`. Encryption now
  runs before the composer is cleared / dialog closed so nothing typed is lost.
- **KI-17 applied** — `20260920110000_surprise_library.sql` applied to live
  project jzlpelxwzjjpddqcrtpu (migration name `surprise_library`); RLS/policies
  verified via catalog query. Two-account cross-read test still outstanding.
- **KI-05 fixed** — added `exportPrivacyData()` (consent.ts) and an export button in
  `PrivacyAISettings.tsx`. Source-level only.
- **KI-08 investigated, deliberately not changed** — the live
  `enforce_call_history_update_rules` trigger does not compute `ended_at` /
  `duration_seconds` (only the un-applied repo migration does, see KI-16), so
  removing them from the client would leave them null. Real fix is server-side.
- **KI-12 gap 1 built (unverified)** — Android "Allow all the time" request: plugin
  methods (Kotlin + definitions.ts), `backgroundLocationPermission.ts`,
  `BackgroundLocationPrompt.tsx`, mounted in `LocationAccessGate.tsx`. Gaps 2 and 3
  untouched.
- **KI-04 audited (no code change)** — findings and options recorded in KI-04. Main
  result: mood is the only one of the six that leaves the device, and the partner can
  read raw camera-derived `features` in `mood_logs`.
- **KI-04 option (a) applied** — raw facial measurements no longer written to
  `mood_logs.features` (MoodDetector.tsx, useBackgroundMoodDetection.ts). Old rows
  untouched; optional scrub SQL recorded in KI-04, not run.
- **Live scrub run** — stripped the four raw facial keys from 37 of 47 existing
  `mood_logs` rows (project jzlpelxwzjjpddqcrtpu). Irreversible by design.
- **Kill switch** — `BACKGROUND_LOCATION_PROMPT_ENABLED` in
  `backgroundLocationPermission.ts` (set false to hide the new Android dialog).
- **KI-12 gap 2 built (unverified) + live infra** — migration
  `location_push_credentials` applied; edge functions `location-push-register`
  (jwt) and `location-push-upload` (no jwt, credential-authenticated) deployed to
  jzlpelxwzjjpddqcrtpu; native upload in DuoSpaceLocationService; JS registration
  in LocationContext. See KI-12 #2 for the full design and limits.
- **Not touched (need a device, network, dashboard, or a product decision):**
  KI-01, 02, 03, 06, 07, 08, 09, 10, 11, 12, 15, 16, 18, 19.


## 2026-09-20 — Phase 1.6 (repository reconciliation + privacy foundation), partial
Added: `consentFeatures.ts` (dependency-free vocabulary + `isConsentActive`),
policy matrix and PARTNER/ANALYTICS/LOGS destinations, gate destination-consent
and explicit-share rules, `sensorPolicy.ts`/`sensorGate.ts`, purpose-required
`acquireCamera`, `derivedMoodGate.ts`, `ai/provenance.ts`, `ai/sharing.ts`,
`ai/localInsightStore.ts`, validator patterns, telemetry consent guard and wider
redaction, `scripts/check-lock-sync.mjs`, RLS-script recognition of
service-role-only tables, vitest plugin aliases, four new test files, five new
`.ai` docs, Phase 1.6 report.
Fixed: mood auto-publish to partner profile; persisted background-mood flag;
object-extra telemetry leak.
Changed behaviour: saving camera-derived mood needs `MOOD_PROCESSING` (KI-24).
Not done / blocked: see the report and KNOWN_ISSUES KI-20..KI-30.

Also 2026-09-20: merged `duospace-theme-update.zip` (theme picker, collapsible
wallpapers, 5 new themes) onto this tree with `patch -p1` — applied cleanly, no
rejects. `ThemeContext.tsx` keeps both the theme additions and the Phase 1.6
persistence-ordering fix. The overlay's own changelog entry is above.


## 2026-09-20 (later) — Music: "no notification when a song plays"
Input: log line "notification posted OK (isPlaying=true)" + "no notifications on playing songs".
Found: the toast is a leftover TEMPORARY diagnostic in `MediaPlaybackService.postNotificationInternal`;
success was inferred from "no exception". See KNOWN_ISSUES KI-31 for the full change list.
Files: `MediaPlaybackService.kt` (verification, new channel, transport category, no toasts,
`onNotificationIssue`), `AudioEnginePlugin.kt` (`notificationIssue` event,
`openNotificationSettings`), `definitions.ts`/`web.ts`, `nativeAudioEngine.ts`
(`ensureNotificationPermission`, `onNotificationIssue`, `openNotificationSettings`),
`GroicContext.tsx`, new `lib/music/notificationIssue.ts` + `notificationIssueToast.tsx`,
new `test/notificationIssue.test.ts` (6 cases, passed under the stand-in runner only).
Not verified: Kotlin compile, any device behaviour.


## 2026-09-20 (later still) — Audit pass merged onto Helllooi.zip: perf + QR partner link

Ported from a parallel session's `duospace-redesign-final-updated.zip` onto this tree with `patch -p1`
(all hunks applied; `AppearanceSettings.tsx` re-done by hand because this tree restructured it). Source-level
only; nothing compiled or run on a device (KI-06 stands).

### Performance
- `src/lib/crypto.ts`: ECDH-derived AES key cached per (private-key JWK object, peer public key) in a WeakMap.
  Opening a chat used to run importKey x2 + deriveKey for EVERY message. Executed against real WebCrypto in
  Node: 60 decrypts 21 ms -> 2 ms (desktop), 120 ops = 2 derivations, wrong key still fails, a failed
  derivation is not cached.
- `GroicContext`: `position`/`duration` moved to `GroicProgressContext` (`useGroicProgress`). `useGroic()` no
  longer changes twice a second during playback; only `SeekBar` (extracted from `GroicFullPlayer`) follows it.
  Merged with the KI-31 notification-issue changes in the same file.
- `QRSignInScanner` / `QRSignInDisplay`: `html5-qrcode` and `qrcode` are dynamically imported on use.
- `AuthContext`: provider value memoised.
- "Smooth mode": `src/lib/perfProfile.ts` + `html[data-effects="lite"]` block at the end of `index.css` +
  Performance card in Appearance settings. Auto turns backdrop blur off on low-end devices
  (deviceMemory <= 3, cores <= 4, saveData). Capable devices unchanged.

### QR partner link — docs/QR_PARTNER_LINK_FIX.md (KI-32)

### Deliberately not changed
Static imports of PeekGuard/MoodDetector/GroicFullPlayer (earlier boot-crash fix). Chat's first load still waits
for all attachment URLs to be signed. KI-11 re-examined: partner-key fetch already runs in parallel, so caching
the own key buys little.

### 2026-09-20 — QR link fix DEPLOYED (server side)
Applied migration `qr_partner_link_fix`, redeployed `redeem-qr-token` (v9), deployed `check-qr-token-status` (v1,
never live before). Details and limits in KNOWN_ISSUES KI-32. App build not yet installed; not tested on devices.


## 2026-09-20 (latest) — "Location not updating although permissions are granted"

Foreground live-location engine (`src/hooks/useLiveLocation.ts`) — NOT compiled
or device-tested (KI-06 still applies). Only the write-gating arithmetic was
checked, by a standalone Node simulation of old vs new logic (3 min, 1 fix/s,
±6 m GPS noise): stationary 1 write -> 5; walking 1 -> 30 (last write ~255 m
stale -> ~4 m); cycling 1 -> 46 (~900 m stale -> ~11 m); driving unchanged.

Root causes found in `onPos`:
1. **Write gate was unreachable below ~10 km/h.** Smoothing (30 % of the raw
   delta) was applied before the "moved >= 8 m" write check, and the smoothing
   base only advanced when the marker moved > 3 m. Net effect: an 8 m smoothed
   step needed a ~27 m raw jump in ONE fix. Standing still or walking wrote
   nothing after the first fix, so the partner's "Updated X ago" froze.
   The code comment promised "distance OR initial OR long idle" but the idle
   branch did not exist. FIX: gate measured against the last WRITTEN position;
   `KEEPALIVE_WRITE_MS` (45 s) idle write added.
2. **Smoothing never converged.** Base now advances on every accepted fix, with
   a heavier weight (0.8) when the raw fix is > 25 m away (real movement).
3. **Eco/high switch thought walking was standing still** (used the same
   unreachable 8 m smoothed step), so a walking person dropped into eco
   (coarse, cached up to 30 s) after 30 s. Movement is now "left the last
   written spot by >= 8 m".
4. **Every fix could be dropped.** Hard reject at > 250 m accuracy (and soft
   drift reject) discarded all fixes on cell/Wi-Fi-only positioning while the
   UI still showed "tracking". Gates are skipped after `STARVED_AFTER_MS`
   (90 s) with nothing accepted; the speed-jump gate is skipped when either fix
   is imprecise.
5. **Dead watcher never noticed.** Added a silence watchdog (150 s without an
   accepted fix while visible -> restart watcher + coarse one-shot) and a
   foreground-resume check (> 60 s silent -> restart).

NOT changed (needs a product decision): Android background tracking. Since the
2026-09-19 "no notification" change `DuoSpaceLocationService` is not a
foreground service, so Android stops delivering fixes shortly after the app is
minimized. See docs/BACKGROUND_LOCATION_NATIVE.md header.

Unverified suspicion: `@capacitor/geolocation` may use the `timeout` option of
`watchPosition` as the Android update INTERVAL. If so, HIGH_OPTS (30 s) /
ECO_OPTS (45 s) mean one fix per 30-45 s. Check `Geolocation.java` in
node_modules after `npm ci`.

## 2026-09-20 (latest, 2) — Quiet background location (no notification)

Request: keep location updating with the app minimized WITHOUT bringing the
foreground-service notification back. There is no legitimate way to hide a
foreground-service notification, so the approach is to not need a foreground
service: Play services PendingIntent updates.
- NEW `native/android/LocationUpdateReceiver.kt`: PendingIntent subscription
  (register/unregister), receiver for location results (forwards to JS if alive,
  else uploads natively via the existing `location-push-upload` credential),
  boot/app-update re-subscribe, and the shared native upload helper.
- `native/android/DuoSpaceLocationService.kt`: ACTION_START registers the
  subscription and stops itself; one-shot bookkeeping via a counter (was
  `isWatcherRunning`); `onDestroy` no longer tears the subscription down; upload
  code delegated to the receiver's helper.
- `scripts/patch-native-permissions.mjs`: copies the new file, registers the
  receiver (own guard), adds RECEIVE_BOOT_COMPLETED.
NOT compiled/run. Needs "Allow all the time"; Android throttles background
apps. Needs a rebuilt APK, then open the app once.

## 2026-09-20 (Calling Phase 4) — authoritative WebSocket signaling for self-hosted calls

Merged onto `duospace-redesign-notification-fix.zip` (3-way; only overlapping
files were `IncomingCallOverlay.tsx`, `CallContext.tsx`, `Chat.tsx`). Full
detail: `docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md`.

- Gateway now authorizes every call-control message against Supabase and acks
  each one (`gateway.ts`, `callRegistry.ts`, `authorizer.ts`); migration
  `20260920140000_signaling_call_facts_and_session_id.sql` (renamed from
  `…130000` — collided with `qr_partner_link_fix`).
- `livekit-token`: room derived from call id (caller-chosen `room_name` no
  longer trusted), provider check, receiver must hold the claim.
- Client engine/client/bridge rewritten; self-hosted ring, accept, reject,
  cancel, end, timeout are socket-driven with typed results; Realtime kept only
  as a labelled recovery path. Daily untouched. No JSX changes.
- Fixed: reconnect used an expired ticket forever; accept flow marked
  token stages before any token existed; call-latency metrics were truncated /
  `[redacted]` by telemetry (KI-41).
- Infra: local/staging/production split; TURN docs corrected (KI-36).
- Not verified: see KI-33. Lockfile: KI-20 downgraded (static agree).

## 2026-09-20 (Partner unlink) — stuck confirm dialog + two-sided (consent) unlink

Source: `duospace-phase4-authoritative-signaling.zip`. No DB / `node_modules` /
device in this sandbox — nothing below was executed. Full write-up:
`docs/PARTNER_UNLINK_CONSENT.md`.

WHY: (1) after a successful unlink the "Unlink from partner?" dialog stayed on
screen; (2) either partner could end the pairing alone (RPC `unlink_partner`
open to all signed-in users, and `profiles` allowed direct `partner_id` writes).

WHAT:
- `ConfirmActionDialog` closes itself after `onConfirm` (resolve `false` to keep
  open); new optional `approvalNote` row. `Settings.handleSignOut` returns
  `false` on failure to keep its retry behavior. Also fixes the same stuck
  dialog on "Turn off App Lock?".
- Migration `20260920150000_partner_unlink_consent.sql`: `unlink_requests`
  (read-only for clients), RPCs `request_unlink` / `respond_unlink` /
  `cancel_unlink`, `unlink_partner` revoked from `authenticated`,
  `profiles.partner_id` client-write guard trigger, push trigger.
- Push types `unlink_request|unlink_approved|unlink_declined`
  (`send-push` `_shared/pushTypes.ts`, `_shared/fcm.ts`); client routing +
  foreground refresh in `usePushNotifications.ts`.
- App: `useUnlinkRequests`, `UnlinkRequestHost` (in `AppLayout`),
  `lib/partnerUnlink.ts`; `PartnerSettings` sends a request, shows
  waiting / incoming state and Cancel. `clearCachedPartner` added; `Chat`
  drops a stale cached partner when the server says none.

RISK: the `profiles.partner_id` guard relies on `current_user` (definer-owner
vs `authenticated`) — correct in theory for Supabase, unverified live. Old app
builds can't unlink after the migration. A partner who never answers cannot be
unlinked (see KI-42).

TEST: `src/test/partnerUnlink.test.ts` (helpers + static SQL checks),
`src/test/confirmActionDialog.test.tsx` — written, NOT RUN. Static regexes in
the SQL checks were confirmed against the migration text with node only.

RESULT: implemented in source, NOT VERIFIED (lint/tsc/tests/build/DB all
BLOCKED BY ENVIRONMENT).

## 2026-09-20 (Shayari) — author-only Edit button

Source: `duospace-phase4-partner-unlink-consent.zip`. No DB / `node_modules` /
device in this sandbox — nothing below was executed against a real build.

WHY: shayaris could be written and deleted but never corrected afterwards.

WHAT:
- `src/pages/Shayari.tsx`: pencil button on a card, rendered only when the
  signed-in user is the author (`canEditShayari`); Edit dialog (title + text);
  saves with `update(...).eq(id).eq(user_id).select()` so a write the database
  refused (0 rows) shows an error instead of a false success; the dialog closes
  on success and stays open with the draft intact on failure. The existing
  realtime UPDATE listener shows the edit on the partner's screen live.
- `src/lib/shayariEdit.ts` (pure rules: author check, trim/empty-title→null,
  "unchanged" short-circuit) + `src/test/shayariEdit.test.ts`.
- `src/lib/errors/registry.ts`: `DS-SHAYARI-006`.
- No migration: the existing "Update own shayaris" RLS policy
  (`auth.uid() = user_id`) already makes editing author-only in the database.

RISK: low. No `updated_at` column exists, so edited shayaris aren't marked
"edited" (would need a migration). The export/PDF/card paths read from state and
pick up edits automatically.

TEST: helper logic run under node (8 cases pass); `shayariEdit.test.ts` written,
NOT RUN under vitest. `Shayari.tsx` not compiled (BLOCKED BY ENVIRONMENT).

RESULT: implemented in source, NOT VERIFIED at runtime.


## 2026-09-21 — Supabase production reconciliation and security fixes

Source: `duospace-offline-gallery-us-shayari.zip`. Work was done against the LIVE project
(`jzlpelxwzjjpddqcrtpu`); nothing in the app was compiled or run in this sandbox.

WHY: the live project had diverged from the repo history. A live exploit
(`partner_requests` sender_id rewrite → forced pairing), a public bucket anyone could write to,
two public diagnostic Edge Functions that leaked secret fragments, and an open `send-push`
were found and fixed while applying the earlier zips. Details: `docs/SUPABASE_PRODUCTION_RECONCILIATION.md`.

WHAT:
- New migrations `20260921110000` … `20260921110500` (all idempotent; already applied live).
- `supabase/functions/send-push/index.ts`: rejects non-service-role callers (403); the zip's
  `/important` bypass is kept.
- `20260921120000_add_messages_important_flag_and_bypass_dnd.sql` corrected: it re-added the
  plaintext `preview` that `20260908090000` had removed. Live already has the correct function.
- Docs corrected: `SUPABASE_SCHEMA_INVENTORY.md` (surprise-assets), `.ai/KNOWN_ISSUES.md`,
  `.ai/CURRENT_STATE.md`.

RISK: `send-push` no longer accepts user-JWT calls (none exist in the app). The unlink cleanup
deletes accepted `partner_requests` rows between the unlinked pair. `accept_partner_request`
now refuses when either side is already linked.

TEST: rolled-back SQL tests on live (listed in the doc); live 403 check on `send-push`.
NOT RUN: vitest, tsc, build, a real two-device flow, Realtime delivery, a real push through the new
`send-push`.

RESULT: applied to live; repo files added to match. Live `send-push` v7 is still the previous
source (no `/important` bypass) — redeploy needed for that.

## 2026-09-22 — Media send speed, WhatsApp ZIP import, on-device downloads
- WhatsApp import: ZIP detected by "PK" signature (Android pickers often drop the .zip extension); file picker accepts zip MIME types; picks `_chat.txt` / "WhatsApp Chat…" / largest .txt instead of first .txt; skips __MACOSX; strips iOS bidi marks inside message content (iOS attachments were never matched); CRLF, a.m./p.m. and dotted-time support; media uploads 4-at-a-time with correct Content-Type; friendly out-of-memory message.
- Sending: new `src/lib/directUpload.ts` — single XHR upload with real progress for files ≤50 MB (bucket cap), chunked `resumableUpload` kept as fallback; photos >600 KB downscaled to 2048px JPEG before send; chunk fallback now uploads 4 chunks concurrently; progress updates throttled to whole-percent changes.
- UploadProgressRing redesigned on theme tokens (--primary/--background, frosted disc, arrow/check icon).
- New `src/lib/downloadToDevice.ts`: file bubbles and PhotoViewer save the file to Documents/DuoSpace (native) or trigger a real browser download (web); raw Supabase URLs are never opened.
- NOT VERIFIED on real devices / live Supabase (npm install blocked in this environment; edited files syntax-checked with esbuild only).

## 2026-09-22 (b) — Scheduled picker layering, slash-command menu, /important & /urgent
- ScheduledMessagePicker portaled to <body> as a z-[80] bottom sheet (was rendered under DuoSpaceBottomSurface z-40, i.e. behind the chat box).
- Composer: typing "/" shows a "Send as" menu (/silent, /important, /urgent), filtered as you type, keyboard + tap support; portaled so the overflow-hidden shell can't clip it.
- /urgent was never parsed (sent as literal text) — now parsed; sets important=true + new urgent column (additive migration 20260922120000). Falls back to important-only if the column isn't deployed yet.
- Messages fetch never selected silent/important, so flags vanished after reload — now selected. Bubbles show "Important" (amber) / "Urgent" (red) label + ring; own silent sends show "Sent silently".
- NOT VERIFIED on device / live DB.

## 2026-09-22 (c) — Vanish Mode persistence, no App Lock during file picking
- Vanish ("ghost") Mode persisted per user+partner (storage key duo-vanish:<uid>:<pid>); survives app close/reopen, WebView reclaim and App Lock; only cleared by endVanishMode.
- appLockTimer: picker grace window. installPickerLockGuard() (called from ThemeContext) marks every <input type=file> click; shouldLockOnResume returns false while the mark is fresh (≤10 min); mark cleared ~3s after return. Real backgrounding still locks as before.
- NOT VERIFIED on device.

## 2026-09-22 (d) — WhatsApp-style call notification, no call spam, music reattach
- Android: new native/android/IncomingCallNotification.kt — ONE incoming-call notification (CallStyle.forIncomingCall: green Answer / red Decline on API 31+, coloured actions below), ongoing, full-screen, no auto-timeout. CallRingingService posts it as its foreground notification under the same id (9911) — was two notifications (9911 + 9912). CallNotificationService always uses the native path (foreground skip removed) and only posts it directly if the ringer service was refused. Added to patch-native-permissions copy list.
- IncomingCallOverlay: on native, renders nothing and plays nothing while the OS owns the ring; falls back to its own screen+ringtone only if native isn't ringing after ~3s; notification body tap ("duospace-call-reveal") shows the in-app answer screen.
- "Call ended" / "Call declined" pushes no longer post tray notifications (missed calls still do).
- Ongoing call + music notification taps bring the existing task forward.
- GroicContext: snapshots current track+queue; on startup/foreground reads nativeEngine.getState() and restores the player UI for music still playing in the background service.
- NOT VERIFIED: needs a native rebuild (npx cap sync + patch script) and device testing.

## 2026-09-22 (e) — Map: single info entry, full zoom without "Map data not available", no control overlap
- Status/details sheet now opens ONLY from the bottom battery chip (header pill made display-only; partner-marker tap removed).
- Tiles: maxNativeZoom reduced by 1 on retina (detectRetina's zoomOffset was requesting z20 → Esri "Map data not yet available" placeholder / OSM 404); satellite real-tile cap lowered 19→17 (z18-19 are placeholders outside major cities); Leaflet upscales to MAX_ZOOM 21; transparent errorTileUrl.
- Leaflet zoom control removed (overlapped recenter at bottom-right); custom glass +/- stacked above the recenter button.
- NOT VERIFIED on device.

## 2026-09-22 (f) — Call "stuck on Connecting… → Call failed"
- useDailyCall.joinCall: mic (and camera for video) permission resolved BEFORE Daily join — an OS prompt raised mid-join could leave join() hanging until the watchdog showed a fake "Couldn't connect"; a denial now surfaces as PERMISSION_DENIED.
- One silent automatic retry (fresh call object, same room/token) on watchdog timeout or non-permission join failure; watchdog 15s first attempt, 20s retry. Error UI only after both fail.
- Removed deprecated dailyConfig.camSimulcastEncodings (daily-js 0.87); best-effort updateSendSettings({video:"bandwidth-optimized"}) after join.
- CallContext accept watchdog 40s → 55s to cover join + retry.
- Daily.co kept as provider per DO_NOT_CHANGE.md. NOT VERIFIED on device.

## 2026-09-22 (g) — Groic trending variety, more languages, language bar, legal YouTube background
- New src/lib/music/trendingMix.ts: per-language rail built from SoundCloud → YouTube → Audius (fixed tier priority, ~40/40/20), each tier from a random query in a per-language pool and shuffled; 30-min provider cache, reshuffled every render/“Shuffle”.
- music-trending edge function: accepts { languages: [...] } (allowlisted, max 4); random query + publishedAfter 60 days + random order instead of fixed order=viewCount; English chart region rotates; results sampled/shuffled. Legacy empty body still returns the original four.
- 16 languages: Hindi, English, Punjabi, Urdu, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Haryanvi, Bhojpuri, Arabic, Spanish, K-Pop.
- Language picker: single scrollable bar, tap select / tap again deselect (any, incl. last), check indicator + native script, Shuffle button.
- YouTube background: no ToS bypass. On backgrounding a YouTube track (native app), Groic hands off to the same song on SoundCloud/Audius (title key + ±20s duration match) at the same position; otherwise YouTube pauses as required.
- NOT VERIFIED on device; redeploy music-trending.

## 2026-09-23 — Self-hosted calling is the only provider (Daily removed)
- Removed: @daily-co/daily-js (+ transitive lock entries), useDailyCall.ts, DailyCallEngineAdapter.ts, DailyKeyManager (onboarding step + Settings card), supabase/functions/daily-call, provider switch/override/VITE_CALL_PROVIDER, all Daily branches in Calls/Chat/CallContext, "No Daily.co API key" 402 message.
- SelfHostedCallEngineAdapter: bounded stages (token 15s / connect 20s / mic 12s), duplicate-join + join-generation (cancel-while-joining) guards, room-mismatch refusal, unexpected-disconnect → error + cleanup, telemetry participant_joined/remote_audio_ready/call_connected.
- Deterministic failure cleanup: caller (leaveCall + cancelOutgoingCall "join_failed"), accept (leaveCall), recovery rejoin (leaveCall + signalCallTerminated).
- livekit-token: service-role signaling_get_call_facts; mutual current partnership, decline, UUID callId, TTL 300s clamped 60–900.
- Gateway: STALE_CONNECTION rejection for replaced sockets (+2 tests).
- Migration 20260923120000: provider default self_hosted, BEFORE INSERT trigger rejects others, dangling live Daily rows → failed/provider_removed. Historical rows kept; Daily-key columns NOT dropped.
- scripts/check-calling-config.mjs (`npm run check:calling`): static production config preflight.
- Tests: adapter (10), no-Daily guard (4), authz (+4), provider config (rewritten), callSignalingBridge (hoisting bug fixed — 6 tests now actually run).
- Docs: docs/calling-architecture.md (authoritative), docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md; superseded banners on 35 historical docs; DO_NOT_CHANGE/ARCHITECTURE/NATIVE_CALLING/SECURITY_MODEL/deployment README updated.
- NOT runtime-verified on devices / live LiveKit / TURN.

## 2026-09-23 — Phase 2B: local AI engine, evaluation harness, 2A hardening
- FIX (pre-existing): local-rule-v1 output failed the validator for Values/Expectations/Reflection (HIGH confidence over cap; unhedged explanations) → every analysis errored.
- FIX (security, verified exploitable on real Postgres): relationship_shares un-revoke/extension; migration 20260923130000 (one-way revoke, immutable expiry, server-owned insert fields, partner-checked recipient reads).
- FIX: validator false negatives ("Your partner…", "they don't care"); euphemism coverage; expectations evidence catalog lists only present types.
- NEW: local-model-v1 provider, capability layer, integrity-verified manifest, transformers.js web runtime (lazy), strict JSON prompt contract, provenance check, local-rule-v1 fallback, device-only enforcement.
- NEW tests: src/test/ai (87), src/test/db (10, PGlite). Deps via npm: @huggingface/transformers, @electric-sql/pglite (dev).
- NOT VERIFIED: no real model inference executed. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## 2026-09-23 — Merge + Phase 2C: AI execution modes
- MERGE: photos-upload + LiveKit-Cloud zips (built on pre-2B) 3-way merged with Phase 2B; 2B share-revoke migration restored; deps re-added via npm. FIX: MoodDetector `pool` ReferenceError (from LiveKit zip).
- NEW: RelationshipAIService (single orchestrator), executionMode (LOCAL/E2E_CLOUD/RULE_BASED/UNAVAILABLE, failure policy, capability assessment), e2eCloud envelope (ECDH P-256/HKDF/AES-GCM, AAD, replay) + BLOCKED E2E provider (no TEE). Validator +8 subtle-inference groups. Reflection.tsx routes via service; toast states mode.
- NOT DONE: real model (403), hashes, inference, performance. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## 2026-09-23 — Phase 2D (blocked at model artifact)
- Artifact BLOCKED (HF/CDN/ModelScope 403; no official non-HF source). No weights, hashes or measurements fabricated.
- NEW: grounding validator (history/frequency/numbers not in input → rejected) in pipeline for generated output; manifest versioning + compatibility gate (safetySpecVersion 3); .ai/MODEL_MANIFEST.json (BLOCKED); real-model evaluation runner (skips without LOCAL_MODEL_DIR).
- Tests 806 pass / 2 skipped / 6 pre-existing fail. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.

## 2026-09-23 — Calling deployment root cause + instrumentation (+ merged peek + Phase 2D)
- ROOT CAUSE: signaling-ticket used SUPABASE_JWT_SECRET, which hosted Supabase never provides to Edge Functions (reserved SUPABASE_ prefix) → tickets 503 → socket never opens → "Connecting…". Fix: dedicated SIGNALING_TICKET_SECRET on both signaling-ticket and the signaling server (old name = local fallback); env examples, docker-compose, README, check-calling-config updated.
- Signaling server now logs socket_connected/closed, upgrade_rejected_origin/auth and every accepted signal (ids only).
- Client trace: required stage names, callId/sessionId, call_failed with machine-readable reason.
- Real local e2e re-run with the fix (real signaling + LiveKit 1.13.7 + 2 WebRTC peers): PASS. Devices: NOT tested. See docs/CALLING_DEVICE_VERIFICATION.md.

## 2026-09-23 — Smoothness / flicker pass (+ incoming-call notification follow-up)
- Route flicker: every page chunk is now warmed after first render (one per idle slot; Gallery/Groic first), Reflection added to routePreload, and BrowserRouter uses v7_startTransition — navigations no longer unmount the current page to flash a skeleton.
- Hub: destination chunk warmed on pointer-down (like dock tabs), so the post-close navigation never waits on a download.
- Global: -webkit-tap-highlight-color: transparent (Android WebView grey tap flash on every button/card/tab).
- Sheets: open 500ms→300ms, close 300ms→200ms. Gallery full-screen image decodes async.
- Incoming call (user's WhatsApp-style change — fullScreenIntent removed): the non-foreground-service fallback path no longer uses CallStyle (which on API 31+ requires a foreground service OR a fullScreenIntent); it uses the regular high-priority template with coloured Answer/Decline. Not compiled here (no Android SDK).
- Gates: check:lock 0, check:rls 0, lint 0 errors, tsc 19 pre-existing/0 new, tests 808 pass / 2 skipped / 6 pre-existing, build 0. Not measured on a device.

## 2026-09-24 — Instant Decline from the call notification (+ smoothness pass)
- Decline no longer launches the app: native CallActionReceiver stops the ringer, removes the notification and clears Telecom instantly, then POSTs a per-call HMAC decline token (minted by send-push, `_shared/callActionToken.ts`) to the new `call-decline` Edge Function (verify_jwt=false; token is the auth). It applies decline_call()'s rules (receiver, in_progress, unclaimed); the existing trigger pushes 'call_rejected' to the caller. Offline/expired → "Tap to finish declining" notification (Android 12 forbids activity trampolines from receivers).
- Requires Supabase secret CALL_ACTION_SECRET + deploy of call-decline and send-push. Without it, Decline uses the old app-launch path (no regression).
- Answer unchanged (must open the app for the call UI; already the fastest allowed path).
- Kotlin NOT compiled here (no Android SDK). Token logic + wiring tested (8 tests).

## 2026-09-24 — "Self-hosted calling isn't set up on this build" (Vercel + APK)
- Cause: VITE_SIGNALING_URL is build-time only and was not set for the Vercel/APK builds → every build without it could never call.
- Fix: runtime config — signaling-ticket (authenticated) returns SIGNALING_PUBLIC_URL (new Supabase secret; `configOnly` mode + included with each ticket); the app fetches it on sign-in and before connecting, validates wss://, caches in localStorage; a build-time URL still wins. Bridge rebuilds a client created before the URL arrived. signalingConfig now uses the standard `import.meta.env.VITE_SIGNALING_URL`.
- Also: type-narrowing fix in useChatRealtimeMessages (alerts zip) — generated Message type lacks important/urgent.
- Requires a deployed signaling server (Docker; not Vercel). See docs/CALLING_SETUP_QUICKSTART.md.
- Gates: lock/rls/lint 0, tsc 19 pre-existing/0 new, tests 834 pass/2 skipped/6 pre-existing, build 0 (with and without the env var). Not tested on devices.

## 2026-09-24 — Fix: routePreload ReferenceError after refactor; iOS origin clarification
- App.tsx used `routePreload` after the map moved to src/lib/routePreload.ts, but only re-exported it (`export … from` creates no local binding) → ReferenceError in the idle warm-up effect on every app start. Added it to the existing import list.
- DO NOT change SIGNALING_ALLOWED_ORIGINS to `DuoSpace://localhost`: capacitor.config.json `ios.scheme` is the Xcode BUILD scheme (Capacitor docs), not the WebView URL scheme; that is `server.iosScheme`, default `capacitor` → the real iOS origin is `capacitor://localhost` (already correct).
- Real local e2e on this tree (real signaling server + LiveKit 1.13.7 + 2 WebRTC peers): PASS, incl. wrong-secret 401. Devices not tested.

## 2026-10-02 — v3.20.6 — Stop sharing (immediate) + 14-day scheduled unilateral unlink; AI eval Stage 4 additions
- BASE: `duospace-ai-phase3m-stage8-legal.zip` (v3.20.5) + `duospace-collab-fix.zip` (Blend push: migration 20261002100000, push types, Playlist) merged unchanged; this work sits on top.
- WHY: unlinking needed the partner's approval (20260920150000) and sharing could not be paused, so a person had no unilateral way out of either (KI-42).
- WHAT: `stop_sharing()` / `resume_sharing()` (migration 20261002110000, DB-enforced on locations / device status / new relationship_shares); `schedule_unlink()` / `cancel_scheduled_unlink()` / `execute_due_unlinks()` / `process_my_due_unlink()` (migration 20261002120000; 14 days server-fixed; partner pushed and can see the date; requester-only cancel; completes via `private.apply_unlink`). Push types `unlink_scheduled` / `unlink_completed` added beside the Blend types. Partner-screen UI, `ScheduledUnlinkHost`, `LocationContext.sharingActive` follows the state. The consent unlink is untouched.
- MIGRATION ORDER: both new migrations are numbered AFTER the collab one (my first draft used 20261002100000, which collides with `blend_collab_push`; same version prefix would break `schema_migrations`).
- AI EVAL (Phase 3M Stage 4): new fixtures `docs/ai-eval/adaptive_stopping.json` and `grounding.json` + suites in `src/test/ai-eval/fixtures.test.ts`.
- RISK: `apply_unlink` re-declared (one added UPDATE); `sharingActive` default-on until first read (DB triggers cover); pg_cron optional (lazy path covers).
- TEST: see KI-44 for what did and did not run. SQL NOT run on a database.


## 2026-10-04 — v3.22.9 follow-up fixes
- Age gate: age now computed against the LOCAL calendar day (was UTC → 18th-birthday rejected for UTC+ users); DOB `max` uses local date (`todayLocalISO`).
- ConnectionStatusPill: AnimatePresence mode="wait" (pills no longer stack side-by-side/off-centre); safe-area + 12px padding via inline style (safe-top/pt-3 conflict).
- useAppNative: duplicate "online" event (Capacitor + window) no longer resets the pill mid-reconnect.
- MessageComposer: removed "Explore your shared space — gallery, music & more" onboarding tooltip.

## 2026-10-04 — Cloudinary media foundation (additive, unverified)
media_assets + upload intents migration (20261004100000), 5 edge functions, `src/services/media/*`, Gallery/Memories dual-read/new-upload, Chat behind
`VITE_CLOUDINARY_CHAT_MEDIA_ENABLED` (default off). See docs/CLOUDINARY_MEDIA.md. Not run: typecheck/lint/test/build, migration, deploy.

## RI redesign audit (v3.22.9 base)
- Audit: contextual fact engine (contextual/extract.ts + present.ts), QuickReplySheet, UnderstandSheet, TodayInsight already implement the chat-first direction.
- Fix: UnderstandSheet no longer consumes AI_STANDARD quota (deterministic, no model/network). Test: test/contextual/understandNoQuota.test.ts.
- Not run: npm ci/typecheck/tests (sandbox has no network; node_modules absent).
- Context menu regrouped: [Reply/React/Copy] · [Help me reply/Understand] · [Edit/Pin/Delete], with dividers; labels wrap safely.
- QuickReplySheet: AI_STANDARD quota charged only when `usedModel` (local-model wording); rule-based replies are free.
- Deferred (needs a networked build to verify): Reflection.tsx split, i18n of remaining hardcoded English, sheet visual polish.
- i18n: context-menu labels + Reflection hint/More tools via tr(); Today empty copy now "Nothing to flag today." (test updated).
- Handoff written: .ai/HANDOFF_RI_REDESIGN.md; intent labels localized.
- Reflection.tsx 785→~635 lines: InsightsTab + shared helpers extracted (components/relationship/InsightsTab.tsx, reflectionShared.tsx). Added test/contextual/communicationFacts.test.ts (unrun).
- QuickReplySheet: long footer moved behind a subtle 'Why?' toggle. Native-review pack lists new p1 keys (no non-English strings added: policy requires native review).
- ReflectTab extracted; Reflection.tsx ~563 lines.
- Values/Expectations tabs extracted (Reflection.tsx ~278 lines); chips trimmed; red-team scan widened.
- Tab components: hardcoded English → tr(p1.rel.*); translations deferred to native review.
- tsc-based check fixed misplaced constants/unused imports from Reflection split. Full gates still pending (no network).

## RI/theme convergence pass (v3.23.0 base) — offline source work
- present.ts: Understand/Today/fallback text now resolved via tr() (p1.fact.*, p1.today.{request,question,feeling,uncertainty,apology}, p1.cantTell.{full,short}); fact kinds stay internal; exact quote passed as {q}. CANT_TELL const kept as English canonical for callers/tests.
- Wording: accusation → "They blamed you for something…", control → "They're asking for access to something private…".
- Today empty copy: "Nothing needs your attention today." (test updated).
- i18n: hi + mr now cover every p1.* key reachable from the RI UX (parity checked by script: every en p1 key appears in both). Reflection page chrome (title/subtitle/tabs) moved to tr(). Machine-authored; needs native review (see docs/NATIVE_LANGUAGE_REVIEW_PACK.md).
- Hinglish: NOT a locale. Exists only as input detection/lexicon (relationship/i18n/lang.ts). Adding a locale = language picker + splash + 12-catalog fallback changes → separate product decision. Hi/en unchanged.
- Ambient glow reduced (dark 0.10→0.07, light 0.07→0.05, engine + index.css kept in sync) and disabled under prefers-reduced-transparency and data-effects="lite".
- Tests written, NOT RUN: contextual/presentI18n.test.ts; themeVisualSystem.test.ts (glow alpha cap, semantic colours stable, CSS fallback contract, boot snapshot key in index.html); contextual.test.ts wording test.
- Audited, intentionally unchanged: Repair (reachable from Understand when ACCUSATION/EVENT facts exist; lives under Reflection ▸ More tools, no questionnaire), DailyCheckIn/AdaptiveQuestionCard (collapsed behind "More tools"), CompatibilityOverview (states only, no score/%), Reflection (hub tier "more"), cold-boot (inline index.html script + themeBoot.ts + snapshot already coherent), QuickReply quota (only when usedModel).
- Still English in hi/mr: DailyCheckIn, AdaptiveQuestionCard, CompatibilityOverview, PartnerComparison, RepairPanel, MemoryPanel, ValuesTab question bank (hardcoded, not p1 keys).
- Added language "Marathi (English letters)" (code `mrl`, short MRL): src/lib/uiCatalogs/mrl.ts (all ui/hub/settings/language keys + every p1.* key; parity checked by script), registered in i18n.ts + SPLASH_LANGUAGES. Hyphen-free code so fallbackChain = [mrl, en] (never Devanagari mr). <html lang> reports "mr-Latn". Safety guidance for mrl falls back to the reviewed English text (isRelLang false). Test written, NOT RUN: src/test/mrlLocale.test.ts. Machine-authored; needs native review.
- DailyCheckIn, AdaptiveQuestionCard, CompatibilityOverview chrome moved to tr() (p1.checkin.*, p1.adaptive.*, p1.compat.*) with en/hi/mr/mrl. Check-in tips/draft messages (checkin.ts) and the values question bank remain English (drafts are user-sendable text; need native-reviewed authoring). Not run.
- Added language "Hindi (English letters)" (code `hil`, short HIL): src/lib/uiCatalogs/hil.ts (same key set as mrl; parity checked), registered in i18n.ts + SPLASH_LANGUAGES, <html lang>="hi-Latn". Hyphen-free code → fallback [hil, en]. Safety guidance uses reviewed English (not a RelLang). Input-side Hinglish detection (relationship/i18n/lang.ts) unchanged. Test written, NOT RUN: src/test/hilLocale.test.ts. Machine-authored; needs native review. Supersedes the earlier "Hinglish is not a locale" note.

## Surprise lag / freeze fix (v3.22.9 base) — source-only, NOT built or run
Symptom: app laggy then "stuck" after the Surprise update, worst while/after a surprise opens.
Root causes found by code audit (no device profile available):
- `useDeviceTilt` kept x/y in React state and called setX/setY on every `deviceorientation` event (60–200 Hz on Android) → SurpriseReveal (≈30 framer-motion nodes, particles, iframe wrapper) re-rendered at sensor rate on top of springs + WebGL + the surprise iframe. Now: readings go straight into the caller's MotionValues via `onTilt`, coalesced to one write per frame, jitter < 0.004 dropped, listener attached once (stable handler via ref; also fixes the iOS listener being dropped when `active` flipped). Only listens while `visible`.
- `useChatSurprise.refreshSurprises` ran once per realtime event (opening one surprise writes ~5 rows → ~5 overlapping 3-query refreshes, answering out of order) and always replaced `surprises/eventStates/dualActivationById` with new objects → whole Chat timeline + `flatRows` rebuilt each time. Now: single in-flight refresh + one trailing run, 200 ms debounce for realtime bursts, state kept (same identity) when the data is unchanged, alive-guard after unmount.
- `VirtualRow` re-created its ResizeObserver (and forced a sync layout read) for every visible row whenever `flatRows` changed, because `onMeasure` identity changed. Now reads `onMeasure` through a ref; effect deps `[index]`.
- `close()` timer could null a surprise opened within the 400 ms exit window; now cancelled on open and guarded by id.
- SurpriseMessage sheen animated `left` (layout every frame per unopened surprise) → transform `x`/`skewX`.
Not changed on purpose: `html[data-surprise-open] *` backdrop-filter kill-switch (needed for the Android blur fix; costs one style recalc on open/close).
Not run: tsc, eslint, vitest, build (no node_modules/network). Syntax-checked the 5 edited files with TypeScript transpile only. Needs a real-device check.


## 2026-10-08 — auth
- Supabase client now uses PKCE + native Preferences storage; detectSessionInUrl off (see HANDOFF_2026-10-08_AUTH_PKCE.md).

## 2026-10-09 — Unlink prompt, password+OTP, code-based reset
See HANDOFF_2026-10-09_AUTH_UNLINK_PASSWORD.md.

## 2026-10-10 — Offline accept + signalling-down banner
WHY: calls hung/failed ungracefully when the device was offline at answer time or the signalling socket was down.
WHAT: offline guard in acceptIncomingCall; `signal-down` notice + SignalingDownBanner; livekit test mock fixed; Calls.tsx duplicate type field removed.
RISK: banner is debounced 4s and gated on signalingBridge.isConfigured(); accept guard trusts navigator.onLine (can be true on a dead link — watchdog still covers that).
TEST: vitest 2414 pass / 1 unrelated fail (singleStopSharingAction); vite build OK.
RESULT: see .ai/HANDOFF_2026-10-10_CALLING_STATES_AND_TICKS.md.

## 2026-10-10 — Connection label + adaptive capture
WHY: weak-link banners were generic and our camera kept encoding 720p on a weak link.
WHAT: connection kind (Wi-Fi/mobile data) in banner wording; own-camera capture tier adapts to link quality with 10s step-up hysteresis.
RISK: applyConstraints is best-effort per platform; failures are logged and ignored.
TEST: callNetworkPolicy 16/16, adapter+related 49/49, vite build.
RESULT: see handoff.

## 2026-10-10 — Top capture tier: 1080p, 90/60 fps by device
WHY: owner asked for up to 1080p and 90/60 fps on a good network.
WHAT: tier "full" = 1080p at device-best 90/60/30 fps; encoder ceilings 8 Mbps/90fps; 720p simulcast layer added; re-apply on camera publish.
RISK: heat/battery/uplink on long calls; encoder may cap above 60fps; ceilings are bounds only (BWE decides).
TEST: callNetworkPolicy 19/19, adapter+related 48/48, vite build.

## 2026-10-10 — Battery-saver / long-call cap
WHY: 1080p60-90 on long calls risks heat and battery drain.
WHAT: top-tier cap (30fps <=30% battery or after 20 min unplugged; 720p30 <=15%), lifted while charging.
RISK: proxy only, no real thermal signal; web builds often have no battery API.
TEST: callNetworkPolicy 25/25, adapter 14/14, vite build.

## 2026-10-13 — v3.23 slice 1
Cloud-backed Help me reply through existing ai-gateway (consent-gated, honest fallback, no client double charge). Unverified: no toolchain this session. See HANDOFF_2026-10-13_V3_23_CLOUD_REPLY.md

## 3.22.27 — 2026-10-15
- Fix stack-overflow crash: re-entrant removeChannel() in LocationContext + GroicContext realtime callbacks.

## 3.22.28 — 2026-10-15
- livekit-token warm-up no longer reported as an error: invokeEdgeFunction gained `quiet` (expected failures are thrown but not logged/captured as DS-API-001). All three warm-up sites (callWarmup + 2x CallContext) now go through the de-duplicated warmCallBackend().

## 3.22.29 — 2026-10-15
- Remove dead `sessionRoleRef.current !== "guest"` check in GroicContext advanceNext (guests return earlier); fixes tsc TS2367. No behaviour change.
