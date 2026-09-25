/**
 * CallEngine — the calling contract CallContext.tsx exposes to every screen
 * (Calls.tsx, Chat.tsx, CallStage, MinimizedCallBubble, IncomingCallOverlay).
 * Implemented by SelfHostedCallEngineAdapter (LiveKit), the only engine.
 * joinCall's first argument is the call id (call_history.id); the adapter
 * derives everything else server-side via the livekit-token function.
 */
import type { CallError } from "@/lib/callErrors";
import type { QualityTier } from "@/lib/networkQualityClassifier";

export type CallEngineNetworkQuality = "excellent" | "good" | "fair" | "poor";
export type CallEngineState = "idle" | "joining" | "joined" | "error";

export interface CallEngineVideoDevice {
  deviceId: string;
  label: string;
}

export interface CallEngine {
  joinCall: (url: string, token?: string, videoOff?: boolean) => Promise<void>;
  leaveCall: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  switchCamera: (deviceId: string) => Promise<void>;
  listCameras: () => Promise<CallEngineVideoDevice[]>;
  cycleCamera: () => Promise<void>;
  facingMode: "user" | "environment" | undefined;
  isAudioOn: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  callState: CallEngineState;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  screenShareRef: React.RefObject<HTMLVideoElement>;
  reattachRemoteVideo: () => void;
  networkQuality: CallEngineNetworkQuality;
  participantCount: number;
  error: string | null;
  callError: CallError | null;
  callDuration: number;
  autoAudioFallback: boolean;
  detailedNetworkQuality: QualityTier;
  /** Resolves true once remote audio is actually PLAYING; false on timeout
   *  or as soon as the call is left/superseded. */
  waitForRemoteAudioReady: (timeoutMs: number) => Promise<boolean>;
  /** Resolves true once the other participant is in the LiveKit room;
   *  false on timeout or as soon as the call is left/superseded. */
  waitForRemoteParticipant: (timeoutMs: number) => Promise<boolean>;
  /** One more play() on attached remote audio (degraded-media recovery). */
  retryRemoteAudioPlayback: () => void;
  /** Start the livekit-token request for `callId` early; joinCall(callId) reuses it. */
  prefetchToken: (callId: string) => void;
  /** Synchronous: is `callId` the call this engine is joining/in right now? */
  isActiveCall: (callId: string) => boolean;
  /** Real media progress — see MEDIA_STAGES in SelfHostedCallEngineAdapter. */
  mediaStage: import("./SelfHostedCallEngineAdapter").MediaStage;
  /** True only once remote audio is actually playing (call really connected). */
  remoteAudioReady: boolean;
}

/** Which engine is actually live for the current call attempt. Distinct
 *  from the *configured* provider (callProviderConfig.ts) — "auto" mode
 *  or a fallback can mean the active engine differs from the configured
 *  one for a given call. */
export type CallEngineProviderId = "self_hosted";

/** Generic error codes an adapter maps its provider-specific failures
 *  onto (STEP 20 of the migration brief). Not yet consumed anywhere —
 *  CallError (callErrors.ts) remains the type actually surfaced to the
 *  UI today; this exists so SelfHostedCallEngineAdapter and a future
 *  fallback controller have a shared vocabulary to translate into
 *  CallError from. */
export type CallEngineErrorCode =
  | "AUTH_FAILED"
  | "TOKEN_EXPIRED"
  | "SIGNALING_UNAVAILABLE"
  | "MEDIA_UNAVAILABLE"
  | "ICE_FAILED"
  | "TURN_FAILED"
  | "ROOM_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "NETWORK_CHANGED"
  | "TIMEOUT"
  | "UNKNOWN";
