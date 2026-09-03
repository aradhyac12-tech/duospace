package com.duospace.devicestatus

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
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

        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) = emitStatus()
        }
        context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

        ringerReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) = emitStatus()
        }
        context.registerReceiver(ringerReceiver, IntentFilter(AudioManager.RINGER_MODE_CHANGED_ACTION))
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
