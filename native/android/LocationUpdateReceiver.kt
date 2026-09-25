package com.duospace.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import com.duospace.backgroundgeolocation.LocationFixBridge
import com.duospace.backgroundgeolocation.PushUploadCredentialStore
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * QUIET BACKGROUND LOCATION — no foreground service, no notification.
 *
 * Why this exists: with the location notification removed, DuoSpaceLocationService
 * is a plain background service, which Android stops shortly after the app is
 * minimized. A callback-based watcher (LocationCallback) dies with it.
 *
 * The supported way to keep receiving location with NO notification is a
 * PENDING-INTENT subscription: we hand Google Play services a PendingIntent
 * pointing at this receiver, and Play services delivers location updates to it
 * itself, waking our process if needed. Nothing of ours has to stay running, so
 * Android requires no foreground service and no notification. It is NOT a hack
 * around a rule; it is the API Google documents for background updates.
 *
 * Honest limits (do not promise more to the user than this):
 *   - Needs "Allow all the time" (ACCESS_BACKGROUND_LOCATION) or background
 *     delivery is not permitted at all.
 *   - Android 8+ throttles apps that are in the background: expect fixes on the
 *     order of a few per hour when the phone is still, more when it is moving
 *     (we ask for a fix every 45 s / 20 m; the OS decides what it actually
 *     delivers). Push-triggered one-shots (a message or call arriving) fill the
 *     gaps and are NOT throttled the same way.
 *   - The subscription is cleared by a reboot and by force-stopping the app.
 *     Reboot / app-update are handled below (BOOT_COMPLETED,
 *     MY_PACKAGE_REPLACED); a force-stop is only undone when the app is opened.
 *   - Users can still see the app is using location in Android's own privacy
 *     indicators / "recent location access" — that is OS-level and can't and
 *     shouldn't be hidden.
 *
 * UNVERIFIED: not compiled or run on a device (same caveat as every native file
 * in this project).
 */
class LocationUpdateReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_LOCATION_UPDATE = "com.duospace.app.location.ACTION_LOCATION_UPDATE"
        private const val REQUEST_CODE = 4711
        const val DEFAULT_INTERVAL_MS = 45_000L
        private const val MIN_DISTANCE_M = 20f

        /** While the JS layer is alive it writes the fix itself; only upload
         *  natively that often in that case. With no JS, always upload. */
        private const val JS_ALIVE_UPLOAD_GAP_MS = 60_000L
        @Volatile private var lastNativeUploadAt = 0L

        private val io = Executors.newSingleThreadExecutor()

        /** MUST be mutable: Play services adds the LocationResult to it. Explicit
         *  component, so mutability is safe. Same intent => same registration, so
         *  calling register twice replaces rather than duplicates. */
        fun pendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, LocationUpdateReceiver::class.java).apply {
                action = ACTION_LOCATION_UPDATE
            }
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
            return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
        }

        /** Subscribes (or re-subscribes) to background updates. Never throws.
         *  Returns false when permission is missing or the call failed. */
        fun register(context: Context, intervalMs: Long = DEFAULT_INTERVAL_MS): Boolean {
            if (ActivityCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED
            ) return false
            return try {
                val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, intervalMs)
                    .setMinUpdateIntervalMillis(intervalMs / 2)
                    .setMinUpdateDistanceMeters(MIN_DISTANCE_M)
                    .build()
                LocationServices.getFusedLocationProviderClient(context)
                    .requestLocationUpdates(request, pendingIntent(context))
                true
            } catch (e: SecurityException) {
                android.util.Log.w("DuoSpaceLocation", "register: SecurityException", e)
                false
            } catch (e: Exception) {
                android.util.Log.w("DuoSpaceLocation", "register failed", e)
                false
            }
        }

        fun unregister(context: Context) {
            try {
                LocationServices.getFusedLocationProviderClient(context).removeLocationUpdates(pendingIntent(context))
            } catch (e: Exception) {
                android.util.Log.w("DuoSpaceLocation", "unregister failed", e)
            }
        }

        /** Shared by this receiver and DuoSpaceLocationService (push one-shots):
         *  POSTs one fix to the location-push-upload edge function with the
         *  per-device credential JS registered while signed in (KI-12 gap 2).
         *  Silent + best-effort; always calls [onDone] on the main thread of
         *  whoever posts it — here, simply on the io thread; callers must only
         *  do thread-safe things in it (finish() / Handler.post). */
        fun uploadFix(context: Context, fix: LocationFixBridge.Fix, onDone: () -> Unit) {
            val cred = PushUploadCredentialStore.read(context)
            if (cred == null) { onDone(); return }
            try {
                io.execute {
                    var conn: HttpURLConnection? = null
                    try {
                        val body = JSONObject().apply {
                            put("credential_id", cred.credentialId)
                            put("secret", cred.secret)
                            put("latitude", fix.latitude)
                            put("longitude", fix.longitude)
                            put("captured_at_ms", fix.timestampMs)
                        }.toString().toByteArray(Charsets.UTF_8)
                        conn = (URL(cred.uploadUrl).openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            connectTimeout = 6_000
                            readTimeout = 6_000
                            doOutput = true
                            setRequestProperty("Content-Type", "application/json")
                            setFixedLengthStreamingMode(body.size)
                        }
                        conn.outputStream.use { it.write(body) }
                        android.util.Log.i("DuoSpaceLocation", "native upload (source=${fix.source}) -> HTTP ${conn.responseCode}")
                    } catch (e: Exception) {
                        android.util.Log.w("DuoSpaceLocation", "native upload failed", e)
                    } finally {
                        try { conn?.disconnect() } catch (_: Exception) {}
                        try { onDone() } catch (_: Exception) {}
                    }
                }
            } catch (e: Exception) {
                onDone()
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_LOCATION_UPDATE -> handleLocation(context, intent)
            // Subscriptions do not survive a reboot or an app update. Re-subscribe,
            // but only if someone is signed in (the push credential exists only
            // after sign-in and is cleared on sign-out) and permission is there.
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (PushUploadCredentialStore.read(context) != null) register(context)
            }
        }
    }

    private fun handleLocation(context: Context, intent: Intent) {
        if (!LocationResult.hasResult(intent)) return
        val loc = LocationResult.extractResult(intent)?.lastLocation ?: return
        val fix = LocationFixBridge.Fix(
            latitude = loc.latitude,
            longitude = loc.longitude,
            accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
            timestampMs = loc.time,
            source = "watch",
        )
        val listener = LocationFixBridge.listener
        listener?.onFix(fix) // JS bridge alive -> LocationContext upserts it

        val now = SystemClock.elapsedRealtime()
        if (listener != null && lastNativeUploadAt != 0L && now - lastNativeUploadAt < JS_ALIVE_UPLOAD_GAP_MS) return
        lastNativeUploadAt = now

        // Keep the process alive until the HTTP request finishes.
        val pending = goAsync()
        uploadFix(context, fix) { pending.finish() }
    }
}
