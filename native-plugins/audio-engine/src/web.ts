/**
 * Web fallback for DuospaceAudioEngine.
 *
 * Real, not a stub — a single HTMLAudioElement plus the standard
 * `navigator.mediaSession` API. Honest picture of what that actually gets
 * you, browser by browser, verified rather than assumed:
 *
 *   - Desktop Chrome/Edge/Firefox/Safari, and Android Chrome/Firefox/
 *     Edge/Samsung Internet: this is genuinely reliable. Backgrounding the
 *     tab or locking an Android phone does not stop a page that's actively
 *     playing audio — the OS and browser both treat that as a real reason
 *     to keep the tab's process alive — and `navigator.mediaSession` (see
 *     below) drives real lock-screen/notification controls there too.
 *
 *   - `navigator.mediaSession` IS supported in iOS Safari — it has been
 *     Baseline-available across browsers, iOS Safari included, since
 *     September 2021. (An older, easy-to-find claim that Safari has no
 *     `navigator.mediaSession` at all is out of date and was never true
 *     for iOS 15+; this file used to repeat that claim in this exact
 *     comment, incorrectly.)
 *
 *   - The REAL iOS constraint isn't MediaSession support — it's that
 *     WebKit's background-tab suspension policy for a plain Safari tab is
 *     independently documented as inconsistent, and has gotten WORSE for
 *     an installed home-screen PWA specifically on iOS 26 as of this
 *     writing (multiple concurrent, still-open Apple Feedback / developer
 *     forum reports as of late 2025: audio breaking after first use, the
 *     next track not advancing while locked, playback needing the app to
 *     be foregrounded again to recover — with several of those reports
 *     noting the SAME site works fine in a plain browser tab but breaks
 *     once "Added to Home Screen"). This is a live, currently-unresolved
 *     WebKit/iOS platform issue, not something any JS in this file (or
 *     anywhere else in this app) can fix outright. What IS in this file's
 *     control: never make it worse with a self-inflicted bug, and recover
 *     automatically where a recovery is actually possible (see the
 *     visibilitychange/pageshow handling in ensureAudio() below) — this is
 *     exactly why the native Capacitor plugin (this file's counterpart on
 *     iOS/Android builds) exists at all, for the cases web fundamentally
 *     cannot guarantee.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  DuospaceAudioEnginePlugin, AudioEngineState, AudioEngineTrack,
  LoadOptions, SeekOptions, SetQueueOptions, SetVolumeOptions,
} from "./definitions";

export class AudioEngineWeb extends WebPlugin implements DuospaceAudioEnginePlugin {
  private audio: HTMLAudioElement | null = null;
  private queue: AudioEngineTrack[] = [];
  private currentIndex = -1;
  private positionTimer: number | null = null;

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("play", () => this.notifyListeners("playbackStateChanged", { state: "playing" }));
    el.addEventListener("pause", () => {
      // Distinguish a real pause from "paused because it just ended" —
      // the 'ended' listener below fires its own state, and firing
      // "paused" right after would make the mini-player flash paused
      // then... nothing, since nothing else corrects it back.
      if (!el.ended) this.notifyListeners("playbackStateChanged", { state: "paused" });
    });
    el.addEventListener("waiting", () => this.notifyListeners("bufferingChanged", { buffering: true }));
    el.addEventListener("playing", () => this.notifyListeners("bufferingChanged", { buffering: false }));
    el.addEventListener("durationchange", () => {
      if (isFinite(el.duration)) this.notifyListeners("durationChanged", { durationSeconds: el.duration });
    });
    el.addEventListener("ended", () => {
      this.notifyListeners("playbackStateChanged", { state: "ended" });
      this.notifyListeners("playbackEnded", null);
    });
    el.addEventListener("error", () => {
      this.notifyListeners("error", { message: el.error?.message ?? "Playback error", trackId: this.queue[this.currentIndex]?.id ?? null });
    });
    this.audio = el;
    this.startPositionTimer();
    this.wireVisibilityResume();
    return el;
  }

  // FIX (silent stall after backgrounding — matches widely-reported iOS
  // Safari/PWA behavior where audio suspended by the OS while the tab was
  // hidden does NOT resume on its own, and previously needed the user to
  // notice the silence and manually hit play again after returning to the
  // tab): track whether the element was actually mid-playback right before
  // the tab was hidden, and on becoming visible again, if it's since gone
  // quietly paused/suspended, retry play() automatically. This can't
  // prevent the OS from suspending playback while backgrounded in the
  // first place — nothing in JS can — it only removes the extra manual
  // step once the user is back looking at the tab, which is the one part
  // of this actually inside this file's control.
  private wasPlayingBeforeHidden = false;
  private visibilityWired = false;
  private wireVisibilityResume() {
    if (this.visibilityWired || typeof document === "undefined") return;
    this.visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      const el = this.audio;
      if (!el) return;
      if (document.hidden) {
        this.wasPlayingBeforeHidden = !el.paused && !el.ended;
        return;
      }
      if (this.wasPlayingBeforeHidden && el.paused && !el.ended) {
        el.play().catch(() => { /* still blocked (e.g. no fresh user gesture on this browser) — leave it for the user to tap play, same as before this fix */ });
      }
    });
    // iOS Safari specifically has also been reported to fire `pageshow`
    // (bfcache restore) without a matching visibilitychange in some
    // versions — cheap to cover both rather than assume only one fires.
    window.addEventListener?.("pageshow", () => {
      const el = this.audio;
      if (el && this.wasPlayingBeforeHidden && el.paused && !el.ended) {
        el.play().catch(() => {});
      }
    });
  }

  // FIX ("do not send a position update to React state every few
  // milliseconds"): this plugin only emits positionChanged on its own
  // 1s interval, decoupled from the audio element's native `timeupdate`
  // (which fires far more often than any UI needs, and at an interval
  // that varies by browser). GroicContext's consumer of this event is
  // free to throttle further, but the plugin itself never floods it.
  private startPositionTimer() {
    if (this.positionTimer) return;
    this.positionTimer = window.setInterval(() => {
      const el = this.audio;
      if (!el || el.paused) return;
      this.notifyListeners("positionChanged", {
        positionSeconds: el.currentTime || 0,
        durationSeconds: isFinite(el.duration) ? el.duration : 0,
      });
      this.updatePositionState(el);
    }, 1000);
  }

  // ADDED: navigator.mediaSession.setPositionState() — separate from
  // .metadata (title/artist/artwork, set once per track) and from
  // .playbackState ("playing"/"paused", set on every play/pause call).
  // Without this, the lock-screen/notification scrub bar on Android
  // Chrome and iOS Safari either doesn't render at all or freezes at
  // 0:00, because neither browser infers position/duration from the
  // <audio> element itself — this is the one call that actually feeds
  // it. Wrapped defensively: unsupported in a handful of older browsers,
  // and duration can legitimately be non-finite (e.g. a live/streamed
  // source) right after load() before metadata has arrived, both of
  // which throw if passed straight through.
  private updatePositionState(el: HTMLAudioElement) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof ms.setPositionState !== "function") return;
    if (!isFinite(el.duration) || el.duration <= 0) return;
    try {
      ms.setPositionState({
        duration: el.duration,
        playbackRate: el.playbackRate || 1,
        position: Math.min(el.currentTime || 0, el.duration),
      });
    } catch { /* e.g. position momentarily > duration mid-seek — skip this tick */ }
  }

  // NOTE: this plugin deliberately does NOT set navigator.mediaSession.metadata
  // or navigator.mediaSession.setActionHandler(...) for play/pause/next/
  // previous/seekto — those used to live here, scoped only to this plugin's
  // own <audio> element (Audius tracks). That meant a YouTube track (played
  // through the separate hidden IFrame, never through this plugin) got no
  // notification/lock-screen controls at all, and if this plugin's handlers
  // and a YouTube-aware set both tried to register at once, whichever ran
  // last would silently win, with no error to signal the conflict.
  // GroicContext (src/contexts/GroicContext.tsx) is now the single owner of
  // navigator.mediaSession for the whole app — it already knows which engine
  // (this plugin vs. the YouTube IFrame) is live for the current track and
  // routes accordingly. This file still keeps playbackState/setPositionState
  // in sync with its own element below, which is harmless either way and
  // lets those two calls stay correct even if something outside GroicContext
  // ever queries navigator.mediaSession.playbackState directly.

  async load(options: LoadOptions): Promise<void> {
    const el = this.ensureAudio();
    const idx = this.queue.findIndex((t) => t.id === options.track.id);
    if (idx >= 0) this.currentIndex = idx;
    el.src = options.track.streamUrl;
    this.notifyListeners("trackChanged", { trackId: options.track.id, index: this.currentIndex });
    if (options.autoplay) await this.play();
  }

  async play(): Promise<void> {
    const el = this.ensureAudio();
    try {
      await el.play();
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    } catch (e) {
      // Autoplay-policy rejection lands here on some browsers if play()
      // is called without a preceding user gesture — surface it as a real
      // error rather than silently doing nothing, so the UI can tell the
      // user to tap play again instead of just looking stuck.
      this.notifyListeners("error", { message: e instanceof Error ? e.message : "Playback was blocked", trackId: this.queue[this.currentIndex]?.id ?? null });
    }
  }

  async pause(): Promise<void> {
    this.audio?.pause();
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }

  async resume(): Promise<void> { await this.play(); }

  async stop(): Promise<void> {
    const el = this.audio;
    if (el) { el.pause(); el.currentTime = 0; }
    this.notifyListeners("playbackStateChanged", { state: "idle" });
  }

  async seek(options: SeekOptions): Promise<void> {
    const el = this.ensureAudio();
    el.currentTime = options.positionSeconds;
    this.notifyListeners("positionChanged", { positionSeconds: options.positionSeconds, durationSeconds: isFinite(el.duration) ? el.duration : 0 });
    this.updatePositionState(el);
  }

  async next(): Promise<void> {
    if (this.currentIndex < 0 || this.queue.length === 0) return;
    const nextIdx = this.currentIndex + 1;
    if (nextIdx >= this.queue.length) { await this.stop(); return; }
    this.currentIndex = nextIdx;
    await this.load({ track: this.queue[nextIdx], autoplay: true });
  }

  async previous(): Promise<void> {
    if (this.currentIndex <= 0) { await this.seek({ positionSeconds: 0 }); return; }
    this.currentIndex -= 1;
    await this.load({ track: this.queue[this.currentIndex], autoplay: true });
  }

  async setQueue(options: SetQueueOptions): Promise<void> {
    this.queue = options.tracks;
    this.currentIndex = options.startIndex ?? (this.queue.length > 0 ? 0 : -1);
  }

  async getState(): Promise<AudioEngineState> {
    const el = this.audio;
    return {
      state: !el ? "idle" : el.ended ? "ended" : el.paused ? "paused" : "playing",
      currentTrackId: this.queue[this.currentIndex]?.id ?? null,
      positionSeconds: el?.currentTime ?? 0,
      durationSeconds: el && isFinite(el.duration) ? el.duration : 0,
      buffering: false,
      volume: el?.volume ?? 1,
    };
  }

  async getPosition(): Promise<{ positionSeconds: number }> {
    return { positionSeconds: this.audio?.currentTime ?? 0 };
  }

  async getDuration(): Promise<{ durationSeconds: number }> {
    return { durationSeconds: this.audio && isFinite(this.audio.duration) ? this.audio.duration : 0 };
  }

  async setVolume(options: SetVolumeOptions): Promise<void> {
    if (this.audio) this.audio.volume = Math.max(0, Math.min(1, options.volume));
  }
}
