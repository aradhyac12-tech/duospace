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
 * This class deliberately does NOT touch WebRTC/the call engine directly — it is
 * purely the Telecom-facing shell. Answering here means "tell the OS this
 * call is active and forward the action into the same JS bridge the
 * notification's Accept button already uses" — it is the JS layer
 * (the call engine adapter) that remains the single source of truth for the
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
    /** Push-issued single-call decline token fields (declineUrl, declineToken,
     *  declineExp, declineReceiver) so a Bluetooth/car/Telecom REJECT can
     *  decline natively — no app launch — through CallActionReceiver. */
    val declineExtras: Map<String, String> = emptyMap(),
) : Connection() {

    companion object {
        const val EXTRA_CALL_ID = "duospace_call_id"
        const val EXTRA_CALLER_NAME = "duospace_caller_name"
        const val EXTRA_IS_VIDEO = "duospace_is_video"
        const val EXTRA_CONVERSATION_ID = "duospace_conversation_id"
        const val EXTRA_ROOM_NAME = "duospace_room_name"
        const val EXTRA_DECLINE_PREFIX = "duospace_decline_"
        /** An unanswered ringing connection is torn down after this long even
         *  if no cancel push ever arrives, so it can't block the next call. */
        const val RING_TIMEOUT_MS = 60_000L
    }

    private var answered = false
    private var lastReportedMute: Boolean? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val ringTimeout = Runnable {
        if (!answered && state == STATE_RINGING) {
            android.util.Log.i("DuoSpaceTelecom", "ring timeout callId=$callId — releasing stale ringing connection")
            setDisconnected(DisconnectCause(DisconnectCause.MISSED))
            destroy()
            DuoSpaceConnectionService.clearIfCurrent(this)
        }
    }

    fun startRingTimeout() { handler.postDelayed(ringTimeout, RING_TIMEOUT_MS) }

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
        if (answered) return // some head units fire both onAnswer overloads
        answered = true
        handler.removeCallbacks(ringTimeout)
        setActive()
        onAnswerCallback()
    }

    override fun onAnswer(videoState: Int) {
        onAnswer()
    }

    override fun onReject() {
        handler.removeCallbacks(ringTimeout)
        android.util.Log.i("DuoSpaceTelecom", "onReject callId=$callId (Telecom/Bluetooth/car button)")
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        onRejectCallback()
    }

    override fun onDisconnect() {
        handler.removeCallbacks(ringTimeout)
        android.util.Log.i("DuoSpaceTelecom", "onDisconnect callId=$callId")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        onDisconnectCallback()
    }

    /**
     * Tears down the Telecom side only, without firing onDisconnectCallback
     * — for when JS itself already decided to hang up (DuospaceCallKitBridge
     * .reportCallEnded) and just needs Telecom's "in call" state cleared so
     * it doesn't outlive the app's own end-call flow. Calling plain
     * onDisconnect() here would re-dispatch a second "end" CallBridge action
     * back into JS for a hangup JS itself already initiated.
     */
    fun disconnectSilently() {
        handler.removeCallbacks(ringTimeout)
        android.util.Log.i("DuoSpaceTelecom", "disconnectSilently callId=$callId (JS-initiated hangup)")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
    }

    override fun onAbort() {
        handler.removeCallbacks(ringTimeout)
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
        // Telecom reports an initial audio state the moment the connection
        // is CREATED (still ringing). Forwarding that used to launch the app
        // on every incoming call. Only real mute CHANGES during an ANSWERED
        // call are meaningful to the in-call UI.
        val previous = lastReportedMute
        lastReportedMute = state.isMuted
        if (!answered || previous == null || previous == state.isMuted) return
        CallBridge.dispatchCallAction(
            DuoSpaceConnectionService.appContext,
            callId,
            if (state.isMuted) "mute" else "unmute",
            isVideo, conversationId, roomName,
        )
    }
}
