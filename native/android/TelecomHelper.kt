package com.duospace.app

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Registers DuoSpace as a *self-managed* ConnectionService — the mechanism
 * WhatsApp/Signal/Messenger use to get OS-level call treatment (Bluetooth
 * and car head-unit answer/reject buttons, "other call" waiting behavior,
 * audio-focus arbitration against the carrier phone app) WITHOUT becoming
 * a system dialer replacement. Self-managed accounts:
 *
 *   - Do NOT require CALL_PHONE / READ_PHONE_STATE — those are for apps
 *     managing the carrier phone's own calls, a different, much more
 *     invasive integration this app deliberately does not use.
 *   - Do NOT show up as a selectable "default calling app".
 *   - DO require the app to draw its own incoming-call UI — Android
 *     supplies none for self-managed connections. This integration is
 *     intentionally layered on top of the existing, already-working
 *     CallNotificationService/CallRingingService presentation rather than
 *     replacing it — see DuoSpaceConnection.onShowIncomingCallUi.
 *
 * Every public function here is best-effort and swallows its own
 * exceptions: a Telecom registration failure (missing system service on
 * some OEM builds, account not yet enabled, API < 26, etc.) must never
 * block app startup or break call handling, which worked via notifications
 * alone before this integration existed and continues to.
 */
object TelecomHelper {
    private const val ACCOUNT_ID = "duospace_self_managed"

    fun phoneAccountHandle(context: Context): PhoneAccountHandle {
        val componentName = ComponentName(context, DuoSpaceConnectionService::class.java)
        return PhoneAccountHandle(componentName, ACCOUNT_ID)
    }

    /** Call once at app startup (see MainActivity's onCreate addition below). Idempotent. */
    fun registerPhoneAccount(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        return try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return false
            val handle = phoneAccountHandle(context)
            val account = PhoneAccount.builder(handle, "DuoSpace")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription("DuoSpace voice and video calls")
                .build()
            telecomManager.registerPhoneAccount(account)
            true
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceTelecom", "registerPhoneAccount failed (non-fatal, notification-based calling still works)", e)
            false
        }
    }

    /**
     * Best-effort OS-level registration for an already-ringing call. This
     * does NOT draw any UI or play any sound by itself — CallNotificationService
     * calls IncomingCallPresenter-equivalent logic directly and
     * unconditionally regardless of this call's outcome, so a Telecom
     * failure here has zero effect on whether the phone actually rings.
     * What this adds when it succeeds: Bluetooth/car head-unit answer-
     * reject buttons start working, and other apps correctly see the
     * device as "in a call".
     */
    fun registerIncomingCall(
        context: Context,
        callId: String,
        callerName: String,
        isVideo: Boolean,
        conversationId: String?,
        roomName: String?,
    ): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        return try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return false
            val handle = phoneAccountHandle(context)
            val callDataExtras = Bundle().apply {
                putString(DuoSpaceConnection.EXTRA_CALL_ID, callId)
                putString(DuoSpaceConnection.EXTRA_CALLER_NAME, callerName)
                putBoolean(DuoSpaceConnection.EXTRA_IS_VIDEO, isVideo)
                putString(DuoSpaceConnection.EXTRA_CONVERSATION_ID, conversationId)
                putString(DuoSpaceConnection.EXTRA_ROOM_NAME, roomName)
            }
            val callExtras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callDataExtras)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }
            telecomManager.addNewIncomingCall(handle, callExtras)
            true
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceTelecom", "registerIncomingCall failed for callId=$callId (non-fatal — notification/ringtone already fired independently)", e)
            false
        }
    }

    /**
     * Registers an outgoing call the same way. Not currently wired to a UI
     * action (DuoSpace's outgoing-call flow starts the Daily.co room
     * directly from JS via useDailyCall.ts and doesn't need Telecom to
     * function) — provided for symmetry and so a future "answer via car
     * dialer callback" or similar flow has a real entry point rather than
     * requiring this file to be revisited.
     */
    fun registerOutgoingCall(context: Context, callId: String, calleeName: String, isVideo: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        return try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return false
            val handle = phoneAccountHandle(context)
            val uri = Uri.fromParts("duospace", callId, null)
            val callDataExtras = Bundle().apply {
                putString(DuoSpaceConnection.EXTRA_CALL_ID, callId)
                putString(DuoSpaceConnection.EXTRA_CALLER_NAME, calleeName)
                putBoolean(DuoSpaceConnection.EXTRA_IS_VIDEO, isVideo)
            }
            val callExtras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callDataExtras)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }
            telecomManager.placeCall(uri, callExtras)
            true
        } catch (e: Exception) {
            android.util.Log.w("DuoSpaceTelecom", "registerOutgoingCall failed for callId=$callId (non-fatal)", e)
            false
        }
    }
}
