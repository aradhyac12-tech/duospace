import Foundation
import AVFoundation
import MediaPlayer
import Capacitor

/// Native background-capable audio engine for iOS.
///
/// Backed by a single AVPlayer (not AVQueuePlayer) with a manually-managed
/// queue array — AVQueuePlayer only ever advances forward and irreversibly
/// drops each item once it's played, which cannot support previous(); a
/// single AVPlayer with `replaceCurrentItem` on next()/previous() gives
/// full control and keeps the queue model identical across Android/iOS/web
/// (an index into an array, not something AVFoundation manages for us).
///
/// IMPORTANT — audio session coordination with the existing calling
/// feature: `native-plugins/audio-route/ios/Plugin/AudioRoutePlugin.swift`
/// already notes that Daily.co's WebRTC engine configures the shared
/// AVAudioSession (`.playAndRecord`) when a call starts, and does not
/// expect another plugin to fight it for ownership of the session
/// category. This plugin follows the same rule: it activates
/// `.playback` only while actually loading/playing a track, and treats
/// an interruption (which is exactly what happens when Daily.co's
/// `.playAndRecord` session takes over for a call) as a signal to pause
/// and back off — never re-asserting `.playback` over an active call's
/// session. See `audioInterruption` handling below.
@objc(AudioEnginePlugin)
public class AudioEnginePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioEnginePlugin"
    public let jsName = "DuospaceAudioEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDuration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
    ]

    private struct QueuedTrack {
        let id: String
        let title: String
        let artist: String
        let artworkUrl: String?
        let streamUrl: String
    }

    private var player: AVPlayer?
    private var queue: [QueuedTrack] = []
    private var currentIndex: Int = -1
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var artworkCache: [String: MPMediaItemArtwork] = [:]

    override public func load() {
        configureRemoteCommandCenter()
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let obs = timeObserver { player?.removeTimeObserver(obs) }
    }

    // MARK: - Session

    private func activateSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true, options: [])
        } catch {
            notifyListeners("error", data: ["message": "Failed to activate audio session: \(error.localizedDescription)", "trackId": currentTrackId()])
        }
    }

    // MARK: - Remote commands (lock screen / headset / Bluetooth / car)

    private func configureRemoteCommandCenter() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.player?.play(); self?.updateNowPlaying(); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.player?.pause(); self?.updateNowPlaying(); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self, let p = self.player else { return .commandFailed }
            if p.timeControlStatus == .playing { p.pause() } else { p.play() }
            self.updateNowPlaying()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.advance(direction: 1); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.advance(direction: -1); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.player?.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 1000))
            self.updateNowPlaying()
            return .success
        }
    }

    // MARK: - Interruptions (calls, other apps, Siri, etc.)

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        if type == .began {
            // Covers a phone call, Siri, another app's audio, and — per
            // this file's header — the calling feature's own Daily.co
            // session taking the shared AVAudioSession for a call. Pause
            // rather than trying to duck: this is music, not a game sound
            // effect, ducking under a phone call is not an improvement.
            player?.pause()
            notifyListeners("audioInterruption", data: ["reason": "began"])
            notifyListeners("playbackStateChanged", data: ["state": "paused"])
            return
        }

        // .ended — report whether the OS thinks it's safe to resume, but
        // deliberately leave the actual decision to JS (GroicContext) —
        // see definitions.ts's AudioInterruptionEvent doc comment for why.
        var shouldResume = false
        if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
            shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume)
        }
        notifyListeners("audioInterruption", data: ["reason": shouldResume ? "endedShouldResume" : "endedShouldNotResume"])
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

        switch reason {
        case .oldDeviceUnavailable:
            // Headphones/Bluetooth device physically disconnected while
            // playing — Apple's documented signal that the app should
            // pause rather than let audio suddenly blast from the
            // speaker (the iOS equivalent of Android's "audio becoming
            // noisy" handling in MediaPlaybackService.kt).
            player?.pause()
            notifyListeners("headsetDisconnected", data: [:])
            notifyListeners("playbackStateChanged", data: ["state": "paused"])
        case .newDeviceAvailable:
            notifyListeners("headsetConnected", data: [:])
        default:
            break
        }
    }

    // MARK: - Now Playing / lock screen metadata

    private func updateNowPlaying() {
        guard let p = player, currentIndex >= 0, currentIndex < queue.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let track = queue[currentIndex]
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: p.currentTime().seconds.isFinite ? p.currentTime().seconds : 0,
            MPNowPlayingInfoPropertyPlaybackRate: p.timeControlStatus == .playing ? 1.0 : 0.0,
        ]
        if let duration = p.currentItem?.duration.seconds, duration.isFinite {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let artwork = artworkCache[track.id] {
            info[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let urlString = track.artworkUrl, artworkCache[track.id] == nil, let url = URL(string: urlString) {
            fetchArtwork(url: url, trackId: track.id)
        }
    }

    private func fetchArtwork(url: URL, trackId: String) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                self.artworkCache[trackId] = artwork
                // Only refresh nowPlayingInfo if this is still the track
                // being shown — a slow artwork fetch for a track the user
                // has since skipped past shouldn't stomp the current one.
                if self.currentIndex >= 0, self.currentIndex < self.queue.count, self.queue[self.currentIndex].id == trackId {
                    self.updateNowPlaying()
                }
            }
        }.resume()
    }

    // MARK: - Playback plumbing

    private func currentTrackId() -> String? {
        guard currentIndex >= 0, currentIndex < queue.count else { return nil }
        return queue[currentIndex].id
    }

    private func attachObservers(to item: AVPlayerItem) {
        if let obs = endObserver { NotificationCenter.default.removeObserver(obs) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("playbackStateChanged", data: ["state": "ended"])
            self?.notifyListeners("playbackEnded", data: [:])
        }
        statusObservation?.invalidate()
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            if item.status == .failed {
                self?.notifyListeners("error", data: ["message": item.error?.localizedDescription ?? "Playback failed", "trackId": self?.currentTrackId()])
            }
        }
    }

    private func loadItem(at index: Int, autoplay: Bool) {
        guard index >= 0, index < queue.count else { return }
        currentIndex = index
        let track = queue[index]
        guard let url = URL(string: track.streamUrl) else {
            notifyListeners("error", data: ["message": "Invalid stream URL", "trackId": track.id])
            return
        }
        activateSession()
        let item = AVPlayerItem(url: url)
        attachObservers(to: item)
        if player == nil {
            let p = AVPlayer(playerItem: item)
            player = p
            let interval = CMTime(seconds: 1, preferredTimescale: 1) // 1s tick — see FIX note in web.ts/AudioEnginePlugin.kt
            timeObserver = p.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
                guard let self = self, let duration = self.player?.currentItem?.duration.seconds, duration.isFinite else { return }
                self.notifyListeners("positionChanged", data: [
                    "positionSeconds": time.seconds.isFinite ? time.seconds : 0,
                    "durationSeconds": duration,
                ])
            }
        } else {
            player?.replaceCurrentItem(with: item)
        }
        notifyListeners("trackChanged", data: ["trackId": track.id, "index": index])
        updateNowPlaying()
        if autoplay {
            player?.play()
            notifyListeners("playbackStateChanged", data: ["state": "playing"])
        }
    }

    private func advance(direction: Int) {
        if direction > 0 {
            let next = currentIndex + 1
            if next < queue.count { loadItem(at: next, autoplay: true) } else { player?.pause(); notifyListeners("playbackStateChanged", data: ["state": "ended"]) }
        } else {
            // Same "restart vs go back" convention as Android — see
            // AudioEnginePlugin.kt's previous() comment.
            if let p = player, p.currentTime().seconds > 3 {
                p.seek(to: .zero)
            } else if currentIndex - 1 >= 0 {
                loadItem(at: currentIndex - 1, autoplay: true)
            } else {
                player?.seek(to: .zero)
            }
        }
        updateNowPlaying()
    }

    // MARK: - JS-facing methods

    @objc func load(_ call: CAPPluginCall) {
        guard let track = call.getObject("track") else { call.reject("Missing track"); return }
        guard let id = track["id"] as? String, let streamUrl = track["streamUrl"] as? String else {
            call.reject("Invalid track"); return
        }
        let title = track["title"] as? String ?? "Unknown"
        let artist = track["artist"] as? String ?? "Unknown"
        let artworkUrl = track["artworkUrl"] as? String
        let queued = QueuedTrack(id: id, title: title, artist: artist, artworkUrl: artworkUrl, streamUrl: streamUrl)
        // load() replaces the current track without necessarily touching
        // the rest of the queue — if this id is already in the queue, jump
        // to it there; otherwise insert it as a length-1 queue of its own
        // (setQueue() is what establishes a real multi-track queue).
        if let idx = queue.firstIndex(where: { $0.id == id }) {
            queue[idx] = queued
            loadItem(at: idx, autoplay: call.getBool("autoplay") ?? false)
        } else {
            queue = [queued]
            loadItem(at: 0, autoplay: call.getBool("autoplay") ?? false)
        }
        call.resolve()
    }

    @objc func play(_ call: CAPPluginCall) {
        activateSession()
        player?.play()
        notifyListeners("playbackStateChanged", data: ["state": "playing"])
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        player?.pause()
        notifyListeners("playbackStateChanged", data: ["state": "paused"])
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) { play(call) }

    @objc func stop(_ call: CAPPluginCall) {
        player?.pause()
        player?.seek(to: .zero)
        notifyListeners("playbackStateChanged", data: ["state": "idle"])
        call.resolve()
    }

    @objc func seek(_ call: CAPPluginCall) {
        let seconds = call.getDouble("positionSeconds") ?? 0
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 1000))
        updateNowPlaying()
        call.resolve()
    }

    @objc func next(_ call: CAPPluginCall) { advance(direction: 1); call.resolve() }
    @objc func previous(_ call: CAPPluginCall) { advance(direction: -1); call.resolve() }

    @objc func setQueue(_ call: CAPPluginCall) {
        guard let tracks = call.getArray("tracks") as? [[String: Any]] else { call.reject("Missing tracks"); return }
        queue = tracks.compactMap { t in
            guard let id = t["id"] as? String, let streamUrl = t["streamUrl"] as? String else { return nil }
            return QueuedTrack(
                id: id,
                title: t["title"] as? String ?? "Unknown",
                artist: t["artist"] as? String ?? "Unknown",
                artworkUrl: t["artworkUrl"] as? String,
                streamUrl: streamUrl,
            )
        }
        let startIndex = call.getInt("startIndex") ?? 0
        currentIndex = queue.isEmpty ? -1 : min(max(startIndex, 0), queue.count - 1)
        call.resolve()
    }

    @objc func getState(_ call: CAPPluginCall) {
        let p = player
        let state: String
        if p == nil { state = "idle" }
        else if p!.currentItem?.status == .failed { state = "error" }
        else if p!.timeControlStatus == .playing { state = "playing" }
        else { state = "paused" }
        call.resolve([
            "state": state,
            "currentTrackId": currentTrackId() as Any,
            "positionSeconds": p?.currentTime().seconds ?? 0,
            "durationSeconds": p?.currentItem?.duration.seconds ?? 0,
            "buffering": p?.currentItem?.isPlaybackLikelyToKeepUp == false,
            "volume": p?.volume ?? 1,
        ])
    }

    @objc func getPosition(_ call: CAPPluginCall) {
        call.resolve(["positionSeconds": player?.currentTime().seconds ?? 0])
    }

    @objc func getDuration(_ call: CAPPluginCall) {
        let d = player?.currentItem?.duration.seconds
        call.resolve(["durationSeconds": (d?.isFinite == true) ? d! : 0])
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getDouble("volume") ?? 1.0
        player?.volume = Float(max(0, min(1, volume)))
        call.resolve()
    }
}
