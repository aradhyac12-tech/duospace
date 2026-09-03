package com.duospace.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.CancellationTokenSource
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.duospace.backgroundgeolocation.LocationFixBridge

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
        private const val NOTIFICATION_ID = 9922
        private const val CHANNEL_ID = "duospace_location"

        /** So the plugin's isRunning() can answer without a round trip. */
        @Volatile
        var isWatcherRunning: Boolean = false
            private set
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private var watcherCallback: LocationCallback? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var oneShotCancellationSource: CancellationTokenSource? = null

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        createChannelIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                // Foreground services must call startForeground() within a
                // few seconds of being started (Android 8+) or the OS kills
                // the process — do this first, before touching location APIs.
                startForeground(NOTIFICATION_ID, buildNotification())
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, DEFAULT_INTERVAL_MS)
                startWatcher(intervalMs)
            }
            ACTION_ONE_SHOT -> {
                // A one-shot request also needs the foreground-service
                // notification while it runs — there's no exemption for a
                // few-seconds fetch on Android 8+. If a watcher is already
                // running, startForeground() again is a harmless no-op
                // (updates the same notification).
                startForeground(NOTIFICATION_ID, buildNotification())
                val reason = intent.getStringExtra(EXTRA_REASON) ?: "unknown"
                val timeoutMs = intent.getLongExtra(EXTRA_TIMEOUT_MS, DEFAULT_ONE_SHOT_TIMEOUT_MS)
                requestOneShotFix(reason, timeoutMs)
                // Also make sure the ongoing watcher is running from here on
                // — see definitions.ts: a one-shot request should leave
                // tracking active, not just fire once and go silent.
                if (!isWatcherRunning) startWatcher(DEFAULT_INTERVAL_MS)
            }
            ACTION_STOP -> {
                stopWatcher()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        // START_STICKY: if the OS kills this service to reclaim memory, ask
        // it to recreate it (with a null Intent) rather than leaving
        // tracking silently dead — matches the "always on while signed in"
        // product decision LocationContext.tsx already encodes for the
        // foreground engine.
        return START_STICKY
    }

    override fun onDestroy() {
        stopWatcher()
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

    private fun startWatcher(intervalMs: Long) {
        if (!hasLocationPermission()) {
            deliverError("denied", "ACCESS_FINE_LOCATION not granted")
            stopSelf()
            return
        }
        if (isWatcherRunning) stopWatcher() // restart cleanly with the new interval

        val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .build()

        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                deliverFix(
                    LocationFixBridge.Fix(
                        latitude = loc.latitude,
                        longitude = loc.longitude,
                        accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
                        timestampMs = loc.time,
                        source = "watch",
                    ),
                )
            }
        }
        watcherCallback = callback
        try {
            fusedClient.requestLocationUpdates(request, callback, Looper.getMainLooper())
            isWatcherRunning = true
        } catch (e: SecurityException) {
            deliverError("denied", e.message ?: "SecurityException requesting updates")
        }
    }

    private fun stopWatcher() {
        watcherCallback?.let { fusedClient.removeLocationUpdates(it) }
        watcherCallback = null
        isWatcherRunning = false
    }

    private fun requestOneShotFix(reason: String, timeoutMs: Long) {
        if (!hasLocationPermission()) {
            deliverError("denied", "ACCESS_FINE_LOCATION not granted")
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
        }
        mainHandler.postDelayed(timeoutRunnable, timeoutMs)

        try {
            fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token)
                .addOnSuccessListener { loc ->
                    mainHandler.removeCallbacks(timeoutRunnable)
                    if (loc == null) {
                        deliverError("unavailable", "getCurrentLocation returned null (reason=$reason)")
                        return@addOnSuccessListener
                    }
                    deliverFix(
                        LocationFixBridge.Fix(
                            latitude = loc.latitude,
                            longitude = loc.longitude,
                            accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
                            timestampMs = loc.time,
                            source = "oneShot",
                        ),
                    )
                }
                .addOnFailureListener { e ->
                    mainHandler.removeCallbacks(timeoutRunnable)
                    deliverError("unknown", e.message ?: "getCurrentLocation failed (reason=$reason)")
                }
        } catch (e: SecurityException) {
            mainHandler.removeCallbacks(timeoutRunnable)
            deliverError("denied", e.message ?: "SecurityException on one-shot fix")
        }
    }

    private fun createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = android.app.NotificationChannel(
            CHANNEL_ID,
            "Location sharing",
            NotificationManager.IMPORTANCE_MIN, // silent, minimal UI intrusion — same spirit as a low-priority "ongoing" foreground-service notice
        ).apply {
            description = "Keeps your live location updating with your partner in the background."
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = openAppIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DuoSpace")
            .setContentText("Sharing your location with your partner")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setContentIntent(contentIntent)
            .build()
    }
}
