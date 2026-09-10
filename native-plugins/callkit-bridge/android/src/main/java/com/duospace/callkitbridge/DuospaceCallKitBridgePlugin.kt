package com.duospace.callkitbridge

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * No-op stub. CallKit/PushKit are iOS-only concepts — Android's equivalent
 * of "report a call to the OS" is the self-managed ConnectionService
 * wired entirely at the native layer (see native/android/TelecomHelper.kt,
 * DuoSpaceConnection.kt, DuoSpaceConnectionService.kt), which needs no
 * JS-triggered call.
 *
 * This plugin exists so JS call-initiation code (useDailyCall.ts) can call
 * DuospaceCallKitBridge.reportOutgoingCall()/reportCallEnded()
 * unconditionally, without an `if (Capacitor.getPlatform() === 'ios')`
 * branch at every call site — on Android these just resolve immediately.
 * `callAction`/`voipTokenUpdated` events never fire here; Android's
 * equivalent path is the window CustomEvents dispatched from
 * native/android/CallBridge.kt (`duospace-call-action` /
 * `duospace-call-control`), not this plugin.
 */
@CapacitorPlugin(name = "DuospaceCallKitBridge")
class DuospaceCallKitBridgePlugin : Plugin() {

    @PluginMethod
    fun reportOutgoingCall(call: PluginCall) {
        call.resolve()
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        call.resolve()
    }

    // Android reads the call ringtone per-push from the FCM data payload
    // (see CallNotificationService.kt / CallRingingService.kt) rather than
    // from a locally-persisted preference, so there's nothing to persist
    // here — this only exists for JS call-site parity with iOS.
    @PluginMethod
    fun setRingtone(call: PluginCall) {
        call.resolve()
    }
}
