package com.duospace.app

import android.content.Context
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Self-managed ConnectionService — see TelecomHelper.kt for why
 * "self-managed" matters (no CALL_PHONE/READ_PHONE_STATE, no system-dialer
 * replacement) and DuoSpaceConnection.kt for why this is additive OS
 * awareness layered on top of the existing notification-based calling,
 * not a replacement for it.
 *
 * Must be declared in AndroidManifest.xml with a
 * BIND_TELECOM_CONNECTION_SERVICE permission and the
 * android.telecom.ConnectionService intent-filter action — see the
 * manifest patching in scripts/patch-native-permissions.mjs.
 *
 * DuoSpace only ever has one call at a time (1:1 calling, no group calls),
 * so `currentConnection` is a single slot, not a list.
 */
class DuoSpaceConnectionService : ConnectionService() {

    companion object {
        @Volatile var appContext: Context? = null
        @Volatile var currentConnection: DuoSpaceConnection? = null
    }

    override fun onCreate() {
        super.onCreate()
        appContext = applicationContext
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        val callDataExtras = request?.extras?.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
        val callId = callDataExtras?.getString(DuoSpaceConnection.EXTRA_CALL_ID)

        if (currentConnection != null || callId == null) {
            // Already on a call, or a malformed/foreign request — reject
            // cleanly rather than leaving Telecom in an inconsistent
            // state. The existing notification path is unaffected either
            // way (see DuoSpaceConnection's class doc).
            android.util.Log.w(
                "DuoSpaceTelecom",
                "onCreateIncomingConnection rejected: " +
                    if (callId == null) "missing call data extras" else "already on a call (busy)",
            )
            return Connection.createFailedConnection(DisconnectCause(DisconnectCause.BUSY))
        }

        val callerName = callDataExtras.getString(DuoSpaceConnection.EXTRA_CALLER_NAME) ?: "DuoSpace"
        val isVideo = callDataExtras.getBoolean(DuoSpaceConnection.EXTRA_IS_VIDEO, false)
        val conversationId = callDataExtras.getString(DuoSpaceConnection.EXTRA_CONVERSATION_ID)
        val roomName = callDataExtras.getString(DuoSpaceConnection.EXTRA_ROOM_NAME)

        val connection = DuoSpaceConnection(
            callId = callId,
            callerName = callerName,
            isVideo = isVideo,
            conversationId = conversationId,
            roomName = roomName,
            onAnswerCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "accept", isVideo, conversationId, roomName)
                currentConnection = null
            },
            onRejectCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "decline", isVideo, conversationId, roomName)
                currentConnection = null
            },
            onDisconnectCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "end", isVideo, conversationId, roomName)
                currentConnection = null
            },
        )
        connection.setRinging()
        currentConnection = connection
        return connection
    }

    override fun onCreateIncomingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?) {
        super.onCreateIncomingConnectionFailed(connectionManagerPhoneAccount, request)
        android.util.Log.w("DuoSpaceTelecom", "onCreateIncomingConnectionFailed — Telecom refused the call; notification path is unaffected.")
    }

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        val callDataExtras = request?.extras?.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)
        val callId = callDataExtras?.getString(DuoSpaceConnection.EXTRA_CALL_ID) ?: java.util.UUID.randomUUID().toString()
        val callerName = callDataExtras?.getString(DuoSpaceConnection.EXTRA_CALLER_NAME) ?: "DuoSpace"
        val isVideo = callDataExtras?.getBoolean(DuoSpaceConnection.EXTRA_IS_VIDEO, false) ?: false

        val connection = DuoSpaceConnection(
            callId = callId,
            callerName = callerName,
            isVideo = isVideo,
            conversationId = null,
            roomName = null,
            onAnswerCallback = {},
            onRejectCallback = {},
            onDisconnectCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "end", isVideo, null, null)
                currentConnection = null
            },
        )
        connection.setDialing()
        connection.setActive()
        currentConnection = connection
        return connection
    }

    override fun onCreateOutgoingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?) {
        super.onCreateOutgoingConnectionFailed(connectionManagerPhoneAccount, request)
        android.util.Log.w("DuoSpaceTelecom", "onCreateOutgoingConnectionFailed")
    }
}
