/**
 * awaitCallMedia — decides when a call is ACTUALLY connected.
 *
 * Replaces the old pattern (used on both caller and receiver side):
 *
 *     const ok = await waitForRemoteAudioReady(8000);
 *     dispatch({ type: "CONNECTED", source: ok ? "remote-audio-ready" : "remote-audio-timeout" });
 *
 * which reported a healthy CONNECTED call even when no remote audio ever
 * played — and on the CALLER side fired 8s after joining the room while
 * the partner's phone was still RINGING (plus a "Voice call started" toast).
 *
 * Stages (each bounded):
 *   1. remote participant in the LiveKit room
 *        caller:   bounded by the ring window (the partner may take ~40s to answer;
 *                  decline / ring-timeout / hang-up end the call → `stale`)
 *        receiver: short — the caller is already in the room
 *   2. remote audio PLAYING within `audioTimeoutMs` (the existing 8s bound)
 *   3. if not: MEDIA_DEGRADED (explicit — never CONNECTED), one playback
 *      retry, then up to `degradedGraceMs` more; still nothing → failed.
 *
 * `isCurrent()` is checked after every await: a result for a call that was
 * left/cancelled/superseded meanwhile is reported as `stale` and must not
 * mutate anything. Framework-free so it is unit-testable.
 */
export type CallMediaOutcome =
  | { result: "connected"; degraded: boolean }
  | { result: "no_remote_participant" }
  | { result: "no_remote_audio" }
  | { result: "stale" };

export interface AwaitCallMediaDeps {
  waitForRemoteParticipant: (timeoutMs: number) => Promise<boolean>;
  waitForRemoteAudioReady: (timeoutMs: number) => Promise<boolean>;
  retryRemoteAudioPlayback?: () => void;
  isCurrent: () => boolean;
  /** Called once, when the audio bound is exceeded (→ MEDIA_DEGRADED). */
  onDegraded?: () => void;
}

export interface AwaitCallMediaOptions {
  participantTimeoutMs: number;
  audioTimeoutMs?: number;
  degradedGraceMs?: number;
}

export const REMOTE_AUDIO_TIMEOUT_MS = 8_000;
export const DEGRADED_GRACE_MS = 12_000;
/** Caller waits for the partner to answer: gateway ring TTL (40s) + slack. */
export const CALLER_PARTICIPANT_TIMEOUT_MS = 50_000;
/** Receiver: the caller is already in the room when we accept. */
export const RECEIVER_PARTICIPANT_TIMEOUT_MS = 10_000;

export async function awaitCallMedia(deps: AwaitCallMediaDeps, opts: AwaitCallMediaOptions): Promise<CallMediaOutcome> {
  const audioTimeoutMs = opts.audioTimeoutMs ?? REMOTE_AUDIO_TIMEOUT_MS;
  const degradedGraceMs = opts.degradedGraceMs ?? DEGRADED_GRACE_MS;

  const participant = await deps.waitForRemoteParticipant(opts.participantTimeoutMs);
  if (!deps.isCurrent()) return { result: "stale" };
  if (!participant) return { result: "no_remote_participant" };

  if (await deps.waitForRemoteAudioReady(audioTimeoutMs)) {
    return deps.isCurrent() ? { result: "connected", degraded: false } : { result: "stale" };
  }
  if (!deps.isCurrent()) return { result: "stale" };

  // Joined, partner present, but no playing audio: degraded, NOT connected.
  deps.onDegraded?.();
  deps.retryRemoteAudioPlayback?.();
  const late = await deps.waitForRemoteAudioReady(degradedGraceMs);
  if (!deps.isCurrent()) return { result: "stale" };
  return late ? { result: "connected", degraded: true } : { result: "no_remote_audio" };
}

/** User-facing message for a media failure outcome. */
export function mediaFailureMessage(o: CallMediaOutcome): string {
  if (o.result === "no_remote_participant") return "Your partner couldn't join the call.";
  if (o.result === "no_remote_audio") return "Connected, but no audio came through. Check your connection and try again.";
  return "The call couldn't connect.";
}
