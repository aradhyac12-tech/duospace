package com.duospace.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * On-device crash capture — added specifically so a crash (e.g. the music
 * playback crash) can be diagnosed from a phone alone, with no PC/adb
 * available. Installs a global uncaught-exception handler that writes the
 * full stack trace to a plain text file in app-external storage (no
 * permission needed on API 19+, and readable by ordinary Files apps under
 * Android/data/com.duospace.app/files/), then hands off to the previous
 * default handler so the crash still proceeds exactly as it did before —
 * this never changes what crashes or when, only that a copy gets saved
 * first. The *next* time MainActivity launches, if that file exists, a
 * dialog shows the trace with a Share button so it can be sent straight
 * from the device (Messages, email, notes, pasting into this chat, etc.)
 * without ever touching a computer.
 */
object CrashLogger {
    private const val FILE_NAME = "duospace_last_crash.txt"

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sw = StringWriter()
                throwable.printStackTrace(PrintWriter(sw))
                val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
                val text = "DuoSpace crash — $timestamp\nThread: ${thread.name}\n\n$sw"
                val dir = appContext.getExternalFilesDir(null) ?: appContext.filesDir
                File(dir, FILE_NAME).writeText(text)
            } catch (_: Throwable) {
                // Never let the crash logger itself cause a second crash —
                // if writing fails, just fall through to the normal handler.
            }
            // Preserve default behavior (process death, any existing
            // crash-reporting SDK) exactly as before — this only adds a
            // side effect, never replaces the actual crash handling.
            previousHandler?.uncaughtException(thread, throwable)
                ?: run {
                    android.os.Process.killProcess(android.os.Process.myPid())
                    kotlin.system.exitProcess(10)
                }
        }
    }

    /** Call from MainActivity.onCreate (after super.onCreate) on every
     *  launch — shows the previous crash, if any, then deletes the file so
     *  it isn't shown again on the next launch. */
    fun showLastCrashIfAny(activity: Activity) {
        val dir = activity.getExternalFilesDir(null) ?: activity.filesDir
        val file = File(dir, FILE_NAME)
        if (!file.exists()) return
        val text = try { file.readText() } catch (_: Throwable) { return }
        file.delete()

        val textView = TextView(activity).apply {
            setText(text)
            setTextIsSelectable(true)
            setPadding(32, 32, 32, 32)
            textSize = 12f
        }
        val scroll = ScrollView(activity).apply { addView(textView) }

        AlertDialog.Builder(activity)
            .setTitle("DuoSpace crashed last time")
            .setView(scroll)
            .setPositiveButton("Share") { _, _ ->
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "DuoSpace crash log")
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                activity.startActivity(Intent.createChooser(send, "Share crash log"))
            }
            .setNegativeButton("Dismiss", null)
            .show()
    }
}
