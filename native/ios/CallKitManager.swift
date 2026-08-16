import Foundation
import UIKit
import CallKit
import AVFoundation

/// Bridges DuoSpace's single active call (1:1 calling only, no group calls
/// — same constraint as Android) to CallKit, the same way
/// native/android/TelecomHelper.kt + DuoSpaceConnection.kt bridge to
/// Android's Telecom framework. CallKit is what gives DuoSpace FaceTime-
/// style incoming-call UI (including when the app is fully terminated),
/// lock-screen answer/decline, Bluetooth/CarPlay button support, and
/// correct interruption/audio-focus behavior against the real Phone app.
///
/// This class deliberately does NOT touch WebRTC/Daily.co directly — exactly
/// like DuoSpaceConnection.kt on Android, answering here means "tell the OS
/// this call is active and forward the action into the JS bridge"; the JS
/// layer (useDailyCall.ts) remains the single source of truth for the
/// actual WebRTC session. See AppDelegate+DuoSpace.swift for how
/// `onCallAction` gets wired to the Capacitor WebView.
///
/// UNVERIFIED: written against the documented CallKit API surface; this
/// has not been compiled (no Xcode/macOS in the environment that generated
/// it) or run on a device. Treat as "structurally correct, ready for
/// Xcode" rather than "tested."
@objc public class CallKitManager: NSObject {
    @objc public static let shared = CallKitManager()

    private let provider: CXProvider
    private let callController = CXCallController()
    private(set) var currentCallUUID: UUID?
    private(set) var currentCallId: String?
    /// True once CallKit's own Answer action (or the JS layer's accept
    /// flow) has fired for currentCallId. Used as a second, independent
    /// guard — alongside the backend's device-targeted exclusion of the
    /// answering device from "answered elsewhere"/end-of-call pushes — so
    /// that even a stale or mistargeted push can never end a call this
    /// device is actively answering or connected to (item 8: "never
    /// terminate the shared active call").
    private(set) var isAnswered: Bool = false

    /// (callId, action, isVideo, conversationId, roomName) — called when
    /// CallKit answers/ends/mutes a call, so AppDelegate can forward it into
    /// the JS `duospace-call-action` / `duospace-call-control` events, the
    /// same events native/android/CallBridge.kt dispatches on Android.
    @objc public var onCallAction: ((String, String, Bool, String?, String?) -> Void)?

    /// Ids whose bundled ringtone actually exists (native/ios/Sounds/<id>_call.caf).
    /// Keep in sync with src/lib/notificationSounds.ts CALL_RINGTONES and
    /// supabase/functions/_shared/soundCatalog.ts CALL_RINGTONE_IDS.
    private static let VALID_RINGTONE_IDS: Set<String> = ["classic", "gentle", "urgent", "marimba"]
    private static let RINGTONE_DEFAULTS_KEY = "duo_call_ringtone_id"

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        if let icon = UIImage(named: "AppIcon") {
            configuration.iconTemplateImageData = icon.pngData()
        }
        // Restore the user's last-chosen call ringtone (persists across
        // launches — see the class doc on applyRingtonePreference for why
        // this can't be read fresh from Supabase at ring time). Falls back
        // to CallKit's own system default sound if nothing was ever chosen
        // or the id is unrecognized.
        let savedId = UserDefaults.standard.string(forKey: CallKitManager.RINGTONE_DEFAULTS_KEY)
        if let savedId = savedId, CallKitManager.VALID_RINGTONE_IDS.contains(savedId) {
            configuration.ringtoneSound = "\(savedId)_call.caf"
        }
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Changes which bundled ringtone CallKit plays for the NEXT incoming
    /// call, and persists the choice (UserDefaults) so it survives app
    /// relaunches/termination — CallKit can answer a call while the app
    /// process is freshly launched from scratch, before any JS/Supabase
    /// state is available, so the preference has to already be on disk
    /// locally rather than fetched at ring time. Call this from Settings
    /// whenever the user picks a different call ringtone (see
    /// DuospaceCallKitBridge.setRingtone in the JS bridge).
    @objc public func applyRingtonePreference(_ soundId: String) {
        let id = CallKitManager.VALID_RINGTONE_IDS.contains(soundId) ? soundId : "classic"
        UserDefaults.standard.set(id, forKey: CallKitManager.RINGTONE_DEFAULTS_KEY)

        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        if let icon = UIImage(named: "AppIcon") {
            configuration.iconTemplateImageData = icon.pngData()
        }
        configuration.ringtoneSound = "\(id)_call.caf"
        // CXProvider.configuration is settable post-init specifically to
        // support exactly this kind of live update — no need to tear down
        // and recreate the provider (which would risk losing in-flight
        // call state).
        provider.configuration = configuration
    }

    /// Called from PushKitManager the moment a VoIP push arrives. Unlike
    /// Android's TelecomHelper.registerIncomingCall (best-effort, safe to
    /// fail because the notification/ringtone path fires independently),
    /// iOS REQUIRES this to be called and to succeed before the PushKit
    /// delegate's completion handler runs, or the OS terminates the app for
    /// violating its VoIP push contract — there is no equivalent fallback
    /// UI on iOS the way there is on Android.
    @objc public func reportIncomingCall(
        callId: String,
        callerName: String,
        isVideo: Bool,
        conversationId: String?,
        roomName: String?,
        completion: ((Error?) -> Void)? = nil
    ) {
        // CallKit UUID mapping determinism (item 7): guard against a
        // retried/duplicated "incoming" VoIP push for a call we're
        // ALREADY tracking. Without this, a second delivery of the same
        // logical call (Apple's own transport-level retry, or any other
        // double-delivery not caught by this project's own server-side
        // apns_push_log idempotency) would call reportNewIncomingCall a
        // second time with a brand-new CXProvider UUID — creating two
        // separate CallKit entries for one call_history row, exactly what
        // this item was asked to rule out. Still satisfies the PushKit
        // "every push must be accounted for" contract: the completion
        // handler still runs, just without a second reportNewIncomingCall.
        if currentCallId == callId, currentCallUUID != nil {
            completion?(nil)
            return
        }

        let uuid = UUID()
        currentCallUUID = uuid
        currentCallId = callId
        isAnswered = false

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = isVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error = error {
                NSLog("[DuoSpaceCallKit] reportNewIncomingCall failed: \(error.localizedDescription)")
            }
            completion?(error)
        }
    }

    @objc public func reportOutgoingCallStarted(callId: String, calleeName: String, isVideo: Bool) {
        let uuid = UUID()
        currentCallUUID = uuid
        currentCallId = callId
        let handle = CXHandle(type: .generic, value: calleeName)
        let startCallAction = CXStartCallAction(call: uuid, handle: handle)
        startCallAction.isVideo = isVideo
        let transaction = CXTransaction(action: startCallAction)
        callController.request(transaction) { error in
            if let error = error {
                NSLog("[DuoSpaceCallKit] Failed to start outgoing call: \(error.localizedDescription)")
            }
        }
    }

    @objc public func reportCallEnded(reason: CXCallEndedReason = .remoteEnded) {
        guard let uuid = currentCallUUID else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        currentCallUUID = nil
        currentCallId = nil
        isAnswered = false
    }

    /// Call when the user ends the call from DuoSpace's own in-app UI
    /// (rather than CallKit's system UI) — keeps CallKit's call state in
    /// sync so a stale "active call" doesn't linger in the OS's call
    /// registry after the app already left the call.
    @objc public func endCallFromApp() {
        guard let uuid = currentCallUUID else { return }
        let endCallAction = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: endCallAction)) { _ in }
    }

    /// Handles a VoIP "cancel" push (caller backed out before answering —
    /// see notify_voip_on_call_end in 20260808120000_ios_voip_push.sql).
    ///
    /// Apple's PushKit contract requires EVERY VoIP push to result in
    /// reportNewIncomingCall before the push handler's completion runs, or
    /// iOS terminates the app for a contract violation — there is no way
    /// to "just not ring" for a push that arrives after the real call
    /// already started ringing via an earlier push. The documented
    /// workaround (used by most VoIP apps, e.g. this exact pattern is how
    /// WhatsApp/Signal-style clients handle it) is to still report a new
    /// incoming call and then immediately end it, rather than skip the
    /// report — CallKit visually coalesces a sub-second report+end into
    /// effectively no UI flash in practice.
    ///
    /// If this cancel arrives for the SAME callId already ringing
    /// (currentCallId matches), end that real call instead of reporting a
    /// second one — this is the common case and produces a clean dismissal
    /// with no extra CallKit entry at all.
    @objc public func reportCancelledCall(callId: String, callerName: String) {
        if currentCallId == callId, currentCallUUID != nil {
            if isAnswered {
                // Belt-and-suspenders: the backend already excludes this
                // device's token from an end-of-call push once it holds
                // the claim (see excludeDeviceId in
                // 20260808150000_call_hardening.sql), but never end a call
                // this device is actively answering/connected to, even if
                // a push somehow still reaches it.
                return
            }
            reportCallEnded(reason: .unanswered)
            return
        }
        // No matching ringing call found locally (e.g. this cancel push
        // raced ahead of, or arrived without, the incoming push actually
        // being reported yet) — still must report+end SOMETHING per the
        // PushKit contract above.
        reportIncomingCall(callId: callId, callerName: callerName, isVideo: false, conversationId: nil, roomName: nil) { [weak self] _ in
            self?.reportCallEnded(reason: .unanswered)
        }
    }

    /// Handles the dedicated "answered elsewhere" VoIP push (item 8): a
    /// sibling device claimed this call first. Deliberately a distinct
    /// method from reportCancelledCall (even though the current
    /// implementation is identical) so the two call sites in
    /// PushKitManager stay semantically separate and can diverge safely if
    /// either ever needs event-specific behavior — e.g. a different
    /// CXCallEndedReason, or UI-level telemetry distinguishing "the other
    /// person hung up" from "you answered on your other device" without
    /// re-deriving that distinction from a shared code path.
    @objc public func reportAnsweredElsewhere(callId: String, callerName: String) {
        reportCancelledCall(callId: callId, callerName: callerName)
    }
}

extension CallKitManager: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        currentCallUUID = nil
        currentCallId = nil
        isAnswered = false
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let callId = currentCallId else { action.fail(); return }
        isAnswered = true
        onCallAction?(callId, "accept", true, nil, nil)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let callId = currentCallId else { action.fail(); return }
        onCallAction?(callId, "end", true, nil, nil)
        action.fulfill()
        currentCallUUID = nil
        currentCallId = nil
        isAnswered = false
    }

    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let callId = currentCallId else { action.fail(); return }
        onCallAction?(callId, action.isMuted ? "mute" : "unmute", true, nil, nil)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Daily.co's WebRTC audio session configuration takes over from
        // here — CallKit hands control of the underlying AVAudioSession to
        // the app once activated. Nothing to do here beyond logging;
        // WebRTC's own audio unit picks up the now-active session.
        NSLog("[DuoSpaceCallKit] Audio session activated by CallKit")
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        NSLog("[DuoSpaceCallKit] Audio session deactivated by CallKit")
    }
}
