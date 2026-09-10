package com.duospace.backgroundgeolocation

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.Collections
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * JS-facing side of native background location. The actual work happens in
 * `native/android/DuoSpaceLocationService.kt` (a foreground service in the
 * *app* package, not this plugin package — see that file's header and
 * LocationFixBridge.kt for why it's split that way: CallNotificationService.kt
 * needs to start the service directly, with zero dependency on this plugin
 * or a live Capacitor Bridge existing, since a push can arrive before the
 * app has ever been opened).
 *
 * This plugin never talks to FusedLocationProviderClient itself — it only
 * starts/stops that service via an explicit Intent (built by class name
 * string, not a compiled class reference: this module doesn't and can't
 * depend on the app module, only the reverse) and relays fixes back to JS
 * via LocationFixBridge, which the service calls into directly.
 *
 * UNVERIFIED: not compiled or run on a device — see DuoSpaceLocationService.kt.
 */
@CapacitorPlugin(
    name = "DuospaceBackgroundGeolocation",
    permissions = [
        Permission(strings = [android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
    ],
)
class BackgroundGeolocationPlugin : Plugin(), LocationFixBridge.Listener {

    // Pending requestImmediateFix() PluginCalls waiting on the next fix/error
    // from LocationFixBridge. FIFO is good enough here — one-shot requests
    // are triggered one push at a time in practice (a call or a message
    // arriving), not fired in bursts.
    private val pendingOneShotCalls: ConcurrentLinkedQueue<PluginCall> = ConcurrentLinkedQueue()

    override fun load() {
        LocationFixBridge.listener = this
    }

    override fun handleOnDestroy() {
        if (LocationFixBridge.listener === this) LocationFixBridge.listener = null
    }

    private fun serviceIntent(action: String): Intent =
        Intent().apply {
            setClassName(context.packageName, "${context.packageName}.DuoSpaceLocationService")
            this.action = action
        }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "startPermsCallback")
            return
        }
        startInternal(call)
    }

    @PermissionCallback
    private fun startPermsCallback(call: PluginCall) {
        if (getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED) {
            startInternal(call)
        } else {
            call.reject("Location permission denied", "denied")
        }
    }

    private fun startInternal(call: PluginCall) {
        // PluginCall has no getLong() in the Capacitor Android API (only
        // getInt/getDouble/getString/getBoolean/getArray/getObject) — using
        // getInt().toLong() instead of a not-reliably-present getLong() to
        // avoid a call the compiler may not resolve.
        val intervalMs = (call.getInt("intervalMs") ?: 45_000).toLong()
        val intent = serviceIntent(DuoSpaceLocationServiceAction.START).apply {
            putExtra("intervalMs", intervalMs)
        }
        try {
            ContextCompat.startForegroundService(context, intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to start background location service", e)
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            context.startService(serviceIntent(DuoSpaceLocationServiceAction.STOP))
            call.resolve()
        } catch (e: Exception) {
            // Best-effort — if the service isn't running there's nothing to
            // stop, which isn't a real failure from the caller's POV.
            call.resolve()
        }
    }

    @PluginMethod
    fun isRunning(call: PluginCall) {
        val ret = JSObject()
        ret.put("running", isWatcherRunningReflective())
        call.resolve(ret)
    }

    // Reads DuoSpaceLocationService.isWatcherRunning without a compile-time
    // class reference (see note on the module-dependency direction above).
    // Falls back to false — a stale "not running" is a harmless miss (JS
    // will just call start() again), whereas any crash here would not be.
    private fun isWatcherRunningReflective(): Boolean {
        return try {
            val cls = Class.forName("${context.packageName}.DuoSpaceLocationService")
            val field = cls.getDeclaredField("isWatcherRunning")
            field.isAccessible = true
            field.getBoolean(null)
        } catch (e: Exception) {
            false
        }
    }

    @PluginMethod
    fun requestImmediateFix(call: PluginCall) {
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Location permission denied", "denied")
            return
        }
        val reason = call.getString("reason") ?: "manual"
        val timeoutMs = (call.getInt("timeoutMs") ?: 8_000).toLong()
        pendingOneShotCalls.add(call)
        val intent = serviceIntent(DuoSpaceLocationServiceAction.ONE_SHOT).apply {
            putExtra("reason", reason)
            putExtra("timeoutMs", timeoutMs)
        }
        try {
            ContextCompat.startForegroundService(context, intent)
        } catch (e: Exception) {
            pendingOneShotCalls.remove(call)
            call.reject("Failed to request immediate fix", e)
        }
    }

    // ── LocationFixBridge.Listener ──────────────────────────────────────────

    override fun onFix(fix: LocationFixBridge.Fix) {
        val json = JSObject().apply {
            put("latitude", fix.latitude)
            put("longitude", fix.longitude)
            put("accuracy", fix.accuracy ?: JSObject.NULL)
            put("timestamp", fix.timestampMs)
            put("source", fix.source)
        }
        notifyListeners("locationUpdate", json)
        if (fix.source == "oneShot") {
            pendingOneShotCalls.poll()?.resolve(json)
        }
    }

    override fun onError(code: String, message: String) {
        val json = JSObject().apply {
            put("code", code)
            put("message", message)
        }
        notifyListeners("locationError", json)
        // Only drain one pending call per error — an error tied to a
        // specific one-shot request shouldn't fail other unrelated pending
        // requests that might still succeed.
        pendingOneShotCalls.poll()?.reject(message, code)
    }
}

/** Mirrors DuoSpaceLocationService.Companion's action constants — kept as
 *  plain strings here (not a shared import) for the same module-boundary
 *  reason documented on LocationFixBridge: this plugin module cannot import
 *  from the app module. Must be kept in sync with
 *  native/android/DuoSpaceLocationService.kt by hand. */
object DuoSpaceLocationServiceAction {
    const val START = "com.duospace.app.location.ACTION_START"
    const val STOP = "com.duospace.app.location.ACTION_STOP"
    const val ONE_SHOT = "com.duospace.app.location.ACTION_ONE_SHOT"
}
