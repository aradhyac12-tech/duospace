import Foundation
import PushKit

/// VoIP push registration and handling — what lets DuoSpace wake up and
/// ring even when fully terminated. Regular APNs remote notifications are
/// NOT reliably delivered in a way that can present a CallKit UI when the
/// app is terminated; VoIP pushes via PushKit are specifically exempted
/// from that restriction, which is why CallKit+PushKit must be used
/// together for a FaceTime-style incoming call rather than a regular push
/// + local notification.
///
/// CRITICAL — unlike Android's best-effort Telecom registration
/// (TelecomHelper.registerIncomingCall can silently fail and the call
/// still rings via the notification path), every VoIP push on iOS MUST
/// result in a CallKitManager.reportIncomingCall call before
/// pushRegistry(_:didReceiveIncomingPushWith:for:completion:) returns, or
/// iOS terminates the app for violating its PushKit contract. There is no
/// safe silent-failure path the way there is on Android — this is handled
/// below by reporting a placeholder call and immediately ending it if the
/// payload is ever malformed, rather than skipping the report.
///
/// UNVERIFIED: written against the documented PushKit API surface; not
/// compiled or run on a device (no Xcode/macOS available in the
/// environment that generated it).
@objc public class PushKitManager: NSObject {
    @objc public static let shared = PushKitManager()
    private var registry: PKPushRegistry?

    /// Fires with the new VoIP push token (hex string) whenever it's
    /// issued or rotates. The app's JS layer must upload this to Supabase
    /// the same way it already does for the regular FCM/APNs token (see
    /// src/hooks/usePushNotifications.ts), tagged as a distinct token type
    /// so supabase/functions/send-push knows to deliver via the VoIP APNs
    /// topic (`<bundle-id>.voip`) and `.voip` push type — a regular APNs
    /// push to a VoIP token (or vice versa) is silently dropped by Apple,
    /// not just misrouted.
    @objc public var onTokenUpdated: ((String) -> Void)?

    @objc public func start() {
        let pushRegistry = PKPushRegistry(queue: .main)
        pushRegistry.delegate = self
        pushRegistry.desiredPushTypes = [.voIP]
        self.registry = pushRegistry
    }
}

extension PushKitManager: PKPushRegistryDelegate {
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let tokenHex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        onTokenUpdated?(tokenHex)
    }

    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        NSLog("[DuoSpacePushKit] VoIP push token invalidated")
    }

    public func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        let data = payload.dictionaryPayload

        guard let callId = data["callId"] as? String else {
            // Malformed/unusable payload — still must report SOMETHING to
            // CallKit or iOS terminates the app for an unreported VoIP
            // push. Report a placeholder call and immediately end it; this
            // is Apple's own documented pattern for this situation.
            CallKitManager.shared.reportIncomingCall(
                callId: UUID().uuidString, callerName: "DuoSpace",
                isVideo: false, conversationId: nil, roomName: nil
            ) { _ in
                CallKitManager.shared.reportCallEnded(reason: .failed)
                completion()
            }
            return
        }
        let callerName = data["callerName"] as? String ?? "DuoSpace"
        let event = data["event"] as? String ?? "incoming"

        // Caller cancelled before the recipient answered, OR the recipient
        // answered on a different device (see notify_voip_on_call_end /
        // notify_voip_on_call_claim in 20260808150000_call_hardening.sql).
        // Both must still satisfy the PushKit contract above — see
        // CallKitManager.reportCancelledCall's doc comment for why this
        // reports-then-immediately-ends rather than silently dropping the
        // push. "answered_elsewhere" specifically must only ever end THIS
        // device's own ringing UUID, never an active call — that guard
        // lives in CallKitManager (currentCallId match + isAnswered check).
        if event == "cancel" {
            CallKitManager.shared.reportCancelledCall(callId: callId, callerName: callerName)
            completion()
            return
        }
        if event == "answered_elsewhere" {
            CallKitManager.shared.reportAnsweredElsewhere(callId: callId, callerName: callerName)
            completion()
            return
        }

        let isVideo = (data["callType"] as? String) == "video"
        let conversationId = data["conversationId"] as? String
        let roomName = data["roomName"] as? String

        CallKitManager.shared.reportIncomingCall(
            callId: callId, callerName: callerName, isVideo: isVideo,
            conversationId: conversationId, roomName: roomName
        ) { _ in
            completion()
        }
    }
}
