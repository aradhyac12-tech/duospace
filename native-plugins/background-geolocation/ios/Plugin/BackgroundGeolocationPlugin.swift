import Foundation
import CoreLocation
import Capacitor

/// The actual location work, split out as a plain NSObject singleton (not
/// just plugin-method bodies) for the same reason CallKitManager.shared /
/// PushKitManager.shared are singletons rather than living only inside a
/// Capacitor plugin class: native/ios/CallKitManager.swift needs to trigger
/// an immediate fix the instant an incoming call is reported, and that has
/// to work whether or not any Capacitor Bridge/WebView/plugin instance has
/// loaded yet — a VoIP push can arrive before the app has ever been
/// opened. Unlike the Android split (a real Gradle module boundary between
/// the app and this plugin, see LocationFixBridge.kt / DuoSpaceLocationService.kt),
/// iOS Capacitor plugins compile as plain source files directly into the
/// single app target via CocoaPods, so CallKitManager.swift can just call
/// `DuoSpaceLocationManager.shared` with no bridge of any kind needed.
///
/// UNVERIFIED: written against the documented CoreLocation API surface;
/// not compiled or run on a device (no Xcode/macOS in the environment that
/// generated it) — same caveat as CallKitManager.swift / PushKitManager.swift.
@objc public class DuoSpaceLocationManager: NSObject, CLLocationManagerDelegate {
    @objc public static let shared = DuoSpaceLocationManager()

    public struct Fix {
        public let latitude: Double
        public let longitude: Double
        public let accuracy: Double?
        public let timestampMs: Double
        public let source: String // "watch" | "oneShot"
    }

    public enum FixError: Error {
        case denied
        case unavailable
        case timeout
        case unknown(String)
    }

    /// Fires for every fix, watcher or one-shot — the plugin subscribes to
    /// this and forwards into `notifyListeners("locationUpdate", ...)`.
    @objc public var onFix: ((Fix) -> Void)?
    @objc public var onError: ((String, String) -> Void)?

    private let manager = CLLocationManager()
    private(set) var isWatcherRunning = false
    private var oneShotTimeoutWorkItem: DispatchWorkItem?
    private var oneShotCompletion: ((Result<Fix, FixError>) -> Void)?

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        // Required for updates to keep arriving once the app is suspended
        // (not just minimized) — needs the "location" UIBackgroundModes
        // entry (added by scripts/patch-native-permissions.mjs) and Always
        // authorization, or iOS silently ignores this flag.
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
    }

    private func ensureAuthorization() {
        let status = manager.authorizationStatus
        if status == .notDetermined {
            manager.requestAlwaysAuthorization()
        } else if status == .authorizedWhenInUse {
            // Upgrade from When-In-Use → Always. iOS shows its own
            // secondary "Change to Always Allow?" prompt for this; there is
            // no way to skip straight to Always on first ask starting with
            // iOS 13's two-step permission model.
            manager.requestAlwaysAuthorization()
        }
    }

    @objc public func start(intervalMs: Double) {
        ensureAuthorization()
        // CoreLocation has no directly-configurable "interval" the way
        // Android's FusedLocationProviderClient does — continuous updates
        // deliver as fast as `desiredAccuracy`/movement allow. Significant-
        // change monitoring is what actually gives the OS-level background
        // wake guarantee once the app is suspended (not just backgrounded);
        // continuous updates are kept on too, for while the process is
        // still alive and active in the background, which is the common
        // case (screen off, another app briefly in front, a call ringing).
        manager.startUpdatingLocation()
        manager.startMonitoringSignificantLocationChanges()
        isWatcherRunning = true
    }

    @objc public func stop() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        isWatcherRunning = false
    }

    /// Requests one fresh high-accuracy fix. `reason` is diagnostic only
    /// (logged, never transmitted) — e.g. "incoming_call", "incoming_message".
    @objc public func requestImmediateFix(reason: String, timeoutMs: Double = 8000, completion: ((Result<Fix, FixError>) -> Void)? = nil) {
        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else {
            let err = FixError.denied
            onError?("denied", "Location authorization not granted")
            completion?(.failure(err))
            return
        }
        oneShotCompletion = completion
        if !isWatcherRunning { start(intervalMs: 45000) }

        oneShotTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.onError?("timeout", "No fix within \(Int(timeoutMs))ms (reason=\(reason))")
            self.oneShotCompletion?(.failure(.timeout))
            self.oneShotCompletion = nil
        }
        oneShotTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1000, execute: workItem)

        manager.requestLocation()
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        let hadPendingOneShot = oneShotCompletion != nil
        oneShotTimeoutWorkItem?.cancel()
        let fix = Fix(
            latitude: loc.coordinate.latitude,
            longitude: loc.coordinate.longitude,
            accuracy: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil,
            timestampMs: loc.timestamp.timeIntervalSince1970 * 1000,
            source: hadPendingOneShot ? "oneShot" : "watch"
        )
        // Mirrors the Android-side fix: if no Capacitor plugin instance has
        // loaded yet (e.g. CallKitManager triggered this via a VoIP push
        // before the app was ever opened, so `onFix` was never assigned in
        // BackgroundGeolocationPlugin.load()), the fix has nowhere to go —
        // same documented limitation as the Android cold-start case (see
        // docs/BACKGROUND_LOCATION_NATIVE.md). Log it instead of dropping
        // silently.
        if onFix == nil {
            NSLog("[DuoSpaceLocation] Fix obtained (source=%@) but no plugin listener attached — dropped (JS bridge never loaded).", fix.source)
        }
        onFix?(fix)
        if hadPendingOneShot {
            oneShotCompletion?(.success(fix))
            oneShotCompletion = nil
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let clErr = error as? CLError
        let code: String
        switch clErr?.code {
        case .denied: code = "denied"
        case .locationUnknown: code = "unavailable"
        default: code = "unknown"
        }
        oneShotTimeoutWorkItem?.cancel()
        onError?(code, error.localizedDescription)
        if oneShotCompletion != nil {
            oneShotCompletion?(.failure(code == "denied" ? .denied : .unavailable))
            oneShotCompletion = nil
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            onError?("denied", "Location authorization revoked or restricted")
        }
    }
}

@objc(DuospaceBackgroundGeolocationPlugin)
public class BackgroundGeolocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DuospaceBackgroundGeolocationPlugin"
    public let jsName = "DuospaceBackgroundGeolocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestImmediateFix", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRunning", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        DuoSpaceLocationManager.shared.onFix = { [weak self] fix in
            self?.notifyListeners("locationUpdate", data: [
                "latitude": fix.latitude,
                "longitude": fix.longitude,
                "accuracy": fix.accuracy as Any,
                "timestamp": fix.timestampMs,
                "source": fix.source,
            ])
        }
        DuoSpaceLocationManager.shared.onError = { [weak self] code, message in
            self?.notifyListeners("locationError", data: ["code": code, "message": message])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let intervalMs = call.getDouble("intervalMs") ?? 45000
        DuoSpaceLocationManager.shared.start(intervalMs: intervalMs)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        DuoSpaceLocationManager.shared.stop()
        call.resolve()
    }

    @objc func isRunning(_ call: CAPPluginCall) {
        call.resolve(["running": DuoSpaceLocationManager.shared.isWatcherRunning])
    }

    @objc func requestImmediateFix(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "manual"
        let timeoutMs = call.getDouble("timeoutMs") ?? 8000
        DuoSpaceLocationManager.shared.requestImmediateFix(reason: reason, timeoutMs: timeoutMs) { result in
            switch result {
            case .success(let fix):
                call.resolve([
                    "latitude": fix.latitude,
                    "longitude": fix.longitude,
                    "accuracy": fix.accuracy as Any,
                    "timestamp": fix.timestampMs,
                    "source": fix.source,
                ])
            case .failure(let err):
                switch err {
                case .denied: call.reject("Location permission denied", "denied")
                case .unavailable: call.reject("Location unavailable", "unavailable")
                case .timeout: call.reject("Timed out waiting for a fix", "timeout")
                case .unknown(let msg): call.reject(msg, "unknown")
                }
            }
        }
    }
}
