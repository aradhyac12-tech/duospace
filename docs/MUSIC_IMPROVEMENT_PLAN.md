# DuoSpace Music — improvement plan (audit + research)

> **How this was made.** Code audit of this repo + Supabase logs + established practice from Spotify / Apple Music /
> YouTube Music behaviour and Android Media3 / WebView performance guidance. It was written without live web access,
> so treat the "what the big apps do" parts as well-known patterns, not fresh benchmarks — verify specifics before
> building. Items marked **[done]** shipped in v3_22_36–45; **[device]** need a real phone to judge.

## 0. What is already strong (don't redo)
Taste profile + skip/complete learning, junk/duplicate filtering, lyrics (LRCLIB, synced), offline downloads, sleep timer,
native Media3 player with media-session/lock-screen controls, playback progress isolated in its own context, virtualised
chat lists, lazy routes, "Smooth mode". The foundation is good — the remaining gaps are *feel*, *background reliability*
and *a few missing features*.

## 1. Reliability (biggest trust factor — do first)
| # | Finding | Fix | Status |
|---|---|---|---|
| 1.1 | Native lookahead was 2 songs; background stalls | window 5 ahead, shuffle chain | done |
| 1.2 | Expired SoundCloud URL while WebView frozen | native refresh in the service | done (Android) |
| 1.3 | Spinner stuck although audio plays | clear on advancing playhead | done |
| 1.4 | YouTube can't play in background | twin substitution; hand-off | done (partial) |
| 1.5 | **Window URLs expire** (signed CDN URLs) for songs 4–5 ahead | resolve lazily in the player (`ResolvingDataSource`) so a URL is fetched when the song *starts*, not 15 min earlier | **next — biggest remaining reliability win** [device] |
| 1.6 | Token (~1 h) can expire while backgrounded → native refresh 401 | have the service call `refresh_session` itself, or ask JS to refresh on a `WorkManager`-free timer | todo |
| 1.7 | Queue is not persisted across app kills | persist `{queue, index, position}` (debounced) and restore paused | todo |
| 1.8 | `livekit-token` returned 400 on 15/15 calls in 24 h (calls) | inspect function/body | todo (not music) |
| 1.9 | No client log sink — device issues are invisible | optional opt-in `client_logs` table (rate-limited, 7-day TTL) | todo |

## 2. Perceived speed (what makes Spotify "instant")
* **Warm the next tap**: resolve URLs for on-screen rows (exists: `warmStreams`) — extend to the *first 3 results of search as you type* (debounced 250 ms).
* **Optimistic UI**: show the new title/cover immediately (exists) — and keep the previous audio playing until the new URL is ready instead of silence (today playback stops first).
* **Skeletons over spinners** on every shelf (exists on genre page; add to Home shelves).
* **CORS preflight**: every edge call costs a ~170 ms `OPTIONS`. Add `Access-Control-Max-Age: 86400` to the function's CORS headers (one line) — saves one round-trip per call after the first.
* **Region**: functions run in eu-central-1 while the user is in Bishkek. Fine today (1.3 s avg); revisit only if latency grows.
* **Image budget**: covers are 300 px thumbs in lists (done); serve `-t200x200` for 56 px rows (SoundCloud supports sizes) — ~3× fewer bytes.

## 3. Scroll & animation performance (WebView rules of thumb)
1. Animate only `transform` and `opacity` (the rest trigger layout/paint). Audit found + fixed `height` animation on equaliser bars earlier.
2. Avoid `filter: blur` / `backdrop-filter` on large or scrolling layers. Now: Smooth mode hides blobs/ambient blur; **auto-detects jank** and downgrades.
3. `content-visibility:auto` + `contain-intrinsic-size` on long rows **[done]**; consider `@tanstack/react-virtual` for lists > 200 (Liked Songs of heavy users).
4. Keep per-frame work off React: progress bar already in its own context; consider driving the scrubber with a CSS variable + `requestAnimationFrame` instead of state.
5. `will-change` only on elements that are animating *right now* (the cover crossfade) — never permanently.
6. Passive listeners everywhere; one `IntersectionObserver` for lazy images instead of per-image `loading=lazy` on huge lists.
7. Measure, don't guess: Chrome `chrome://inspect` → Performance on the S24 Ultra while scrolling; look for long "Recalculate Style"/"Layer" bars. **[device]**

## 4. UI / design direction (Apple Music + Spotify, kept tasteful)
* **Genre/browse tiles** — gradient + sheen + tilted glyph, staggered entrance **[done]**.
* **Header washes from artwork** on playlist/genre/home mix **[done]**.
* **Song-change motion**: cover crossfade, text slide-fade **[done]**; next: shared-element morph mini→full cover (framer `layoutId`) [device].
* **Now playing**: already strong. Add: tap-hold cover = zoom lightbox; swipe-down handle hint; progress "thumb grows while dragging" + time tooltip.
* **Dynamic accent colour**: extract the dominant colour server-side or via a tiny canvas *only for CORS-enabled art* (SoundCloud art is `sndcdn` — test `crossOrigin="anonymous"`); fall back to the blur wash (current approach).
* **Typography/spacing**: unify the section scale (title 20/700, subtitle 12/500, row 15/600) in one `MusicUI` token set so Home/Search/Genre/Library match; check 8-pt rhythm (rows are 56 px cover + 8 px padding ✓).
* **Haptics** on play/like/queue (done for play); add a light tick on scrubber detents and swipe-to-queue.
* **Empty/error states** with an illustration + one clear action (Retry / Open Downloads).

## 5. Recommendations & auto-next (what "best for the user" means)
Already: artist affinity with recency decay, skip penalty, no-repeat window. Added **[done]**: liked-song boost, time-of-day affinity.
Next, in order of value/effort:
1. **Completion-ratio signal** (listened % per song, not just done/skip) → weights taste smoothly. Data exists in the play log.
2. **Session mood continuity**: keep tempo/energy similar between consecutive songs. No BPM in SoundCloud data → proxy with genre tag + duration band + title keywords; or call a free audio-features source for the *current* song only.
3. **Artist diversity cap** (max 2 in a row from one artist unless the user keeps finishing them).
4. **Couples feature (unique to DuoSpace)**: "Songs you both liked" blend, "Play what [partner] is listening to", shared Daily Mix. Liked sync table (`music_library`) is already live — a join across the two partners' libraries is cheap.
5. **Daily Mix / Discover Weekly-style** shelves generated on-device from the taste profile + cached per day.
6. **Smart shuffle** (insert 1 recommended song every N): optional toggle.
7. **Cold start**: first-run picker of 5 genres/artists to seed the profile.

## 6. Missing player features (users expect these)
Crossfade **[done, Android, off by default]** · gapless (native window) ✓ · **sleep timer** ✓ · **playback speed** (plugin has it, no UI) · **loudness normalisation** (SoundCloud levels vary a lot — use `LoudnessEnhancer`/ExoPlayer `setSkipSilenceEnabled` option) · **equaliser** (Android `Equalizer` API) · **queue persistence** (1.7) · **Android Auto / Bluetooth browse** (`MediaLibraryService` instead of `MediaSessionService`) · **lock-screen like button** (custom `SessionCommand`) · **Share song card** · **Lyrics share**.

## 7. Suggested roadmap
1. *(1 week)* 1.5 lazy native URL resolve + 1.7 queue persistence + CORS max-age. → "never stuck, never forgets".
2. *(1 week)* completion-ratio signal, artist-diversity cap, cold-start picker, couples blend.
3. *(1 week)* mini→full shared-element morph, scrubber polish, typography tokens, skeletons on Home.
4. *(later)* loudness normalisation, EQ, playback-speed UI, Android Auto, iOS crossfade/native window.
