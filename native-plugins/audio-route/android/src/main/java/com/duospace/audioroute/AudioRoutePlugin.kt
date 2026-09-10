package com.duospace.audioroute

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Real call-audio route switching (earpiece / speaker / Bluetooth / wired
 * headset) for Android.
 *
 * IMPORTANT — this does not own the call's audio session. Daily.co's WebRTC
 * engine (running inside the WebView) already puts AudioManager into
 * MODE_IN_COMMUNICATION and requests audio focus when a call starts. This
 * plugin only flips routing flags (speakerphone / Bluetooth SCO) on top of
 * that existing session — the same technique native WebRTC apps use — so it
 * must only be called while a Daily.co call is actually joined. Calling it
 * before/after a call is a harmless no-op (the OS just ignores the routing
 * hint), not a crash.
 */
@CapacitorPlugin(name = "DuospaceAudioRoute")
class AudioRoutePlugin : Plugin() {

    private lateinit var audioManager: AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = emitRouteChanged()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = emitRouteChanged()
    }

    override fun load() {
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
    }

    override fun handleOnDestroy() {
        try {
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
        } catch (_: Exception) {
            // Already unregistered or manager gone — safe to ignore on teardown.
        }
    }

    private fun emitRouteChanged() {
        val obj = JSObject()
        obj.put("route", currentRouteJson())
        notifyListeners("routeChanged", obj)
    }

    private fun typeNameFor(deviceType: Int): String = when (deviceType) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headset"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "wired_headset"
        else -> "unknown"
    }

    private fun deviceJson(device: AudioDeviceInfo): JSObject {
        val obj = JSObject()
        obj.put("id", device.id.toString())
        val label = device.productName?.toString()?.takeIf { it.isNotBlank() } ?: typeNameFor(device.type)
        obj.put("name", label)
        obj.put("type", typeNameFor(device.type))
        return obj
    }

    private fun outputDevices(): List<AudioDeviceInfo> =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .filter { typeNameFor(it.type) != "unknown" }

    @PluginMethod
    fun listRoutes(call: PluginCall) {
        val routes = outputDevices().map { deviceJson(it) }
        val obj = JSObject()
        obj.put("routes", com.getcapacitor.JSArray(routes))
        call.resolve(obj)
    }

    private fun currentRouteJson(): JSObject? {
        // API 31+: AudioManager exposes the actual active communication
        // device directly — the precise answer.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val active = audioManager.communicationDevice
            if (active != null) return deviceJson(active)
        }
        // Older API: infer from the routing flags this plugin itself sets.
        val inferredType = when {
            audioManager.isBluetoothScoOn -> "bluetooth"
            audioManager.isSpeakerphoneOn -> "speaker"
            outputDevices().any { typeNameFor(it.type) == "wired_headset" } -> "wired_headset"
            else -> "earpiece"
        }
        val match = outputDevices().firstOrNull { typeNameFor(it.type) == inferredType }
        return match?.let { deviceJson(it) }
    }

    @PluginMethod
    fun getCurrentRoute(call: PluginCall) {
        val obj = JSObject()
        obj.put("route", currentRouteJson())
        call.resolve(obj)
    }

    @PluginMethod
    fun setRoute(call: PluginCall) {
        val id = call.getString("id")
        val requestedType = call.getString("type")

        val targetDevice = id?.let { targetId -> outputDevices().firstOrNull { it.id.toString() == targetId } }
        val type = targetDevice?.let { typeNameFor(it.type) } ?: requestedType

        if (type == null) {
            call.reject("setRoute requires either id or type")
            return
        }

        // Precise path: Android 12+ can select the exact AudioDeviceInfo.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && targetDevice != null) {
            audioManager.setCommunicationDevice(targetDevice)
            call.resolve()
            return
        }

        // Broad-compat path (also the only path below API 31): flip the
        // classic routing flags. Always clear Bluetooth SCO first so
        // switching *away* from Bluetooth doesn't leave it dangling.
        when (type) {
            "bluetooth" -> {
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
                audioManager.isSpeakerphoneOn = false
            }
            "speaker" -> {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
                audioManager.isSpeakerphoneOn = true
            }
            "earpiece", "wired_headset" -> {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
                audioManager.isSpeakerphoneOn = false
            }
            else -> {
                call.reject("Unknown route type: $type")
                return
            }
        }
        call.resolve()
    }
}
