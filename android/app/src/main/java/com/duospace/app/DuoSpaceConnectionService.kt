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

        /** Called by DuospaceCallKitBridgePlugin.reportCallEnded — JS
         *  already decided to hang up, this just clears Telecom's "in call"
         *  state to match without re-dispatching a redundant "end" action
         *  back into JS (see DuoSpaceConnection.disconnectSilently's doc
         *  comment). Safe no-op if there's no active connection (e.g.
         *  Telecom registration never succeeded for this call, or it's
         *  already been torn down). */
        fun endCurrentConnectionSilently() {
            currentConnection?.disconnectSilently()
            currentConnection = null
        }

        /** Like endCurrentConnectionSilently(), but only if the current
         *  connection belongs to `callId` (or `callId` is null). Used when an
         *  incoming call stops ringing for a reason Telecom itself didn't
         *  report — answered/declined in the app's own UI, or the caller hung
         *  up — so a stale request for an old call can't end a newer one. */
        /** Drops the slot only if it still points at `connection`. */
        fun clearIfCurrent(connection: DuoSpaceConnection) {
            if (currentConnection === connection) currentConnection = null
        }

        fun endConnectionForCall(callId: String?) {
            val connection = currentConnection ?: return
            if (callId != null && connection.callId != callId) return
            connection.disconnectSilently()
            currentConnection = null
        }
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

        // STALE-CONNECTION FIX: a connection left over from an earlier call
        // (its cancel push never arrived, app killed mid-call, JS never
        // reported the end) used to make EVERY later incoming call fail here
        // as BUSY. DuoSpace is strictly 1:1 with one partner, so a NEW
        // callId ringing means the old one is over — release it silently and
        // take the new call. Only a genuinely ANSWERED connection for another
        // call still counts as busy.
        currentConnection?.let { old ->
            if (callId != null && old.callId != callId && old.state != Connection.STATE_ACTIVE) {
                android.util.Log.i("DuoSpaceTelecom", "releasing stale connection ${old.callId} for new call $callId")
                old.disconnectSilently()
                currentConnection = null
            }
        }
        if (callId != null && currentConnection?.callId == callId) {
            // Duplicate push for the call that is already registered.
            return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
        }
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
        val declineExtras = HashMap<String, String>()
        for (k in listOf("declineUrl", "declineToken", "declineExp", "declineReceiver")) {
            callDataExtras.getString(DuoSpaceConnection.EXTRA_DECLINE_PREFIX + k)?.let { declineExtras[k] = it }
        }

        val connection = DuoSpaceConnection(
            callId = callId,
            callerName = callerName,
            isVideo = isVideo,
            conversationId = conversationId,
            roomName = roomName,
            onAnswerCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "accept", isVideo, conversationId, roomName)
                // Deliberately NOT nulling currentConnection here (it used to):
                // the answered connection stays alive for the whole call, and
                // dropping our only reference meant nothing could ever end it
                // when the call finished — see endConnectionForCall /
                // CallOngoingService.stopSelfCleanly.
            },
            onRejectCallback = {
                // Decline natively (same path as the notification's Decline
                // button) instead of launching the app just to say no.
                appContext?.let { ctx ->
                    try {
                        ctx.sendBroadcast(android.content.Intent(ctx, CallActionReceiver::class.java).apply {
                            action = CallActionReceiver.ACTION_DECLINE
                            putExtra("callId", callId)
                            putExtra("callType", if (isVideo) "video" else "audio")
                            conversationId?.let { putExtra("conversationId", it) }
                            roomName?.let { putExtra("roomName", it) }
                            for ((k, v) in declineExtras) putExtra(k, v)
                        })
                    } catch (e: Exception) {
                        android.util.Log.w("DuoSpaceTelecom", "native decline broadcast failed", e)
                    }
                }
                CallBridge.dispatchCallAction(appContext, callId, "decline", isVideo, conversationId, roomName)
                currentConnection = null
            },
            onDisconnectCallback = {
                CallBridge.dispatchCallAction(appContext, callId, "end", isVideo, conversationId, roomName)
                currentConnection = null
            },
            declineExtras = declineExtras,
        )
        connection.setRinging()
        connection.startRingTimeout()
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
