package com.duospace.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** One alert tier's ringer + haptic settings. File-private on purpose. */
private class AlertTier(
    val rawName: String,
    val vibration: LongArray,
    /** Motor strength for the "on" segments (1..255). */
    val amplitude: Int,
    /** Fraction of max alarm volume to raise to, if it is lower. */
    val alarmVolume: Float,
    val maxMillis: Long,
)

/**
 * Rings and vibrates for /important and /urgent messages — loudly, for a long
 * time, and through the phone's silent mode and Do Not Disturb.
 *
 * WHY A SERVICE INSTEAD OF A NOTIFICATION CHANNEL
 * These messages used to be an ordinary notification on a "bypass DND" channel
 * and so behaved like any other message: Android ignores an app's own
 * setBypassDnd(true) unless the person turns "Override Do Not Disturb" on for
 * that channel by hand, mutes notification sound and vibration entirely when
 * the ringer is on silent, and freezes a channel's short sound/vibration at
 * creation. So this service is the ringer, exactly like CallRingingService is
 * for calls, with three deliberate differences:
 *   1. Audio is played as USAGE_ALARM. The alarm stream is independent of the
 *      ringer mode (silent / vibrate don't touch it) and Do Not Disturb's
 *      default "priority only" mode lets alarms through.
 *   2. Vibration is issued with alarm audio attributes, which the system does
 *      not gate on ringer mode either (this is how alarm clocks buzz on silent).
 *   3. If the person has granted Do Not Disturb access (Settings → Do Not
 *      Disturb → App access — see openDndAccessSettings in the bridge plugin),
 *      the interruption filter is lifted to "all" for the duration of the alert
 *      and restored afterwards. That is the only way past "Total silence" or a
 *      DND setup with the Alarms exception switched off.
 *
 * TWO TIERS, DIFFERENT SOUND AND FEEL (keep in sync with src/lib/messageAlert.ts,
 * supabase/functions/_shared/messageAlert.ts — src/test/messageAlert.test.ts
 * fails on drift):
 *   important  rising three-note bell, three long pulses,      rings ≤ 20 s
 *   urgent     two-tone siren + rapid beeps, heavy long pulses, rings ≤ 60 s
 *
 * Stops when: the person taps Stop / opens the chat / swipes the notification,
 * the JS layer calls stopMessageAlert (app resumed, chat opened), the
 * timeout above elapses, or another alert replaces it.
 *
 * Honest limits: nothing here can beat Total Silence without DND access, a
 * person who turned "alarm vibration" off in system settings, or a phone that
 * is powered off / has the app force-stopped. Started from a high-priority FCM
 * message (Android allows a foreground-service start from that).
 */
class MessageAlertService : Service() {

    companion object {
        const val ACTION_START = "com.duospace.app.action.START_MESSAGE_ALERT"
        const val ACTION_STOP = "com.duospace.app.action.STOP_MESSAGE_ALERT"
        const val EXTRA_LEVEL = "alertLevel"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_MESSAGE_ID = "messageId"
        const val EXTRA_CONVERSATION_ID = "conversationId"
        const val EXTRA_TIMESTAMP = "timestamp"
        /** Preview from Settings: shorter, and never opens a chat. */
        const val EXTRA_PREVIEW = "preview"

        const val LEVEL_IMPORTANT = "important"
        const val LEVEL_URGENT = "urgent"

        /** Pushes older than this are shown as a normal message, not rung —
         *  an alarm minutes late is worse than none. Mirrors ALERT_STALE_AFTER_MS
         *  in supabase/functions/_shared/messageAlert.ts. */
        const val STALE_ALERT_MS = 10 * 60 * 1000L

        private const val PREVIEW_MS = 6_000L
        private const val FOREGROUND_NOTIFICATION_ID = 9931
        private const val PREFS = "duospace_message_alert"
        private const val KEY_DND_RESTORE = "dnd_restore_filter"

        // Vibration timings (ms: wait, on, off, on, ...) — even indices are
        // "off". Repeat from index 1 (skip the leading wait once looping).
        // Must equal ALERT_TIERS[*].pattern in src/lib/messageAlert.ts.
        @JvmField val IMPORTANT_VIBRATION = longArrayOf(0, 700, 250, 700, 250, 700, 1200)
        @JvmField val URGENT_VIBRATION = longArrayOf(0, 1500, 150, 1500, 150, 300, 100, 300, 100, 300, 600)
        private const val VIBRATE_REPEAT_FROM = 1

        private val TIERS = mapOf(
            LEVEL_IMPORTANT to AlertTier("alert_important", IMPORTANT_VIBRATION, 200, 0.8f, 20_000L),
            LEVEL_URGENT to AlertTier("alert_urgent", URGENT_VIBRATION, 255, 1.0f, 60_000L),
        )

        /** True while an alert is ringing/vibrating. */
        @Volatile
        var isAlerting: Boolean = false
            private set

        @Volatile
        private var currentMessageId: String? = null

        /** Fresh = worth ringing for. No/unparseable timestamp counts as fresh. */
        @JvmStatic
        fun isFresh(isoTimestamp: String?): Boolean {
            if (isoTimestamp.isNullOrBlank()) return true
            return try {
                System.currentTimeMillis() - java.time.Instant.parse(isoTimestamp).toEpochMilli() <= STALE_ALERT_MS
            } catch (_: Exception) {
                true
            }
        }

        /**
         * Starts the alert from an FCM data map. Returns false if the OS refused
         * the foreground-service start (caller then falls back to a plain
         * notification on the audible alert channel — sound only, but never
         * silent).
         */
        @JvmStatic
        fun start(context: Context, data: Map<String, String>, preview: Boolean = false): Boolean {
            val level = data[EXTRA_LEVEL]?.takeIf { TIERS.containsKey(it) } ?: return false
            return try {
                val intent = Intent(context, MessageAlertService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_LEVEL, level)
                    putExtra(EXTRA_TITLE, data[EXTRA_TITLE])
                    putExtra(EXTRA_BODY, data[EXTRA_BODY])
                    putExtra(EXTRA_MESSAGE_ID, data[EXTRA_MESSAGE_ID])
                    putExtra(EXTRA_CONVERSATION_ID, data[EXTRA_CONVERSATION_ID])
                    putExtra(EXTRA_TIMESTAMP, data[EXTRA_TIMESTAMP])
                    putExtra(EXTRA_PREVIEW, preview)
                }
                ContextCompat.startForegroundService(context, intent)
                true
            } catch (e: Exception) {
                // ForegroundServiceStartNotAllowedException (API 31+) is an
                // IllegalStateException; OEM task killers can also refuse.
                android.util.Log.w("DuoSpaceAlert", "MessageAlertService start refused — falling back to notification", e)
                false
            }
        }

        /** Stops a running alert. No-op (and no service start) if none is ringing. */
        @JvmStatic
        fun stop(context: Context) {
            if (!isAlerting) return
            try {
                context.startService(Intent(context, MessageAlertService::class.java).apply { action = ACTION_STOP })
            } catch (e: Exception) {
                android.util.Log.w("DuoSpaceAlert", "MessageAlertService stop request failed", e)
            }
        }
    }

    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null
    private var savedAlarmVolume: Int = -1
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    private var lastNotificationArgs: NotificationArgs? = null

    private class NotificationArgs(
        val title: String,
        val body: String,
        val conversationId: String?,
        val timestamp: String?,
        val preview: Boolean,
    )

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startAlert(intent)
            ACTION_STOP -> stopAlert()
            // Anything else (or a null intent from a system restart): nothing to do.
            else -> if (!isAlerting) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startAlert(intent: Intent) {
        val level = intent.getStringExtra(EXTRA_LEVEL)?.takeIf { TIERS.containsKey(it) } ?: LEVEL_IMPORTANT
        val tier = TIERS.getValue(level)
        val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID)
        val preview = intent.getBooleanExtra(EXTRA_PREVIEW, false)
        val maxMillis = if (preview) PREVIEW_MS else tier.maxMillis

        // FCM can redeliver. The same message must not double the ring or
        // restart the vibration — just re-arm the timeout.
        if (isAlerting && messageId != null && messageId == currentMessageId) {
            armTimeout(maxMillis)
            return
        }
        // A different alert while one is already going: replace it cleanly.
        if (isAlerting) releaseRingerAndVibration()

        NotificationChannels.createAll(this)
        // A DND filter left lifted by an alert whose process was killed.
        restoreDnd()

        val args = NotificationArgs(
            title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "DuoSpace",
            body = intent.getStringExtra(EXTRA_BODY)?.takeIf { it.isNotBlank() } ?: "Sent you a message",
            conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID),
            timestamp = intent.getStringExtra(EXTRA_TIMESTAMP),
            preview = preview,
        )
        lastNotificationArgs = args
        val notification = buildNotification(args, showStop = true)
        // The foreground call must come first and fast (5 s budget on API 26+);
        // everything below is best-effort and must never throw out of here.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(FOREGROUND_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(FOREGROUND_NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Missing foreground-service permission/type or an OS refusal.
            // Never crash the process over it: post the audible-channel
            // notification instead (sound + vibration from the channel) and quit.
            android.util.Log.w("DuoSpaceAlert", "startForeground refused — posting fallback notification", e)
            postFallbackNotification(level, args)
            stopSelf()
            return
        }

        isAlerting = true
        currentMessageId = messageId

        acquireWakeLock(maxMillis)
        liftDndIfAllowed()
        startRinger(tier)
        startVibration(tier)
        armTimeout(maxMillis)
    }

    // ── notification ────────────────────────────────────────────────────────

    private fun buildNotification(args: NotificationArgs, showStop: Boolean): Notification {
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, MessageAlertService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openIntent = PendingIntent.getActivity(
            this, 2,
            Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("pushType", "chat_message")
                putExtra("conversationId", args.conversationId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, NotificationChannels.ALERT_VISUAL)
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle(args.title)
            .setContentText(args.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(args.body))
            // CATEGORY_ALARM is what lets Do Not Disturb's "Alarms" exception
            // pass the notification itself, not just the audio.
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setWhen(parseTimestamp(args.timestamp))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .setDeleteIntent(stopIntent)
        if (showStop) builder.addAction(0, "Stop alert", stopIntent)
        return builder.build()
    }

    /** Audible-channel notification for when the service can't run. The channel
     *  (see NotificationChannels.kt) carries the tier's sound + vibration. */
    private fun postFallbackNotification(level: String, args: NotificationArgs) {
        try {
            val channel = if (level == LEVEL_URGENT) NotificationChannels.ALERT_URGENT else NotificationChannels.ALERT_IMPORTANT
            val open = PendingIntent.getActivity(
                this, 2,
                Intent(this, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    putExtra("pushType", "chat_message")
                    putExtra("conversationId", args.conversationId)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n = NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat_duospace)
                .setContentTitle(args.title)
                .setContentText(args.body)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setWhen(parseTimestamp(args.timestamp))
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(FOREGROUND_NOTIFICATION_ID, n)
        } catch (_: Exception) {
        }
    }

    private fun parseTimestamp(iso: String?): Long {
        if (iso.isNullOrBlank()) return System.currentTimeMillis()
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }

    // ── sound ───────────────────────────────────────────────────────────────

    private fun alarmAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    private fun startRinger(tier: AlertTier) {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            raiseAlarmVolume(am, tier)
            requestFocus(am)
        } catch (_: Exception) {
        }
        val bundled = playLoop(Uri.parse("android.resource://$packageName/raw/${tier.rawName}"))
        // The bundled asset should always exist (scripts/patch-native-
        // permissions.mjs copies res_raw); if it doesn't, an alarm beats silence.
        if (!bundled) playLoop(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
    }

    private fun playLoop(uri: Uri?): Boolean {
        if (uri == null) return false
        return try {
            val player = MediaPlayer().apply {
                setAudioAttributes(alarmAttributes())
                setDataSource(this@MessageAlertService, uri)
                isLooping = true
                setVolume(1f, 1f)
                prepare()
            }
            player.start()
            mediaPlayer = player
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Alarm volume is separate from ring/notification volume, so raising it
     *  needs no DND access. Remembered and put back in stopAlert(). */
    private fun raiseAlarmVolume(am: AudioManager, tier: AlertTier) {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        if (max <= 0) return
        val current = am.getStreamVolume(AudioManager.STREAM_ALARM)
        val target = Math.round(max * tier.alarmVolume).coerceIn(1, max)
        if (current < target) {
            savedAlarmVolume = current
            am.setStreamVolume(AudioManager.STREAM_ALARM, target, 0)
        }
    }

    private fun requestFocus(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(alarmAttributes())
                .setOnAudioFocusChangeListener { }
                .build()
            focusRequest = request
            am.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    private fun abandonFocus() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(null)
            }
        } catch (_: Exception) {
        }
        focusRequest = null
    }

    // ── vibration ───────────────────────────────────────────────────────────

    private fun startVibration(tier: AlertTier) {
        try {
            val v: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            } else {
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (v == null || !v.hasVibrator()) return
            vibrator = v
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // "on" segments at the tier's strength, "off" segments at 0.
                val amplitudes = IntArray(tier.vibration.size) { i -> if (i % 2 == 1) tier.amplitude else 0 }
                val effect = if (v.hasAmplitudeControl()) {
                    VibrationEffect.createWaveform(tier.vibration, amplitudes, VIBRATE_REPEAT_FROM)
                } else {
                    VibrationEffect.createWaveform(tier.vibration, VIBRATE_REPEAT_FROM)
                }
                // Alarm attributes are what keep this vibrating on silent / in DND.
                @Suppress("DEPRECATION")
                v.vibrate(effect, alarmAttributes())
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(tier.vibration, VIBRATE_REPEAT_FROM, alarmAttributes())
            }
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceAlert", "vibration failed (non-fatal)", e)
        }
    }

    // ── Do Not Disturb ──────────────────────────────────────────────────────

    /** Only possible if the person granted DND access. Lifts to ALL for the
     *  alert's duration; the previous filter is persisted so it is restored
     *  even if this process is killed mid-alert. */
    private fun liftDndIfAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!nm.isNotificationPolicyAccessGranted) return
            val current = nm.currentInterruptionFilter
            if (current == NotificationManager.INTERRUPTION_FILTER_ALL ||
                current == NotificationManager.INTERRUPTION_FILTER_UNKNOWN
            ) return
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY_DND_RESTORE, current).apply()
            nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceAlert", "could not lift Do Not Disturb (non-fatal)", e)
        }
    }

    private fun restoreDnd() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val previous = prefs.getInt(KEY_DND_RESTORE, -1)
            if (previous == -1) return
            prefs.edit().remove(KEY_DND_RESTORE).apply()
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Only put it back if it is still the filter WE set — if the
            // person changed DND themselves during the alert, leave it alone.
            if (nm.isNotificationPolicyAccessGranted &&
                nm.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL
            ) {
                nm.setInterruptionFilter(previous)
            }
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceAlert", "could not restore Do Not Disturb (non-fatal)", e)
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    private fun acquireWakeLock(maxMillis: Long) {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DuoSpace:MessageAlert").apply {
                setReferenceCounted(false)
                acquire(maxMillis + 2_000L)
            }
        } catch (_: Exception) {
        }
    }

    private fun armTimeout(maxMillis: Long) {
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        val runnable = Runnable { stopAlert() }
        timeoutRunnable = runnable
        handler.postDelayed(runnable, maxMillis)
    }

    /** Sound + vibration + audio focus + volume only. Leaves the foreground
     *  state alone so a replacement alert can start straight after. */
    private fun releaseRingerAndVibration() {
        try { mediaPlayer?.stop() } catch (_: Exception) {}
        try { mediaPlayer?.release() } catch (_: Exception) {}
        mediaPlayer = null
        try { vibrator?.cancel() } catch (_: Exception) {}
        vibrator = null
        abandonFocus()
        if (savedAlarmVolume >= 0) {
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                am.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0)
            } catch (_: Exception) {}
            savedAlarmVolume = -1
        }
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    private fun stopAlert() {
        val wasAlerting = isAlerting
        isAlerting = false
        currentMessageId = null
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        releaseRingerAndVibration()
        restoreDnd()
        if (wasAlerting) {
            // Leave the notification in the shade as a quiet, normal one so the
            // message can still be tapped; drop the now-meaningless Stop action.
            // A preview (Settings) leaves nothing behind.
            val args = lastNotificationArgs
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_DETACH)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(false)
            }
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (args == null || args.preview) nm.cancel(FOREGROUND_NOTIFICATION_ID)
                else nm.notify(FOREGROUND_NOTIFICATION_ID, buildNotification(args, showStop = false))
            } catch (_: Exception) {
            }
        }
        stopSelf()
    }

    override fun onDestroy() {
        // Idempotent safety net: OS-initiated destroy must still silence
        // everything and put Do Not Disturb back.
        isAlerting = false
        currentMessageId = null
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        releaseRingerAndVibration()
        restoreDnd()
        super.onDestroy()
    }
}
