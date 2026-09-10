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
        private const val NOTIFICATION_ID = 9911
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
            // Not a ringing call — let Capacitor's own service (also
            // registered for MESSAGING_EVENT) and the JS layer handle it.
            return
        }
        NotificationChannels.createAll(this)
        showIncomingCallNotification(data, type)
        startRingtoneService(data)
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
        try {
            val intent = Intent(this, DuoSpaceLocationService::class.java).apply {
                action = DuoSpaceLocationService.ACTION_ONE_SHOT
                putExtra(DuoSpaceLocationService.EXTRA_REASON, "push:$pushType")
            }
            androidx.core.content.ContextCompat.startForegroundService(this, intent)
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceLocation", "requestLocationFixForPush failed for type=$pushType", e)
        }
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
        )
    }

    private fun startRingtoneService(data: Map<String, String>) {
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
        }
        try {
            androidx.core.content.ContextCompat.startForegroundService(this, intent)
        } catch (_: Exception) {
            // If the OS refuses the foreground service (rare background
            // restriction edge case), the visual notification below still
            // rings via its channel sound as a fallback.
        }
    }

    private fun showIncomingCallNotification(data: Map<String, String>, type: String) {
        val callId = data["callId"] ?: return
        val conversationId = data["conversationId"]
        val callerName = data["senderName"] ?: "DuoSpace"
        val title = data["title"] ?: callerName
        val body = data["body"] ?: if (type == "incoming_video_call") "Incoming video call" else "Incoming voice call"

        // Full-screen intent: launches the app straight to the in-call UI
        // even over the lock screen — this is what makes it ring like a
        // real phone call instead of sitting as a silent notification.
        val fullScreenIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callType", data["callType"])
            putExtra("conversationId", conversationId)
            putExtra("roomName", data["roomName"])
            putExtra("pushType", type)
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, callId.hashCode(), fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Accept/Decline both simply open the app (there is no separate
        // background call-answer path in this codebase — joining a Daily.co
        // room requires the JS layer's existing token/room logic in
        // src/hooks/useDailyCall.ts). MainActivity reads `callAction` and:
        //  - "accept": lets the normal in-app IncomingCallOverlay flow take over.
        //  - "decline": immediately marks the call missed and stops ringing,
        //    same effect as tapping Decline inside the app.
        val acceptIntent = Intent(fullScreenIntent).putExtra("callAction", "accept")
        val declineIntent = Intent(fullScreenIntent).putExtra("callAction", "decline")
        val acceptPendingIntent = PendingIntent.getActivity(
            this, (callId + "_accept").hashCode(), acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val declinePendingIntent = PendingIntent.getActivity(
            this, (callId + "_decline").hashCode(), declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val callsChannel = NotificationChannels.callChannelId(data["callRingtone"] ?: "classic")
        val builder = NotificationCompat.Builder(this, callsChannel)
            // FIX: was applicationInfo.icon — rendered as a blank white
            // blob in the status bar (Android shows only the alpha
            // channel of a small icon; a launcher icon has none). See
            // DuoSpaceMessagingService.kt for the full explanation.
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)
            .addAction(0, "Decline", declinePendingIntent)
            .addAction(0, "Accept", acceptPendingIntent)
            .setTimeoutAfter(45_000)

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, builder.build())
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Token persistence is already owned by Capacitor's own service +
        // src/hooks/usePushNotifications.ts — nothing to do here.
    }
}
