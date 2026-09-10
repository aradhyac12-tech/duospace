export type RingerMode = 'normal' | 'vibrate' | 'silent' | 'unknown';

export interface DeviceStatus {
  /** 0-100, or null if genuinely unreadable (rare — battery info is normally
   *  available on both platforms once the OS has had a moment to report it). */
  batteryLevel: number | null;
  /** null when the platform can't determine charging state either. */
  charging: boolean | null;
  /**
   * 'normal' | 'vibrate' | 'silent' on Android (a real, always-available
   * public API — AudioManager.getRingerMode()).
   *
   * Always 'unknown' on iOS. This is not a plugin limitation — Apple
   * provides no public API to read the physical mute-switch position, full
   * stop. Some apps fake this by timing a silent-audio-playback trick, but
   * that's unreliable (false positives/negatives) and exactly the kind of
   * thing that shouldn't ship in a couples-trust app: a wrong "they're not
   * on silent" reading is worse than an honest "unknown". iOS always
   * reports 'unknown' here on purpose.
   */
  ringerMode: RingerMode;
}

export interface DuospaceDeviceStatusPlugin {
  getStatus(): Promise<DeviceStatus>;
  /** Fires whenever the OS reports a battery or (Android-only) ringer
   *  change, so the UI can push a fresh value without polling. */
  addListener(
    eventName: 'statusChanged',
    listenerFunc: (status: DeviceStatus) => void,
  ): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}
