package com.duospace.audioengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import java.net.HttpURLConnection
import java.net.URL

/**
 * The native audio engine: one androidx.media3 ExoPlayer, one foreground
 * service, ONE MediaSession, ONE notification.
 *
 * ── WHY THIS IS NO LONGER A MediaSessionService (2026-09-20) ────────────────
 * Symptom: the OS reported the now-playing notification as active
 * ("confirmed visible by the OS", NotificationManager.activeNotifications
 * contained id 4271, and KDE Connect — a NotificationListenerService — mirrored
 * it to a PC), yet nothing ever appeared on the phone itself, for BOTH
 * YouTube-driven and ExoPlayer-driven tracks.
 *
 * That combination is the signature of a MediaStyle notification that the
 * system UI intentionally pulls out of the normal shade and hands to its
 * media carousel (Quick Settings / lock screen player) — and then the
 * carousel drops it. The carousel keys everything on the MediaSession token
 * carried by the notification and on which of the package's *active
 * sessions* is the "real" one. This app used to publish up to FOUR sessions
 * for a single package at the same time:
 *   1. MediaPlaybackService's Media3 MediaSession (wrapping ExoPlayer),
 *   2. that Media3 session's own internal MediaSessionCompat,
 *   3. a hand-made "legacy" MediaSessionCompat whose token was the ONLY one
 *      the notification pointed at,
 *   4. WebKeepAliveService's second Media3 session (YouTube mirror), which
 *      also posted its own second automatic notification.
 * The session actually playing (1/2/4) was never the one the notification's
 * token referred to (3), so the carousel had a "playing" session with no
 * matching notification data and a notification whose session it didn't
 * consider current — exactly the shape that gets filtered out.
 *
 * Fix: exactly one MediaSessionCompat (below) is the single source of truth
 * for the OS — metadata, playback state, position, actions, media-button
 * routing — for BOTH native (ExoPlayer) and external (YouTube) playback, and
 * the one notification's MediaStyle token points at it. Media3 is still used
 * for what it is best at (ExoPlayer decoding, audio focus, becoming-noisy
 * handling); it just no longer publishes a second, competing session.
 *
 * ── OTHER DEFECTS FIXED IN THE SAME PASS (all visible in the device log) ─
 *  - Notification churn: every 1s YouTube position tick rebuilt and re-posted
 *    the whole notification (and startForeground'd again), and every track
 *    start posted 3-4 times within 10ms. NotificationManagerService sheds an
 *    app's notification updates once its enqueue rate estimate exceeds ~5/s,
 *    so a burst at track start could get the *real* update dropped. Posts are
 *    now de-duplicated by content signature; position ticks only refresh the
 *    session state (which is all the scrubber reads).
 *  - Foreground flapping: a transient isPlaying=false (ExoPlayer buffering an
 *    HLS SoundCloud track, 4-5 flips in 3s in the log) detached the service
 *    from foreground each time. Foreground now follows "wants to play"
 *    (playWhenReady while not idle/ended), not the instantaneous isPlaying.
 *  - startForeground() failing (Android 12+ background-start restrictions)
 *    used to mean NO notification at all; it now falls back to a plain
 *    notify() so the controls are still shown.
 *  - A paused-then-resumed ExoPlayer item could overwrite the notification of
 *    the YouTube track that was actually playing; ExoPlayer events are now
 *    ignored for notification purposes while external playback is active.
 *  - Artwork download had no timeouts and could hand the OS a multi-megapixel
 *    bitmap; it is now time-boxed, down-sampled and square-cropped.
 */
class MediaPlaybackService : Service() {

    private var player: ExoPlayer? = null
    private var sessionActivityPendingIntent: PendingIntent? = null
    private var session: MediaSessionCompat? = null

    private var currentTrackTitle: String? = null
    private var currentTrackArtist: String? = null
    private var currentTrackArtworkUrl: String? = null
    private var currentArtworkBitmap: Bitmap? = null

    // YouTube-sourced tracks never go through this file's ExoPlayer (they play
    // in the web/iframe player); JS mirrors that player's state into this same
    // session + notification. See updateExternalNowPlaying().
    private var externalPlaybackActive = false
    private var externalIsPlaying = false

    // Position/duration/speed the OS interpolates the scrubber from. Refreshed
    // by reportPlaybackProgress() (native) and updateExternalPlaybackState()
    // (YouTube) roughly once a second — session state only, no notification
    // rebuild.
    private var lastKnownPositionMs = 0L
    private var lastKnownDurationMs = 0L
    private var lastKnownSpeed = 1f

    private var artworkLoadRequestId = 0
    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Notification bookkeeping ────────────────────────────────────────
    private var isForeground = false
    private var lastPostedKey: String? = null
    // PERF/ANR FIX: updateSessionState() runs about once a SECOND (every position tick, for
    // native tracks and YouTube keep-alive alike). It used to rebuild MediaMetadata and
    // re-send it — including the artwork bitmap twice (ALBUM_ART + DISPLAY_ICON) — to
    // system_server on every tick: megabytes of Binder traffic per minute on the main thread,
    // which is what made the whole app stutter/hang while a track played. Metadata now goes
    // out only when its content actually changed; ticks only refresh the (tiny) playback state.
    private var lastMetadataKey: String? = null
    private var notificationPosted = false
    private var notificationCheckToken = 0
    private var repostAttempted = false
    private var lastReportedIssue: String? = null
    private var confirmedVisibleOnce = false

    // ── Public API used by AudioEnginePlugin ────────────────────────────

    private fun captureTrackMetadata(item: MediaItem?) {
        externalPlaybackActive = false
        val metadata = item?.mediaMetadata
        currentTrackTitle = metadata?.title?.toString()?.takeIf { it.isNotBlank() }
        currentTrackArtist = metadata?.artist?.toString()?.takeIf { it.isNotBlank() }
        lastKnownPositionMs = 0L
        lastKnownDurationMs = 0L
        loadArtworkIfChanged(metadata?.artworkUri?.toString())
    }

    /** JS-driven mirror for playback that isn't happening in this service's
     *  ExoPlayer (YouTube, via the web/iframe player). */
    fun updateExternalNowPlaying(
        title: String?,
        artist: String?,
        artworkUrl: String?,
        isPlaying: Boolean,
        positionSeconds: Double = 0.0,
        durationSeconds: Double = 0.0,
    ) {
        externalPlaybackActive = true
        externalIsPlaying = isPlaying
        currentTrackTitle = title?.takeIf { it.isNotBlank() }
        currentTrackArtist = artist?.takeIf { it.isNotBlank() }
        lastKnownPositionMs = (positionSeconds * 1000).toLong().coerceAtLeast(0)
        lastKnownDurationMs = (durationSeconds * 1000).toLong().coerceAtLeast(0)
        lastKnownSpeed = if (isPlaying) 1f else 0f
        loadArtworkIfChanged(artworkUrl)
    }

    fun clearExternalNowPlaying() {
        if (!externalPlaybackActive) return
        externalPlaybackActive = false
        stopPlaybackNotification()
    }

    /** Position/state-only update for a YouTube track (called about once a
     *  second from JS). Never wipes title/artist/artwork; only re-posts the
     *  notification if play/pause actually changed (see the de-dupe in
     *  postNotificationInternal). */
    fun updateExternalPlaybackState(isPlaying: Boolean, positionSeconds: Double = 0.0, durationSeconds: Double = 0.0) {
        if (!externalPlaybackActive) return
        externalIsPlaying = isPlaying
        lastKnownPositionMs = (positionSeconds * 1000).toLong().coerceAtLeast(0)
        if (durationSeconds > 0) lastKnownDurationMs = (durationSeconds * 1000).toLong()
        lastKnownSpeed = if (isPlaying) 1f else 0f
        postNotificationInternal(isPlaying)
    }

    /** ~1s tick while a native track plays: refreshes the session's position
     *  only (the OS interpolates the scrubber between ticks). */
    fun reportPlaybackProgress(positionMs: Long, durationMs: Long, speed: Float) {
        if (externalPlaybackActive) return
        val title = currentTrackTitle ?: return
        lastKnownPositionMs = positionMs.coerceAtLeast(0)
        lastKnownDurationMs = durationMs.coerceAtLeast(0)
        lastKnownSpeed = speed
        updateSessionState(title, wantsPlayback())
    }

    fun getPlayer(): ExoPlayer? = player

    fun loadAndPlay(item: MediaItem, autoplay: Boolean) {
        val p = player ?: return
        // Order matters: the notification path bails out if the player has no
        // media item, so the item must be set before metadata is captured.
        p.setMediaItem(item)
        captureTrackMetadata(item)
        p.prepare()
        p.playWhenReady = autoplay
    }

    fun setQueue(items: List<MediaItem>, startIndex: Int) {
        val p = player ?: return
        val index = startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0))
        // FIX (play -> pause -> play stutter): JS calls setQueue() right after
        // load() with a window around the track that is ALREADY playing.
        // setMediaItems(items, index, TIME_UNSET) tears down and re-prepares
        // that item, restarting it from 0 (audible pause + restart). When the
        // playing item is the same one, keep it untouched and only swap the
        // neighbours around it, so playback is never interrupted.
        val target = items.getOrNull(index)
        val currentId = p.currentMediaItem?.mediaId
        if (target != null && currentId != null && currentId == target.mediaId && p.mediaItemCount > 0) {
            val curIdx = p.currentMediaItemIndex
            if (curIdx < p.mediaItemCount - 1) p.removeMediaItems(curIdx + 1, p.mediaItemCount)
            if (curIdx > 0) p.removeMediaItems(0, curIdx)
            if (index > 0) p.addMediaItems(0, items.subList(0, index))
            if (index < items.size - 1) p.addMediaItems(items.subList(index + 1, items.size))
            return
        }
        p.setMediaItems(items, index, C.TIME_UNSET)
        captureTrackMetadata(items.getOrNull(index))
        p.prepare()
    }

    // ── Artwork ─────────────────────────────────────────────────────────

    private fun loadArtworkIfChanged(artworkUrl: String?) {
        if (artworkUrl == currentTrackArtworkUrl) {
            postCurrent()
            return
        }
        currentTrackArtworkUrl = artworkUrl
        currentArtworkBitmap = null
        val requestId = ++artworkLoadRequestId
        postCurrent()
        if (artworkUrl.isNullOrBlank()) return
        Thread {
            val bitmap = downloadArtwork(artworkUrl)
            // Back on main: ExoPlayer must only be touched from its own thread.
            mainHandler.post {
                if (requestId == artworkLoadRequestId && bitmap != null) {
                    currentArtworkBitmap = bitmap
                    postCurrent()
                }
            }
        }.start()
    }

    /** Time-boxed, down-sampled (<= ~512px), square-cropped artwork fetch. A
     *  slow/huge/bad image must never delay or break the notification. */
    private fun downloadArtwork(url: String): Bitmap? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 6000
                readTimeout = 8000
                instanceFollowRedirects = true
            }
            val bytes = connection.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 512) sample *= 2
            val decoded = BitmapFactory.decodeByteArray(
                bytes, 0, bytes.size,
                BitmapFactory.Options().apply { inSampleSize = sample },
            ) ?: return null
            val side = minOf(decoded.width, decoded.height)
            if (decoded.width == decoded.height) decoded
            else Bitmap.createBitmap(decoded, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side)
        } catch (_: Throwable) {
            null
        } finally {
            try { connection?.disconnect() } catch (_: Throwable) { /* best effort */ }
        }
    }

    // ── Binding ─────────────────────────────────────────────────────────

    /** Same-process bridge to AudioEnginePlugin.kt. */
    inner class LocalBinder : Binder() {
        fun getService(): MediaPlaybackService = this@MediaPlaybackService
    }
    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder? =
        if (intent?.action == ACTION_LOCAL_BIND) binder else null

    // Notification button taps (PendingIntent.getService) land here.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            // Headset/Bluetooth PLAY after this process was killed lands here (see setMediaButtonReceiver
            // in onCreate): route it through the session callbacks -> dispatchTransport.
            Intent.ACTION_MEDIA_BUTTON -> {
                try { androidx.media.session.MediaButtonReceiver.handleIntent(session, intent) } catch (_: Throwable) { /* best effort */ }
            }
            ACTION_PLAY_PAUSE -> dispatchTransport(if (wantsPlayback()) "pause" else "play")
            ACTION_NEXT -> dispatchTransport("next")
            ACTION_PREVIOUS -> dispatchTransport("previous")
            // Fired by the deleteIntent when the user swipes away the paused notification.
            "STOP_SELF" -> stopPlaybackNotification()
        }
        // Never restart into an empty, notification-less state after a kill.
        return START_NOT_STICKY
    }

    /** One entry point for every command source (notification buttons,
     *  lock screen, Bluetooth, headset). YouTube commands are handed to JS;
     *  native ones go straight to ExoPlayer. */
    private fun dispatchTransport(action: String) {
        if (externalPlaybackActive) {
            eventListener?.onExternalTransportCommand(action)
            return
        }
        val p = player ?: return
        when (action) {
            "play" -> {
                if (p.mediaItemCount == 0 && restoreLastTrack()) return
                // An errored/idle player (stream dropped while paused) must be re-prepared first.
                if (p.playbackState == Player.STATE_IDLE && p.mediaItemCount > 0) p.prepare()
                p.play()
            }
            "pause" -> p.pause()
            // The native queue is only a small window (previous + 2 ahead, in
            // list order). When it cannot satisfy the command (end of window,
            // single-item queue, shuffle) the button used to do NOTHING. Hand
            // it to JS, which owns the real queue / shuffle / auto-next.
            "next" ->
                if (p.hasNextMediaItem()) p.seekToNextMediaItem()
                else eventListener?.onExternalTransportCommand("next")
            "previous" ->
                if (p.hasPreviousMediaItem() || p.currentPosition > PREVIOUS_RESTART_THRESHOLD_MS) p.seekToPreviousMediaItem()
                else eventListener?.onExternalTransportCommand("previous")
        }
    }

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()

        // SPEED FIX (slow start after tapping play): ExoPlayer's default load
        // control waits until 2.5s of audio is buffered before it starts
        // (5s after a rebuffer) — noticeable on every tap, and worst on HLS
        // (SoundCloud). Start as soon as ~0.8s is buffered; keep buffering up
        // to 50s ahead as before. (min, max, forPlayback, forPlaybackAfterRebuffer)
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 50_000, 800, 2_000)
            .build()

        val exoPlayer = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            // Keep CPU + Wi-Fi awake for streamed audio with the screen off.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player = exoPlayer

        // Tapping the now-playing notification brings the existing app task
        // forward (no relaunch/reset); a relaunched app reattaches via
        // GroicContext's getState() restore.
        sessionActivityPendingIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        }?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        session = MediaSessionCompat(this, "DuoSpaceMedia").apply {
            sessionActivityPendingIntent?.let { setSessionActivity(it) }
            // null = this service handles media buttons itself via onStartCommand().
            // Setting null here prevents a second, redundant MediaButtonReceiver
            // broadcast path from racing with our own onStartCommand() handler
            // when a Bluetooth headset or wired headset button is pressed.
            // RESTORED (was null): with no receiver registered, a Bluetooth/headset PLAY press after Android
            // killed this process had nobody to wake. Pointing it at THIS service lets the OS restart it.
            setMediaButtonReceiver(
                PendingIntent.getService(
                    this@MediaPlaybackService, 7,
                    Intent(Intent.ACTION_MEDIA_BUTTON).setClass(this@MediaPlaybackService, MediaPlaybackService::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = dispatchTransport("play")
                override fun onPause() = dispatchTransport("pause")
                override fun onSkipToNext() = dispatchTransport("next")
                override fun onSkipToPrevious() = dispatchTransport("previous")
                override fun onStop() = dispatchTransport("pause")
                override fun onSeekTo(pos: Long) {
                    if (externalPlaybackActive) eventListener?.onExternalSeek(pos / 1000.0)
                    else player?.seekTo(pos)
                }
                // MEDIA BUTTON FIX: onMediaButtonEvent is called for hardware
                // media key events routed through the MediaSession. Without this,
                // some Bluetooth headsets (especially those that send ACTION_DOWN
                // + ACTION_UP as separate KeyEvents rather than a single click
                // ACTION_DOWN with KeyEvent.FLAG_LONG_PRESS) would fire this
                // twice for one button press. Let super() handle the dispatch —
                // it already does the right deduplication.
                override fun onMediaButtonEvent(mediaButtonEvent: android.content.Intent): Boolean =
                    super.onMediaButtonEvent(mediaButtonEvent)
            })
            // VOLUME ROUTING: hardware volume keys adjust STREAM_MUSIC while the
            // controls are shown. Once, before the session is first activated.
            setPlaybackToLocal(android.media.AudioManager.STREAM_MUSIC)
            isActive = true
        }

        exoPlayer.addListener(playerEventListener)
    }

    private val playerEventListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            eventListener?.onPlaybackStateChanged(playbackState, player?.playWhenReady == true)
            if (playbackState == Player.STATE_ENDED) {
                eventListener?.onPlaybackEnded()
                // Queue exhausted (not just advancing): clean up rather than
                // leaving a stale "paused" notification forever.
                if (!externalPlaybackActive && player?.hasNextMediaItem() != true) stopPlaybackNotification()
                return
            }
            postNativeIfActive()
        }
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = postNativeIfActive()
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // FIX (pause -> resume -> pause flicker): ExoPlayer's isPlaying is false
            // while it is merely BUFFERING or switching tracks even though the user
            // still wants playback (playWhenReady == true). Forwarding that as
            // "paused" made the app flash the pause state on every song change and
            // every HLS rebuffer. Only report "not playing" to JS when playback is
            // genuinely stopped: the user/focus/notification paused it
            // (playWhenReady == false) or the item ended. Buffering is already
            // reported separately by onPlaybackStateChanged as "loading".
            val p = player
            val genuinelyStopped = p != null && (!p.playWhenReady || p.playbackState == Player.STATE_ENDED)
            if (isPlaying || genuinelyStopped) eventListener?.onIsPlayingChanged(isPlaying)
            postNativeIfActive()
        }
        override fun onIsLoadingChanged(isLoading: Boolean) {
            eventListener?.onBufferingChanged(isLoading)
        }
        override fun onPlayerError(error: PlaybackException) {
            eventListener?.onError(error.message ?: "Playback error")
        }
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            eventListener?.onTrackChanged(mediaItem?.mediaId, player?.currentMediaItemIndex ?: -1)
            captureTrackMetadata(mediaItem)
        }
        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            // Seek / auto-advance: make the scrubber jump immediately.
            if (externalPlaybackActive) return
            val title = currentTrackTitle ?: return
            lastKnownPositionMs = newPosition.positionMs.coerceAtLeast(0)
            updateSessionState(title, wantsPlayback())
        }
    }

    private fun postNativeIfActive() {
        if (!externalPlaybackActive) postPlaybackNotification()
    }

    /** Re-post for whichever source currently owns the notification. */
    private fun postCurrent() {
        if (externalPlaybackActive) postNotificationInternal(externalIsPlaying) else postPlaybackNotification()
    }

    /** What the person is asking for, not what the decoder is doing this
     *  instant: a track that is buffering because playWhenReady is true is
     *  still "playing" as far as the notification, session and foreground
     *  state are concerned. */
    private fun wantsPlayback(): Boolean {
        if (externalPlaybackActive) return externalIsPlaying
        val p = player ?: return false
        return p.playWhenReady &&
            p.playbackState != Player.STATE_IDLE &&
            p.playbackState != Player.STATE_ENDED
    }

    private fun postPlaybackNotification() {
        val p = player
        if (p == null || p.mediaItemCount == 0) {
            stopPlaybackNotification()
            return
        }
        postNotificationInternal(isPlaying = wantsPlayback())
    }

    // ── Posting ─────────────────────────────────────────────────────────

    private fun postNotificationInternal(isPlaying: Boolean) {
        val title = currentTrackTitle
        if (title == null) {
            Log.d(TAG, "postNotificationInternal: no title yet, not posting")
            return
        }
        // De-dupe: identical content that the OS is already holding only needs
        // its session state (position) refreshed, not a rebuilt notification.
        val key = "$title|$currentTrackArtist|$currentTrackArtworkUrl|" +
            "${currentArtworkBitmap?.let { System.identityHashCode(it) }}|$isPlaying"
        if (notificationPosted && key == lastPostedKey) {
            updateSessionState(title, isPlaying)
            return
        }
        // DIAGNOSTIC: now only logs REAL posts (was every 1s tick + bursts).
        Log.d(TAG, "postNotificationInternal called: title=$title isPlaying=$isPlaying externalPlaybackActive=$externalPlaybackActive")
        try {
            updateSessionState(title, isPlaying)
            val notification = buildPlaybackNotification(title, isPlaying)
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (isPlaying) {
                mainHandler.removeCallbacks(detachWhenPausedRunnable)
                if (!isForeground) promoteToForeground(notification, manager) else manager.notify(NOTIFICATION_ID, notification)
            } else {
                // FIX (paused for a while -> app/music "closes", Bluetooth play does nothing):
                // detaching from foreground the instant playback paused left a plain background
                // service that Android kills within minutes (START_NOT_STICKY, so it never came
                // back) — a later Bluetooth/headset PLAY had nothing to talk to. Stay foreground
                // while paused and only let go after a long idle period.
                manager.notify(NOTIFICATION_ID, notification)
                saveResumePoint()
                scheduleDetachWhenLongPaused()
            }
            lastPostedKey = key
            notificationPosted = true
            scheduleNotificationVisibilityCheck()
        } catch (e: Throwable) {
            val message = e.message ?: e.javaClass.simpleName
            Log.e(TAG, "Now-playing notification failed to post: $message", e)
            // NOT eventListener.onError(): that would look like the song failing.
            eventListener?.onNotificationIssue("POST_FAILED: $message")
        }
    }

    /** startForeground with a guaranteed fallback: if the OS refuses to make
     *  us foreground (Android 12+ background-start rules, OEM restrictions),
     *  the controls must still show as an ordinary notification. */
    private fun promoteToForeground(notification: Notification, manager: NotificationManager) {
        try {
            // Make sure the service is a *started* one before promoting; a
            // bound-only service loses foreground status when unbound.
            try {
                startService(Intent(this, MediaPlaybackService::class.java))
            } catch (_: Throwable) { /* already running / not allowed: fine */ }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
        } catch (e: Throwable) {
            Log.w(TAG, "startForeground refused (${e.javaClass.simpleName}: ${e.message}) — posting as a plain notification instead", e)
            isForeground = false
            manager.notify(NOTIFICATION_ID, notification)
        }
    }

    // ── Visibility verification ─────────────────────────────────────────

    private fun scheduleNotificationVisibilityCheck() {
        val token = ++notificationCheckToken
        mainHandler.postDelayed({
            if (token == notificationCheckToken) verifyNotificationVisible()
        }, NOTIFICATION_CHECK_DELAY_MS)
    }

    private fun verifyNotificationVisible() {
        if (currentTrackTitle == null) return
        val reason = diagnoseNotificationProblem()
        if (reason == null) {
            repostAttempted = false
            lastReportedIssue = null
            if (!confirmedVisibleOnce) {
                confirmedVisibleOnce = true
                Log.i(TAG, "Now-playing notification confirmed visible by the OS (channel=$NOTIFICATION_CHANNEL_ID, id=$NOTIFICATION_ID)")
                eventListener?.onNotificationVisible()
            }
            return
        }
        if (!repostAttempted && (reason == ISSUE_NOT_ACTIVE || reason == ISSUE_CHANNEL_MISSING)) {
            repostAttempted = true
            if (reason == ISSUE_CHANNEL_MISSING) ensureNotificationChannel()
            lastPostedKey = null // force a real re-post past the de-dupe
            postCurrent()
            return
        }
        repostAttempted = false
        Log.w(TAG, "Now-playing notification is not visible: $reason")
        if (reason != lastReportedIssue) {
            lastReportedIssue = reason
            eventListener?.onNotificationIssue(reason)
        }
    }

    /** null = the OS is holding our notification as expected. */
    private fun diagnoseNotificationProblem(): String? {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            Log.d(TAG, "diagnoseNotificationProblem: app notifications are OFF at the OS level")
            return ISSUE_APP_DISABLED
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID)
            if (channel == null) {
                Log.d(TAG, "diagnoseNotificationProblem: channel $NOTIFICATION_CHANNEL_ID does not exist")
                return ISSUE_CHANNEL_MISSING
            }
            if (channel.importance == NotificationManager.IMPORTANCE_NONE) {
                Log.d(TAG, "diagnoseNotificationProblem: channel $NOTIFICATION_CHANNEL_ID is blocked (importance=NONE)")
                return ISSUE_CHANNEL_BLOCKED
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val active = try { manager.activeNotifications } catch (_: Throwable) { null }
            if (active != null && active.none { it.id == NOTIFICATION_ID }) {
                Log.d(TAG, "diagnoseNotificationProblem: OS reports ${active.size} active notification(s) for this app, none with id=$NOTIFICATION_ID")
                return ISSUE_NOT_ACTIVE
            }
        }
        return null
    }

    // ── Resume point (survives process death) ───────────────────────────
    private val resumePrefs by lazy { getSharedPreferences("duo_audio_resume", Context.MODE_PRIVATE) }

    /** Remember what was loaded + where we paused, so a headset PLAY after the process was killed can
     *  bring the song back. Only stable (non-http) URLs are restorable — signed stream URLs expire. */
    private fun saveResumePoint() {
        try {
            val p = player ?: return
            val item = p.currentMediaItem ?: return
            val uri = item.localConfiguration?.uri?.toString() ?: return
            if (uri.startsWith("http://") || uri.startsWith("https://")) { resumePrefs.edit().clear().apply(); return }
            val md = item.mediaMetadata
            resumePrefs.edit()
                .putString("id", item.mediaId).putString("uri", uri)
                .putString("title", md.title?.toString() ?: "").putString("artist", md.artist?.toString() ?: "")
                .putString("art", md.artworkUri?.toString())
                .putLong("pos", p.currentPosition.coerceAtLeast(0)).apply()
        } catch (_: Throwable) { /* best effort */ }
    }

    private fun restoreLastTrack(): Boolean {
        return try {
            val p = player ?: return false
            val uri = resumePrefs.getString("uri", null) ?: return false
            val item = buildMediaItem(
                resumePrefs.getString("id", "") ?: "", resumePrefs.getString("title", "") ?: "",
                resumePrefs.getString("artist", "") ?: "", resumePrefs.getString("art", null), uri,
            )
            p.setMediaItem(item, resumePrefs.getLong("pos", 0L))
            captureTrackMetadata(item)
            p.prepare()
            p.playWhenReady = true
            true
        } catch (_: Throwable) { false }
    }

    private val detachWhenPausedRunnable = Runnable {
        if (!wantsPlayback() && isForeground) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH)
                else {
                    @Suppress("DEPRECATION")
                    stopForeground(false)
                }
            } catch (_: Throwable) { /* best effort */ }
            isForeground = false
        }
    }

    /** Keep the paused session alive (foreground) for a long while so a later Bluetooth/headset
     *  PLAY still reaches a live player. */
    private fun scheduleDetachWhenLongPaused() {
        mainHandler.removeCallbacks(detachWhenPausedRunnable)
        mainHandler.postDelayed(detachWhenPausedRunnable, PAUSED_KEEP_ALIVE_MS)
    }

    private fun stopPlaybackNotification() {
        mainHandler.removeCallbacks(detachWhenPausedRunnable)
        notificationCheckToken++
        repostAttempted = false
        lastPostedKey = null
        lastMetadataKey = null
        notificationPosted = false
        currentTrackTitle = null
        currentTrackArtist = null
        currentTrackArtworkUrl = null
        currentArtworkBitmap = null
        lastKnownPositionMs = 0L
        lastKnownDurationMs = 0L
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            isForeground = false
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
            // SESSION INACTIVE FIX: set isActive = false so the OS removes this
            // session from the "active sessions" list immediately. Without this,
            // the session lingers as "active" in the media session registry even
            // though nothing is playing, which can confuse the Quick Settings media
            // player carousel into showing stale controls for a stopped session.
            session?.setPlaybackState(
                PlaybackStateCompat.Builder().setState(PlaybackStateCompat.STATE_STOPPED, 0L, 0f).build(),
            )
            // Deactivate so the stopped session leaves the OS's active-session
            // list (no stale controls in Quick Settings). It is re-activated by
            // ensureSessionActive() the next time something is posted.
            session?.isActive = false
        } catch (_: Throwable) {
            // Nothing more to do if even this fails.
        }
    }

    // ── Session state (the single source of truth the OS reads) ─────────

    private fun updateSessionState(title: String, isPlaying: Boolean) {
        val s = session ?: return
        // After stopPlaybackNotification() the session is inactive; a new track
        // must re-activate it or media buttons / the OS player never reach it.
        if (!s.isActive) s.isActive = true
        val p = player
        // For native playback read the live position/duration straight from
        // ExoPlayer so the scrubber is right immediately after a seek/skip.
        if (!externalPlaybackActive && p != null) {
            lastKnownPositionMs = p.currentPosition.coerceAtLeast(0)
            if (p.duration != C.TIME_UNSET && p.duration > 0) lastKnownDurationMs = p.duration
        }
        val metadataKey = "$title|$currentTrackArtist|$lastKnownDurationMs|" +
            "${currentArtworkBitmap?.let { System.identityHashCode(it) }}"
        if (metadataKey != lastMetadataKey) {
            lastMetadataKey = metadataKey
            val metadata = MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastKnownDurationMs)
            currentTrackArtist?.let {
                metadata.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, it)
                metadata.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, it)
            }
            currentArtworkBitmap?.let {
                metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
                metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, it)
            }
            s.setMetadata(metadata.build())
        }

        // (setPlaybackToLocal(STREAM_MUSIC) is applied once when the session is
        // created — calling it on every ~1s state refresh made the system
        // re-publish the session's audio info each time.)

        val actions = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_STOP or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_SEEK_TO
        val buffering = !externalPlaybackActive && isPlaying && p?.playbackState == Player.STATE_BUFFERING
        val state = when {
            !isPlaying -> PlaybackStateCompat.STATE_PAUSED
            buffering -> PlaybackStateCompat.STATE_BUFFERING
            else -> PlaybackStateCompat.STATE_PLAYING
        }
        val speed = if (state == PlaybackStateCompat.STATE_PLAYING) lastKnownSpeed.takeIf { it > 0f } ?: 1f else 0f
        s.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, lastKnownPositionMs, speed)
                .build(),
        )
    }

    private fun buildPlaybackNotification(title: String, isPlaying: Boolean): Notification {
        val artist = currentTrackArtist
        val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(title)
            .apply { if (!artist.isNullOrBlank()) setContentText(artist) }
            .setSmallIcon(R.drawable.ic_stat_now_playing)
            .apply { currentArtworkBitmap?.let { setLargeIcon(it) } }
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .apply { sessionActivityPendingIntent?.let { setContentIntent(it) } }
            .addAction(R.drawable.ic_media_previous, "Previous", actionPendingIntent(ACTION_PREVIOUS, 3))
            .addAction(
                if (isPlaying) R.drawable.ic_media_pause else R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                actionPendingIntent(ACTION_PLAY_PAUSE, 1),
            )
            .addAction(R.drawable.ic_media_next, "Next", actionPendingIntent(ACTION_NEXT, 2))

        session?.sessionToken?.let { token ->
            builder.setStyle(
                MediaStyle()
                    .setMediaSession(token)
                    .setShowActionsInCompactView(0, 1, 2),
            )
        }
        // SWIPE-TO-DISMISS FIX: when the user swipes the notification away
        // while paused (ongoing=false), stop the service cleanly. Without this,
        // the service remains running silently after the notification is gone,
        // which wastes memory and can confuse the OS media routing.
        if (!isPlaying) {
            val stopIntent = Intent(this, MediaPlaybackService::class.java).apply { action = "STOP_SELF" }
            val stopPendingIntent = PendingIntent.getService(
                this, 99, stopIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.setDeleteIntent(stopPendingIntent)
        }
        return builder.build()
    }

    private fun actionPendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, MediaPlaybackService::class.java).setAction(action)
        return PendingIntent.getService(
            this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Old channel id abandoned rather than reused: a channel's importance
        // is frozen at first creation, so a bad one from an earlier build
        // could never be repaired.
        try {
            if (manager.getNotificationChannel(LEGACY_NOTIFICATION_CHANNEL_ID) != null) {
                manager.deleteNotificationChannel(LEGACY_NOTIFICATION_CHANNEL_ID)
            }
        } catch (_: Throwable) { /* best effort */ }
        val existing = manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID)
        if (existing != null) {
            Log.d(TAG, "ensureNotificationChannel: channel already exists, importance=${existing.importance}")
            return
        }
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            getString(R.string.audio_engine_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped from recents: keep going only if something is really playing.
        if (!wantsPlayback()) {
            stopPlaybackNotification()
            stopSelf()
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        player?.removeListener(playerEventListener)
        player?.release()
        player = null
        session?.release()
        session = null
        super.onDestroy()
    }

    interface EventListener {
        fun onPlaybackStateChanged(playbackState: Int, playWhenReady: Boolean)
        fun onIsPlayingChanged(isPlaying: Boolean)
        fun onBufferingChanged(buffering: Boolean)
        fun onError(message: String)
        fun onTrackChanged(mediaId: String?, index: Int)
        fun onPlaybackEnded()
        // Transport command (notification button, lock screen, Bluetooth)
        // while a YouTube track is the active one: handed back to JS, which
        // drives the IFrame. action: "play" | "pause" | "next" | "previous".
        fun onExternalTransportCommand(action: String)
        fun onExternalSeek(positionSeconds: Double) {}
        // DIAGNOSTIC: the OS confirmed it is holding the notification.
        fun onNotificationVisible() {}
        // The OS is not showing the notification. `reason` is an ISSUE_* code
        // or "POST_FAILED: <message>".
        fun onNotificationIssue(reason: String) {}
    }
    var eventListener: EventListener? = null

    companion object {
        const val ACTION_LOCAL_BIND = "com.duospace.audioengine.LOCAL_BIND"
        private const val ACTION_PLAY_PAUSE = "com.duospace.audioengine.PLAY_PAUSE"
        private const val ACTION_NEXT = "com.duospace.audioengine.NEXT"
        private const val ACTION_PREVIOUS = "com.duospace.audioengine.PREVIOUS"

        private const val NOTIFICATION_CHANNEL_ID = "duospace_now_playing_v2"
        private const val LEGACY_NOTIFICATION_CHANNEL_ID = "duospace_now_playing"
        private const val NOTIFICATION_ID = 4271
        private const val TAG = "DuoSpaceAudio"
        private const val NOTIFICATION_CHECK_DELAY_MS = 1200L
        private const val PREVIOUS_RESTART_THRESHOLD_MS = 3000L
        private const val PAUSED_KEEP_ALIVE_MS = 6L * 60L * 60L * 1000L // stay alive 6h while paused
        const val ISSUE_APP_DISABLED = "APP_NOTIFICATIONS_DISABLED"
        const val ISSUE_CHANNEL_BLOCKED = "CHANNEL_BLOCKED"
        const val ISSUE_CHANNEL_MISSING = "CHANNEL_MISSING"
        const val ISSUE_NOT_ACTIVE = "NOT_ACTIVE"
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
