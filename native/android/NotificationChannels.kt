package com.duospace.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build

/**
 * Creates every Android notification channel DuoSpace pushes rely on.
 *
 * Channel ids here MUST match the ones computed by
 * supabase/functions/_shared/soundCatalog.ts (messageChannelId / callChannelId)
 * exactly. If a channel referenced by an FCM `android.notification.channel_id`
 * doesn't exist on the device yet, Android silently drops that notification
 * instead of showing it — so this must run once at app startup, before any
 * push can arrive.
 *
 * Multiple sounds, one channel each: Android freezes a channel's sound and
 * vibration pattern the moment it's first created — there is no API to
 * change them later short of deleting and recreating the channel (which
 * loses the user's per-channel system settings, like a manual mute). So
 * "pick your notification sound" is implemented as one physical channel per
 * sound choice (duospace_messages_classic/chime/pop/marimba, same for
 * calls), all created upfront here. Settings just changes *which* channel id
 * future notifications are routed through — see notification_preferences.
 *
 * Call `NotificationChannels.createAll(this)` from MainActivity.onCreate()
 * (see PUSH_NOTIFICATIONS.md — scripts/patch-native-permissions.mjs adds
 * this call automatically when it finds MainActivity.kt/.java).
 */
object NotificationChannels {
    // Sound-variant id -> (display label, raw resource filename without extension).
    // Keep in sync with src/lib/notificationSounds.ts and
    // supabase/functions/_shared/soundCatalog.ts.
    private val MESSAGE_SOUND_VARIANTS = linkedMapOf(
        "classic" to Pair("Classic", "classic_msg"),
        "chime" to Pair("Chime", "chime_msg"),
        "pop" to Pair("Pop", "pop_msg"),
        "marimba" to Pair("Marimba", "marimba_msg"),
    )
    private val CALL_SOUND_VARIANTS = linkedMapOf(
        "classic" to Pair("Classic", "classic_call"),
        "gentle" to Pair("Gentle", "gentle_call"),
        "urgent" to Pair("Urgent", "urgent_call"),
        "marimba" to Pair("Marimba", "marimba_call"),
    )

    // Vibration patterns per sound id (ms: off, on, off, on, ...). Same
    // patterns as previewHaptic()'s arrays in src/lib/notificationSounds.ts,
    // so what the user feels in the Settings preview matches what they feel
    // on a real notification.
    private val MESSAGE_VIBRATE_PATTERNS = mapOf(
        "classic" to longArrayOf(0, 250, 150, 250),
        "chime" to longArrayOf(0, 120, 80, 120, 80, 200),
        "pop" to longArrayOf(0, 60),
        "marimba" to longArrayOf(0, 90, 60, 90, 60, 90, 60, 150),
    )
    private val CALL_VIBRATE_PATTERNS = mapOf(
        "classic" to longArrayOf(0, 400, 200, 400, 200),
        "gentle" to longArrayOf(0, 200, 800),
        "urgent" to longArrayOf(0, 150, 100, 150, 100, 150, 500),
        "marimba" to longArrayOf(0, 80, 60, 80, 60, 80, 60, 300),
    )

    const val REACTIONS = "duospace_reactions"
    const val SYSTEM = "duospace_system"

    /** e.g. messageChannelId("chime") -> "duospace_messages_chime" */
    @JvmStatic
    fun messageChannelId(soundId: String): String {
        val id = if (MESSAGE_SOUND_VARIANTS.containsKey(soundId)) soundId else "classic"
        return "duospace_messages_$id"
    }

    /** e.g. callChannelId("urgent") -> "duospace_incoming_calls_urgent" */
    @JvmStatic
    fun callChannelId(soundId: String): String {
        val id = if (CALL_SOUND_VARIANTS.containsKey(soundId)) soundId else "classic"
        return "duospace_incoming_calls_$id"
    }

    @JvmStatic
    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val pkg = context.packageName

        for ((soundId, meta) in MESSAGE_SOUND_VARIANTS) {
            val (label, rawName) = meta
            createIfMissing(
                manager, "duospace_messages_$soundId", "Messages \u2014 $label",
                NotificationManager.IMPORTANCE_HIGH,
                "New chat messages, photos, videos, voice notes, files, and replies",
            ) { channel ->
                channel.setSound(
                    Uri.parse("android.resource://$pkg/raw/$rawName"),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                channel.enableVibration(true)
                channel.vibrationPattern = MESSAGE_VIBRATE_PATTERNS[soundId]
            }
        }

        for ((soundId, meta) in CALL_SOUND_VARIANTS) {
            val (label, rawName) = meta
            createIfMissing(
                manager, "duospace_incoming_calls_$soundId", "Incoming calls \u2014 $label",
                NotificationManager.IMPORTANCE_HIGH,
                "Ringing voice and video calls from your partner",
            ) { channel ->
                channel.setSound(
                    Uri.parse("android.resource://$pkg/raw/$rawName"),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                channel.enableVibration(true)
                channel.vibrationPattern = CALL_VIBRATE_PATTERNS[soundId]
                channel.setBypassDnd(true)
                channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
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
