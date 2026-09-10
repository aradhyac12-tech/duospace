import Foundation
import AVFoundation
import Capacitor

/// Real call-audio route switching (earpiece / speaker / Bluetooth / wired
/// headset) for iOS.
///
/// IMPORTANT — this does not own the shared AVAudioSession's category/mode.
/// Daily.co's WebRTC engine already configures the session (playAndRecord,
/// voiceChat mode, allowBluetooth/allowBluetoothA2DP options) when a call
/// starts. This plugin only calls `overrideOutputAudioPort` and
/// `setPreferredInput` on top of that existing session — the same technique
/// native WebRTC/CallKit apps use — so it should only be used while a
/// Daily.co call is actually joined. Calling it outside a call just throws
/// (caught below), not a crash.
@objc(AudioRoutePlugin)
public class AudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoutePlugin"
    public let jsName = "DuospaceAudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listRoutes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRoute", returnType: CAPPluginReturnPromise),
    ]

    private let speakerId = "speaker"

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(routeChanged),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func routeChanged() {
        notifyListeners("routeChanged", data: ["route": currentRouteJSObject() as Any])
    }

    private func typeName(for portType: AVAudioSession.Port) -> String {
        switch portType {
        case .builtInMic, .builtInReceiver:
            return "earpiece"
        case .builtInSpeaker:
            return "speaker"
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE:
            return "bluetooth"
        case .headsetMic, .headphones:
            return "wired_headset"
        case .usbAudio, .carAudio:
            return "wired_headset"
        default:
            return "unknown"
        }
    }

    private func inputRouteJSObject(_ port: AVAudioSessionPortDescription) -> [String: Any] {
        return ["id": port.uid, "name": port.portName, "type": typeName(for: port.portType)]
    }

    private func speakerJSObject() -> [String: Any] {
        return ["id": speakerId, "name": "Speaker", "type": "speaker"]
    }

    @objc func listRoutes(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        var routes: [[String: Any]] = [speakerJSObject()]
        for port in session.availableInputs ?? [] {
            let type = typeName(for: port.portType)
            if type != "unknown" { routes.append(inputRouteJSObject(port)) }
        }
        call.resolve(["routes": routes])
    }

    private func currentRouteJSObject() -> [String: Any]? {
        let session = AVAudioSession.sharedInstance()
        guard let output = session.currentRoute.outputs.first else { return nil }
        let type = typeName(for: output.portType)
        if type == "speaker" { return speakerJSObject() }
        return ["id": output.uid, "name": output.portName, "type": type]
    }

    @objc func getCurrentRoute(_ call: CAPPluginCall) {
        call.resolve(["route": currentRouteJSObject() as Any])
    }

    @objc func setRoute(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let id = call.getString("id")
        let type = call.getString("type")

        do {
            if id == speakerId || type == "speaker" {
                try session.overrideOutputAudioPort(.speaker)
                call.resolve()
                return
            }

            // Anything else: clear the speaker override, then (if a specific
            // input port was requested) prefer it — on iPhone, input
            // selection drives output routing for voice-call sessions
            // (built-in mic -> earpiece, Bluetooth HFP -> Bluetooth, headset
            // mic -> wired headset).
            try session.overrideOutputAudioPort(.none)

            if let id = id, let port = (session.availableInputs ?? []).first(where: { $0.uid == id }) {
                try session.setPreferredInput(port)
            } else if let type = type {
                let match = (session.availableInputs ?? []).first { typeName(for: $0.portType) == type }
                if let match = match {
                    try session.setPreferredInput(match)
                } else if type != "earpiece" {
                    call.reject("No available route of type \(type)")
                    return
                }
            }
            call.resolve()
        } catch {
            // Most commonly: no active call audio session to route yet.
            // Treated as a soft failure, not a plugin crash.
            call.reject("Could not switch audio route: \(error.localizedDescription)")
        }
    }
}
