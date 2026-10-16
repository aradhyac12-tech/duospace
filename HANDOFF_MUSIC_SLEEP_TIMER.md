# Handoff: sleep timer + fade (music / Groic)

## Changes
- NEW src/hooks/useSleepTimer.ts: end-timestamp based timer (15/30/45/60 min), 20 s linear fade via setVolume, then pause()
  and volume restored to 1. Re-checks on visibilitychange so a throttled timer still fires correctly on wake.
- src/pages/Groic.tsx: "Sleep timer" chip (moon icon) under the header while music plays; tap -> 15/30/45/60/Cancel; shows
  "Sleep in N min" while active.

## Honest limits
- JS timer, NOT the native service: if Android fully freezes the WebView with the screen off, the pause lands when it wakes.
  A guaranteed version needs the timer inside the native MediaPlaybackService (not done).
- Fade works for native-engine tracks (setVolume); YouTube-iframe tracks just pause at the end (no fade).
- Chip only shows while music is playing (or a timer is active).

## Still pending
- Phone-wide music scan (MediaStore): needs a native plugin registered through scripts/patch-native-permissions.mjs
  (android/ is generated, so a new Kotlin file must be added to its copy list + MainActivity registration). Not attempted
  because it can't be compiled here and could break the APK build. READ_MEDIA_AUDIO is already in the manifest.
- Personal playlists.

## Not verified
Syntax-checked only. Test: start a song, set 15 min, confirm chip countdown; lock screen and see if it pauses on time;
check fade on a SoundCloud/Audius track.

---
# Update: native "Scan phone" (done in this build)
- NEW native/android/DeviceMusicPlugin.kt (+ copy in android/app/.../com/duospace/app/): Capacitor plugin "DeviceMusic"
  (checkPermission / requestPermission / scan) over MediaStore. Music only (IS_MUSIC, >= 30 s), newest first, max 5000.
  Permission: READ_MEDIA_AUDIO (Android 13+) / READ_EXTERNAL_STORAGE (<=12) — both already in the manifest.
- scripts/patch-native-permissions.mjs: file added to NATIVE_KOTLIN_FILES; registerPlugin() added to both MainActivity
  templates AND a new idempotent patchDeviceMusicPlugin() (runs after patchSecureWindow) so already-patched projects get it.
  android/app/.../MainActivity.java already patched in this zip.
- src/lib/music/deviceMusic.ts: scanDeviceMusic(). localLibrary.ts: syncDeviceTracks() merges scans into My Files
  (ids ms<MediaStoreId>, optional `uri`, nothing copied); Remove only forgets a scanned song (never deletes the file);
  rescan re-adds it. Playback = rec.uri straight to ExoPlayer (DefaultDataSource handles content://).
- Groic.tsx: "Scan phone" button on the My Files page header, "Scan" on the shelf, big button in the empty state (Android only).
- Test: src/test/deviceMusicSync.test.ts.

## Not verified (important)
Kotlin NOT compiled, nothing built or run on a device. If the APK build fails, the likely culprit is DeviceMusicPlugin.kt
(annotation syntax) — delete that file + the registerPlugin line in MainActivity to roll back; JS degrades to a toast.
Check on device: Scan -> permission prompt -> songs appear -> tap one with screen off -> Remove -> rescan.
Known limits: no cover art for scanned songs (generated cover); a partner can't play them; scanned songs show offline automatically.

---
# Update: real album art for scanned songs
- DeviceMusicPlugin.kt: new getArt({id,size}) -> { art: "data:image/jpeg;base64,..." } (omitted if none). Tries the system
  thumbnail (Android 10+, loadThumbnail) then the picture embedded in the file tags (MediaMetadataRetriever); centre-cropped
  to 200px JPEG. Never rejects for "no art" (art is cosmetic).
- localLibrary.ts backfillDeviceArt(): background, ONE song at a time, only songs without a cover and not yet tried (artTried),
  saves covers as files in app storage (same as imported songs), flushes the list every 20 songs. Orphan covers are deleted
  when a scanned song disappears or is removed.
- deviceMusic.ts loadDeviceArt(): runs after each scan and once when the Music page opens (silently skipped without permission).
- Covers appear gradually after a big scan (a few songs per second). Songs with no art keep the generated cover.
Not verified: Kotlin not compiled; no device run. If art never shows, check logcat for DeviceMusic getArt and that the song
actually has embedded art / a MediaStore thumbnail.

---
# Update: personal playlists ("Your playlists")
- NEW src/lib/music/playlists.ts: create / rename / delete / add (dedupes) / remove, per account per device (localStorage,
  same scoping as Liked Songs). Limits: 50 playlists, 1000 songs each, 40-char names. Streamed songs keep a slim copy (no stream
  URL); uploaded/scanned songs store only their id and are looked up in My Files at read time (no big covers persisted).
- MusicUI.tsx: song "⋯" menu has a new "Add to my playlist" row (optional prop onAddToMyPlaylist; Our Playlist row unchanged).
- Groic.tsx: "Your playlists" shelf on the music home (New button, gradient cards), full playlist page with Play/Shuffle, filter,
  per-song remove, Rename and Delete (confirm). Add-to-playlist picker drawer with "New playlist". listView now also accepts `pl:<id>`.
- Test: src/test/playlists.test.ts.
## Limits / not verified
Not synced between phones and NOT shared with your partner (that is Our Playlist). A local song removed from My Files disappears
from the playlist view but stays in the saved list (reappears if re-imported/scanned with the same id; scanned ids are stable,
imported ids are not). Syntax-checked only; no build/tests/device run.

---
# Update: music home de-cluttered + re-sorted (src/pages/Groic.tsx only)
New home order: [offline banner] -> greeting/quick picks -> "Your mix" hero -> **Your library** hub (2x2 tiles: Liked Songs,
My Files, Playlists, Our Playlist; each shows a count) -> Recent searches -> Recently played -> Because you searched ->
Made for you -> Our Playlist (shared) -> Downloads (native, hidden when empty) -> **Discover**: Trending by language ->
Popular on Free Music -> Browse by mood -> Browse all.
- REMOVED from the home (replaced by the hub + their full pages): the inline My Files shelf (Upload/Scan/Play/Shuffle/remove live
  on the My Files page), the inline Liked Songs shelf, and the "Your playlists" shelf (new full **Playlists** page: list, New).
- Header: Upload is now an icon-only button (less crowding next to "Together").
- No data/logic changes; only JSX blocks moved + hub + Playlists page. listView accepts "playlists".
Not verified visually (syntax-checked only). Tell me what still feels busy after you see it on the phone (e.g. hero size,
mood/genre grids, spacing) and I'll tune those.
