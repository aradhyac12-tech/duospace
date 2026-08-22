package com.duospace.app

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat

/**
 * Plays the actual ringing experience for an incoming call: a looping
 * ringtone + repeating vibration pattern, running as a foreground service so
 * it survives independently of any Activity/UI and isn't killed the instant
 * the process backgrounds.
 *
 * This is deliberately separate from the notification shown by
 * CallNotificationService — the notification is the visual/full-screen-intent
 * part, this service is the audio/haptic part, matching how a real phone
 * dialer splits the two concerns.
 *
 * Sound: plays the recipient's chosen bundled ringtone (native/android/res_raw,
 * copied to res/raw/ by scripts/patch-native-permissions.mjs) via MediaPlayer
 * with isLooping = true, NOT the system default ringtone — MediaPlayer's
 * native looping is reliable across every API level this app supports,
 * unlike android.media.Ringtone's isLooping (API 28+ only, and still
 * inconsistent on some OEM skins), which is why the older implementation's
 * legacy-replay-timer workaround for pre-28 devices is gone: MediaPlayer
 * never needed it. Falls back to the system default ringtone only if the
 * bundled asset can't be opened (e.g. patch script never ran).
 *
 * Vibration: a distinct waveform per ringtone id, matching
 * NotificationChannels.kt's per-channel vibrationPattern and
 * src/lib/notificationSounds.ts's preview patterns, so Settings preview ==
 * what actually fires on a real call.
 *
 * Silencing: MainActivity intercepts the physical volume buttons while this
 * service is ringing and calls `silence()` — this stops sound + vibration
 * but leaves the call ringing/notification in place, exactly like pressing
 * volume during a real phone call. See the platform note in MainActivity
 * about why the power button can't do the same thing for a non-dialer app.
 */
class CallRingingService : Service() {

    companion object {
        const val ACTION_START = "com.duospace.app.action.START_RINGING"
        const val ACTION_SILENCE = "com.duospace.app.action.SILENCE_RINGING"
        const val ACTION_STOP = "com.duospace.app.action.STOP_RINGING"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_CALLER_NAME = "callerName"
        const val EXTRA_RINGTONE_ID = "ringtoneId"
        private const val FOREGROUND_NOTIFICATION_ID = 9912

        // Keep in sync with native/android/res_raw/*.ogg filenames,
        // src/lib/notificationSounds.ts, and supabase/functions/_shared/soundCatalog.ts.
        private val RINGTONE_RAW_NAMES = mapOf(
            "classic" to "classic_call",
            "gentle" to "gentle_call",
            "urgent" to "urgent_call",
            "marimba" to "marimba_call",
        )
        private val VIBRATE_PATTERNS = mapOf(
            "classic" to longArrayOf(0, 400, 200, 400, 200),
            "gentle" to longArrayOf(0, 200, 800),
            "urgent" to longArrayOf(0, 150, 100, 150, 100, 150, 500),
            "marimba" to longArrayOf(0, 80, 60, 80, 60, 80, 60, 300),
        )
        // All these patterns repeat from index 1 (skip the leading "wait"
        // once we're looping, not just on the very first pulse).
        private const val VIBRATE_REPEAT_FROM = 1

        /** True while a call is actively ringing (sound may or may not be silenced). */
        @Volatile
        var isRinging: Boolean = false
            private set

        /** True once the user has silenced the ringtone via the volume keys. */
        @Volatile
        var isSilenced: Boolean = false
            private set
    }

    private var mediaPlayer: MediaPlayer? = null
    private var fallbackRingtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var ringtoneId: String = "classic"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRinging(intent)
            ACTION_SILENCE -> silence()
            ACTION_STOP -> stopRinging()
        }
        return START_NOT_STICKY
    }

    private fun startRinging(intent: Intent) {
        NotificationChannels.createAll(this)
        isRinging = true
        isSilenced = false
        ringtoneId = intent.getStringExtra(EXTRA_RINGTONE_ID)?.takeIf { RINGTONE_RAW_NAMES.containsKey(it) } ?: "classic"

        val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "DuoSpace"
        val notification = buildForegroundNotification(callerName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification)
        }

        playRingtoneLoop()
        vibrateLoop()
    }

    private fun buildForegroundNotification(callerName: String): Notification {
        return NotificationCompat.Builder(this, NotificationChannels.callChannelId(ringtoneId))
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(callerName)
            .setContentText("Incoming call")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .build()
    }

    private fun playRingtoneLoop() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL) return

        val rawName = RINGTONE_RAW_NAMES[ringtoneId] ?: "classic_call"
        val bundled = playBundledRingtone(rawName)
        if (!bundled) playSystemFallbackRingtone()
    }

    /** Returns true if the bundled asset started playing successfully. */
    private fun playBundledRingtone(rawName: String): Boolean {
        return try {
            val uri = Uri.parse("android.resource://$packageName/raw/$rawName")
            val player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(this@CallRingingService, uri)
                isLooping = true
                prepare()
            }
            player.start()
            mediaPlayer = player
            true
        } catch (_: Exception) {
            // Missing raw resource (patch script never ran) or codec issue —
            // fall back rather than ring silently.
            false
        }
    }

    private fun playSystemFallbackRingtone() {
        try {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getValidRingtoneUri(this)
            val tone = RingtoneManager.getRingtone(this, uri) ?: return
            tone.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) tone.isLooping = true
            fallbackRingtone = tone
            tone.play()
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) scheduleLegacyReplay()
        } catch (_: Exception) {
            // Best-effort: a ringtone failure should never crash call handling.
        }
    }

    private fun scheduleLegacyReplay() {
        val handler = android.os.Handler(mainLooper)
        val runnable = object : Runnable {
            override fun run() {
                if (!isRinging || isSilenced) return
                fallbackRingtone?.takeIf { !it.isPlaying }?.play()
                handler.postDelayed(this, 2500)
            }
        }
        handler.postDelayed(runnable, 2500)
    }

    private fun vibrateLoop() {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        vibrator = v
        val pattern = VIBRATE_PATTERNS[ringtoneId] ?: VIBRATE_PATTERNS.getValue("classic")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(pattern, VIBRATE_REPEAT_FROM))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(pattern, VIBRATE_REPEAT_FROM)
        }
    }

    /** Stops sound + vibration but keeps the call ringing (notification stays, service stays alive). */
    fun silence() {
        isSilenced = true
        try { mediaPlayer?.pause() } catch (_: Exception) {}
        try { fallbackRingtone?.stop() } catch (_: Exception) {}
        try { vibrator?.cancel() } catch (_: Exception) {}
    }

    private fun stopRinging() {
        isRinging = false
        isSilenced = false
        try { mediaPlayer?.stop() } catch (_: Exception) {}
        try { mediaPlayer?.release() } catch (_: Exception) {}
        try { fallbackRingtone?.stop() } catch (_: Exception) {}
        try { vibrator?.cancel() } catch (_: Exception) {}
        mediaPlayer = null
        fallbackRingtone = null
        vibrator = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }
}
