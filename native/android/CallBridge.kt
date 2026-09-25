package com.duospace.app

import android.content.Context
import android.content.Intent

/**
 * Shared entry point for "an incoming call was answered/declined/ended via
 * a channel other than tapping the in-app UI directly". Before Telecom
 * integration, the only such channel was CallNotificationService's
 * notification Accept/Decline PendingIntents, which start MainActivity
 * with `callAction` extras that MainActivity.handleDuospaceCallIntent
 * already parses and forwards to JS as the `duospace-call-action`
 * CustomEvent.
 *
 * DuoSpaceConnection (Bluetooth/car head-unit answer-reject buttons, or
 * any other Telecom-originated action) now funnels into this exact same
 * Intent shape, so there is exactly one code path translating a native
 * call action into the JS event — not two that could drift apart.
 */
object CallBridge {
    /**
     * Set by MainActivity while its WebView exists (onCreate → onDestroy).
     * Receives a ready-to-dispatch JSON payload for the 'duospace-call-action'
     * event, WITHOUT bringing the activity to the foreground.
     */
    @Volatile var liveSink: ((String) -> Unit)? = null

    private fun deliverLive(callId: String, action: String, isVideo: Boolean, conversationId: String?, roomName: String?) {
        val sink = liveSink ?: return
        val payload = org.json.JSONObject().apply {
            put("callId", callId)
            put("action", action)
            put("callType", if (isVideo) "video" else "audio")
            put("conversationId", conversationId)
            put("roomName", roomName)
        }.toString()
        try { sink(payload) } catch (e: Exception) {
            android.util.Log.w("DuoSpaceTelecom", "CallBridge live delivery failed action=$action", e)
        }
    }

    fun dispatchCallAction(
        context: Context?,
        callId: String,
        action: String,
        isVideo: Boolean,
        conversationId: String?,
        roomName: String?,
    ) {
        // APP-OPENS-ON-EVERY-CALL FIX: this used to startActivity() for EVERY
        // action — including the "unmute" Telecom reports via
        // onCallAudioStateChanged the instant an incoming connection is
        // created. Result: every incoming call launched the app over the
        // lock screen / whatever you were doing, and MainActivity's intent
        // handler then stopped the ringtone. Now only an actual ANSWER
        // (Bluetooth/car/Telecom button) is allowed to bring the app up —
        // the WebRTC session has to run somewhere. Everything else goes to
        // the running WebView if there is one, and is simply dropped if not
        // (mute/end of a call whose JS isn't even running has nothing to act on).
        val launchApp = action == "accept"
        if (!launchApp) {
            deliverLive(callId, action, isVideo, conversationId, roomName)
            return
        }
        val ctx = context ?: return
        val intent = Intent(ctx, MainActivity::class.java).apply {
            this.action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callAction", action)
            putExtra("callType", if (isVideo) "video" else "audio")
            conversationId?.let { putExtra("conversationId", it) }
            roomName?.let { putExtra("roomName", it) }
        }
        try {
            ctx.startActivity(intent)
        } catch (e: Exception) {
            // Best-effort — the notification's own Accept/Decline
            // PendingIntents remain a fully independent path into the same
            // MainActivity flow if this somehow fails.
            android.util.Log.w("DuoSpaceTelecom", "CallBridge.dispatchCallAction failed for callId=$callId action=$action", e)
        }
    }
}
