package com.duospace.devicestatus

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Battery percentage + ringer/silent mode, both real public Android APIs —
 * no special permission needed for either.
 *
 *  - Battery: read from the sticky ACTION_BATTERY_CHANGED intent (registering
 *    a receiver with a null Intent for a sticky action returns the last
 *    broadcast immediately, so getStatus() doesn't need to wait for a fresh
 *    broadcast) plus a live receiver for change notifications.
 *  - Ringer: AudioManager.ringerMode, plus AudioManager.RINGER_MODE_CHANGED_ACTION
 *    for live updates.
 */
@CapacitorPlugin(name = "DuospaceDeviceStatus")
class DeviceStatusPlugin : Plugin() {

    private lateinit var audioManager: AudioManager
    private var batteryReceiver: BroadcastReceiver? = null
    private var ringerReceiver: BroadcastReceiver? = null

    override fun load() {
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

        // CRASH FIX (native process crash the first time this plugin is
        // touched from JS — e.g. usePublishDeviceStatus() mounting inside
        // LocationProvider right after a successful sign-in/sign-up,
        // regardless of which auth method was used, since that's the first
        // moment any screen calls DuospaceDeviceStatus.getStatus()/
        // addListener() and Capacitor lazily instantiates + load()s this
        // plugin on that first call):
        // targetSdkVersion is 35 (see build.gradle) — on Android 13+ apps
        // targeting API 33+, Context.registerReceiver(receiver, filter) for
        // a *real* (non-null) receiver requires explicitly declaring
        // RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED, and on API 34+ this is
        // no longer just a lint warning: omitting it throws a
        // SecurityException that is NOT caught anywhere in this call chain
        // (Capacitor's own plugin-load path doesn't wrap it), which crashes
        // the whole native process — exactly the generic "DuoSpace closed
        // because this app has a bug" OS dialog, not a JS-catchable error.
        // Both receivers here only ever need to observe this app's own
        // process/system broadcasts, never another app's, so
        // RECEIVER_NOT_EXPORTED (no other app may send these broadcasts to
        // us) is the correct flag, not RECEIVER_EXPORTED.
        // ContextCompat.registerReceiver back-fills the flagged overload on
        // API <33 too, so this is safe across minSdkVersion 23 as well.
        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) = emitStatus()
        }
        ContextCompat.registerReceiver(
            context,
            batteryReceiver,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        ringerReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) = emitStatus()
        }
        ContextCompat.registerReceiver(
            context,
            ringerReceiver,
            IntentFilter(AudioManager.RINGER_MODE_CHANGED_ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    override fun handleOnDestroy() {
        try { batteryReceiver?.let { context.unregisterReceiver(it) } } catch (_: Exception) { /* already gone */ }
        try { ringerReceiver?.let { context.unregisterReceiver(it) } } catch (_: Exception) { /* already gone */ }
    }

    private fun ringerModeName(): String = when (audioManager.ringerMode) {
        AudioManager.RINGER_MODE_SILENT -> "silent"
        AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
        AudioManager.RINGER_MODE_NORMAL -> "normal"
        else -> "unknown"
    }

    private fun statusJson(): JSObject {
        val obj = JSObject()
        // Sticky broadcast — registering with a null receiver against this
        // action synchronously returns the last-known battery intent.
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (batteryIntent != null) {
            val level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) {
                obj.put("batteryLevel", (level * 100.0 / scale))
            } else {
                obj.put("batteryLevel", JSObject.NULL)
            }
            val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            obj.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        } else {
            obj.put("batteryLevel", JSObject.NULL)
            obj.put("charging", JSObject.NULL)
        }
        obj.put("ringerMode", ringerModeName())
        return obj
    }

    private fun emitStatus() {
        notifyListeners("statusChanged", statusJson())
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(statusJson())
    }
}
