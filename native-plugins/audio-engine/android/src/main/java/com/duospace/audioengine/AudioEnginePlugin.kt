package com.duospace.audioengine

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
        bindToService()
    }

    // CRASH FIX (native process crash the first time this plugin is
    // touched from JS — e.g. GroicContext's mount-time addListener calls
    // inside AppLayout, which mounts the instant a user signs in/up by any
    // method, since that's the first moment anything calls
    // DuospaceAudioEngine.addListener()/etc. and Capacitor lazily
    // instantiates + load()s this plugin on that first call, exactly like
    // the two crash fixes already documented in DeviceStatusPlugin.kt and
    // DuoSpaceLocationService.kt on this same post-sign-in path):
    // context.startService()/bindService() here were completely unguarded.
    // Android's background-execution limits let Context.startService()
    // throw an uncaught IllegalStateException ("Not allowed to start
    // service Intent ...: app is in background") if the process isn't yet
    // fully classified as foreground at the exact moment this runs — a
    // real, observed timing window right as control returns from the
    // external OAuth browser/Custom Tab into the app (some OEM skins,
    // e.g. Samsung One UI, are more aggressive about this than stock
    // Android). That exception was not caught anywhere in this call
    // chain (Capacitor's own plugin-load path doesn't wrap it either),
    // so it crashed the whole native process — the generic "DuoSpace
    // closed because this app has a bug" OS dialog, not a JS-catchable
    // error, on every single sign-in/sign-up method every time.
    // Wrapping in try/catch here, plus retrying from load(call) below if
    // the initial bind never completed, keeps background playback working
    // once the app is fully foregrounded instead of trading the crash for
    // a permanently-broken audio engine.
    private fun bindToService() {
        if (bound) return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = MediaPlaybackService.ACTION_LOCAL_BIND
        }
        // startService (not just bindService) so the service — and
        // playback — survives the binding Activity going away entirely,
        // which is the whole point of background playback surviving
        // navigation away from the app (requirements #6/#7). bindService
        // alone would tie the service's lifecycle to this plugin/Activity.
        //
        // BUG FIX (this was the actual cause of background playback being
        // broken on Android): this previously called
        // ContextCompat.startForegroundService() here, in Plugin.load() —
        // which the Capacitor bridge invokes once at APP STARTUP for every
        // registered plugin, not when the user taps play. That makes
        // Android a hard promise: "this service WILL call
        // startForeground() within ~5 seconds." At this point nothing has
        // been loaded into the player yet, so MediaPlaybackService (a
        // MediaSessionService, which only promotes itself to a real
        // foreground service once the player actually starts playing —
        // see that file) has no way to keep that promise. On Android 12+
        // the OS kills the process with
        // ForegroundServiceDidNotStartInTimeException as soon as the
        // ~5s window elapses; on older versions the service silently gets
        // torn down instead. Either way: the one service background
        // playback depends on was already dead before the person ever
        // pressed play, on every single app launch — matching "music
        // doesn't play in the background" exactly (this is also a
        // widely-reported real crash class in Media3's own issue tracker,
        // not a one-off — e.g. androidx/media#112, #167, #2412).
        //
        // Plain startService() carries no such promise, and none is
        // needed here: Media3's MediaSessionService calls
        // startForeground()/setForegroundServiceNotification() itself,
        // synchronously with the moment playback actually begins,
        // whichever path triggers it (a JS play() call below, or a
        // Bluetooth/lock-screen media button arriving while the process
        // isn't running — Media3's own MediaButtonReceiver calls
        // startForegroundService() for THAT specific case, right before
        // immediately starting playback, which is the one situation
        // startForegroundService() is actually for).
        try {
            context.startService(intent)
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            // Swallow and retry later (see load(call) below) instead of
            // crashing the app — this is expected to occasionally fail in
            // the brief window right after returning from an external
            // OAuth browser tab.
        }
    }

    override fun handleOnDestroy() {
        stopPositionTicker()
        if (bound) {
            try { context.unbindService(connection) } catch (_: IllegalArgumentException) { /* already unbound */ }
            bound = false
        }
        if (keepAliveBound) {
            try { context.unbindService(keepAliveConnection) } catch (_: IllegalArgumentException) { /* already unbound */ }
            keepAliveBound = false
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

    // CRASH FIX (native process crash every time playback was started —
    // reported as "the app crashes when I try to play SoundCloud", but the
    // same call path is used for every natively-streamable provider,
    // SoundCloud included, since it's the one now searched/tapped first):
    // androidx.media3's ExoPlayer enforces that it is only ever touched
    // from the single thread that created it — here, MediaPlaybackService's
    // main-thread onCreate() (see that file's ExoPlayer.Builder(this).build()
    // call). Capacitor's Android Bridge invokes every @PluginMethod on a
    // background executor by default, NOT the main thread (this is
    // documented Capacitor behavior, not specific to this plugin — see
    // Capacitor's own "Handling Threads" guidance for plugin authors).
    // Every method below used to call straight into service?.getPlayer()
    // from that background thread, which trips ExoPlayerImpl's own
    // verifyApplicationThread() check and throws an uncaught
    // IllegalStateException ("Player is accessed on the wrong thread") —
    // not a JS-catchable rejection, a real crash of the whole native
    // process, exactly matching "the app crashes" rather than a graceful
    // playback error. bridge.executeOnMainThread{} is Capacitor's own
    // supported hop back onto the main thread before touching a
    // main-thread-owned object like this ExoPlayer instance; every player
    // call in this class now goes through it.
    @PluginMethod
    fun load(call: PluginCall) {
        val track = call.getObject("track")
        if (track == null) { call.reject("Missing track"); return }
        if (service == null && !bound) bindToService()
        val svc = service
        if (svc == null) { call.reject("Audio engine not ready"); return }
        val item = jsObjectToMediaItem(track)
        val autoplay = call.getBoolean("autoplay", false) ?: false
        bridge.executeOnMainThread {
            svc.loadAndPlay(item, autoplay)
            call.resolve()
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        bridge.executeOnMainThread { service?.getPlayer()?.play(); call.resolve() }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        bridge.executeOnMainThread { service?.getPlayer()?.pause(); call.resolve() }
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        bridge.executeOnMainThread { service?.getPlayer()?.play(); call.resolve() }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        bridge.executeOnMainThread { service?.getPlayer()?.stop(); call.resolve() }
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val positionSeconds = call.getDouble("positionSeconds") ?: 0.0
        bridge.executeOnMainThread {
            service?.getPlayer()?.seekTo((positionSeconds * 1000).toLong())
            call.resolve()
        }
    }

    @PluginMethod
    fun next(call: PluginCall) {
        bridge.executeOnMainThread {
            val p = service?.getPlayer()
            if (p != null && p.hasNextMediaItem()) p.seekToNextMediaItem() else p?.stop()
            call.resolve()
        }
    }

    @PluginMethod
    fun previous(call: PluginCall) {
        bridge.executeOnMainThread {
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
        bridge.executeOnMainThread {
            service?.setQueue(items, startIndex)
            call.resolve()
        }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        bridge.executeOnMainThread {
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
    }

    @PluginMethod
    fun getPosition(call: PluginCall) {
        bridge.executeOnMainThread {
            val p = service?.getPlayer()
            call.resolve(JSObject().put("positionSeconds", (p?.currentPosition ?: 0) / 1000.0))
        }
    }

    @PluginMethod
    fun getDuration(call: PluginCall) {
        bridge.executeOnMainThread {
            val p = service?.getPlayer()
            val d = if (p == null || p.duration == C.TIME_UNSET) 0.0 else p.duration / 1000.0
            call.resolve(JSObject().put("durationSeconds", d))
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getDouble("volume") ?: 1.0
        bridge.executeOnMainThread {
            service?.getPlayer()?.volume = volume.toFloat().coerceIn(0f, 1f)
            call.resolve()
        }
    }

    // ── Web keep-alive (YouTube-provider tracks) ─────────────────────────
    // See WebKeepAliveService.kt's header for the full design. This is a
    // completely separate bound service/connection from `service`/
    // `connection` above — MediaPlaybackService (real ExoPlayer audio) and
    // WebKeepAliveService (a mirrored, audio-less MediaSession) are never
    // both active at once in practice (GroicContext's single-current-track
    // model + its own start/stop wiring guarantees that), but keeping them
    // as fully independent objects here means a bug in one can't corrupt
    // the other's lifecycle.
    private var keepAliveService: WebKeepAliveService? = null
    private var keepAliveBound = false
    private val keepAliveCommandListener = object : WebKeepAliveService.CommandListener {
        override fun onPlay() = notifyListeners("webKeepAliveCommand", JSObject().put("action", "play"))
        override fun onPause() = notifyListeners("webKeepAliveCommand", JSObject().put("action", "pause"))
        override fun onNext() = notifyListeners("webKeepAliveCommand", JSObject().put("action", "next"))
        override fun onPrevious() = notifyListeners("webKeepAliveCommand", JSObject().put("action", "previous"))
        override fun onSeek(positionSeconds: Double) =
            notifyListeners("webKeepAliveCommand", JSObject().put("action", "seek").put("positionSeconds", positionSeconds))
    }
    private val keepAliveConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as? WebKeepAliveService.LocalBinder)?.getService() ?: return
            keepAliveService = svc
            keepAliveBound = true
            svc.commandListener = keepAliveCommandListener
            pendingKeepAliveMeta?.let { (title, artist, artworkUrl) ->
                applyKeepAliveMetadata(svc, title, artist, artworkUrl)
                pendingKeepAliveMeta = null
            }
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            keepAliveService = null
            keepAliveBound = false
        }
    }
    // Same class of startup-timing race documented in bindToService()
    // above — a call() can resolve before onServiceConnected fires, so the
    // metadata from that first startWebKeepAlive() call is queued here and
    // applied the moment the connection actually completes.
    private var pendingKeepAliveMeta: Triple<String, String, String?>? = null

    private fun applyKeepAliveMetadata(svc: WebKeepAliveService, title: String, artist: String, artworkUrl: String?) {
        val uri = artworkUrl?.let { try { android.net.Uri.parse(it) } catch (_: Exception) { null } }
        svc.updateMetadata(title, artist, uri)
    }

    @PluginMethod
    fun startWebKeepAlive(call: PluginCall) {
        val meta = call.getObject("meta")
        val title = meta?.getString("title") ?: "DuoSpace"
        val artist = meta?.getString("artist") ?: ""
        val artworkUrl = meta?.getString("artworkUrl")
        val intent = Intent(context, WebKeepAliveService::class.java)
        try {
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
            if (!keepAliveBound) context.bindService(intent, keepAliveConnection, Context.BIND_AUTO_CREATE)
            val svc = keepAliveService
            if (svc != null) applyKeepAliveMetadata(svc, title, artist, artworkUrl)
            else pendingKeepAliveMeta = Triple(title, artist, artworkUrl)
            call.resolve()
        } catch (e: Exception) {
            // Same reasoning as bindToService()'s try/catch: a narrow
            // background-execution timing window, not a reason to crash
            // the app. GroicContext already treats every nativeEngine.*
            // call as fire-and-forget (.catch(() => {})).
            call.reject("Could not start web keep-alive: ${e.message}")
        }
    }

    @PluginMethod
    fun updateWebKeepAlive(call: PluginCall) {
        val playing = call.getBoolean("playing", false) ?: false
        val positionSeconds = call.getDouble("positionSeconds") ?: 0.0
        val durationSeconds = call.getDouble("durationSeconds") ?: 0.0
        keepAliveService?.updateState(playing, positionSeconds, durationSeconds)
        val meta = call.getObject("meta")
        if (meta != null) {
            val svc = keepAliveService
            if (svc != null) applyKeepAliveMetadata(svc, meta.getString("title") ?: "DuoSpace", meta.getString("artist") ?: "", meta.getString("artworkUrl"))
        }
        call.resolve()
    }

    @PluginMethod
    fun stopWebKeepAlive(call: PluginCall) {
        if (keepAliveBound) {
            try { context.unbindService(keepAliveConnection) } catch (_: IllegalArgumentException) { /* already unbound */ }
            keepAliveBound = false
        }
        keepAliveService = null
        pendingKeepAliveMeta = null
        try { context.stopService(Intent(context, WebKeepAliveService::class.java)) } catch (_: Exception) { /* already stopped */ }
        call.resolve()
    }
}
