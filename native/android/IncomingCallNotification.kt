package com.duospace.app

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * The ONE incoming-call notification (WhatsApp-style).
 *
 * Previously an incoming call produced up to three ringing surfaces at once:
 * CallRingingService's own foreground notification ("Incoming call", no
 * buttons, id 9912), CallNotificationService's separate notification with
 * plain-text "Decline"/"Accept" actions (id 9911), and — when the app was
 * open — the full-screen in-app IncomingCallOverlay. Now both services post
 * this same notification under the same id, so there is exactly one.
 *
 * API 31+: NotificationCompat.CallStyle.forIncomingCall — the system renders
 * the real phone-call layout with a green Answer and red Decline button.
 * Older Android: same notification with coloured action labels.
 *
 * Persistent: ongoing + not auto-cancel + no setTimeoutAfter; it is removed
 * only when the call is answered, declined, cancelled by the caller, or the
 * ringer's own 45s unanswered timeout ends the call.
 *
 * WHATSAPP-STYLE FIX: this used to also carry setFullScreenIntent(fullScreen,
 * true), which tells the OS it MAY launch MainActivity full-screen on its own
 * the instant the notification posts — and on plenty of devices (unlocked
 * screen, no other app in front) it does exactly that, so every incoming
 * call yanked the person into the app instead of just ringing. WhatsApp
 * doesn't do this: it posts a high-priority CallStyle notification — heads-up
 * banner, big Answer/Decline buttons, full ring — and only opens the app if
 * you actually tap it. No fullScreenIntent means no OS-initiated launch;
 * contentIntent below still opens the app if the person taps the
 * notification body, and answer/decline still open it to join/end the call.
 */
object IncomingCallNotification {
    const val NOTIFICATION_ID = 9911

    fun build(
        context: Context,
        channelId: String,
        callId: String,
        callerName: String,
        isVideo: Boolean,
        callType: String?,
        conversationId: String?,
        roomName: String?,
        pushType: String?,
        /** CallStyle needs a foreground service OR a full-screen intent on
         *  API 31+. The ringer service is a foreground service → true. The
         *  plain-notify() fallback has neither (no fullScreenIntent by design),
         *  so it passes false and gets the regular high-priority template with
         *  coloured Answer/Decline actions instead of being rejected by the OS. */
        useCallStyle: Boolean = true,
        /** From the push (send-push → callActionToken.ts). When present,
         *  Decline is an instant background broadcast (CallActionReceiver)
         *  instead of launching the app. */
        decline: Map<String, String?> = emptyMap(),
    ): Notification {
        val base = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callType", callType)
            putExtra("conversationId", conversationId)
            putExtra("roomName", roomName)
            putExtra("pushType", pushType)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        // Only used as contentIntent now (tap-to-open) — see the
        // WHATSAPP-STYLE FIX note above for why this is no longer also
        // passed to setFullScreenIntent.
        val fullScreen = PendingIntent.getActivity(context, callId.hashCode(), base, flags)
        val answer = PendingIntent.getActivity(
            context, (callId + "_accept").hashCode(), Intent(base).putExtra("callAction", "accept"), flags,
        )
        val canDeclineInBackground = listOf(
            CallActionReceiver.EXTRA_DECLINE_URL, CallActionReceiver.EXTRA_DECLINE_TOKEN,
            CallActionReceiver.EXTRA_DECLINE_EXP, CallActionReceiver.EXTRA_DECLINE_RECEIVER,
        ).all { !decline[it].isNullOrEmpty() }
        val decline = if (canDeclineInBackground) {
            val i = Intent(context, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_DECLINE
                putExtra("callId", callId)
                putExtra("callType", callType)
                putExtra("conversationId", conversationId)
                putExtra("roomName", roomName)
                for ((k, v) in decline) putExtra(k, v)
            }
            PendingIntent.getBroadcast(context, (callId + "_decline").hashCode(), i, flags)
        } else {
            PendingIntent.getActivity(
                context, (callId + "_decline").hashCode(), Intent(base).putExtra("callAction", "decline"), flags,
            )
        }

        val body = if (isVideo) "Incoming video call" else "Incoming voice call"
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle(callerName)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(fullScreen)

        if (useCallStyle && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = Person.Builder().setName(callerName).setImportant(true).build()
            builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer).setIsVideo(isVideo))
        } else {
            builder
                .addAction(0, coloured("Decline", 0xFFE53935.toInt()), decline)
                .addAction(0, coloured("Answer", 0xFF2E7D32.toInt()), answer)
        }
        return builder.build()
    }

    private fun coloured(label: String, color: Int): CharSequence {
        val s = android.text.SpannableString(label)
        s.setSpan(android.text.style.ForegroundColorSpan(color), 0, s.length, 0)
        s.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, s.length, 0)
        return s
    }
}
