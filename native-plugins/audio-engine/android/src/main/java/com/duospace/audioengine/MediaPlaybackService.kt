package com.duospace.audioengine

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * The actual native audio engine — an androidx.media3 (ExoPlayer) player
 * running inside a MediaSessionService, which is Android's own designed-
 * for-this-exact-purpose foreground-service class: it automatically
 * publishes a MediaSession that the lock screen, notification shade,
 * Bluetooth headsets, and car head units all already know how to render
 * controls for and send commands through, without this app hand-rolling
 * any of that plumbing.
 *
 * WHY THIS INSTEAD OF HAND-ROLLING AudioManager/NotificationCompat:
 *   - Audio focus: ExoPlayer's own `setAudioAttributes(attrs,
 *     handleAudioFocus = true)` makes it request audio focus when playing,
 *     automatically duck or pause on a transient loss (e.g. a
 *     notification chime from another app), and pause on a permanent loss
 *     (another app starting real playback) — exactly the AudioManager
 *     focus behavior requested, but using the library's own correct
 *     implementation of it rather than a second, hand-rolled
 *     AudioManager.OnAudioFocusChangeListener that could drift out of
 *     sync with what ExoPlayer itself is doing internally.
 *   - "Audio becoming noisy" (headset unplugged / Bluetooth disconnected
 *     while playing) — `setHandleAudioBecomingNoisy(true)` below is
 *     ExoPlayer's built-in handling of exactly this, which is also what
 *     the `ACTION_AUDIO_BECOMING_NOISY` broadcast exists for at the
 *     platform level.
 *   - Lock-screen/notification media controls + artwork — built from the
 *     MediaSession + the MediaItem's own MediaMetadata (title/artist/
 *     artwork) by MediaSessionService's default notification provider; no
 *     manual NotificationCompat.MediaStyle building needed.
 *   - Bluetooth/car play-pause-next-previous — delivered by the OS as
 *     standard MediaSession commands, handled by the same
 *     MediaSession.Callback as every other command source.
 */
class MediaPlaybackService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    /** Same-process bridge to AudioEnginePlugin.kt — both this service and
     *  the plugin live in the same app process, so a bound-service
     *  LocalBinder is the simplest correct way to let the plugin call
     *  straight into the live ExoPlayer instance and attach a
     *  Player.Listener, without the overhead/complexity of AIDL or a
     *  Messenger designed for cross-process communication this app
     *  doesn't need. */
    inner class LocalBinder : Binder() {
        fun getService(): MediaPlaybackService = this@MediaPlaybackService
    }
    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder? {
        // MediaSessionService's own onBind (used by the OS/MediaController
        // clients) takes precedence for its own well-known action; only
        // return our LocalBinder for the plugin's own bind Intent.
        return if (intent?.action == ACTION_LOCAL_BIND) binder else super.onBind(intent)
    }

    override fun onCreate() {
        super.onCreate()

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        player = exoPlayer

        // Session activity: tapping the lock-screen/notification artwork
        // should reopen the app (Capacitor's MainActivity), not do nothing.
        val sessionActivityIntent = packageManager.getLaunchIntentForPackage(packageName)
        val sessionActivityPendingIntent = sessionActivityIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        val session = MediaSession.Builder(this, exoPlayer)
            .apply { sessionActivityPendingIntent?.let { setSessionActivity(it) } }
            .setCallback(PlaybackSessionCallback())
            .build()
        mediaSession = session

        exoPlayer.addListener(playerEventListener)
    }

    /** Forwards every ExoPlayer event AudioEnginePlugin.kt cares about.
     *  Kept as a plain lambda-style listener the plugin attaches its own
     *  forwarding listener alongside, rather than the plugin polling
     *  getState() — see AudioEnginePlugin.kt's `attach()`. */
    private val playerEventListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            eventListener?.onPlaybackStateChanged(playbackState, player?.playWhenReady == true)
            if (playbackState == Player.STATE_ENDED) eventListener?.onPlaybackEnded()
        }
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            eventListener?.onIsPlayingChanged(isPlaying)
        }
        override fun onIsLoadingChanged(isLoading: Boolean) {
            eventListener?.onBufferingChanged(isLoading)
        }
        override fun onPlayerError(error: PlaybackException) {
            eventListener?.onError(error.message ?: "Playback error")
        }
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            eventListener?.onTrackChanged(mediaItem?.mediaId, player?.currentMediaItemIndex ?: -1)
        }
    }

    /** MediaSession.Callback is where every *external* command source
     *  (lock screen, notification, Bluetooth headset buttons, car head
     *  unit, Android Auto) actually lands — routing all of them through
     *  the same player calls the plugin's own JS-driven play()/pause()/
     *  next()/previous() use keeps a single source of truth: there is
     *  exactly one path a command can take to reach the player, regardless
     *  of whether it originated from a JS call or a Bluetooth headset. */
    private inner class PlaybackSessionCallback : MediaSession.Callback {
        // Default MediaSession.Callback implementation already maps the
        // standard transport commands (play/pause/seek/skip-next/skip-
        // previous) onto the underlying Player — which is exactly ExoPlayer
        // here — so next()/previous() from a Bluetooth headset or the lock
        // screen already do the right thing with zero code in this class.
        // A custom override would only be needed for a *non-standard*
        // command (this plugin doesn't define any), so this callback is
        // intentionally close to empty rather than re-implementing
        // behavior the base class already provides correctly.
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        // If nothing is actively playing when the user swipes the app away
        // from recents, there's no reason to keep the foreground service
        // (and its notification) alive — stop cleanly. If something IS
        // playing, deliberately do nothing here: that's the whole point of
        // background playback surviving "user left DuoSpace" (requirement
        // #6/#7 — playback continuing when the app is backgrounded or the
        // user navigates elsewhere must not depend on the Activity/task
        // still existing).
        val p = player
        if (p == null || !p.isPlaying) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        player?.removeListener(playerEventListener)
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        player = null
        super.onDestroy()
    }

    // ── Direct player access for AudioEnginePlugin.kt (same-process bind) ──

    fun getPlayer(): ExoPlayer? = player

    fun loadAndPlay(item: MediaItem, autoplay: Boolean) {
        val p = player ?: return
        p.setMediaItem(item)
        p.prepare()
        p.playWhenReady = autoplay
    }

    fun setQueue(items: List<MediaItem>, startIndex: Int) {
        val p = player ?: return
        p.setMediaItems(items, startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)), C.TIME_UNSET)
        p.prepare()
    }

    interface EventListener {
        fun onPlaybackStateChanged(playbackState: Int, playWhenReady: Boolean)
        fun onIsPlayingChanged(isPlaying: Boolean)
        fun onBufferingChanged(buffering: Boolean)
        fun onError(message: String)
        fun onTrackChanged(mediaId: String?, index: Int)
        fun onPlaybackEnded()
    }
    var eventListener: EventListener? = null

    companion object {
        const val ACTION_LOCAL_BIND = "com.duospace.audioengine.LOCAL_BIND"
    }
}

/** True for a SoundCloud HLS-transcoding stream URL. SoundCloud's signed,
 *  short-lived CDN URLs for the `hls` protocol keep a `.m3u8` path segment
 *  even once query params are appended (see soundcloud-search/index.ts's
 *  resolveStreamUrl for where these come from) — this is the same signal
 *  a browser's <video>/<audio> element or AVPlayer would key off, just
 *  applied explicitly since ExoPlayer's default MediaSource selection
 *  looks at the URI, not the response, and won't infer HLS on its own
 *  when the extension is buried before a query string. */
private fun isHlsStreamUrl(url: String): Boolean =
    url.substringBefore('?').contains(".m3u8", ignoreCase = true)

/** Helper so buildMediaItem's metadata (title/artist/artwork) shows up
 *  correctly on the lock screen/notification without every call site
 *  repeating the MediaMetadata.Builder boilerplate. Kept top-level
 *  (not a method on the service) since AudioEnginePlugin.kt also needs
 *  it when building items for setQueue(). */
fun buildMediaItem(id: String, title: String, artist: String, artworkUri: String?, streamUrl: String): MediaItem {
    val metadataBuilder = MediaMetadata.Builder()
        .setTitle(title)
        .setArtist(artist)
        .setIsPlayable(true)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
    if (!artworkUri.isNullOrEmpty()) {
        metadataBuilder.setArtworkUri(android.net.Uri.parse(artworkUri))
    }
    val builder = MediaItem.Builder()
        .setMediaId(id)
        .setUri(streamUrl)
        .setMediaMetadata(metadataBuilder.build())
    // FIX (SoundCloud auto-next silently not firing): without this hint,
    // an HLS transcoding's URL falls through to ExoPlayer's default
    // progressive-audio extractor, which can't parse an .m3u8 playlist —
    // that MediaItem then errors instead of ever completing, so
    // Player.STATE_ENDED (what onPlaybackEnded, and this app's queue
    // advance, are entirely driven by) never fires for it. Progressive
    // (plain MP3) transcodings — most Audius tracks, and the SoundCloud
    // tracks that still have one — are unaffected; this only changes
    // routing for URLs actually carrying an .m3u8 payload.
    if (isHlsStreamUrl(streamUrl)) {
        builder.setMimeType(MimeTypes.APPLICATION_M3U8)
    }
    return builder.build()
}
