export type AudioRouteType = 'earpiece' | 'speaker' | 'bluetooth' | 'wired_headset' | 'unknown';

export interface AudioRoute {
  /** Stable id to pass back to setRoute(). On Android this is the underlying
   *  AudioDeviceInfo id (changes per-connection); on iOS it's the
   *  AVAudioSessionPortDescription.uid. Always re-fetch via listRoutes()
   *  rather than caching ids across calls. */
  id: string;
  /** Human-readable label, e.g. "iPhone", "AirPods Pro", "Speaker". */
  name: string;
  type: AudioRouteType;
}

export interface ListRoutesResult {
  routes: AudioRoute[];
}

export interface CurrentRouteResult {
  route: AudioRoute | null;
}

export interface SetRouteOptions {
  /** Prefer this — the id from a listRoutes() result. */
  id?: string;
  /** Fallback: switch to the first available route of this type
   *  (e.g. { type: 'speaker' }) without needing a fresh listRoutes() call. */
  type?: AudioRouteType;
}

export interface RouteChangedEvent {
  route: AudioRoute | null;
}

export interface DuospaceAudioRoutePlugin {
  /**
   * List currently available output routes (earpiece, speaker, any
   * connected Bluetooth/wired headset). Only meaningful while a call's
   * audio session is active — call this after joining the Daily.co call,
   * not before.
   */
  listRoutes(): Promise<ListRoutesResult>;
  /** Currently active output route, if determinable. */
  getCurrentRoute(): Promise<CurrentRouteResult>;
  /** Switch the active call's audio output. Pass either `id` (from
   *  listRoutes()) or `type` as a fallback. No-ops harmlessly if no call
   *  audio session is active. */
  setRoute(options: SetRouteOptions): Promise<void>;
  /** Fires whenever the OS changes the active route on its own — e.g. a
   *  Bluetooth headset connects/disconnects mid-call, or the wired headset
   *  is unplugged (both platforms auto-fall-back to speaker/earpiece and
   *  this event lets the UI stay in sync instead of showing a stale icon). */
  addListener(
    eventName: 'routeChanged',
    listenerFunc: (event: RouteChangedEvent) => void,
  ): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}
