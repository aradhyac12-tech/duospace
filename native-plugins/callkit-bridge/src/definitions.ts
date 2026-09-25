export interface ReportOutgoingCallOptions {
  callId: string;
  calleeName: string;
  isVideo: boolean;
}

export interface ReportCallConnectedOptions {
  callId: string;
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
  /**
   * Only meaningful for action 'end'. CallKit reports both "declined an
   * incoming call before answering" and "hung up an already-answered call"
   * as the same CXEndCallAction, so this distinguishes them: false means
   * decline (treat like Android's ACTION_DECLINE — mark call_history
   * missed), true means a real hangup of an active/answered call (treat
   * like Android's mute/unmute/end control events — route to the live
   * call's own hangup).
   */
  wasAnswered: boolean;
}

export interface VoipTokenEvent {
  token: string;
}

/** Shape persisted by CallKitManager.persistPendingAction (iOS) / the
 *  localStorage write in handleDuospaceCallIntent (Android) — see
 *  getPendingCallAction's doc comment below and
 *  src/lib/nativeCallActionBridge.ts for how this is consumed. */
export interface PendingCallAction {
  callId: string;
  action: string;
  isVideo?: boolean;
  wasAnswered?: boolean;
  /** epoch ms, set at persist time — used by nativeCallActionBridge.ts to
   *  discard a stale entry rather than replay it against a later call. */
  ts: number;
}

export type MessageAlertLevel = 'important' | 'urgent';

/** What the phone will and won't let a /important or /urgent alert do. */
export interface MessageAlertStatus {
  /** false on iOS/web, where alerts are delivered by the push itself. */
  supported: boolean;
  /** Settings → Do Not Disturb → App access granted: alerts can lift DND
   *  (including "Total silence") for their duration. */
  dndAccessGranted: boolean;
  ringerMode: 'normal' | 'vibrate' | 'silent';
  /** Current Do Not Disturb mode. 'all' = DND is off. */
  interruptionFilter: 'all' | 'priority' | 'alarms' | 'none' | 'unknown';
  /** Alarm-stream volume 0-100 — this is what alerts play on. */
  alarmVolumePercent: number;
}

export interface DuospaceCallKitBridgePlugin {
  /** ANDROID ONLY. Stops a ringing /important or /urgent alert (sound +
   *  vibration). Call when the person opens the app/chat. No-op if none is
   *  ringing. See native/android/MessageAlertService.kt. */
  stopMessageAlert(): Promise<void>;

  /** ANDROID ONLY. Plays a ~6 s sample of a tier's real alert (same service,
   *  same alarm-stream sound + vibration) so the person can hear/feel it with
   *  the phone silent or in Do Not Disturb. */
  previewMessageAlert(options: { level: MessageAlertLevel }): Promise<void>;

  /** ANDROID ONLY. See MessageAlertStatus. */
  getMessageAlertStatus(): Promise<MessageAlertStatus>;

  /** ANDROID ONLY. Opens Settings → Do Not Disturb → App access. */
  openDndAccessSettings(): Promise<void>;

  /**
   * Call this the moment an outgoing call starts dialing (before/alongside
   * The call engine room-create — see Calls.tsx/Chat.tsx). Cross-platform, both
   * with real behavior:
   *  - iOS: reports the call to CallKit (system call UI, Bluetooth/CarPlay
   *    displays, audio-focus arbitration against the Phone app).
   *  - Android: registers with Telecom (native/android/TelecomHelper.kt's
   *    registerOutgoingCall — previously dead code, never called from
   *    anywhere, which meant outgoing calls never got OS-level "in call"
   *    treatment at all) AND starts the caller-side "Calling…" notification
   *    (native/android/CallOngoingService.kt) that this app was missing —
   *    incoming calls already had one, outgoing calls had none.
   * Both platforms are best-effort: a Telecom/CallKit registration failure
   * must never block the call itself, which works via the call engine/WebRTC
   * independent of this layer either way.
   */
  reportOutgoingCall(options: ReportOutgoingCallOptions): Promise<void>;

  /**
   * GAP FIX: this used to be iOS-only in practice because nothing on either
   * platform ever called reportOutgoingCall in the first place (see that
   * method's own comment, now corrected). Call this once real remote audio
   * is confirmed (the call engine adapter's waitForRemoteAudioReady) —
   * NOT at tap-to-call and NOT at local call.join() resolution, same "don't
   * claim connected early" rule this app already applies to
   * callStateMachine/callLatency. On iOS this flips CallKit's outgoing-call
   * UI from "Calling…" to connected and turns on proximity-sensor
   * screen-off for voice calls (CallKitManager.reportCallConnected). On
   * Android there's no CallKit layer to piggyback this on, so it directly
   * drives native/android/CallOngoingService.kt's own notification-text +
   * proximity-lock transition. Safe/expected to be a no-op if the call
   * already ended by the time this resolves — both platforms guard on
   * "is there still a call this belongs to".
   */
  reportCallConnected(options: ReportCallConnectedOptions): Promise<void>;

  /**
   * Call this whenever the user hangs up (or a call fails/is cancelled)
   * from DuoSpace's own in-app UI — not needed when CallKit's own system UI
   * reports the end itself (that path already knows). Cross-platform: tells
   * CallKit the call ended on iOS, and on Android tears down the Telecom
   * connection + stops the "Calling…"/in-progress notification + releases
   * the proximity wake lock (native/android/CallOngoingService.kt).
   */
  reportCallEnded(options: ReportCallEndedOptions): Promise<void>;

  /**
   * Android only. Silences and dismisses the NATIVE incoming-call experience
   * (native/android/CallRingingService.kt's looping ringtone + vibration, the
   * full-screen "Incoming call" notification, and the still-ringing Telecom
   * connection) for a call that was answered, declined, cancelled or ended
   * from inside the app's own JS UI.
   *
   * Why this exists: that native ringing is started by the FCM push alone,
   * and before this method the only things that could stop it were the
   * notification's own Accept/Decline buttons, a call_ended/missed/rejected
   * push, or its 45s self-timeout. Tapping Accept on the in-app overlay (or
   * the call ending while the app was open) stopped only the JS ringtone/
   * haptics — the phone kept vibrating natively. `callId`-guarded natively,
   * so a stale dismiss for an old call can't touch a newer one. Safe to call
   * when nothing is ringing. No-op resolving immediately on iOS (CallKit owns
   * that lifecycle) and on web.
   */
  dismissIncomingCall(options?: { callId?: string }): Promise<void>;

  /**
   * True while the OS-level incoming-call ring is active, i.e. the phone is
   * ALREADY playing the user's chosen ringtone natively — Android: the
   * CallRingingService foreground notification is up; iOS: CallKit has an
   * unanswered call. The in-app overlay asks this before playing its own
   * copy of the ringtone so the two never ring on top of each other (that
   * doubled the sound, and until v3.11.1 the in-app copy was a hard-coded
   * beep that ignored the chosen ringtone). Rejects / is unimplemented on
   * web and on native builds that predate this method — callers must treat
   * any failure as "unknown" and ring in-app.
   */
  isIncomingRinging(): Promise<{ ringing: boolean }>;

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

  /**
   * iOS only. Reads and clears whatever call action CallKit's
   * CXProviderDelegate most recently persisted to UserDefaults (see
   * CallKitManager.swift's PENDING_ACTION_DEFAULTS_KEY doc comment) —
   * durable, so it survives a cold start that raced ahead of this plugin's
   * own `callAction` listener being registered. Call once on boot, not
   * polled. Resolves `{}` (no `callId` key) when nothing is pending — check
   * for that rather than expecting a rejection. No-op resolving `{}`
   * immediately on Android, which has its own localStorage-based version
   * of this same fix, read directly (not through this plugin) — see
   * src/lib/nativeCallActionBridge.ts.
   */
  getPendingCallAction(): Promise<Partial<PendingCallAction>>;
}
