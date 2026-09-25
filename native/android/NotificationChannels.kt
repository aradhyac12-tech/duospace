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
        "bell" to Pair("Bell", "bell_msg"),
        "droplet" to Pair("Droplet", "droplet_msg"),
        "crystal" to Pair("Crystal", "crystal_msg"),
        "harp" to Pair("Harp", "harp_msg"),
        "sparkle" to Pair("Sparkle", "sparkle_msg"),
        "tick" to Pair("Tick", "tick_msg"),
        "whistle" to Pair("Whistle", "whistle_msg"),
        "glass" to Pair("Glass", "glass_msg"),
    )
    private val CALL_SOUND_VARIANTS = linkedMapOf(
        "classic" to Pair("Classic", "classic_call"),
        "gentle" to Pair("Gentle", "gentle_call"),
        "urgent" to Pair("Urgent", "urgent_call"),
        "marimba" to Pair("Marimba", "marimba_call"),
        "retro" to Pair("Retro", "retro_call"),
        "digital" to Pair("Digital", "digital_call"),
        "melody" to Pair("Melody", "melody_call"),
        "bells" to Pair("Bells", "bells_call"),
        "pulse" to Pair("Pulse", "pulse_call"),
        "sunrise" to Pair("Sunrise", "sunrise_call"),
        "waltz" to Pair("Waltz", "waltz_call"),
        "groove" to Pair("Groove", "groove_call"),
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
        "bell" to longArrayOf(0, 200),
        "droplet" to longArrayOf(0, 40, 60, 40),
        "crystal" to longArrayOf(0, 70, 50, 70),
        "harp" to longArrayOf(0, 60, 50, 60, 50, 90),
        "sparkle" to longArrayOf(0, 40, 40, 40, 40, 40, 40, 60),
        "tick" to longArrayOf(0, 30),
        "whistle" to longArrayOf(0, 300),
        "glass" to longArrayOf(0, 100, 80, 60),
    )
    private val CALL_VIBRATE_PATTERNS = mapOf(
        "classic" to longArrayOf(0, 400, 200, 400, 200),
        "gentle" to longArrayOf(0, 200, 800),
        "urgent" to longArrayOf(0, 150, 100, 150, 100, 150, 500),
        "marimba" to longArrayOf(0, 80, 60, 80, 60, 80, 60, 300),
        "retro" to longArrayOf(0, 650, 300, 650, 1400),
        "digital" to longArrayOf(0, 110, 50, 110, 50, 110, 50, 110, 470, 110, 50, 110, 50, 110, 50, 110, 860),
        "melody" to longArrayOf(0, 200, 100, 200, 100, 400, 1900),
        "bells" to longArrayOf(0, 500, 250, 500, 250, 500, 1400),
        "pulse" to longArrayOf(0, 300, 120, 300, 1680),
        "sunrise" to longArrayOf(0, 120, 80, 160, 80, 200, 80, 260, 2220),
        "waltz" to longArrayOf(0, 180, 140, 90, 140, 90, 2360),
        "groove" to longArrayOf(0, 120, 180, 120, 300, 120, 300, 120, 1340),
    )

    const val REACTIONS = "duospace_reactions"
    const val SYSTEM = "duospace_system"

    /**
     * /important and /urgent — one channel per tier, "_v2" because the old
     * single `duospace_urgent_message` channel had its short sound/vibration
     * frozen at creation and Android never lets an app change them afterwards
     * (it is deleted in createAll below). Ids MUST match ALERT_CHANNELS in
     * supabase/functions/_shared/messageAlert.ts.
     *
     * These two are the AUDIBLE FALLBACK: MessageAlertService (the real ringer
     * — alarm-stream audio + long vibration that get through silent mode and
     * Do Not Disturb) normally handles the push and never posts here. They are
     * used only when the OS refuses to start that service, so a flagged message
     * is never silent. ALERT_VISUAL is the notification the service itself
     * shows: silent (the service is the ringer, same reasoning as CALL_VISUAL).
     */
    const val ALERT_IMPORTANT = "duospace_alert_important_v2"
    const val ALERT_URGENT = "duospace_alert_urgent_v2"
    const val ALERT_VISUAL = "duospace_alert_visual_v2"
    private const val LEGACY_URGENT_MESSAGE = "duospace_urgent_message"

    /**
     * Incoming-call notification WITHOUT sound or vibration of its own.
     * CallRingingService already loops the chosen ringtone + vibration; the
     * two notifications it goes with (its foreground notification and
     * CallNotificationService's full-screen one) used to sit on the
     * per-ringtone channel, so the same ringtone also played from the channel
     * on top of the service's loop. Those two use this channel whenever the
     * service is running; the per-ringtone channel stays as the fallback for
     * when the OS refuses the service.
     */
    const val CALL_VISUAL = "duospace_incoming_call_visual"

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
            manager, CALL_VISUAL, "Incoming call screen", NotificationManager.IMPORTANCE_HIGH,
            "Full-screen incoming call alert (the ringtone itself is played by the ringing service)",
        ) { channel ->
            channel.setSound(null, null)
            channel.enableVibration(false)
            channel.setBypassDnd(true)
            channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        // Retire the old single urgent channel (see ALERT_* above).
        try { manager.deleteNotificationChannel(LEGACY_URGENT_MESSAGE) } catch (_: Exception) {}

        for ((id, label, desc, raw, vibration) in listOf(
            AlertChannelSpec(
                ALERT_IMPORTANT, "Important messages",
                "Messages sent with /important — long alert that rings through silent mode and Do Not Disturb",
                "alert_important", MessageAlertService.IMPORTANT_VIBRATION,
            ),
            AlertChannelSpec(
                ALERT_URGENT, "Urgent messages",
                "Messages sent with /urgent — the strongest alert, rings through silent mode and Do Not Disturb",
                "alert_urgent", MessageAlertService.URGENT_VIBRATION,
            ),
        )) {
            createIfMissing(manager, id, label, NotificationManager.IMPORTANCE_HIGH, desc) { channel ->
                channel.setSound(
                    Uri.parse("android.resource://$pkg/raw/$raw"),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                channel.enableVibration(true)
                channel.vibrationPattern = vibration
                channel.setBypassDnd(true)
                channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        }
        createIfMissing(
            manager, ALERT_VISUAL, "Alert screen", NotificationManager.IMPORTANCE_HIGH,
            "Shown while an important/urgent message is ringing (the sound itself is played by the alert service)",
        ) { channel ->
            channel.setSound(null, null)
            channel.enableVibration(false)
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

/** Constructor-shaped bundle for the two alert channels (destructured above). */
private data class AlertChannelSpec(
    val id: String,
    val label: String,
    val description: String,
    val rawName: String,
    val vibration: LongArray,
)
