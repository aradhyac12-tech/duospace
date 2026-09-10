package com.duospace.audioengine

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A second, DELIBERATELY SEPARATE foreground MediaSessionService from
 * MediaPlaybackService (see that file). MediaPlaybackService owns a real
 * ExoPlayer decoding real Audius/SoundCloud audio bytes; this service
 * never plays or touches any audio at all — it exists purely so a
 * YouTube-provider track, which stays on GroicContext's existing hidden
 * YouTube IFrame (see docs/MUSIC_NATIVE_PLAYBACK.md's hard boundary on
 * never extracting/proxying YouTube audio), can still get:
 *
 *   1. Android foreground-service ("mediaPlayback" type) protection, so
 *      the OS does not freeze this app's process — and with it, the
 *      WebView running the YouTube IFrame — while the app is backgrounded
 *      and a YouTube track is the one actually playing. This is the exact
 *      same OS mechanism MediaPlaybackService already gets for the other
 *      two providers; YouTube tracks simply never had it before.
 *   2. A real android.media.session.MediaSession (via
 *      androidx.media3.session), so the OS notification shade,
 *      lock screen, Bluetooth headset, and car head units all get
 *      standard transport controls for a YouTube track too.
 *
 * HOW: `androidx.media3.common.SimpleBasePlayer` is Media3's own supported
 * API for exactly this situation — publishing a real, OS-recognized
 * Player/MediaSession whose reported state (playing, position, duration,
 * metadata) is driven by something OTHER than Media3 itself. Every method
 * below that would normally start real playback (play(), pause(), seek(),
 * skip) instead reports the requested change up to
 * AudioEnginePlugin.kt via `commandListener`, which forwards it to JS as a
 * `webKeepAliveCommand` event — GroicContext then drives the actual
 * YouTube IFrame (playVideo()/pauseVideo()/seekTo()), the same as any
 * other command source already routes through it. This service's own
 * `state` is then corrected by the JS side calling back into
 * `updateState()` (via AudioEnginePlugin.updateWebKeepAlive) — the same
 * "JS is the source of truth, native mirrors it" relationship
 * navigator.mediaSession already has with a browser tab, just backed by a
 * real Android foreground service+MediaSession instead of a page-level
 * Web API this app's process can be frozen out from under.
 */
@UnstableApi
class WebKeepAliveService : MediaSessionService() {

    interface CommandListener {
        fun onPlay()
        fun onPause()
        fun onNext()
        fun onPrevious()
        fun onSeek(positionSeconds: Double)
    }

    inner class LocalBinder : Binder() {
        fun getService(): WebKeepAliveService = this@WebKeepAliveService
    }

    private val binder = LocalBinder()
    var commandListener: CommandListener? = null

    private var mediaSession: MediaSession? = null
    private var player: MirrorPlayer? = null

    override fun onCreate() {
        super.onCreate()
        val p = MirrorPlayer()
        player = p
        val sessionActivityIntent = packageManager?.getLaunchIntentForPackage(packageName)
        val pendingIntent = sessionActivityIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        val builder = MediaSession.Builder(this, p)
            .setCallback(object : MediaSession.Callback {
                // Media3's default callback already routes standard
                // play/pause/seek/skip commands to the Player interface
                // below (onSetPlayWhenReady/onSeek/etc via MirrorPlayer's
                // own handlePlay/handlePause/... hooks) — no custom
                // command parsing needed here, unlike MediaPlaybackService
                // which doesn't override the callback either.
            })
        if (pendingIntent != null) builder.setSessionActivity(pendingIntent)
        mediaSession = builder.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    // Bound (not just started) so AudioEnginePlugin.kt can call
    // updateState()/stopSelf() directly — same LocalBinder pattern as
    // MediaPlaybackService, kept as a fully separate binder/service pair
    // so the two foreground services never share lifecycle.
    override fun onBind(intent: Intent?): IBinder {
        super.onBind(intent)
        return binder
    }

    fun updateState(playing: Boolean, positionSeconds: Double, durationSeconds: Double) {
        player?.mirrorState(playing, positionSeconds, durationSeconds)
    }

    fun updateMetadata(title: String, artist: String, artworkUri: android.net.Uri?) {
        player?.mirrorMetadata(title, artist, artworkUri)
    }

    override fun onDestroy() {
        mediaSession?.run {
            player?.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }

    /**
     * The actual SimpleBasePlayer subclass. Reports whatever state was
     * last pushed from JS; every mutating call (play/pause/seek/skip)
     * is forwarded to `commandListener` instead of performed locally,
     * since this player owns no real media — see this file's header.
     */
    private inner class MirrorPlayer : SimpleBasePlayer(mainLooper) {
        private var playing = false
        private var positionMs = 0L
        private var durationMs = 0L
        private var metadata = MediaMetadata.Builder().setTitle("DuoSpace").build()

        fun mirrorState(isPlaying: Boolean, positionSeconds: Double, durationSeconds: Double) {
            playing = isPlaying
            positionMs = (positionSeconds * 1000).toLong().coerceAtLeast(0)
            durationMs = (durationSeconds * 1000).toLong().coerceAtLeast(0)
            invalidateState()
        }

        fun mirrorMetadata(title: String, artist: String, artworkUri: android.net.Uri?) {
            metadata = MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setArtworkUri(artworkUri)
                .build()
            invalidateState()
        }

        override fun getState(): State {
            val item = MediaItemData.Builder("web-keep-alive-current")
                .setMediaItem(androidx.media3.common.MediaItem.Builder().setMediaMetadata(metadata).build())
                .setDurationUs(if (durationMs > 0) durationMs * 1000 else androidx.media3.common.C.TIME_UNSET)
                .build()
            return State.Builder()
                .setAvailableCommands(
                    Player.Commands.Builder()
                        .addAll(
                            Player.COMMAND_PLAY_PAUSE,
                            Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
                            Player.COMMAND_SEEK_TO_NEXT,
                            Player.COMMAND_SEEK_TO_PREVIOUS,
                            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                            Player.COMMAND_GET_METADATA,
                            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                            Player.COMMAND_GET_TIMELINE,
                        )
                        .build()
                )
                .setPlaylist(listOf(item))
                .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .setPlaybackState(if (durationMs > 0) Player.STATE_READY else Player.STATE_BUFFERING)
                .setContentPositionMs(positionMs)
                .build()
        }

        override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
            if (playWhenReady) commandListener?.onPlay() else commandListener?.onPause()
            return Futures.immediateVoidFuture()
        }

        override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
            when (seekCommand) {
                Player.COMMAND_SEEK_TO_NEXT -> commandListener?.onNext()
                Player.COMMAND_SEEK_TO_PREVIOUS -> commandListener?.onPrevious()
                else -> commandListener?.onSeek(positionMs / 1000.0)
            }
            return Futures.immediateVoidFuture()
        }
    }
}
