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
    fun dispatchCallAction(
        context: Context?,
        callId: String,
        action: String,
        isVideo: Boolean,
        conversationId: String?,
        roomName: String?,
    ) {
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
