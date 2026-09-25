package com.duospace.app

import android.app.PendingIntent
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Additional FirebaseMessagingService for DuoSpace incoming-call pushes.
 *
 * Registered ALONGSIDE (not instead of) the Capacitor push-notifications
 * plugin's own service in AndroidManifest.xml — Android allows more than one
 * component declaring the `com.google.firebase.MESSAGING_EVENT` intent
 * filter, and FCM delivers the message to every matching listener. Ordinary
 * message/reaction/friend pushes are left untouched here and continue to be
 * handled by Capacitor's plugin (and the JS listeners in
 * src/hooks/usePushNotifications.ts) exactly as before.
 *
 * This service only intercepts the two ringing-call types
 * (`incoming_audio_call` / `incoming_video_call`), which the send-push Edge
 * Function always sends data-only (no top-level `notification` block — see
 * supabase/functions/_shared/fcm.ts) specifically so a plain OS notification
 * is never auto-shown for them and this is the only code path that renders
 * them: a full-screen-intent, high-importance, Accept/Decline ringing
 * notification plus a real looping ringtone via CallRingingService.
 *
 * ALSO requests an immediate location fix for every push this service
 * receives — calls and ordinary messages alike (see the top of
 * onMessageReceived, before the call-type check) — by starting
 * DuoSpaceLocationService with ACTION_ONE_SHOT. That's a plain foreground-
 * service Intent, independent of whether the Capacitor Bridge/WebView/
 * duospace-background-geolocation plugin has ever loaded, so it works even
 * on a fully cold FCM wakeup (see docs/BACKGROUND_LOCATION_NATIVE.md).
 */
class CallNotificationService : FirebaseMessagingService() {

    companion object {
        const val ACTION_ACCEPT = "com.duospace.app.ACTION_ACCEPT_CALL"
        const val ACTION_DECLINE = "com.duospace.app.ACTION_DECLINE_CALL"
        // Not private: CallRingingService.dismissIncoming() cancels this same
        // notification when the JS layer reports the call is no longer ringing.
        const val NOTIFICATION_ID = IncomingCallNotification.NOTIFICATION_ID

        /**
         * DOUBLE-NOTIFICATION FIX: true while the app is visibly in the
         * foreground (MainActivity.onResume → true, MainActivity.onPause →
         * false). Set from MainActivity only — never from this service,
         * so there's no circular dependency.
         *
         * When true, showIncomingCallNotification() and startRingtoneService()
         * are skipped: the in-app IncomingCallOverlay (a full-screen React
         * component that mounts in CallContext.tsx for every authenticated
         * route) is already showing and the JS layer is already playing the
         * ringtone/vibration via startRingtoneLoop()/startCallVibration().
         * Posting the OS notification on top creates two simultaneous ringing
         * experiences — the larger, interactive in-app screen (correct) and
         * a second, smaller notification-panel card (redundant and confusing).
         *
         * Volatile because it is written from the main thread (Activity
         * lifecycle callbacks) and read from the FCM delivery thread.
         *
         * @JvmField is REQUIRED, not cosmetic: Capacitor 8 generates
         * MainActivity.java (not .kt), and the Java port of the lifecycle
         * hooks in scripts/patch-native-permissions.mjs assigns this as a
         * plain static field (`CallNotificationService.isAppForegrounded =
         * true;`). Without @JvmField, Kotlin keeps the backing field
         * private and only exposes Companion.isAppForegrounded()/
         * Companion.setAppForegrounded(), so javac fails with
         * "isAppForegrounded has private access in CallNotificationService"
         * (compileReleaseJavaWithJavac). @JvmField promotes the backing
         * field to a public static volatile field; Kotlin callers are
         * unaffected.
         */
        @JvmField
        @Volatile
        var isAppForegrounded: Boolean = false
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        requestLocationFixForPush(data["type"] ?: "unknown")
        val type = data["type"] ?: return
        if (type == "missed_call" || type == "call_ended" || type == "call_rejected") {
            // GAP FIX (source-level, unverified on device — see
            // docs/NATIVE_CALL_AUDIT.md): these three push types are exactly
            // the "this call is over" signals send-push already dispatches
            // to the receiver (supabase/functions/_shared/fcm.ts) — caller
            // cancelled, call ended, or declined elsewhere — but nothing in
            // this service (or anywhere else in the native call stack) ever
            // acted on them; onMessageReceived returned early for every type
            // except incoming_*_call, so a backgrounded/killed app had no
            // path that could ever stop CallRingingService or dismiss the
            // ringing notification once started. See that stopIncomingCallUi
            // for the fix and why it's still callId-guarded even though this
            // is the primary stop signal, not just the self-timeout fallback.
            stopIncomingCallUi(data)
            return
        }
        if (type != "incoming_audio_call" && type != "incoming_video_call") {
            // FCM ROUTING FIX (KI-08): Android may route ALL FCM messages to
            // ONE registered FirebaseMessagingService, not all three. When
            // this service wins routing, non-call pushes would silently get
            // dropped here (returning early) and DuoSpaceMessagingService
            // would never see them — causing the "no text/call notifications"
            // symptom. Fix: delegate to DuoSpaceMessagingService's static
            // handler so chat/reaction/request notifications still appear
            // regardless of which service Android chose to route to.
            DuoSpaceMessagingService.handlePush(this, data, type)
            return
        }
        NotificationChannels.createAll(this)
        // ONE-SURFACE FIX: Android now ALWAYS uses the native ringer + the
        // single WhatsApp-style CallStyle notification — foregrounded or not.
        // The in-app IncomingCallOverlay no longer renders its own ringing
        // screen on Android (it only falls back to it if this native path
        // never started — see IncomingCallOverlay.tsx), so there is exactly
        // one incoming-call surface instead of an overlay + two notifications.
        // When the ringer service started, ITS foreground notification is
        // that one notification (same id) — nothing extra is posted here.
        val serviceRinging = startRingtoneService(data, type)
        if (!serviceRinging) showIncomingCallNotification(data, type)
        registerWithTelecom(data, type)
    }

    /**
     * Stops the native ringing experience for a call that just ended,
     * was declined, or was missed — see the onMessageReceived call site.
     * callId-guarded inside CallRingingService itself (ACTION_STOP now
     * checks it against whatever's actually ringing) so a delayed/
     * out-of-order stop push for an old call can't cut off a newer one
     * that's ringing now (item 12 in the brief this audit traces back to:
     * "a stale event from an old call must never terminate a newer call").
     * The notification cancel() below is NOT similarly guarded — this app
     * only ever shows one call notification at a time under the fixed
     * NOTIFICATION_ID (9911), so there's nothing to disambiguate; a second
     * concurrent incoming call isn't part of this architecture (see
     * CallContext.tsx's "already on a call" guard on the JS side).
     */
    private fun stopIncomingCallUi(data: Map<String, String>) {
        try {
            val intent = Intent(this, CallRingingService::class.java).apply {
                action = CallRingingService.ACTION_STOP
                putExtra(CallRingingService.EXTRA_CALL_ID, data["callId"])
            }
            // startService (not startForegroundService) — this is a command
            // to a service that should already be running in the foreground
            // from the original incoming-call push, not a new start.
            // REQUIRES REAL DEVICE: if CallRingingService somehow ISN'T
            // already running (e.g. this stop push arrives before the
            // ringing push ever did), this line would need to start a new
            // background service instance just to stop it — background-
            // service-start restrictions (Android 8+) vary by OS
            // version/manufacturer and FirebaseMessagingService's temporary
            // foreground grace period; caught below rather than assumed safe.
            startService(intent)
        } catch (_: Exception) {
            // Best-effort — a failure here must not crash push handling.
        }
        try {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(NOTIFICATION_ID)
        } catch (_: Exception) {
        }
        // The call is over (cancelled / declined / ended) — a ringing Telecom
        // connection left behind would keep the OS thinking a call is still
        // incoming and make onCreateIncomingConnection reject the NEXT call as
        // BUSY. callId-guarded so a stale push can't end a newer call.
        try {
            DuoSpaceConnectionService.endConnectionForCall(data["callId"])
        } catch (_: Exception) {
        }
    }

    /**
     * Fires for literally every push this service sees (see the call site
     * at the top of onMessageReceived, before the call-type filter below).
     * Best-effort by design: a failure here must never affect call
     * ringing/notification delivery, which is why it's wrapped and never
     * rethrows — same "never fail the thing that triggered it" philosophy
     * PUSH_NOTIFICATIONS.md documents for the send-push DB triggers.
     */
    private fun requestLocationFixForPush(pushType: String) {
        // Shared + debounced — see DuoSpaceLocationService.requestFixForPush.
        // DuoSpaceMessagingService calls the same helper, so the fix happens
        // regardless of which of the two services Android delivers a push to.
        DuoSpaceLocationService.requestFixForPush(this, pushType)
    }

    /**
     * Best-effort OS-level call registration — see TelecomHelper.kt. This
     * runs AFTER the notification/ringtone above are already unconditionally
     * fired, purely to add Bluetooth/car head-unit answer-reject support
     * and correct "in a call" awareness for other apps. Its success or
     * failure has no effect on whether the phone actually rings.
     */
    private fun registerWithTelecom(data: Map<String, String>, type: String) {
        val callId = data["callId"] ?: return
        TelecomHelper.registerIncomingCall(
            context = this,
            callId = callId,
            callerName = data["senderName"] ?: data["title"] ?: "DuoSpace",
            isVideo = type == "incoming_video_call",
            conversationId = data["conversationId"],
            roomName = data["roomName"],
            decline = listOf("declineUrl", "declineToken", "declineExp", "declineReceiver").associateWith { data[it] },
        )
    }

    /** True if the OS accepted the ringing service start. */
    private fun startRingtoneService(data: Map<String, String>, type: String): Boolean {
        val intent = Intent(this, CallRingingService::class.java).apply {
            action = CallRingingService.ACTION_START
            putExtra(CallRingingService.EXTRA_CALL_ID, data["callId"])
            putExtra(CallRingingService.EXTRA_CALLER_NAME, data["senderName"] ?: data["title"])
            // Which bundled ringtone + vibration pattern to actually play —
            // the recipient's saved preference, echoed by send-push into
            // data.callRingtone (see soundCatalog.ts). The CALLS channel's
            // own sound/vibration (below) is a fallback for the rare case
            // the foreground service itself is refused by the OS.
            putExtra(CallRingingService.EXTRA_RINGTONE_ID, data["callRingtone"] ?: "classic")
            putExtra(CallRingingService.EXTRA_IS_VIDEO, type == "incoming_video_call")
            putExtra(CallRingingService.EXTRA_CALL_TYPE, data["callType"])
            putExtra(CallRingingService.EXTRA_CONVERSATION_ID, data["conversationId"])
            putExtra(CallRingingService.EXTRA_ROOM_NAME, data["roomName"])
            putExtra(CallRingingService.EXTRA_PUSH_TYPE, type)
            for (k in listOf("declineUrl", "declineToken", "declineExp", "declineReceiver")) data[k]?.let { putExtra(k, it) }
        }
        return try {
            androidx.core.content.ContextCompat.startForegroundService(this, intent)
            true
        } catch (_: Exception) {
            // If the OS refuses the foreground service (rare background
            // restriction edge case), the visual notification still rings
            // via its per-ringtone channel sound as a fallback.
            false
        }
    }

    /** Fallback only — used when the OS refused the ringer foreground
     *  service. Same single notification, on the audible per-ringtone
     *  channel so it still rings once. */
    private fun showIncomingCallNotification(data: Map<String, String>, type: String) {
        val callId = data["callId"] ?: return
        val notification = IncomingCallNotification.build(
            context = this,
            channelId = NotificationChannels.callChannelId(data["callRingtone"] ?: "classic"),
            callId = callId,
            callerName = data["senderName"] ?: data["title"] ?: "DuoSpace",
            isVideo = type == "incoming_video_call",
            callType = data["callType"],
            conversationId = data["conversationId"],
            roomName = data["roomName"],
            pushType = type,
            useCallStyle = false, // not a foreground service and no fullScreenIntent → see IncomingCallNotification
            decline = listOf("declineUrl", "declineToken", "declineExp", "declineReceiver").associateWith { data[it] },
        )
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, notification)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Token persistence is already owned by Capacitor's own service +
        // src/hooks/usePushNotifications.ts — nothing to do here.
    }
}
