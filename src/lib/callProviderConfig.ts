/**
 * callProviderConfig — the calling provider for DuoSpace.
 *
 * There is exactly ONE production calling provider: the self-hosted stack
 * (authenticated DuoSpace WebSocket signaling for call control; media runs
 * on LiveKit Cloud, which also provides managed TURN). There is no
 * build-time flag, no per-device override and no fallback provider —
 * nothing can select another engine at runtime. See
 * docs/calling-architecture.md.
 */
export type CallProviderMode = "self_hosted";

export function resolveCallProviderMode(): CallProviderMode {
  return "self_hosted";
}

export function resolveActiveCallEngine(): "self_hosted" {
  return "self_hosted";
}
