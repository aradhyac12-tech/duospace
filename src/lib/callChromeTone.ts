/**
 * Which surface sits BEHIND the in-call chrome (header, control bar)?
 *
 * - "stage": the themed --call-stage surface (voice calls, connecting, or a
 *   video call whose partner camera is off). Chrome must use the theme's
 *   --call-stage-foreground so it stays readable in every light/dark/custom theme.
 * - "video": live (or black, not-yet-playing) video under dark scrims. Chrome
 *   must be light regardless of theme.
 *
 * Pure so the rule is unit-testable without rendering the call stack.
 */
export interface ChromeSurfaceInput {
  isVoiceCall: boolean;
  callUiState: string;
  remoteVideoOn: boolean;
  isScreenSharing: boolean;
}

export function isStageSurface({ isVoiceCall, callUiState, remoteVideoOn, isScreenSharing }: ChromeSurfaceInput): boolean {
  if (isVoiceCall) return true;
  if (callUiState === "connecting") return true;
  if ((callUiState === "connected" || callUiState === "reconnecting") && !remoteVideoOn && !isScreenSharing) return true;
  return false;
}
