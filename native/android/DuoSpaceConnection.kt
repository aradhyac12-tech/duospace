package com.duospace.app

import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.TelecomManager

/**
 * One instance per active call. DuoSpace is 1:1 (no group calls), so at
 * most one of these exists at a time — DuoSpaceConnectionService tracks it
 * via a single companion slot rather than a list, and rejects a second
 * incoming connection request as BUSY.
 *
 * This class deliberately does NOT touch WebRTC/Daily.co directly — it is
 * purely the Telecom-facing shell. Answering here means "tell the OS this
 * call is active and forward the action into the same JS bridge the
 * notification's Accept button already uses" — it is the JS layer
 * (useDailyCall.ts) that remains the single source of truth for the
 * actual WebRTC session, exactly as before this integration existed.
 *
 * onShowIncomingCallUi() deliberately does nothing beyond logging: the
 * incoming-call notification + ringtone are already fired unconditionally
 * and directly by CallNotificationService the moment the FCM push arrives,
 * independent of whether Telecom registration succeeds. Duplicating that
 * here would risk two competing ringtone-service start calls racing each
 * other for no benefit — Telecom integration is additive OS awareness, not
 * a second UI.
 */
class DuoSpaceConnection(
    val callId: String,
    private val callerName: String,
    private val isVideo: Boolean,
    private val conversationId: String?,
    private val roomName: String?,
    private val onAnswerCallback: () -> Unit,
    private val onRejectCallback: () -> Unit,
    private val onDisconnectCallback: () -> Unit,
) : Connection() {

    companion object {
        const val EXTRA_CALL_ID = "duospace_call_id"
        const val EXTRA_CALLER_NAME = "duospace_caller_name"
        const val EXTRA_IS_VIDEO = "duospace_is_video"
        const val EXTRA_CONVERSATION_ID = "duospace_conversation_id"
        const val EXTRA_ROOM_NAME = "duospace_room_name"
    }

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        connectionCapabilities = CAPABILITY_SUPPORT_HOLD or CAPABILITY_MUTE
        setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        setAudioModeIsVoip(true)
    }

    override fun onShowIncomingCallUi() {
        android.util.Log.i(
            "DuoSpaceTelecom",
            "onShowIncomingCallUi callId=$callId caller=$callerName isVideo=$isVideo " +
                "— no-op by design, see class doc: notification/ringtone already fired independently.",
        )
    }

    override fun onAnswer() {
        android.util.Log.i("DuoSpaceTelecom", "onAnswer callId=$callId (Telecom/Bluetooth/car button)")
        setActive()
        onAnswerCallback()
    }

    override fun onAnswer(videoState: Int) {
        onAnswer()
    }

    override fun onReject() {
        android.util.Log.i("DuoSpaceTelecom", "onReject callId=$callId (Telecom/Bluetooth/car button)")
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        onRejectCallback()
    }

    override fun onDisconnect() {
        android.util.Log.i("DuoSpaceTelecom", "onDisconnect callId=$callId")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        onDisconnectCallback()
    }

    override fun onAbort() {
        setDisconnected(DisconnectCause(DisconnectCause.CANCELED))
        destroy()
        onDisconnectCallback()
    }

    /**
     * Fires on mute toggles AND audio-route changes (speaker/Bluetooth/
     * wired headset/earpiece) that originate from the OS side — a
     * Bluetooth headset's own button, Android's audio-route picker, etc.
     * Forwarded into the same JS bridge so the in-call UI (mute icon,
     * route indicator) stays in sync with a route change the user made
     * outside the app's own controls, instead of silently drifting out of
     * sync with what Android/the headset actually did.
     */
    override fun onCallAudioStateChanged(state: android.telecom.CallAudioState) {
        super.onCallAudioStateChanged(state)
        val routeLabel = when (state.route) {
            android.telecom.CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
            android.telecom.CallAudioState.ROUTE_SPEAKER -> "speaker"
            android.telecom.CallAudioState.ROUTE_WIRED_HEADSET -> "wired_headset"
            else -> "earpiece"
        }
        android.util.Log.i("DuoSpaceTelecom", "onCallAudioStateChanged callId=$callId muted=${state.isMuted} route=$routeLabel")
        CallBridge.dispatchCallAction(
            DuoSpaceConnectionService.appContext,
            callId,
            if (state.isMuted) "mute" else "unmute",
            isVideo, conversationId, roomName,
        )
    }
}
