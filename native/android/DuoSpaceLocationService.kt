package com.duospace.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import com.google.android.gms.location.CurrentLocationRequest
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
 * PUSH-TRIGGERED FIXES RUN IN A SHORT-LIVED FOREGROUND SERVICE (2026-10-01).
 * ROOT CAUSE of "location doesn't update with notifications": for a BACKGROUND
 * app Android (8.0+) makes the location system service compute a new fix only a
 * few times per hour, and the no-notification mode below meant a push-woken
 * one-shot ran as an ordinary background service — so getCurrentLocation()
 * returned nothing/stale data most of the time. The documented way around it is
 * a foreground service. A high-priority FCM message is an exemption that lets
 * an app start one from the background (Android 12+); a location-type FGS
 * started from the background still gets location only if the user granted
 * "Allow all the time". So: the FCM path now starts this service with
 * startForegroundService + EXTRA_FOREGROUND, it calls startForeground()
 * immediately, takes the fix, uploads, and stops. On Android 12+ the system
 * defers showing an FGS notification for ~10 s, so a normal push cycle shows
 * none; on Android 8-11 a minimum-importance, lock-screen-hidden "Syncing"
 * entry is visible for a few seconds. The always-on watcher is still notification-
 * free (and therefore still throttled by Android — push fixes are what fill it in).
 * Set USE_FOREGROUND_FOR_PUSH_FIX = false to go back to the notification-free mode.
 *
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
        /** Set by requestFixForPush when started with startForegroundService — the
         *  service MUST then call startForeground() within ~5 s. */
        const val EXTRA_FOREGROUND = "foreground"

        /** See the PUSH-TRIGGERED FIXES note above. */
        const val USE_FOREGROUND_FOR_PUSH_FIX = true

        private const val SYNC_CHANNEL_ID = "duospace_sync"
        private const val SYNC_NOTIFICATION_ID = 9931
        private const val TAG = "DuoSpaceLocation"

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
            val intent = Intent(context, DuoSpaceLocationService::class.java).apply {
                action = ACTION_ONE_SHOT
                putExtra(EXTRA_REASON, "push:$pushType")
            }
            if (USE_FOREGROUND_FOR_PUSH_FIX) {
                try {
                    intent.putExtra(EXTRA_FOREGROUND, true)
                    androidx.core.content.ContextCompat.startForegroundService(context, intent)
                    return
                } catch (e: Exception) {
                    // e.g. ForegroundServiceStartNotAllowedException (push was not
                    // high priority / OEM restriction). Fall through to a plain start.
                    android.util.Log.w(TAG, "foreground start refused for push:$pushType — trying plain start", e)
                    intent.removeExtra(EXTRA_FOREGROUND)
                }
            }
            try {
                context.startService(intent)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "requestFixForPush failed for type=$pushType — uploading status only", e)
                // The service could not start at all. The FCM handler still has a few
                // seconds of process life: at least push battery/ringer to the partner.
                try { LocationUpdateReceiver.uploadFix(context, null) { } } catch (_: Exception) { }
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
        // MUST be first: startForegroundService() requires startForeground() within ~5 s.
        if (intent?.getBooleanExtra(EXTRA_FOREGROUND, false) == true) enterForeground()
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
        mainHandler.removeCallbacksAndMessages(null)
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
    private fun uploadFixNatively(fix: LocationFixBridge.Fix?, onDone: () -> Unit) {
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

    /** Minimal, silent, lock-screen-hidden notification that satisfies the FGS contract. */
    private fun enterForeground() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val ch = NotificationChannel(SYNC_CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_SECRET
                    description = "Shown for a moment while DuoSpace refreshes your status after a message or call."
                }
                nm.createNotificationChannel(ch)
            }
            val n = androidx.core.app.NotificationCompat.Builder(this, SYNC_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_duospace)
                .setContentTitle("DuoSpace")
                .setContentText("Syncing")
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
                .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_SECRET)
                .setOngoing(true)
                .setCategory(androidx.core.app.NotificationCompat.CATEGORY_SERVICE)
                .build()
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(SYNC_NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                } else {
                    startForeground(SYNC_NOTIFICATION_ID, n)
                }
            } catch (e: Exception) {
                android.util.Log.w(TAG, "typed startForeground failed — retrying untyped", e)
                startForeground(SYNC_NOTIFICATION_ID, n)
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "could not enter foreground; continuing as a plain service", e)
        }
    }

    private fun backgroundPermissionMissing(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
            PackageManager.PERMISSION_GRANTED

    /** One getCurrentLocation attempt. [onResult] runs once on the main thread; null = no fix. */
    private fun fetchCurrent(priority: Int, durationMs: Long, maxAgeMs: Long, onResult: (Location?) -> Unit) {
        val cts = CancellationTokenSource()
        oneShotCancellationSource = cts
        var done = false
        val timeout = Runnable {
            if (done) return@Runnable
            done = true
            cts.cancel()
            onResult(null)
        }
        mainHandler.postDelayed(timeout, durationMs + 1_500L)
        try {
            val req = CurrentLocationRequest.Builder()
                .setPriority(priority)
                .setMaxUpdateAgeMillis(maxAgeMs)
                .setDurationMillis(durationMs)
                .build()
            fusedClient.getCurrentLocation(req, cts.token)
                .addOnSuccessListener { loc ->
                    if (done) return@addOnSuccessListener
                    done = true; mainHandler.removeCallbacks(timeout); onResult(loc)
                }
                .addOnFailureListener { e ->
                    if (done) return@addOnFailureListener
                    done = true; mainHandler.removeCallbacks(timeout)
                    android.util.Log.w(TAG, "getCurrentLocation failed: ${e.message}")
                    onResult(null)
                }
        } catch (e: SecurityException) {
            if (!done) { done = true; mainHandler.removeCallbacks(timeout); onResult(null) }
        }
    }

    /**
     * Push-triggered fix, staged so it succeeds indoors / with a cold GPS:
     *   1. HIGH_ACCURACY (accepts a fix <=30 s old) — up to [timeoutMs]
     *   2. BALANCED (Wi-Fi/cell, works indoors)     — up to 6 s
     *   3. last known location if <=10 min old (the edge function's own limit)
     * Exactly ONE upload + ONE stopIfIdle per request. If nothing works, a STATUS-ONLY
     * upload still goes out so battery/ringer refresh.
     */
    private fun requestOneShotFix(reason: String, timeoutMs: Long) {
        activeOneShots.incrementAndGet()
        val finished = java.util.concurrent.atomic.AtomicBoolean(false)
        fun finish(fix: LocationFixBridge.Fix?) {
            if (!finished.compareAndSet(false, true)) return
            uploadFixNatively(fix) { stopIfIdle() }
        }
        if (!hasLocationPermission()) {
            deliverError("denied", "ACCESS_FINE_LOCATION not granted")
            finish(null)
            return
        }
        if (backgroundPermissionMissing() && !isAppInForeground()) {
            // Without "Allow all the time" a background-started service gets no location.
            android.util.Log.w(TAG, "ACCESS_BACKGROUND_LOCATION not granted — push fix will likely fail (reason=$reason)")
        }

        fun accept(loc: Location, how: String) {
            android.util.Log.i(TAG, "one-shot fix via $how (reason=$reason, age=${System.currentTimeMillis() - loc.time}ms, acc=${if (loc.hasAccuracy()) loc.accuracy else -1f})")
            val fix = LocationFixBridge.Fix(
                latitude = loc.latitude,
                longitude = loc.longitude,
                accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
                timestampMs = loc.time,
                source = "oneShot",
            )
            if (!finished.get()) deliverFix(fix)
            finish(fix)
        }

        fun lastKnownFallback() {
            try {
                fusedClient.lastLocation
                    .addOnSuccessListener { loc ->
                        if (loc != null && System.currentTimeMillis() - loc.time <= 10 * 60 * 1000L) accept(loc, "lastLocation")
                        else { deliverError("unavailable", "no fix (reason=$reason)"); finish(null) }
                    }
                    .addOnFailureListener { deliverError("unknown", it.message ?: "lastLocation failed"); finish(null) }
            } catch (e: SecurityException) {
                deliverError("denied", e.message ?: "SecurityException"); finish(null)
            }
        }

        // Hard deadline so a stalled Play-services call can never pin the service.
        mainHandler.postDelayed({
            if (!finished.get()) {
                oneShotCancellationSource?.cancel()
                deliverError("timeout", "push fix deadline hit (reason=$reason)")
                finish(null)
            }
        }, timeoutMs.coerceIn(4_000L, 12_000L) + 6_000L + 5_000L)

        fetchCurrent(Priority.PRIORITY_HIGH_ACCURACY, timeoutMs.coerceIn(4_000L, 12_000L), 30_000L) { hi ->
            if (hi != null) { accept(hi, "high-accuracy"); return@fetchCurrent }
            fetchCurrent(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 6_000L, 60_000L) { bal ->
                if (bal != null) accept(bal, "balanced") else lastKnownFallback()
            }
        }
    }

    private fun isAppInForeground(): Boolean = CallNotificationService.isAppForegrounded

    /** A push-triggered one-shot must not leave an idle service (or a GPS
     *  watcher) running in the background once it has its answer. */
    private fun stopIfIdle() {
        // May be reached twice for one request (timeout runnable + cancelled
        // task), so never let the counter go negative.
        val left = activeOneShots.updateAndGet { maxOf(0, it - 1) }
        if (left == 0) {
            // Leave foreground first (no-op if this run was never foreground) so the
            // short-lived "Syncing" notification disappears the moment the work is done.
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE)
                else @Suppress("DEPRECATION") stopForeground(true)
            } catch (_: Exception) { }
            stopSelf()
        }
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
