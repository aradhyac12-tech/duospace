export interface ReportOutgoingCallOptions {
  callId: string;
  calleeName: string;
  isVideo: boolean;
}

export interface ReportCallEndedOptions {
  /** 'remoteEnded' | 'failed' | 'unanswered' | 'declinedElsewhere' | 'answeredElsewhere' */
  reason?: 'remoteEnded' | 'failed' | 'unanswered' | 'declinedElsewhere' | 'answeredElsewhere';
}

export interface CallActionEvent {
  callId: string;
  /** 'accept' | 'end' | 'mute' | 'unmute' */
  action: string;
  isVideo: boolean;
  conversationId?: string;
  roomName?: string;
}

export interface VoipTokenEvent {
  token: string;
}

export interface DuospaceCallKitBridgePlugin {
  /**
   * iOS only. Reports an outgoing call to CallKit so it shows in the
   * system's call UI, Bluetooth/CarPlay displays, and correctly arbitrates
   * audio focus against the Phone app. No-op resolving immediately on
   * Android — DuoSpace's Android equivalent (self-managed
   * ConnectionService) is wired directly at the native layer via
   * native/android/TelecomHelper.kt and doesn't need a JS-triggered call
   * for outgoing calls; this exists so call-initiation code in
   * useDailyCall.ts can call it unconditionally without an `if
   * (Capacitor.getPlatform() === 'ios')` branch at every call site.
   */
  reportOutgoingCall(options: ReportOutgoingCallOptions): Promise<void>;

  /**
   * iOS only. Tells CallKit the current call ended — call this whenever
   * the user hangs up from DuoSpace's own in-app UI (not via CallKit's
   * system UI, which reports itself). No-op on Android.
   */
  reportCallEnded(options: ReportCallEndedOptions): Promise<void>;

  /**
   * iOS only. Sets which bundled ringtone CallKit's incoming-call screen
   * plays — CXProviderConfiguration.ringtoneSound must name a .caf file in
   * the app bundle (native/ios/Sounds/, copied by
   * scripts/patch-native-permissions.mjs; see CallKitManager.swift). Persists
   * across launches (UserDefaults), and takes effect on the next incoming
   * call — CallKit calls are answered outside the WebView's lifetime, so
   * this can't be read fresh from Supabase at ring-time the way Android's
   * CallRingingService reads it from the FCM push payload; it has to already
   * be set locally before the VoIP push arrives. Call this whenever the
   * user changes their call ringtone in Settings. No-op resolving
   * immediately on Android (which reads the ringtone per-push instead — see
   * CallNotificationService.kt).
   */
  setRingtone(options: { soundId: string }): Promise<void>;

  /**
   * Fires when CallKit answers/ends/mutes the current call — e.g. the user
   * tapped Accept on the lock-screen CallKit UI, or pressed a Bluetooth/
   * CarPlay button. Mirrors the `duospace-call-action` /
   * `duospace-call-control` window events Android dispatches from
   * native/android/CallBridge.kt, so JS-side handling
   * (src/hooks/usePushNotifications.ts, src/contexts/CallContext.tsx) can
   * stay platform-agnostic. Never fires on Android (no CallKit there) —
   * Android's equivalent path is the window CustomEvents, not this plugin.
   */
  addListener(
    eventName: 'callAction',
    listenerFunc: (event: CallActionEvent) => void,
  ): Promise<{ remove: () => void }>;

  /**
   * Fires when a new VoIP push token is issued/rotated (PushKitManager on
   * iOS). The app must upload this to Supabase as a distinct token type —
   * see native/ios/PushKitManager.swift's doc comment for why a regular
   * APNs push to a VoIP token (or vice versa) is silently dropped, not
   * just misrouted.
   */
  addListener(
    eventName: 'voipTokenUpdated',
    listenerFunc: (event: VoipTokenEvent) => void,
  ): Promise<{ remove: () => void }>;

  removeAllListeners(): Promise<void>;
}
