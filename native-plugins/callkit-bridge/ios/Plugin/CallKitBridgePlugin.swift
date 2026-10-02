import Foundation
import Capacitor
import CallKit

/**
 * Capacitor plugin bridging JS <-> CallKitManager/PushKitManager. Thin by
 * design — all the real CallKit/PushKit logic lives in
 * native/ios/CallKitManager.swift and native/ios/PushKitManager.swift
 * (copied into ios/App/App/ by scripts/patch-native-permissions.mjs, same
 * mechanism as the Android Kotlin files), so this plugin has one job:
 * translate between the app-wide singletons' callback closures and
 * Capacitor's JS event system.
 *
 * UNVERIFIED: written against the documented CAPPlugin API surface; not
 * compiled or run (no Xcode/macOS in the environment that generated it).
 */
@objc(DuospaceCallKitBridgePlugin)
public class DuospaceCallKitBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DuospaceCallKitBridgePlugin"
    public let jsName = "DuospaceCallKitBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "reportOutgoingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportCallConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportCallEnded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRingtone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingCallAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissIncomingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isIncomingRinging", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        CallKitManager.shared.onCallAction = { [weak self] callId, action, isVideo, conversationId, roomName, wasAnswered in
            self?.notifyListeners("callAction", data: [
                "callId": callId,
                "action": action,
                "isVideo": isVideo,
                "conversationId": conversationId as Any,
                "roomName": roomName as Any,
                "wasAnswered": wasAnswered,
            ])
        }
        PushKitManager.shared.onTokenUpdated = { [weak self] token in
            self?.notifyListeners("voipTokenUpdated", data: ["token": token])
        }
        PushKitManager.shared.start()
    }

    @objc func reportOutgoingCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId"), let calleeName = call.getString("calleeName") else {
            call.reject("callId and calleeName are required")
            return
        }
        let isVideo = call.getBool("isVideo") ?? false
        CallKitManager.shared.reportOutgoingCallStarted(callId: callId, calleeName: calleeName, isVideo: isVideo)
        call.resolve()
    }

    /// Call once real remote audio is confirmed (see
    /// The call engine adapter's waitForRemoteAudioReady) — flips CallKit from
    /// "Calling…" to connected and turns on proximity-sensor screen-off
    /// for voice calls. See CallKitManager.reportCallConnected's doc
    /// comment.
    @objc func reportCallConnected(_ call: CAPPluginCall) {
        let isVideo = call.getBool("isVideo") ?? false
        CallKitManager.shared.reportCallConnected(isVideo: isVideo)
        call.resolve()
    }

    @objc func reportCallEnded(_ call: CAPPluginCall) {
        let reasonStr = call.getString("reason") ?? "remoteEnded"
        let reason: CXCallEndedReasonCompat = CXCallEndedReasonCompat(rawValue: reasonStr) ?? .remoteEnded
        CallKitManager.shared.reportCallEnded(reason: reason.toCXCallEndedReason())
        call.resolve()
    }

    @objc func setRingtone(_ call: CAPPluginCall) {
        guard let soundId = call.getString("soundId") else {
            call.reject("soundId is required")
            return
        }
        CallKitManager.shared.applyRingtonePreference(soundId)
        call.resolve()
    }

    /// See CallKitManager.persistPendingAction/drainPendingAction's doc
    /// comment for the full cold-start-lost-action rationale. Called once
    /// by src/lib/nativeCallActionBridge.ts on app boot; resolves with an
    /// empty object (not a rejection) when there's nothing pending, so JS
    /// doesn't need a try/catch just to check.
    @objc func getPendingCallAction(_ call: CAPPluginCall) {
        guard let pending = CallKitManager.drainPendingAction() else {
            call.resolve([:])
            return
        }
        call.resolve(pending)
    }

    /// Android-only concept (dismissing CallRingingService's ringtone/vibration
    /// + notification). On iOS, CallKit owns the incoming-call lifecycle, so
    /// this exists only to keep the JS-facing API identical on both platforms.
    @objc func dismissIncomingCall(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// True while CallKit has a call that hasn't been answered yet (its own
    /// ringtone — the user's chosen one, see CallKitManager
    /// .applyRingtonePreference — is playing). JS only asks this when an
    /// INCOMING call has just arrived, when no outgoing call can exist, so
    /// "unanswered current call" is a sound proxy for "incoming ring active".
    /// Lets the in-app overlay skip its own copy of the ringtone instead of
    /// ringing on top of CallKit's.
    @objc func isIncomingRinging(_ call: CAPPluginCall) {
        call.resolve(["ringing": CallKitManager.shared.isRingingUnanswered])
    }
}

/// Small string<->CXCallEndedReason mapping helper so the JS-facing API can
/// pass a plain string instead of needing to know CallKit's raw Int enum.
private enum CXCallEndedReasonCompat: String {
    case remoteEnded, failed, unanswered, declinedElsewhere, answeredElsewhere

    func toCXCallEndedReason() -> CXCallEndedReason {
        switch self {
        case .remoteEnded: return .remoteEnded
        case .failed: return .failed
        case .unanswered: return .unanswered
        case .declinedElsewhere: return .declinedElsewhere
        case .answeredElsewhere: return .answeredElsewhere
        }
    }
}
