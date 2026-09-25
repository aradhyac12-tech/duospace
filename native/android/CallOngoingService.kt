package com.duospace.app

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * GAP FIX (calling-reliability follow-up): DuoSpace never told Android an
 * outgoing call was happening at all. TelecomHelper.registerOutgoingCall()
 * existed but was never called from anywhere (dead code — see git blame /
 * DuospaceCallKitBridgePlugin.kt's prior no-op reportOutgoingCall), and
 * nothing anywhere acquired a proximity wake lock. Net effect: outgoing
 * calls had no system-level "you're on a call" notification (unlike
 * incoming calls, which CallNotificationService/CallRingingService already
 * handle correctly), and the screen never blanked against your ear the way
 * a real phone call does — because nothing was actually the "phone call"
 * as far as Android's power manager was concerned.
 *
 * This service is the caller-side counterpart to CallRingingService
 * (receiver-side ringing): a persistent, undismissable "Calling…" / "On
 * call" notification via NotificationCompat.CallStyle (falls back to a
 * plain ongoing notification pre-API 31), PLUS the actual proximity
 * mechanism — PROXIMITY_SCREEN_OFF_WAKE_LOCK — held only while it's a
 * voice call (video needs the screen on). Started by
 * DuospaceCallKitBridgePlugin.reportOutgoingCall() (now wired — see that
 * file) at the same moment TelecomHelper.registerOutgoingCall() is called,
 * kept alive through CONNECTING/CONNECTED, and stopped by
 * DuospaceCallKitBridgePlugin.reportCallEnded().
 *
 * Deliberately independent of DuoSpaceConnectionService/Telecom: a Telecom
 * registration failure on some OEM build (already handled as best-effort
 * everywhere else in this file's siblings) must not also silently disable
 * the proximity fix, which has nothing to do with Telecom succeeding.
 */
class CallOngoingService : android.app.Service() {

    companion object {
        const val ACTION_START = "com.duospace.app.ONGOING_CALL_START"
        const val ACTION_MARK_CONNECTED = "com.duospace.app.ONGOING_CALL_CONNECTED"
        const val ACTION_STOP = "com.duospace.app.ONGOING_CALL_STOP"
        const val ACTION_HANGUP_TAPPED = "com.duospace.app.ONGOING_CALL_HANGUP_TAPPED"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_PARTNER_NAME = "partnerName"
        const val EXTRA_IS_VIDEO = "isVideo"
        private const val NOTIFICATION_ID = 9931
        private const val CHANNEL_ID = "duospace_ongoing_call"

        // NOTE ON CALLERS: DuospaceCallKitBridgePlugin (the Capacitor local
        // plugin JS talks to) lives in a SEPARATE Gradle module
        // (native-plugins/callkit-bridge, a com.android.library depending
        // only on capacitor-android — see its build.gradle) with no
        // compile-time dependency on this app module, and can't import
        // this class directly. It instead sends the same Intent actions
        // this companion builds, addressed by class name string
        // (Intent().setClassName(pkg, "com.duospace.app.CallOngoingService"))
        // — ordinary implicit-by-name component resolution, no reflection.
        // These start()/markConnected()/stop() helpers are for in-app-module
        // callers only (there currently are none, but keeping the direct
        // API avoids ever being tempted to have this module call back into
        // the plugin module the wrong way round).
        fun start(context: Context, callId: String, partnerName: String, isVideo: Boolean) {
            val intent = Intent(context, CallOngoingService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_PARTNER_NAME, partnerName)
                putExtra(EXTRA_IS_VIDEO, isVideo)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        /** Call once real remote audio is confirmed (see
         *  the call engine adapter's waitForRemoteAudioReady) — same "don't claim
         *  connected on local join alone" rule this app already applies to
         *  callStateMachine/callLatency. Switches the notification text
         *  from "Calling…" to an ongoing-call state and — this is the part
         *  that actually matters — acquires the proximity wake lock for
         *  voice calls. */
        fun markConnected(context: Context, callId: String, isVideo: Boolean) {
            val intent = Intent(context, CallOngoingService::class.java).apply {
                action = ACTION_MARK_CONNECTED
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_IS_VIDEO, isVideo)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, CallOngoingService::class.java).apply { action = ACTION_STOP })
        }
    }

    private var proximityLock: PowerManager.WakeLock? = null
    private var currentCallId: String? = null
    private var currentPartnerName: String = "Partner"
    private var registeredWithTelecom = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return START_NOT_STICKY
                val partnerName = intent.getStringExtra(EXTRA_PARTNER_NAME) ?: "Partner"
                val isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false)
                currentCallId = callId
                currentPartnerName = partnerName
                ensureChannel()
                val notification = buildNotification(partnerName, dialing = true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
                // Not acquired yet at dial time — see markConnected(). A
                // caller isn't holding the phone to their ear while it's
                // still ringing on the other end; acquiring here would just
                // blank the screen on the caller's own "Calling…" UI for no
                // reason.

                // GAP FIX: this is the actual wiring TelecomHelper.
                // registerOutgoingCall() was missing since it was written —
                // nothing ever called it. Best-effort, same as every other
                // Telecom call in this file's siblings: a failure (missing
                // system service, OEM quirk, API < 26) must not block the
                // call itself, which already works via the call engine/WebRTC with no
                // Telecom involvement at all — only the notification/
                // proximity fix above depends on this service running, not
                // on Telecom succeeding.
                try {
                    registeredWithTelecom = TelecomHelper.registerOutgoingCall(applicationContext, callId, partnerName, isVideo)
                } catch (e: Exception) {
                    android.util.Log.w("CallOngoingService", "registerOutgoingCall failed (non-fatal)", e)
                }
            }
            ACTION_MARK_CONNECTED -> {
                if (currentCallId == null) return START_NOT_STICKY // never started — stale/duplicate call
                val isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false)
                ensureChannel()
                val notification = buildNotification(currentPartnerName, dialing = false)
                val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                nm.notify(NOTIFICATION_ID, notification)
                setProximity(enabled = !isVideo)
            }
            ACTION_HANGUP_TAPPED -> {
                val callId = currentCallId
                CallBridge.dispatchCallAction(applicationContext, callId ?: "", "end", false, null, null)
                stopSelfCleanly()
            }
            ACTION_STOP, null -> stopSelfCleanly()
        }
        return START_NOT_STICKY
    }

    /** Video<->voice toggle mid-call should flip proximity without
     *  restarting the whole notification — exposed for a future JS hook if
     *  camera-toggle-during-voice-call ever needs it; not currently wired
     *  since DuoSpace calls don't switch call TYPE mid-call today, only
     *  camera on/off within a video call (which never had a proximity lock
     *  to begin with). Kept as a plain instance method rather than deleted
     *  so that hook has somewhere to go without touching wake-lock plumbing
     *  again. */
    @Suppress("DEPRECATION") // PROXIMITY_SCREEN_OFF_WAKE_LOCK has no non-deprecated replacement
    private fun setProximity(enabled: Boolean) {
        if (enabled) {
            if (proximityLock?.isHeld == true) return
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
            proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "DuoSpace:CallProximity")
            proximityLock?.setReferenceCounted(false)
            proximityLock?.acquire(10 * 60 * 60 * 1000L /* 10h safety cap, mirrors a real phone call's max hold */)
        } else {
            if (proximityLock?.isHeld == true) proximityLock?.release()
            proximityLock = null
        }
    }

    @Suppress("DEPRECATION")
    private fun stopSelfCleanly() {
        setProximity(false)
        currentCallId = null
        // See DuoSpaceConnection.disconnectSilently's doc comment: this is
        // JS-initiated (endCall()/cancel already decided to hang up before this
        // service's ACTION_STOP ever fires), so tear down Telecom's "in call"
        // state without re-dispatching a redundant "end" action back into JS.
        // FIX: this used to run only when THIS service had registered an
        // OUTGOING call (registeredWithTelecom). An answered INCOMING call's
        // connection was registered by CallNotificationService instead, so it
        // was never torn down when the call ended and lingered as a phantom
        // active/ringing call. Ending whatever connection exists is safe here:
        // reportCallEnded is only sent when a call is over.
        try {
            DuoSpaceConnectionService.endCurrentConnectionSilently()
        } catch (e: Exception) {
            android.util.Log.w("CallOngoingService", "endCurrentConnectionSilently failed (non-fatal)", e)
        }
        registeredWithTelecom = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        setProximity(false)
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = android.app.NotificationChannel(
            CHANNEL_ID, "Ongoing calls", android.app.NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while a DuoSpace call is dialing or in progress"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(partnerName: String, dialing: Boolean): Notification {
        val hangupIntent = Intent(this, CallOngoingService::class.java).apply { action = ACTION_HANGUP_TAPPED }
        val hangupPendingIntent = PendingIntent.getService(
            this, 0, hangupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0),
        )
        // Tapping the persistent "in call" notification brings the running
        // call screen back (same task, no relaunch) — how a call is
        // recovered after leaving the app.
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            putExtra("openOngoingCall", true)
        }
        val contentPendingIntent = openAppIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0),
            )
        }

        // CallStyle (API 31+) gives the real system "in call" chip/UI
        // treatment — same visual language as the phone app. Below that,
        // fall back to a plain high-priority ongoing notification with the
        // same hang-up action; it's not styled as a phone call but is
        // still accurate, dismiss-proof, and functional.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = Person.Builder().setName(partnerName).build()
            // androidx CallStyle has no separate "dialing" factory distinct
            // from forOngoingCall — forIncomingCall is receiver-side only
            // (already used by CallNotificationService for that case). The
            // dialing/connected distinction here is carried entirely by the
            // title/text below, same content the pre-API-31 fallback shows.
            val style = NotificationCompat.CallStyle.forOngoingCall(person, hangupPendingIntent)
            return NotificationCompat.Builder(this, CHANNEL_ID)
                .setStyle(style)
                .setContentTitle(if (dialing) "Calling $partnerName…" else partnerName)
                .setContentText(if (dialing) null else "DuoSpace call in progress")
                .setSmallIcon(R.drawable.ic_stat_duospace)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(contentPendingIntent)
                .build()
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(if (dialing) "Calling $partnerName…" else "DuoSpace call in progress")
            .setContentText(partnerName)
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, "Hang up", hangupPendingIntent)
            .setContentIntent(contentPendingIntent)
            .build()
    }
}
