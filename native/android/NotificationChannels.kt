package com.duospace.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * Creates every Android notification channel DuoSpace pushes rely on.
 *
 * Channel ids here MUST match `CHANNELS` in
 * supabase/functions/_shared/fcm.ts exactly. If a channel referenced by an
 * FCM `android.notification.channel_id` doesn't exist on the device yet,
 * Android silently drops that notification instead of showing it — so this
 * must run once at app startup, before any push can arrive.
 *
 * Call `NotificationChannels.createAll(this)` from MainActivity.onCreate()
 * (see PUSH_NOTIFICATIONS.md — scripts/patch-native-permissions.mjs adds
 * this call automatically when it finds MainActivity.kt/.java).
 */
object NotificationChannels {
    const val MESSAGES = "duospace_messages"
    const val CALLS = "duospace_incoming_calls"
    const val REACTIONS = "duospace_reactions"
    const val SYSTEM = "duospace_system"

    @JvmStatic
    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        createIfMissing(
            manager, MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH,
            "New chat messages, photos, videos, voice notes, files, and replies",
        )
        createIfMissing(
            manager, CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH,
            "Ringing voice and video calls from your partner",
        ) { channel ->
            channel.enableVibration(true)
            channel.setBypassDnd(true)
            channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        createIfMissing(
            manager, REACTIONS, "Reactions", NotificationManager.IMPORTANCE_DEFAULT,
            "Emoji reactions to your messages",
        )
        createIfMissing(
            manager, SYSTEM, "Account & requests", NotificationManager.IMPORTANCE_DEFAULT,
            "Partner requests and other account notifications",
        )
    }

    private inline fun createIfMissing(
        manager: NotificationManager,
        id: String,
        name: String,
        importance: Int,
        desc: String,
        configure: (NotificationChannel) -> Unit = {},
    ) {
        if (manager.getNotificationChannel(id) != null) return
        val channel = NotificationChannel(id, name, importance).apply {
            description = desc
            configure(this)
        }
        manager.createNotificationChannel(channel)
    }
}
