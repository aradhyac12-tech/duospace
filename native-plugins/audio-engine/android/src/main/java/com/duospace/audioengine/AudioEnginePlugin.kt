package com.duospace.audioengine

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * JS-facing bridge for DuospaceAudioEngine. Binds to MediaPlaybackService
 * (a foreground MediaSessionService — see that file's header for why the
 * actual player logic lives there and not here) and translates its
 * Player.Listener callbacks into the plugin events GroicContext listens
 * for, and translates GroicContext's JS calls into direct ExoPlayer calls
 * on the bound service.
 *
 * This class deliberately does NOT itself hold an ExoPlayer instance —
 * doing so would be a second, competing audio engine (the exact "duplicate
 * audio engines" failure mode this implementation was specifically asked
 * to avoid). Every playback call here forwards to the one ExoPlayer
 * instance MediaPlaybackService owns.
 */
@CapacitorPlugin(name = "DuospaceAudioEngine")
class AudioEnginePlugin : Plugin() {

    private var service: MediaPlaybackService? = null
    private var bound = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var positionTicker: Runnable? = null

    // Queued track metadata (id -> title/artist/artwork), kept here because
    // MediaItem itself only round-trips a mediaId through ExoPlayer's
    // events, not the full track object GroicContext passed to setQueue().
    private var queueMeta: Map<String, Triple<String, String, String?>> = emptyMap()

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as? MediaPlaybackService.LocalBinder)?.getService() ?: return
            service = svc
            bound = true
            svc.eventListener = pluginEventListener
            startPositionTicker()
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            bound = false
            stopPositionTicker()
        }
    }

    override fun load() {
        super.load()
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = MediaPlaybackService.ACTION_LOCAL_BIND
        }
        // startService (not just bindService) so the service — and
        // playback — survives the binding Activity going away entirely,
        // which is the whole point of background playback surviving
        // navigation away from the app (requirements #6/#7). bindService
        // alone would tie the service's lifecycle to this plugin/Activity.
        // HARDENING FIX: ContextCompat.startForegroundService(), not a
        // plain startService() — on Android 8+, starting a service the OS
        // considers itself "in the background" at that instant throws
        // IllegalStateException unless startForegroundService() is used
        // (a real, if narrow, window: e.g. a Bluetooth/lock-screen "play"
        // arriving after the Activity has been backgrounded a while).
        // Always correct/safe when the app IS in the foreground too — no
        // behavior change for the common case, load() being called from a
        // just-tapped play button.
        ContextCompat.startForegroundService(context, intent)
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    override fun handleOnDestroy() {
        stopPositionTicker()
        if (bound) {
            try { context.unbindService(connection) } catch (_: IllegalArgumentException) { /* already unbound */ }
            bound = false
        }
        super.handleOnDestroy()
    }

    private val pluginEventListener = object : MediaPlaybackService.EventListener {
        override fun onPlaybackStateChanged(playbackState: Int, playWhenReady: Boolean) {
            val state = when {
                playbackState == Player.STATE_BUFFERING -> "loading"
                playbackState == Player.STATE_ENDED -> "ended"
                playbackState == Player.STATE_IDLE -> "idle"
                playWhenReady -> "playing"
                else -> "paused"
            }
            notifyListeners("playbackStateChanged", JSObject().put("state", state))
        }
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            notifyListeners("playbackStateChanged", JSObject().put("state", if (isPlaying) "playing" else "paused"))
        }
        override fun onBufferingChanged(buffering: Boolean) {
            notifyListeners("bufferingChanged", JSObject().put("buffering", buffering))
        }
        override fun onError(message: String) {
            val trackId = service?.getPlayer()?.currentMediaItem?.mediaId
            notifyListeners("error", JSObject().put("message", message).put("trackId", trackId))
        }
        override fun onTrackChanged(mediaId: String?, index: Int) {
            notifyListeners("trackChanged", JSObject().put("trackId", mediaId).put("index", index))
        }
        override fun onPlaybackEnded() {
            notifyListeners("playbackEnded", JSObject())
        }
    }

    // FIX ("do not send a position update to React state every few
    // milliseconds"): a single 1-second Handler tick, not a per-frame
    // ExoPlayer position listener (which fires far more often than any
    // UI needs) — matches the same interval chosen for the web fallback
    // (src/web.ts) so behavior is consistent across platforms.
    private fun startPositionTicker() {
        stopPositionTicker()
        val tick = object : Runnable {
            override fun run() {
                val p = service?.getPlayer()
                if (p != null && p.isPlaying) {
                    val payload = JSObject()
                        .put("positionSeconds", p.currentPosition / 1000.0)
                        .put("durationSeconds", if (p.duration == C.TIME_UNSET) 0.0 else p.duration / 1000.0)
                    notifyListeners("positionChanged", payload)
                }
                mainHandler.postDelayed(this, 1000)
            }
        }
        positionTicker = tick
        mainHandler.postDelayed(tick, 1000)
    }
    private fun stopPositionTicker() {
        positionTicker?.let { mainHandler.removeCallbacks(it) }
        positionTicker = null
    }

    private fun jsObjectToMediaItem(track: JSObject): MediaItem {
        val id = track.getString("id") ?: ""
        val title = track.getString("title") ?: "Unknown"
        val artist = track.getString("artist") ?: "Unknown"
        val artworkUrl = track.getString("artworkUrl")
        val streamUrl = track.getString("streamUrl") ?: ""
        return buildMediaItem(id, title, artist, artworkUrl, streamUrl)
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val track = call.getObject("track")
        if (track == null) { call.reject("Missing track"); return }
        val svc = service
        if (svc == null) { call.reject("Audio engine not ready"); return }
        val item = jsObjectToMediaItem(track)
        svc.loadAndPlay(item, call.getBoolean("autoplay", false) ?: false)
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) { service?.getPlayer()?.play(); call.resolve() }

    @PluginMethod
    fun pause(call: PluginCall) { service?.getPlayer()?.pause(); call.resolve() }

    @PluginMethod
    fun resume(call: PluginCall) { service?.getPlayer()?.play(); call.resolve() }

    @PluginMethod
    fun stop(call: PluginCall) { service?.getPlayer()?.stop(); call.resolve() }

    @PluginMethod
    fun seek(call: PluginCall) {
        val positionSeconds = call.getDouble("positionSeconds") ?: 0.0
        service?.getPlayer()?.seekTo((positionSeconds * 1000).toLong())
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) {
        val p = service?.getPlayer()
        if (p != null && p.hasNextMediaItem()) p.seekToNextMediaItem() else p?.stop()
        call.resolve()
    }

    @PluginMethod
    fun previous(call: PluginCall) {
        val p = service?.getPlayer()
        if (p != null && p.currentPosition > 3000) {
            // Standard media-player convention (also what most Bluetooth
            // head units expect): "previous" restarts the current track
            // if you're more than a few seconds into it, and only actually
            // goes back to the prior track from very near the start —
            // otherwise a single accidental tap loses your place entirely.
            p.seekTo(0)
        } else if (p != null && p.hasPreviousMediaItem()) {
            p.seekToPreviousMediaItem()
        } else {
            p?.seekTo(0)
        }
        call.resolve()
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val tracks: JSArray = call.getArray("tracks") ?: JSArray()
        val startIndex = call.getInt("startIndex", 0) ?: 0
        val items = mutableListOf<MediaItem>()
        for (i in 0 until tracks.length()) {
            val obj = JSObject.fromJSONObject(tracks.getJSONObject(i))
            items.add(jsObjectToMediaItem(obj))
        }
        service?.setQueue(items, startIndex)
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val p = service?.getPlayer()
        val result = JSObject()
        if (p == null) {
            result.put("state", "idle").put("currentTrackId", null).put("positionSeconds", 0)
                .put("durationSeconds", 0).put("buffering", false).put("volume", 1)
        } else {
            val state = when {
                p.playbackState == Player.STATE_BUFFERING -> "loading"
                p.playbackState == Player.STATE_ENDED -> "ended"
                p.playbackState == Player.STATE_IDLE -> "idle"
                p.isPlaying -> "playing"
                else -> "paused"
            }
            result.put("state", state)
                .put("currentTrackId", p.currentMediaItem?.mediaId)
                .put("positionSeconds", p.currentPosition / 1000.0)
                .put("durationSeconds", if (p.duration == C.TIME_UNSET) 0.0 else p.duration / 1000.0)
                .put("buffering", p.playbackState == Player.STATE_BUFFERING)
                .put("volume", p.volume.toDouble())
        }
        call.resolve(result)
    }

    @PluginMethod
    fun getPosition(call: PluginCall) {
        val p = service?.getPlayer()
        call.resolve(JSObject().put("positionSeconds", (p?.currentPosition ?: 0) / 1000.0))
    }

    @PluginMethod
    fun getDuration(call: PluginCall) {
        val p = service?.getPlayer()
        val d = if (p == null || p.duration == C.TIME_UNSET) 0.0 else p.duration / 1000.0
        call.resolve(JSObject().put("durationSeconds", d))
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getDouble("volume") ?: 1.0
        service?.getPlayer()?.volume = volume.toFloat().coerceIn(0f, 1f)
        call.resolve()
    }
}
