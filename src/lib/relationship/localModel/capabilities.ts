/**
 * LocalAIPlatformCapabilities — can THIS device actually run local-model-v1?
 * A provider class existing is NOT support. Every field is derived from the
 * real environment; anything unknown reports unsupported (fail closed).
 */
import { LOCAL_MODEL_MANIFEST, isManifestPinned, manifestCompatibility, totalModelBytes, type LocalModelManifest } from "./manifest";

export type LocalAIPlatform = "web" | "android" | "ios" | "unknown";

export interface LocalAIPlatformCapabilities {
  platform: LocalAIPlatform;
  supported: boolean;            // runtime exists for this platform in this build
  modelAvailable: boolean;       // pinned + configured + device can hold it
  modelVersion: string | null;
  maxContext: number;
  approxMemoryRequirementMB: number;
  modelSizeBytes: number;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean; // validated JSON contract (parse + schema), not grammar-constrained decoding
  accelerator: "webgpu" | "wasm" | "none";
  reasons: string[];             // why unavailable — shown in dev tooling, never contains user data
}

export interface CapabilityEnv {
  platform: LocalAIPlatform;
  hasWebGPU: boolean;
  hasWasm: boolean;
  hasSubtleCrypto: boolean;
  deviceMemoryGB: number | null;  // navigator.deviceMemory (Chromium only); null = unknown
  modelBaseUrl: string | null;
  localModelEnabled: boolean;     // build flag VITE_LOCAL_MODEL_ENABLED === "true"
}

export function detectCapabilityEnv(): CapabilityEnv {
  const g = globalThis as unknown as {
    navigator?: { gpu?: unknown; deviceMemory?: number };
    WebAssembly?: unknown;
    crypto?: { subtle?: unknown };
    Capacitor?: { getPlatform?: () => string };
  };
  const p = g.Capacitor?.getPlatform?.();
  const platform: LocalAIPlatform = p === "android" ? "android" : p === "ios" ? "ios" : p === "web" || p === undefined ? "web" : "unknown";
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return {
    platform,
    hasWebGPU: !!g.navigator?.gpu,
    hasWasm: typeof g.WebAssembly === "object",
    hasSubtleCrypto: !!g.crypto?.subtle,
    deviceMemoryGB: typeof g.navigator?.deviceMemory === "number" ? g.navigator.deviceMemory : null,
    modelBaseUrl: env.VITE_LOCAL_MODEL_BASE_URL?.trim() || null,
    localModelEnabled: env.VITE_LOCAL_MODEL_ENABLED === "true",
  };
}

export function computeCapabilities(env: CapabilityEnv, manifest: LocalModelManifest = LOCAL_MODEL_MANIFEST): LocalAIPlatformCapabilities {
  const reasons: string[] = [];
  // Android/iOS: the WebView could run the web runtime, but WebView WebGPU is
  // not dependable and a ~600MB WASM working set inside the WebView is not an
  // acceptable default on phones. A native runtime plugin (llama.cpp /
  // MediaPipe LLM) does not exist in this repo yet → unsupported, honestly.
  const supported = env.platform === "web" && env.hasWasm;
  if (env.platform === "android" || env.platform === "ios") reasons.push(`no native local-model runtime for ${env.platform} in this build`);
  if (env.platform === "unknown") reasons.push("unknown platform");
  if (env.platform === "web" && !env.hasWasm) reasons.push("WebAssembly unavailable");
  if (!env.localModelEnabled) reasons.push("local model disabled in this build (VITE_LOCAL_MODEL_ENABLED)");
  if (!isManifestPinned(manifest)) reasons.push("model files are not pinned (no verified SHA-256)");
  for (const p of manifestCompatibility(manifest)) reasons.push(`incompatible model: ${p}`); // never silently load an incompatible model
  if (!env.modelBaseUrl) reasons.push("no model origin configured (VITE_LOCAL_MODEL_BASE_URL)");
  else if (!/^https:\/\//.test(env.modelBaseUrl)) reasons.push("model origin must be https");
  if (!env.hasSubtleCrypto) reasons.push("SubtleCrypto unavailable — cannot verify model integrity");
  const needGB = manifest.approxMemoryMB / 1024;
  if (env.deviceMemoryGB !== null && env.deviceMemoryGB < Math.max(2, needGB * 3)) reasons.push("device memory too low");

  const modelAvailable = supported && reasons.length === 0;
  return {
    platform: env.platform,
    supported,
    modelAvailable,
    modelVersion: modelAvailable ? manifest.modelVersion : null,
    maxContext: manifest.maxContextTokens,
    approxMemoryRequirementMB: manifest.approxMemoryMB,
    modelSizeBytes: totalModelBytes(manifest),
    supportsStreaming: false,        // not used: output must be complete JSON before validation
    supportsStructuredOutput: true,  // enforced by parse + schema validation after generation
    accelerator: !supported ? "none" : env.hasWebGPU ? "webgpu" : "wasm",
    reasons,
  };
}

export const getLocalAICapabilities = (): LocalAIPlatformCapabilities => computeCapabilities(detectCapabilityEnv());
