/**
 * AI execution modes + the ONE routing policy for relationship AI.
 *
 *   LOCAL       on-device model (local-model-v1)
 *   E2E_CLOUD   genuinely end-to-end-encrypted cloud inference — BLOCKED in
 *               this build: no attested confidential-computing (TEE) inference
 *               endpoint exists, and without one any cloud server would see
 *               plaintext (see e2eCloud/e2eCloudProvider.ts).
 *   RULE_BASED  deterministic on-device rules (local-rule-v1)
 *   UNAVAILABLE no safe processing path
 *
 * The decision is LOCAL (never uploads device data), deterministic, and
 * bounded: per request at most one primary attempt + one RULE_BASED
 * fallback. There is no LOCAL→CLOUD or CLOUD→LOCAL hop within a request, and
 * a LOCAL failure never escalates to cloud (a failing model is not a reason
 * to send private text off the device).
 */
import type { LocalAIPlatformCapabilities } from "./localModel/capabilities";

export const AIExecutionMode = {
  LOCAL: "LOCAL",
  E2E_CLOUD: "E2E_CLOUD",
  RULE_BASED: "RULE_BASED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;
export type AIExecutionMode = (typeof AIExecutionMode)[keyof typeof AIExecutionMode];

/** User-facing wording. Accurate to what actually happens — no "E2E" claim
 *  is shown anywhere because E2E_CLOUD never runs in this build. */
export const MODE_LABEL: Readonly<Record<AIExecutionMode, string>> = {
  LOCAL: "Processed on your device",
  E2E_CLOUD: "Processed using encrypted cloud AI",
  RULE_BASED: "Using offline reflection on your device",
  UNAVAILABLE: "Reflection isn't available right now",
};

// ── Local runtime failure state (no user content; safe to persist) ────────
export type LocalFailureKind =
  | "MODEL_MISSING" | "DOWNLOAD" | "INTEGRITY" | "TOKENIZER" | "RUNTIME"
  | "UNSUPPORTED" | "OUT_OF_MEMORY" | "TIMEOUT" | "MALFORMED_OUTPUT" | "UNSAFE_OUTPUT";

/** How each failure affects FUTURE routing (the current request always goes
 *  to RULE_BASED if it can). Output-quality failures are content-dependent
 *  and never disable the model. */
export const FAILURE_POLICY: Readonly<Record<LocalFailureKind, { disableLocalForMs: number; marksDeviceIncapable: boolean }>> = {
  MODEL_MISSING:    { disableLocalForMs: 6 * 3600_000, marksDeviceIncapable: false },
  DOWNLOAD:         { disableLocalForMs: 30 * 60_000, marksDeviceIncapable: false },   // network may recover
  INTEGRITY:        { disableLocalForMs: Number.POSITIVE_INFINITY, marksDeviceIncapable: false }, // until the manifest version changes
  TOKENIZER:        { disableLocalForMs: 24 * 3600_000, marksDeviceIncapable: false },
  RUNTIME:          { disableLocalForMs: 24 * 3600_000, marksDeviceIncapable: true },
  UNSUPPORTED:      { disableLocalForMs: 24 * 3600_000, marksDeviceIncapable: true },
  OUT_OF_MEMORY:    { disableLocalForMs: 24 * 3600_000, marksDeviceIncapable: true },
  TIMEOUT:          { disableLocalForMs: 0, marksDeviceIncapable: false },            // see TIMEOUTS_BEFORE_INCAPABLE
  MALFORMED_OUTPUT: { disableLocalForMs: 0, marksDeviceIncapable: false },
  UNSAFE_OUTPUT:    { disableLocalForMs: 0, marksDeviceIncapable: false },
};
export const TIMEOUTS_BEFORE_INCAPABLE = 2; // consecutive timeouts → device treated as too slow for 24h

export interface LocalRuntimeState {
  modelVersion: string;
  lastFailure: LocalFailureKind | null;
  failedAt: number | null;
  consecutiveTimeouts: number;
  incapableUntil: number | null;
}

export function emptyRuntimeState(modelVersion: string): LocalRuntimeState {
  return { modelVersion, lastFailure: null, failedAt: null, consecutiveTimeouts: 0, incapableUntil: null };
}

export function recordLocalFailure(s: LocalRuntimeState, kind: LocalFailureKind, now: number): LocalRuntimeState {
  const next: LocalRuntimeState = { ...s, lastFailure: kind, failedAt: now };
  if (kind === "TIMEOUT") {
    next.consecutiveTimeouts = s.consecutiveTimeouts + 1;
    if (next.consecutiveTimeouts >= TIMEOUTS_BEFORE_INCAPABLE) next.incapableUntil = now + 24 * 3600_000;
  } else if (FAILURE_POLICY[kind].marksDeviceIncapable) {
    next.incapableUntil = now + FAILURE_POLICY[kind].disableLocalForMs;
  }
  return next;
}

export function recordLocalSuccess(s: LocalRuntimeState): LocalRuntimeState {
  return { ...s, lastFailure: null, failedAt: null, consecutiveTimeouts: 0 };
}

export function isLocalTemporarilyDisabled(s: LocalRuntimeState, now: number): boolean {
  if (!s.lastFailure || s.failedAt === null) return false;
  const ms = FAILURE_POLICY[s.lastFailure].disableLocalForMs;
  return ms > 0 && now - s.failedAt < ms;
}

/** Map a thrown runtime error to a failure kind (message/name only — never content). */
export function classifyLocalFailure(err: unknown): LocalFailureKind {
  const e = err as { name?: string; message?: string; code?: string } | null;
  const name = e?.name ?? "";
  const msg = (e?.message ?? String(err ?? "")).toLowerCase();
  if (e?.code === "PROVIDER_TIMEOUT" || /timeout/.test(msg)) return "TIMEOUT";
  if (e?.code === "MALFORMED_RESPONSE") return "MALFORMED_OUTPUT";
  if (e?.code === "NO_VALID_INSIGHTS") return "UNSAFE_OUTPUT";
  if (e?.code === "LOCAL_MODEL_UNAVAILABLE") return "MODEL_MISSING";
  if (name === "ModelIntegrityError") return /http \d+/.test(msg) ? (/http 404/.test(msg) ? "MODEL_MISSING" : "DOWNLOAD") : "INTEGRITY";
  if (/out of memory|allocation|rangeerror|oom/.test(msg) || name === "RangeError") return "OUT_OF_MEMORY";
  if (/tokeniz/.test(msg)) return "TOKENIZER";
  if (/failed to fetch|networkerror|http \d+/.test(msg)) return "DOWNLOAD";
  if (/not supported|unsupported|webgpu|no available backend/.test(msg)) return "UNSUPPORTED";
  return "RUNTIME"; // ONNX session / wasm / other runtime failure
}

// ── Capability summary used for routing ───────────────────────────────────
export type MemoryClass = "low" | "mid" | "high" | "unknown";

export interface DeviceCapability {
  /** Could this device practically run the local model (independent of whether the artifact is ready)? */
  capable: boolean;
  /** Is the verified artifact ready to load right now? */
  localModelReady: boolean;
  runtime: "webgpu" | "wasm" | "none";
  memoryClass: MemoryClass;
  /** How the verdict was reached: measured signals vs assumptions. */
  confidence: "measured" | "inferred" | "unknown";
  reason: string;
}

export function memoryClassOf(gb: number | null): MemoryClass {
  if (gb === null) return "unknown";
  return gb < 4 ? "low" : gb < 8 ? "mid" : "high";
}

export function assessDevice(caps: LocalAIPlatformCapabilities, deviceMemoryGB: number | null, state: LocalRuntimeState, now: number): DeviceCapability {
  const memoryClass = memoryClassOf(deviceMemoryGB);
  const slowOrBroken = state.incapableUntil !== null && now < state.incapableUntil;
  // "capable" uses only what the platform really exposes: runtime support,
  // WASM/WebGPU, deviceMemory when Chromium exposes it, and this device's own
  // past runtime failures. No brand/model/OS-version heuristics.
  const capable = caps.supported && memoryClass !== "low" && !slowOrBroken;
  const reason = !caps.supported ? (caps.reasons[0] ?? "no local runtime")
    : memoryClass === "low" ? "device memory too low for the local model"
    : slowOrBroken ? `local model disabled after ${state.lastFailure?.toLowerCase() ?? "failures"} on this device`
    : caps.modelAvailable ? "local model ready" : (caps.reasons[0] ?? "local model not ready");
  return {
    capable,
    localModelReady: capable && caps.modelAvailable && !isLocalTemporarilyDisabled(state, now),
    runtime: caps.accelerator,
    memoryClass,
    confidence: !caps.supported || slowOrBroken ? "measured" : memoryClass === "unknown" ? "unknown" : "measured",
    reason,
  };
}

export interface CloudStatus { available: boolean; userConsented: boolean; reason: string }

/** THE routing policy. Pure and deterministic. */
export function decideExecutionMode(device: DeviceCapability, cloud: CloudStatus, ruleBasedSupported: boolean): { mode: AIExecutionMode; fallback: AIExecutionMode | null; reason: string } {
  if (device.localModelReady) {
    return { mode: "LOCAL", fallback: ruleBasedSupported ? "RULE_BASED" : null, reason: device.reason };
  }
  // Cloud ONLY for devices that cannot practically run local inference —
  // never because a capable device's model is merely missing or failed.
  if (!device.capable && cloud.available && cloud.userConsented) {
    return { mode: "E2E_CLOUD", fallback: ruleBasedSupported ? "RULE_BASED" : null, reason: `${device.reason}; using E2E cloud` };
  }
  if (ruleBasedSupported) return { mode: "RULE_BASED", fallback: null, reason: device.reason };
  return { mode: "UNAVAILABLE", fallback: null, reason: `${device.reason}; ${cloud.reason}` };
}
