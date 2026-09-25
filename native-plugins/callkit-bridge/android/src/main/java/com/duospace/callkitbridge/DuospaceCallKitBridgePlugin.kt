package com.duospace.callkitbridge

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * GAP FIX: this used to be a true no-op stub on the theory that "Android's
 * equivalent (self-managed ConnectionService) is wired entirely at the
 * native layer and doesn't need a JS-triggered call" — that was aspirational,
 * not actual: TelecomHelper.registerOutgoingCall() existed but nothing ever
 * called it, so outgoing calls never registered with Telecom at all, got no
 * system "in call" notification, and never held the proximity wake lock a
 * real call needs. reportOutgoingCall/reportCallConnected/reportCallEnded now
 * forward to native/android/CallOngoingService.kt, which does the actual
 * Telecom registration/teardown + notification + proximity work.
 *
 * NOT a direct class reference: this plugin compiles as its own Gradle
 * module (native-plugins/callkit-bridge/android — a com.android.library
 * depending only on capacitor-android, see its build.gradle), with no
 * compile-time dependency on the app module CallOngoingService lives in.
 * Reaching it is an ordinary implicit Intent addressed by component class
 * name string (`Intent().setClassName(pkg, "com.duospace.app....")`) —
 * resolved by the OS at runtime, no reflection, no new Gradle dependency.
 * Action-string/extra-key constants below MUST stay in sync with
 * native/android/CallOngoingService.kt's own (that file is the source of
 * truth; it isn't importable from here to share them directly).
 *
 * `callAction`/`voipTokenUpdated` events still never fire here — Android's
 * equivalent path remains the window CustomEvents dispatched from
 * native/android/CallBridge.kt (`duospace-call-action` /
 * `duospace-call-control`), not this plugin.
 */
@CapacitorPlugin(name = "DuospaceCallKitBridge")
class DuospaceCallKitBridgePlugin : Plugin() {

    companion object {
        private const val ONGOING_SERVICE_CLASS = "com.duospace.app.CallOngoingService"
        private const val ACTION_START = "com.duospace.app.ONGOING_CALL_START"
        private const val ACTION_MARK_CONNECTED = "com.duospace.app.ONGOING_CALL_CONNECTED"
        private const val ACTION_STOP = "com.duospace.app.ONGOING_CALL_STOP"
        private const val EXTRA_CALL_ID = "callId"
        private const val EXTRA_PARTNER_NAME = "partnerName"
        private const val EXTRA_IS_VIDEO = "isVideo"

        // Keep in sync with native/android/CallRingingService.kt
        // (ACTION_DISMISS_INCOMING) and CallNotificationService.kt
        // (NOTIFICATION_ID) — not importable from this module, see above.
        private const val RINGING_SERVICE_CLASS = "com.duospace.app.CallRingingService"
        private const val ACTION_DISMISS_INCOMING = "com.duospace.app.action.DISMISS_INCOMING"
        private const val INCOMING_CALL_NOTIFICATION_ID = 9911
        // CallRingingService.FOREGROUND_NOTIFICATION_ID — posted only while
        // the service is actually ringing (removed by stopRinging()).
        private const val RINGING_FOREGROUND_NOTIFICATION_ID = 9912

        // Keep in sync with native/android/MessageAlertService.kt (ACTION_*,
        // EXTRA_*) — not importable from this module, see the class doc.
        private const val ALERT_SERVICE_CLASS = "com.duospace.app.MessageAlertService"
        private const val ACTION_ALERT_START = "com.duospace.app.action.START_MESSAGE_ALERT"
        private const val ACTION_ALERT_STOP = "com.duospace.app.action.STOP_MESSAGE_ALERT"
    }

    private fun ongoingServiceIntent(action: String) =
        Intent().setClassName(context.packageName, ONGOING_SERVICE_CLASS).apply { this.action = action }

    @PluginMethod
    fun reportOutgoingCall(call: PluginCall) {
        val callId = call.getString("callId")
        val calleeName = call.getString("calleeName") ?: "Partner"
        val isVideo = call.getBoolean("isVideo") ?: false
        if (callId == null) {
            call.reject("callId is required")
            return
        }
        try {
            val intent = ongoingServiceIntent(ACTION_START).apply {
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_PARTNER_NAME, calleeName)
                putExtra(EXTRA_IS_VIDEO, isVideo)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        } catch (e: Exception) {
            // Best-effort, same as every other Telecom/notification call in
            // this codebase — a failure here must not block the call
            // itself, which already works via the call engine/WebRTC independent of
            // this notification/proximity layer.
            android.util.Log.w("DuospaceCallKitBridge", "CallOngoingService start failed (non-fatal)", e)
        }
        call.resolve()
    }

    /** Called once real remote audio is confirmed (see the call engine adapter's
     *  waitForRemoteAudioReady) — switches the ongoing-call notification out
     *  of "Calling…" and acquires the proximity wake lock for voice calls.
     *  Not part of the original iOS-mirrored surface (iOS gets the
     *  equivalent via CallKitManager.reportCallConnected, called directly by
     *  that platform's plugin) — added here since Android has no CallKit
     *  layer to piggyback the "now actually connected" moment on. */
    @PluginMethod
    fun reportCallConnected(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val isVideo = call.getBoolean("isVideo") ?: false
        try {
            context.startService(ongoingServiceIntent(ACTION_MARK_CONNECTED).apply {
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_IS_VIDEO, isVideo)
            })
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "CallOngoingService markConnected failed (non-fatal)", e)
        }
        call.resolve()
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        try {
            context.startService(ongoingServiceIntent(ACTION_STOP))
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "CallOngoingService stop failed (non-fatal)", e)
        }
        call.resolve()
    }

    // Android reads the call ringtone per-push from the FCM data payload
    // (see CallNotificationService.kt / CallRingingService.kt) rather than
    // from a locally-persisted preference, so there's nothing to persist
    // here — this only exists for JS call-site parity with iOS.
    /**
     * See definitions.ts `dismissIncomingCall`. Two independent best-effort
     * steps so a failure of one can't leave the other undone:
     *  1. tell CallRingingService (app module — reached by class-name string,
     *     same reason as ongoingServiceIntent above) to stop the ringtone/
     *     vibration and end the ringing Telecom connection for this callId;
     *  2. cancel the ringing notification directly here, so it disappears even
     *     if starting the service is refused.
     */
    @PluginMethod
    fun dismissIncomingCall(call: PluginCall) {
        val callId = call.getString("callId")
        try {
            val intent = Intent().setClassName(context.packageName, RINGING_SERVICE_CLASS).apply {
                action = ACTION_DISMISS_INCOMING
                if (callId != null) putExtra(EXTRA_CALL_ID, callId)
            }
            context.startService(intent)
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "CallRingingService dismiss failed (non-fatal)", e)
        }
        try {
            val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            nm.cancel(INCOMING_CALL_NOTIFICATION_ID)
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "incoming-call notification cancel failed (non-fatal)", e)
        }
        call.resolve()
    }

    /**
     * See definitions.ts `isIncomingRinging`. Read from the system's own list
     * of active notifications rather than a static on CallRingingService
     * (app module — not importable from this library module, see the class
     * doc). getActiveNotifications() needs API 23; older devices report false
     * (= "unknown, ring in-app").
     */
    @PluginMethod
    fun isIncomingRinging(call: PluginCall) {
        var ringing = false
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                ringing = nm.activeNotifications.any { it.id == RINGING_FOREGROUND_NOTIFICATION_ID }
            }
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "isIncomingRinging failed (non-fatal)", e)
        }
        call.resolve(JSObject().put("ringing", ringing))
    }

    @PluginMethod
    fun setRingtone(call: PluginCall) {
        call.resolve()
    }

    // Android's cold-start-lost-action fix for incoming-call accepts is the
    // localStorage write in handleDuospaceCallIntent (see
    // scripts/patch-native-permissions.mjs) — read directly by
    // src/lib/nativeCallActionBridge.ts, not through this plugin. Stubbed
    // here purely for call-site parity with iOS (same reasoning as the
    // other methods in this file's doc comment).
    @PluginMethod
    fun getPendingCallAction(call: PluginCall) {
        call.resolve()
    }

    // ── /important + /urgent message alerts (Android) ─────────────────────
    // The ringer itself is native/android/MessageAlertService.kt, started by the
    // FCM handler. These four methods only let JS stop it, preview it, read
    // what the phone allows, and send the person to the DND-access screen.

    @PluginMethod
    fun stopMessageAlert(call: PluginCall) {
        try {
            context.startService(
                Intent().setClassName(context.packageName, ALERT_SERVICE_CLASS).apply { action = ACTION_ALERT_STOP },
            )
        } catch (e: Exception) {
            // Not running / background start refused — nothing to stop.
            android.util.Log.w("DuospaceCallKitBridge", "stopMessageAlert (non-fatal)", e)
        }
        call.resolve()
    }

    @PluginMethod
    fun previewMessageAlert(call: PluginCall) {
        val level = if (call.getString("level") == "urgent") "urgent" else "important"
        try {
            val intent = Intent().setClassName(context.packageName, ALERT_SERVICE_CLASS).apply {
                action = ACTION_ALERT_START
                putExtra("alertLevel", level)
                putExtra("title", if (level == "urgent") "\uD83D\uDEA8 URGENT \u00B7 Preview" else "\u26A1 Important \u00B7 Preview")
                putExtra("body", "This is how an alert from your partner rings and vibrates.")
                putExtra("preview", true)
            }
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not start the alert preview: ${e.message}")
        }
    }

    @PluginMethod
    fun getMessageAlertStatus(call: PluginCall) {
        val out = JSObject().put("supported", true)
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val dnd = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm.isNotificationPolicyAccessGranted
            out.put("dndAccessGranted", dnd)
            out.put(
                "ringerMode",
                when (am.ringerMode) {
                    AudioManager.RINGER_MODE_SILENT -> "silent"
                    AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
                    else -> "normal"
                },
            )
            val filter = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                when (nm.currentInterruptionFilter) {
                    NotificationManager.INTERRUPTION_FILTER_ALL -> "all"
                    NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "priority"
                    NotificationManager.INTERRUPTION_FILTER_ALARMS -> "alarms"
                    NotificationManager.INTERRUPTION_FILTER_NONE -> "none"
                    else -> "unknown"
                }
            } else "all"
            out.put("interruptionFilter", filter)
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            out.put("alarmVolumePercent", if (max > 0) Math.round(100f * am.getStreamVolume(AudioManager.STREAM_ALARM) / max) else 0)
        } catch (e: Exception) {
            android.util.Log.w("DuospaceCallKitBridge", "getMessageAlertStatus (non-fatal)", e)
            out.put("dndAccessGranted", false).put("ringerMode", "normal").put("interruptionFilter", "unknown").put("alarmVolumePercent", 0)
        }
        call.resolve(out)
    }

    @PluginMethod
    fun openDndAccessSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open Do Not Disturb access settings: ${e.message}")
        }
    }
}
