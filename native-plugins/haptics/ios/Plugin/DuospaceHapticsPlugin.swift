import Foundation
import UIKit
import CoreHaptics
import Capacitor

/// Premium haptics for iOS.
///
/// Single taps use the UIKit feedback generators (Soft/Rigid styles + a
/// per-call `intensity`, which @capacitor/haptics doesn't expose) — they have
/// near-zero latency once prepared. Multi-event "signature" patterns and
/// ramps use Core Haptics (transient + continuous events with
/// intensity/sharpness and parameter curves). Devices without Core Haptics
/// (e.g. iPad) degrade to sequenced generator taps, or silence — never an error.
///
/// Class is deliberately NOT named `HapticsPlugin`: @capacitor/haptics ships a
/// Swift class with that name and the ObjC runtime would collide.
@objc(DuospaceHapticsPlugin)
public class DuospaceHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DuospaceHapticsPlugin"
    public let jsName = "DuospaceHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "perform", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    // All UIKit generator + engine access happens on the main queue.
    private var soft: UIImpactFeedbackGenerator?
    private var light: UIImpactFeedbackGenerator?
    private var medium: UIImpactFeedbackGenerator?
    private var heavy: UIImpactFeedbackGenerator?
    private var rigid: UIImpactFeedbackGenerator?
    private var selection: UISelectionFeedbackGenerator?
    private var notification: UINotificationFeedbackGenerator?

    private var engine: CHHapticEngine?
    private var engineRunning = false
    private var currentPlayer: CHHapticPatternPlayer?
    private let supportsCoreHaptics: Bool = CHHapticEngine.capabilitiesForHardware().supportsHaptics

    private struct Ev {
        let kind: String
        let intensity: Float
        let atMs: Int
    }

    // MARK: - JS API

    @objc func getCapabilities(_ call: CAPPluginCall) {
        let major = Int(UIDevice.current.systemVersion.split(separator: ".").first ?? "0") ?? 0
        call.resolve([
            "platform": "ios",
            "hasHaptics": supportsCoreHaptics || UIDevice.current.userInterfaceIdiom == .phone,
            "rich": supportsCoreHaptics,
            "amplitudeControl": true,
            "osVersion": major,
            "primitives": ["tick", "lowTick", "click", "thud", "quickRise", "slowRise", "fall", "spin"],
        ])
    }

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.makeGeneratorsIfNeeded()
            self.soft?.prepare(); self.light?.prepare(); self.medium?.prepare()
            self.heavy?.prepare(); self.rigid?.prepare()
            self.selection?.prepare(); self.notification?.prepare()
            if let e = self.ensureEngine() { _ = self.startEngineIfNeeded(e) }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            try? self.currentPlayer?.cancel()
            self.currentPlayer = nil
            call.resolve()
        }
    }

    @objc func perform(_ call: CAPPluginCall) {
        let effect = call.getString("effect") ?? "impactLight"
        let k = Float(max(0, min(1, call.getDouble("intensity") ?? 1)))
        DispatchQueue.main.async {
            self.makeGeneratorsIfNeeded()
            switch effect {
            case "selection": self.selection?.selectionChanged(); self.selection?.prepare()
            case "success": self.notification?.notificationOccurred(.success); self.notification?.prepare()
            case "warning": self.notification?.notificationOccurred(.warning); self.notification?.prepare()
            case "error": self.notification?.notificationOccurred(.error); self.notification?.prepare()
            case "impactSoft": self.soft?.impactOccurred(intensity: CGFloat(max(0.05, k))); self.soft?.prepare()
            case "impactMedium": self.medium?.impactOccurred(intensity: CGFloat(max(0.05, k))); self.medium?.prepare()
            case "impactHeavy": self.heavy?.impactOccurred(intensity: CGFloat(max(0.05, k))); self.heavy?.prepare()
            case "impactRigid": self.rigid?.impactOccurred(intensity: CGFloat(max(0.05, k))); self.rigid?.prepare()
            default: self.light?.impactOccurred(intensity: CGFloat(max(0.05, k))); self.light?.prepare()
            }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        var events: [Ev] = []
        if let raw = call.options["events"] as? [[String: Any]] {
            for item in raw {
                let kind = (item["kind"] as? String) ?? "click"
                let intensity = (item["intensity"] as? NSNumber)?.floatValue ?? 1
                let atMs = (item["atMs"] as? NSNumber)?.intValue ?? 0
                events.append(Ev(kind: kind, intensity: max(0, min(1, intensity)), atMs: max(0, atMs)))
            }
        }
        DispatchQueue.main.async {
            self.run(events.sorted { $0.atMs < $1.atMs })
            call.resolve()
        }
    }

    // MARK: - Generators

    private func makeGeneratorsIfNeeded() {
        if soft != nil { return }
        soft = UIImpactFeedbackGenerator(style: .soft)
        light = UIImpactFeedbackGenerator(style: .light)
        medium = UIImpactFeedbackGenerator(style: .medium)
        heavy = UIImpactFeedbackGenerator(style: .heavy)
        rigid = UIImpactFeedbackGenerator(style: .rigid)
        selection = UISelectionFeedbackGenerator()
        notification = UINotificationFeedbackGenerator()
    }

    /// Single transient → the lowest-latency generator that matches its character.
    private func tapViaGenerator(_ e: Ev) {
        makeGeneratorsIfNeeded()
        let i = CGFloat(max(0.05, e.intensity))
        switch e.kind {
        case "tick": rigid?.impactOccurred(intensity: max(0.05, i * 0.55)); rigid?.prepare()
        case "lowTick": soft?.impactOccurred(intensity: max(0.05, i * 0.8)); soft?.prepare()
        case "thud": heavy?.impactOccurred(intensity: max(0.05, i * 0.9)); heavy?.prepare()
        case "click": light?.impactOccurred(intensity: i); light?.prepare()
        default: medium?.impactOccurred(intensity: max(0.05, i * 0.7)); medium?.prepare()
        }
    }

    // MARK: - Core Haptics

    private func ensureEngine() -> CHHapticEngine? {
        guard supportsCoreHaptics else { return nil }
        if let e = engine { return e }
        do {
            let e = try CHHapticEngine()
            e.playsHapticsOnly = true
            e.isAutoShutdownEnabled = true
            e.stoppedHandler = { [weak self] _ in
                DispatchQueue.main.async { self?.engineRunning = false }
            }
            e.resetHandler = { [weak self] in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.engineRunning = false
                    if let e = self.engine { _ = self.startEngineIfNeeded(e) }
                }
            }
            engine = e
            return e
        } catch {
            return nil
        }
    }

    private func startEngineIfNeeded(_ e: CHHapticEngine) -> Bool {
        if engineRunning { return true }
        do {
            try e.start()
            engineRunning = true
            return true
        } catch {
            return false
        }
    }

    private func run(_ events: [Ev]) {
        guard !events.isEmpty else { return }

        // Fast path: one plain tap needs no engine and no pattern.
        let isTap = { (k: String) in k == "tick" || k == "lowTick" || k == "click" || k == "thud" }
        if events.count == 1, isTap(events[0].kind) {
            tapViaGenerator(events[0])
            return
        }

        if let e = ensureEngine(), startEngineIfNeeded(e), let pattern = buildPattern(events) {
            do {
                try? currentPlayer?.cancel()
                let player = try e.makePlayer(with: pattern)
                currentPlayer = player
                try player.start(atTime: CHHapticTimeImmediate)
                return
            } catch {
                // fall through to the generator fallback
            }
        }

        // No Core Haptics (or it failed): sequence generator taps.
        for ev in events {
            let work = { self.tapViaGenerator(ev) }
            if ev.atMs == 0 { work() } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ev.atMs), execute: work)
            }
        }
    }

    private func transient(_ intensity: Float, _ sharpness: Float, at t: TimeInterval) -> CHHapticEvent {
        CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ],
            relativeTime: t
        )
    }

    private func continuous(_ intensity: Float, _ sharpness: Float, at t: TimeInterval, duration: TimeInterval) -> CHHapticEvent {
        CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ],
            relativeTime: t,
            duration: duration
        )
    }

    private func ramp(from: Float, to: Float, at t: TimeInterval, duration: TimeInterval) -> CHHapticParameterCurve {
        CHHapticParameterCurve(
            parameterID: .hapticIntensityControl,
            controlPoints: [
                CHHapticParameterCurve.ControlPoint(relativeTime: 0, value: from),
                CHHapticParameterCurve.ControlPoint(relativeTime: duration, value: to),
            ],
            relativeTime: t
        )
    }

    private func buildPattern(_ events: [Ev]) -> CHHapticPattern? {
        var out: [CHHapticEvent] = []
        var curves: [CHHapticParameterCurve] = []
        for ev in events {
            let t = TimeInterval(ev.atMs) / 1000
            let i = ev.intensity
            switch ev.kind {
            case "tick": out.append(transient(i, 0.90, at: t))
            case "lowTick": out.append(transient(i, 0.35, at: t))
            case "click": out.append(transient(i, 0.60, at: t))
            case "thud":
                out.append(transient(i, 0.10, at: t))
                out.append(continuous(i * 0.5, 0.10, at: t, duration: 0.05))
            case "quickRise":
                out.append(continuous(i, 0.45, at: t, duration: 0.09))
                curves.append(ramp(from: 0.2, to: 1.0, at: t, duration: 0.09))
            case "slowRise":
                out.append(continuous(i, 0.40, at: t, duration: 0.22))
                curves.append(ramp(from: 0.15, to: 1.0, at: t, duration: 0.22))
            case "fall":
                out.append(continuous(i, 0.35, at: t, duration: 0.10))
                curves.append(ramp(from: 1.0, to: 0.1, at: t, duration: 0.10))
            case "spin":
                out.append(continuous(i * 0.6, 0.55, at: t, duration: 0.14))
            default: out.append(transient(i, 0.60, at: t))
            }
        }
        do {
            return curves.isEmpty
                ? try CHHapticPattern(events: out, parameters: [])
                : try CHHapticPattern(events: out, parameterCurves: curves)
        } catch {
            return nil
        }
    }
}
