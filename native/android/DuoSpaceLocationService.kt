package com.duospace.app

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.duospace.backgroundgeolocation.LocationFixBridge
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground location service — the piece
 * docs/DUOSPACE-LOCATION-CONTEXT.md's "Known limitation — native
 * background" section flagged as still missing: everything in that doc
 * fixed *foreground* reliability (another in-app screen, the ringing-call
 * overlay). This is what keeps a fix flowing once the OS has actually
 * suspended the WebView (app minimized / screen off), and what produces an
 * immediate fresh fix the instant a call or message push arrives —
 * CallNotificationService.kt starts this with ACTION_ONE_SHOT at the very
 * top of onMessageReceived(), before it even looks at the push type, so
 * this fires for every push (calls AND ordinary messages), not just calls.
 *
 * Deliberately lives in the app package (com.duospace.app), copied in by
 * scripts/patch-native-permissions.mjs alongside CallNotificationService.kt
 * / CallRingingService.kt, rather than inside the
 * duospace-background-geolocation plugin module — CallNotificationService
 * needs to start it directly with a plain same-package Intent, with zero
 * dependency on a Capacitor Bridge/WebView/plugin instance existing yet
 * (the whole point: a push can arrive before the app has ever been
 * opened). It reports fixes back out through LocationFixBridge (see that
 * file for why the app module is allowed to import the plugin module's
 * classes but not vice versa).
 *
 * UNVERIFIED: written against the documented FusedLocationProviderClient /
 * foreground-service API surface; not compiled or run on a device (no
 * Android SDK/emulator available in the environment that generated it) —
 * same caveat every native file in this project already carries (see
 * CallKitManager.swift). Treat as structurally correct, ready for Android
 * Studio, not as tested.
 */
/**
 * NO-NOTIFICATION MODE (user request: remove the "location accessing" /
 * blank "DuoSpace" notification): this service no longer calls
 * startForeground(), so it posts NO notification at all — not a persistent
 * one, not a brief one per push. Android only lets an app hide the
 * notification by not being a foreground service, which has a real cost that
 * is deliberate and should be understood before changing it back:
 *
 *   - Location keeps flowing while the app is open, and for as long as the OS
 *     keeps the process alive after it's minimized (typically a few minutes).
 *   - After that the OS may stop the process, so the partner sees the last
 *     known location until the app is opened again. A foreground service was
 *     the only way to prevent that, and it always shows a notification.
 *   - Push-triggered one-shot fixes (ACTION_ONE_SHOT) only succeed if the
 *     background-location permission is granted; otherwise Android returns
 *     no fix and the service just stops itself.
 *
 * UPDATE 2026-09-20 — QUIET BACKGROUND TRACKING: the "after a few minutes it
 * stops" cost above is largely recovered WITHOUT a notification. The ongoing
 * watcher is now a PendingIntent subscription (see LocationUpdateReceiver.kt):
 * Play services delivers fixes to that receiver even after this service and the
 * WebView are gone. It needs "Allow all the time"; Android still throttles
 * background apps (a few fixes/hour when still, more when moving), and
 * push-triggered one-shots below fill the gaps. This service is now only a
 * short-lived launcher (register/unregister + one-shots) and stops itself.
 *
 * To restore always-on background tracking (with its notification), re-add
 * startForeground(...) in ACTION_START/ACTION_ONE_SHOT and switch the three
 * callers back to ContextCompat.startForegroundService (CallNotificationService,
 * BackgroundGeolocationPlugin.startInternal / requestImmediateFix) — they must
 * change together or Android kills the app for not calling startForeground().
 */
class DuoSpaceLocationService : Service() {

    companion object {
        const val ACTION_START = "com.duospace.app.location.ACTION_START"
        const val ACTION_STOP = "com.duospace.app.location.ACTION_STOP"
        const val ACTION_ONE_SHOT = "com.duospace.app.location.ACTION_ONE_SHOT"
        const val EXTRA_INTERVAL_MS = "intervalMs"
        const val EXTRA_REASON = "reason"
        const val EXTRA_TIMEOUT_MS = "timeoutMs"

        private const val DEFAULT_INTERVAL_MS = 45_000L
        private const val DEFAULT_ONE_SHOT_TIMEOUT_MS = 8_000L
        // Only used to delete the channel older builds created — see
        // removeLegacyNotificationChannel().
        private const val LEGACY_CHANNEL_ID = "duospace_location"

        /** Minimum gap between push-triggered fixes. A burst of chat messages
         *  (or "typing" pushes, if the server sends them) must not turn into
         *  a burst of high-accuracy GPS requests — one fix every 15s is plenty
         *  for a partner-facing map and keeps battery cost negligible. */
        private const val MIN_PUSH_FIX_INTERVAL_MS = 15_000L
        private var lastPushFixRequestAt = 0L

        /**
         * THE single entry point for "a push just arrived — get a fresh fix".
         * Called from EVERY FirebaseMessagingService this app registers
         * (CallNotificationService and DuoSpaceMessagingService), so it does
         * not matter which of them Android routes a given push to: Android
         * resolves the MESSAGING_EVENT intent to one service, not all of
         * them (see .ai/KNOWN_ISSUES.md KI-12). Debounced, so being called
         * from more than one place for the same push is harmless.
         *
         * Uses plain startService (no foreground notification — see the
         * NO-NOTIFICATION MODE note above); allowed from an FCM handler
         * because a high-priority FCM message grants a short background-start
         * window. Never throws.
         */
        fun requestFixForPush(context: Context, pushType: String) {
            if (pushType == "typing") return // ephemeral; never worth a GPS fix
            val now = SystemClock.elapsedRealtime()
            synchronized(this) {
                if (lastPushFixRequestAt != 0L && now - lastPushFixRequestAt < MIN_PUSH_FIX_INTERVAL_MS) return
                lastPushFixRequestAt = now
            }
            try {
                val intent = Intent(context, DuoSpaceLocationService::class.java).apply {
                    action = ACTION_ONE_SHOT
                    putExtra(EXTRA_REASON, "push:$pushType")
                }
                context.startService(intent)
            } catch (e: Exception) {
                android.util.Log.w("DuoSpaceLocation", "requestFixForPush failed for type=$pushType", e)
            }
        }

        /** So the plugin's isRunning() can answer without a round trip. */
        @Volatile
        var isWatcherRunning: Boolean = false
            private set
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private val mainHandler = Handler(Looper.getMainLooper())
    private var oneShotCancellationSource: CancellationTokenSource? = null

    // Push-triggered one-shots currently in flight. The service stops itself
    // when this reaches 0. The ongoing watcher does NOT keep it alive any more:
    // it is a PendingIntent subscription delivered to LocationUpdateReceiver.
    private val activeOneShots = AtomicInteger(0)

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        removeLegacyNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, DEFAULT_INTERVAL_MS)
                startWatcher(intervalMs)
            }
            ACTION_ONE_SHOT -> {
                val reason = intent.getStringExtra(EXTRA_REASON) ?: "unknown"
                val timeoutMs = intent.getLongExtra(EXTRA_TIMEOUT_MS, DEFAULT_ONE_SHOT_TIMEOUT_MS)
                requestOneShotFix(reason, timeoutMs)
            }
            ACTION_STOP -> {
                stopWatcher() // removes the PendingIntent subscription
                stopSelf()
            }
        }
        // Not sticky: with no foreground notification the OS is free to
        // reclaim this process, and restarting an idle service with a null
        // Intent would do nothing useful. The JS layer calls start() again on
        // the next app open.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // Deliberately NOT calling stopWatcher(): the background subscription
        // is owned by Play services + LocationUpdateReceiver and must outlive
        // this service. It is only removed by ACTION_STOP (sign-out).
        oneShotCancellationSource?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun hasLocationPermission(): Boolean =
        ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Routes a fix to [LocationFixBridge.listener] if one is attached, and
     * — unlike before — actually logs when it isn't, rather than silently
     * dropping the fix. This matters specifically for the cold-start case
     * `docs/BACKGROUND_LOCATION_NATIVE.md` documents as a known limitation:
     * a push-triggered one-shot fired before the app has ever been opened
     * has nowhere to write the fix (no JS bridge, no plugin instance, hence
     * no Supabase upsert path), and that's an accepted gap — but it should
     * be visible in logcat when it happens, not invisible.
     */
    private fun deliverFix(fix: LocationFixBridge.Fix) {
        val listener = LocationFixBridge.listener
        if (listener == null) {
            android.util.Log.i(
                "DuoSpaceLocation",
                "Fix obtained (source=${fix.source}) but no plugin listener attached — " +
                    "dropped (JS bridge never loaded, e.g. app not yet opened since this cold push).",
            )
            return
        }
        listener.onFix(fix)
    }

    private fun deliverError(code: String, message: String) {
        val listener = LocationFixBridge.listener
        if (listener == null) {
            android.util.Log.i("DuoSpaceLocation", "Error ($code: $message) but no plugin listener attached — dropped.")
            return
        }
        listener.onError(code, message)
    }

    /**
     * KI-12 gap 2 — upload a fix WITHOUT the WebView. The implementation moved
     * to [LocationUpdateReceiver.uploadFix] so the quiet background receiver
     * and this service share one copy. [onDone] is posted back to the main
     * thread here.
     */
    private fun uploadFixNatively(fix: LocationFixBridge.Fix, onDone: () -> Unit) {
        LocationUpdateReceiver.uploadFix(this, fix) { mainHandler.post(onDone) }
    }

    /**
     * Ongoing background location, with NO notification: subscribes Play
     * services to deliver fixes straight to [LocationUpdateReceiver] via a
     * PendingIntent, then lets this service stop — nothing of ours needs to
     * stay running. See LocationUpdateReceiver's header for the honest limits
     * ("Allow all the time" is required; Android throttles background apps).
     */
    private fun startWatcher(intervalMs: Long) {
        if (!hasLocationPermission()) {
            deliverError("denied", "ACCESS_FINE_LOCATION not granted")
            stopIfIdle()
            return
        }
        isWatcherRunning = LocationUpdateReceiver.register(this, intervalMs)
        if (!isWatcherRunning) deliverError("unknown", "Could not subscribe to background location updates")
        // Idle unless a push one-shot is in flight (it will stop us when done).
        if (activeOneShots.get() == 0) stopSelf()
    }

    private fun stopWatcher() {
        LocationUpdateReceiver.unregister(this)
        isWatcherRunning = false
    }

    private fun requestOneShotFix(reason: String, timeoutMs: Long) {
        activeOneShots.incrementAndGet()
        if (!hasLocationPermission()) {
            deliverError("denied", "ACCESS_FINE_LOCATION not granted")
            stopIfIdle()
            return
        }
        val cts = CancellationTokenSource()
        oneShotCancellationSource = cts

        // Belt-and-braces timeout — getCurrentLocation() has its own
        // internal timeout, but this guarantees callers waiting on
        // LocationFixBridge (the plugin's requestImmediateFix promise) are
        // never left hanging past `timeoutMs` even if the OS-level call
        // stalls, e.g. GPS/network location genuinely unavailable indoors.
        val timeoutRunnable = Runnable {
            cts.cancel()
            deliverError("timeout", "No fix within ${timeoutMs}ms (reason=$reason)")
            stopIfIdle()
        }
        mainHandler.postDelayed(timeoutRunnable, timeoutMs)

        try {
            fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token)
                .addOnSuccessListener { loc ->
                    mainHandler.removeCallbacks(timeoutRunnable)
                    if (loc == null) {
                        deliverError("unavailable", "getCurrentLocation returned null (reason=$reason)")
                        stopIfIdle()
                        return@addOnSuccessListener
                    }
                    val fix = LocationFixBridge.Fix(
                        latitude = loc.latitude,
                        longitude = loc.longitude,
                        accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
                        timestampMs = loc.time,
                        source = "oneShot",
                    )
                    deliverFix(fix)
                    // Push-triggered fix: upload natively too (KI-12 gap 2) and
                    // only stop the service once that upload has finished,
                    // otherwise the OS could kill the process mid-request.
                    uploadFixNatively(fix) { stopIfIdle() }
                }
                .addOnFailureListener { e ->
                    mainHandler.removeCallbacks(timeoutRunnable)
                    deliverError("unknown", e.message ?: "getCurrentLocation failed (reason=$reason)")
                    stopIfIdle()
                }
        } catch (e: SecurityException) {
            mainHandler.removeCallbacks(timeoutRunnable)
            deliverError("denied", e.message ?: "SecurityException on one-shot fix")
            stopIfIdle()
        }
    }

    /** A push-triggered one-shot must not leave an idle service (or a GPS
     *  watcher) running in the background once it has its answer. */
    private fun stopIfIdle() {
        // May be reached twice for one request (timeout runnable + cancelled
        // task), so never let the counter go negative.
        val left = activeOneShots.updateAndGet { maxOf(0, it - 1) }
        if (left == 0) stopSelf()
    }

    /** Older builds created a "DuoSpace" channel for the foreground-service
     *  notification. Nothing posts to it any more — remove it so it doesn't
     *  linger as an empty entry in the app's notification settings. */
    private fun removeLegacyNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            getSystemService(NotificationManager::class.java)?.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        } catch (_: Exception) {
            // Best-effort cleanup only.
        }
    }
}
