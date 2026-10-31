# SoundCloud stuck on "loading" — root cause & fix (2026-10-17)

**Evidence (phone diagnostics):** `streamHostProbe.reached=false` (5 s abort) to `playback.media-streaming.soundcloud.cloud`,
engine `state=loading, position=0, duration=0`, `loads: started=3 ok=0 err=0`. The edge function answered fine (HTTP 200, ~1.3 s);
the phone's network cannot reach SoundCloud's stream hosts, ExoPlayer waits silently (no error), so nothing ever "failed".

**What was wrong**
1. Proxy mode was only switched on AFTER a ~10 s playback stall → the first song always hung.
2. When it switched on, URLs already cached (JS resolver + the native lookahead window) were still DIRECT ones and kept being used.
3. Proxied HLS URLs were `…/functions/v1/sc-hls-proxy?u=…` — no `.m3u8` in the PATH. The native engine only sets the HLS mime type when
   the path contains `.m3u8`, so ExoPlayer treated the playlist as a progressive file it cannot parse.
4. The native self-heal always asked for proxied URLs regardless of the network.

**Fixes**
* `soundcloud-search` (deployed v25): proxied HLS URLs are now `…/sc-hls-proxy/playlist.m3u8?u=…&s=…` (sub-path ignored by the proxy).
* `soundcloudProvider.probeSoundCloudReachability()`: launch-time + before-first-play probe of the stream hosts; blocked → proxy ON,
  reachable → proxy OFF (re-evaluated every launch, cached 20 min). Stall-based enabling stays as the fallback.
* Proxy mode change → `streamResolver.clearProvider("soundcloud")` + native window re-sync + native service informed
  (`setResolverConfig({proxy})`, Kotlin `ResolverConfig.proxy`).
* Tests: `src/test/streamResolver.test.ts` ("SoundCloud proxy mode").

**To verify on the phone:** Details → Copy. Expect `cachedStreamUrl.host` = `<project>.supabase.co`, `pathTail` ending `playlist.m3u8`,
and `engine.loads` showing `ok>0`.
- 2026-10-17 (l) Music: usePullToRefresh hook + indicator on the music page (home trending/for-you/downloads, search re-run, genre refetch); Back from search now clears the query (header chevron via goBackInMusic + useBackHandler(searching)) instead of leaving to chat.
