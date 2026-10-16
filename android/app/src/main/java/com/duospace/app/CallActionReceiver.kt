package com.duospace.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * INSTANT DECLINE from the incoming-call notification — without launching
 * the app.
 *
 * Before: Decline was a PendingIntent.getActivity → the whole app (WebView +
 * JS) booted just to say "no", so on a cold start the phone kept ringing and
 * the app flashed open for seconds.
 *
 * Now, on tap:
 *   1. ringer stopped (stopService — always allowed) + notification removed +
 *      Telecom's call state cleared — the user sees/hears it stop at once;
 *   2. in the background (goAsync), POST the push's single-call decline token
 *      to the call-decline Edge Function, which applies decline_call()'s rules
 *      and triggers the existing 'call_rejected' push to the caller.
 *   3. If that request fails (offline, token expired), a small "Tap to decline"
 *      notification is posted: Android 12+ forbids a notification-action
 *      receiver from launching an activity ("trampoline"), so the fallback to
 *      the in-app decline must be a user tap.
 * Only callId/decline fields are handled here — no auth tokens, no content.
 */
class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_DECLINE = "com.duospace.app.action.CALL_DECLINE"
        const val EXTRA_DECLINE_URL = "declineUrl"
        const val EXTRA_DECLINE_TOKEN = "declineToken"
        const val EXTRA_DECLINE_EXP = "declineExp"
        const val EXTRA_DECLINE_RECEIVER = "declineReceiver"
        private const val FALLBACK_NOTIFICATION_ID = 9915
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECLINE) return
        val callId = intent.getStringExtra("callId") ?: return

        // 1) Immediate local effect.
        try { context.stopService(Intent(context, CallRingingService::class.java)) } catch (_: Exception) {}
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(IncomingCallNotification.NOTIFICATION_ID)
        } catch (_: Exception) {}
        try { DuoSpaceConnectionService.endCurrentConnectionSilently() } catch (_: Exception) {}

        // 2) Tell the server off the main thread.
        val pending = goAsync()
        Thread {
            val ok = try { postDecline(intent, callId) } catch (_: Exception) { false }
            if (!ok) postFallback(context, intent, callId)
            pending.finish()
        }.start()
    }

    private fun postDecline(intent: Intent, callId: String): Boolean {
        val url = intent.getStringExtra(EXTRA_DECLINE_URL) ?: return false
        if (!url.startsWith("https://")) return false
        val body = JSONObject().apply {
            put("callId", callId)
            put("receiverId", intent.getStringExtra(EXTRA_DECLINE_RECEIVER) ?: return false)
            put("exp", (intent.getStringExtra(EXTRA_DECLINE_EXP) ?: return false).toLongOrNull() ?: return false)
            put("token", intent.getStringExtra(EXTRA_DECLINE_TOKEN) ?: return false)
        }.toString().toByteArray()
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 6000
            readTimeout = 6000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        return try {
            conn.outputStream.use { it.write(body) }
            conn.responseCode == 200 // {declined:true|false}: false = already answered/ended elsewhere — also fine
        } finally {
            conn.disconnect()
        }
    }

    private fun postFallback(context: Context, intent: Intent, callId: String) {
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callAction", "decline")
            putExtra("callType", intent.getStringExtra("callType"))
            putExtra("conversationId", intent.getStringExtra("conversationId"))
            putExtra("roomName", intent.getStringExtra("roomName"))
        }
        val pi = PendingIntent.getActivity(context, (callId + "_decline_fallback").hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, NotificationChannels.CALL_VISUAL)
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle("Couldn't decline the call")
            .setContentText("Tap to finish declining")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .setContentIntent(pi)
            .build()
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(FALLBACK_NOTIFICATION_ID, n)
        } catch (_: Exception) {}
    }
}
