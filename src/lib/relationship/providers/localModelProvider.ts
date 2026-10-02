/**
 * local-model-v1 — RelationshipAIProvider backed by an on-device model.
 *
 * Contract with the pipeline:
 *  - throws LOCAL_MODEL_UNAVAILABLE if capabilities say no (the pipeline then
 *    falls back to local-rule-v1 — never to any cloud model);
 *  - returns the RAW parsed JSON object; parseProviderResponse + the safety
 *    validator + the evidence (provenance) check decide what survives;
 *  - unparseable output throws MALFORMED_RESPONSE (→ fallback).
 *
 * isProduction is FALSE: it may only become the default provider after the
 * evaluation gates in src/test/ai pass against the REAL runtime on target
 * devices (see docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md §Quality gates).
 */
import { ProcessingLocation } from "../../privacy/dataClassification";
import { RelationshipError } from "../errors";
import type { ProviderResponse, RelationshipAIProvider } from "../provider";
import { getLocalAICapabilities, type LocalAIPlatformCapabilities } from "../localModel/capabilities";
import { LOCAL_MODEL_MANIFEST } from "../localModel/manifest";
import type { LocalModelRuntime } from "../localModel/runtime";
import { SYSTEM_PROMPT, expectationsPrompt, extractJson, reflectionPrompt, valuesPrompt } from "../localModel/prompt";

export interface LocalModelProviderOptions {
  capabilities?: () => LocalAIPlatformCapabilities;
  /** Runtime factory — called lazily on first analysis, never at import. */
  createRuntime?: () => Promise<LocalModelRuntime>;
  modelVersion?: string;
}

async function defaultRuntime(): Promise<LocalModelRuntime> {
  const caps = getLocalAICapabilities();
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const { createTransformersWebRuntime } = await import("../localModel/transformersWebRuntime");
  return createTransformersWebRuntime(LOCAL_MODEL_MANIFEST, env.VITE_LOCAL_MODEL_BASE_URL ?? "", caps.accelerator === "webgpu" ? "webgpu" : "wasm");
}

export function createLocalModelProvider(opts: LocalModelProviderOptions = {}): RelationshipAIProvider & {
  isAvailable(): boolean; runtimeMetrics(): ReturnType<LocalModelRuntime["metrics"]> | null;
} {
  const caps = opts.capabilities ?? getLocalAICapabilities;
  const factory = opts.createRuntime ?? defaultRuntime;
  let runtime: LocalModelRuntime | null = null;

  const run = async (userPrompt: string): Promise<ProviderResponse> => {
    const c = caps();
    if (!c.modelAvailable) throw new RelationshipError("LOCAL_MODEL_UNAVAILABLE");
    if (!runtime) runtime = await factory();
    const text = await runtime.generate(SYSTEM_PROMPT, userPrompt, {
      maxNewTokens: LOCAL_MODEL_MANIFEST.maxNewTokens, temperature: 0, // deterministic decoding
    });
    const json = extractJson(text);
    if (json === null) throw new RelationshipError("MALFORMED_RESPONSE");
    return json as ProviderResponse; // shape is verified by parseProviderResponse in the pipeline
  };

  return {
    info: {
      id: "local-model-v1",
      kind: "LOCAL_MODEL",
      processingLocation: ProcessingLocation.DEVICE,
      modelVersion: opts.modelVersion ?? LOCAL_MODEL_MANIFEST.modelVersion,
      isProduction: false,
      description: "On-device language model (transformers.js / ONNX). Output is validated; falls back to local-rule-v1.",
    },
    isAvailable: () => caps().modelAvailable,
    runtimeMetrics: () => runtime?.metrics() ?? null,
    analyzeValues: (i) => run(valuesPrompt(i)),
    analyzeExpectations: (i) => run(expectationsPrompt(i)),
    analyzeCommunicationReflection: (i) => run(reflectionPrompt(i)),
  };
}
