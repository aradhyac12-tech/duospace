import Foundation
import UIKit
import Capacitor

/// Battery percentage (real, via UIDevice battery monitoring) + ringer mode
/// (always "unknown" on iOS — see definitions.ts for why this isn't a bug).
@objc(DeviceStatusPlugin)
public class DeviceStatusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceStatusPlugin"
    public let jsName = "DuospaceDeviceStatus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(emitStatus),
            name: UIDevice.batteryLevelDidChangeNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(emitStatus),
            name: UIDevice.batteryStateDidChangeNotification, object: nil
        )
    }

    deinit {
        UIDevice.current.isBatteryMonitoringEnabled = false
        NotificationCenter.default.removeObserver(self)
    }

    private func statusDict() -> [String: Any] {
        let device = UIDevice.current
        let rawLevel = device.batteryLevel // -1.0 if monitoring not yet ready
        let batteryLevel: Any = rawLevel >= 0 ? Double(rawLevel * 100) : NSNull()
        let charging: Any
        switch device.batteryState {
        case .charging, .full: charging = true
        case .unplugged: charging = false
        default: charging = NSNull() // .unknown — genuinely undetermined
        }
        return [
            "batteryLevel": batteryLevel,
            "charging": charging,
            // No public Apple API exposes the physical mute-switch position.
            // Always reporting 'unknown' here (rather than guessing) is the
            // deliberate, correct behavior — see definitions.ts.
            "ringerMode": "unknown",
        ]
    }

    @objc private func emitStatus() {
        notifyListeners("statusChanged", data: statusDict())
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(statusDict())
    }
}
