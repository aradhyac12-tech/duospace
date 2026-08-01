package com.duospace.app

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
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
        private const val FOREGROUND_NOTIFICATION_ID = 9912
        private const val VIBRATE_PATTERN_MS = 1000L

        /** True while a call is actively ringing (sound may or may not be silenced). */
        @Volatile
        var isRinging: Boolean = false
            private set

        /** True once the user has silenced the ringtone via the volume keys. */
        @Volatile
        var isSilenced: Boolean = false
            private set
    }

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null

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
        return NotificationCompat.Builder(this, NotificationChannels.CALLS)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(callerName)
            .setContentText("Incoming call")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .build()
    }

    private fun playRingtoneLoop() {
        try {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getValidRingtoneUri(this)
            val tone = RingtoneManager.getRingtone(this, uri) ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                tone.audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                tone.isLooping = true
            }
            ringtone = tone
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL) {
                tone.play()
            }
            // Pre-API 28 Ringtone has no isLooping — re-trigger play() periodically instead.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                scheduleLegacyReplay()
            }
        } catch (_: Exception) {
            // Best-effort: a ringtone failure should never crash call handling.
        }
    }

    private fun scheduleLegacyReplay() {
        val handler = android.os.Handler(mainLooper)
        val runnable = object : Runnable {
            override fun run() {
                if (!isRinging || isSilenced) return
                ringtone?.takeIf { !it.isPlaying }?.play()
                handler.postDelayed(this, 2500)
            }
        }
        handler.postDelayed(runnable, 2500)
    }

    private fun vibrateLoop() {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        vibrator = v
        val pattern = longArrayOf(0, VIBRATE_PATTERN_MS, VIBRATE_PATTERN_MS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(pattern, 0)
        }
    }

    /** Stops sound + vibration but keeps the call ringing (notification stays, service stays alive). */
    fun silence() {
        isSilenced = true
        try { ringtone?.stop() } catch (_: Exception) {}
        try { vibrator?.cancel() } catch (_: Exception) {}
    }

    private fun stopRinging() {
        isRinging = false
        isSilenced = false
        try { ringtone?.stop() } catch (_: Exception) {}
        try { vibrator?.cancel() } catch (_: Exception) {}
        ringtone = null
        vibrator = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }
}
